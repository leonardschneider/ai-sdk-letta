import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { LettaAgent, ToolInteractions, STAY_SILENT_TOOL } from 'ai-sdk-letta';
import { ThreadRuntime, TeamDirectory, teamApp, RuntimeFault, type RuntimeHost, type RunAuthor, type TeamAgent, type RuntimeOptions } from '../src/index.js';
import { tools } from './fixtures.js';

/* ------------------------------------------------------------------ */
/* Fixture: a listening host. The scripted agent stays silent when the   */
/* turn allows it and the text contains "chat"; "hold" waits for release */
/* ------------------------------------------------------------------ */

type Sent = { conversationId: string; text: string; otid?: string; silence: boolean };
function listeningFixture(options: RuntimeOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-listen-'));
  const filename = join(directory, 'state.json');
  const conversations = new Map<string, UIMessage[]>();
  const sent: Sent[] = [];
  const gates = new Map<string, () => void>();
  const host: RuntimeHost = {
    parallel: true,
    async close() {},
    async open(target) {
      const conversationId = 'conversationId' in target ? target.conversationId : `local-conv-${randomUUID()}`;
      if (!conversations.has(conversationId)) conversations.set(conversationId, []);
      const history = conversations.get(conversationId)!;
      let input = '';
      let silence = false;
      const agent = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'agent-local-listen', interactions: new ToolInteractions(), listening: true, name: 'Desk',
        open: (signal, turn) => ({
          async send(message: SendMessage, sendOptions?: { otid?: string }) {
            input = typeof message === 'string' ? message : message.map(item => item.type === 'text' ? item.text : '').join('');
            silence = turn.silence;
            sent.push({ conversationId, text: input, otid: sendOptions?.otid, silence });
            history.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: input.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\n/, '') }], metadata: { otid: sendOptions?.otid } });
          },
          async abort() {}, close() {},
          async *stream() {
            if (input.includes('hold')) await new Promise<void>(resolve => { gates.set(conversationId, resolve); signal.addEventListener('abort', () => resolve(), { once: true }); });
            if (silence && input.includes('wordless')) {
              // Uses a tool, then ends without a word and without stay_silent.
              yield { type: 'tool_call', toolCallId: 'w1', toolName: 'text_stats', toolInput: { text: 'a b' }, uuid: 'w1' } as SDKMessage;
              yield { type: 'tool_result', toolCallId: 'w1', content: '{"words":2}', isError: false, uuid: 'w2' } as SDKMessage;
              history.push({ id: randomUUID(), role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'text_stats', toolCallId: 'w1', input: { text: 'a b' }, state: 'output-available', output: { words: 2 } }] });
              yield { type: 'result', success: true, uuid: 'z', durationMs: 1, conversationId } as SDKMessage;
              return;
            }
            if (silence && input.includes('chat')) {
              const id = `s-${randomUUID()}`;
              yield { type: 'reasoning', content: 'They are chatting among themselves.', uuid: 'r' } as SDKMessage;
              yield { type: 'tool_call', toolCallId: id, toolName: STAY_SILENT_TOOL, toolInput: { reason: 'Not for me.' }, uuid: 'c' } as SDKMessage;
              yield { type: 'tool_result', toolCallId: input.includes('mismatch') ? `${id}-other` : id, content: 'OK', isError: false, uuid: 'x' } as SDKMessage;
            }
            yield { type: 'assistant', content: silence && input.includes('chat') ? '' : 'Reply', uuid: 'a' } as SDKMessage;
            if (!(silence && input.includes('chat'))) history.push({ id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Reply' }] });
            yield { type: 'result', success: true, uuid: 'z', durationMs: 1, conversationId } as SDKMessage;
          },
        }) });
      return { agent, agentId: 'agent-local-listen', conversationId, history: structuredClone(history), reload: async () => structuredClone(history), close: async () => { agent.close(); } };
    },
  };
  const runtime = new ThreadRuntime(host, filename, 'team', { queue: true, parallel: true, replyMode: 'auto', agentName: 'Desk', ...options });
  return { runtime, filename, sent, conversations, release: (id: string) => { gates.get(id)?.(); gates.delete(id); }, gates,
    cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean, label = 'condition') {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Fixture deadline: ${label}`);
}
const mia: RunAuthor = { id: 'u-mia', login: 'mia@example.com', name: 'Mia' };
const otto: RunAuthor = { id: 'u-otto', login: 'otto@example.com', name: 'Otto' };
const turn = (threadId: string, text: string) => ({ id: randomUUID(), threadId, text, parentRunId: null });
const status = (runtime: ThreadRuntime, id: string) => runtime.events('team', id, 0).status;
const conversationOf = (f: ReturnType<typeof listeningFixture>, thread: string) => JSON.parse(readFileSync(f.filename, 'utf8')).threads.find((t: { id: string }) => t.id === thread).conversationId as string;

test('reply mode in a shared runtime: always while one person writes, agent decides once two do; overrides stick; mentions always reply', async () => {
  const f = listeningFixture();
  try {
    const thread = randomUUID();
    await f.runtime.create('team', thread, 'Lunch', mia);
    const summary = () => f.runtime.list('team').find(t => t.id === thread) as unknown as { replyMode: string; replyModeInEffect: string; participants: number };
    assert.deepEqual([summary().replyMode, summary().replyModeInEffect, summary().participants], ['inherit', 'always', 0]);
    const first = turn(thread, 'chat: hello');
    await f.runtime.start('team', first, mia);
    await until(() => status(f.runtime, first.id) === 'completed');
    // Solo: "always", the agent must reply, so silence is not allowed even for chat.
    assert.equal(f.sent[0]!.silence, false);
    assert.match(f.sent[0]!.text, /Reply mode: always\./);
    assert.equal(summary().participants, 1);
    const second = turn(thread, 'chat: hi Mia');
    await f.runtime.start('team', second, otto);
    await until(() => status(f.runtime, second.id) === 'completed');
    assert.equal(summary().replyModeInEffect, 'agent-decides'); assert.equal(summary().participants, 2);
    assert.match(f.sent[1]!.text, /Reply mode: agent decides\./);
    // A mention always gets a reply, in any mode.
    const mention = turn(thread, 'chat: @Desk what do you think?');
    await f.runtime.start('team', mention, mia);
    await until(() => status(f.runtime, mention.id) === 'completed');
    assert.equal(f.sent[2]!.silence, false); assert.match(f.sent[2]!.text, /This turn mentions you \(Desk\): reply\./);
    // Explicit overrides: validated, persisted, and back to inherit.
    assert.throws(() => f.runtime.updateMetadata('team', thread, { replyMode: 'sometimes' }), (e: unknown) => e instanceof RuntimeFault && e.code === 'invalid_input');
    assert.equal((f.runtime.updateMetadata('team', thread, { replyMode: 'always' }) as unknown as { replyModeInEffect: string }).replyModeInEffect, 'always');
    assert.equal(JSON.parse(readFileSync(f.filename, 'utf8')).threads[0].replyMode, 'always');
    assert.equal((f.runtime.updateMetadata('team', thread, { replyMode: 'when-addressed' }) as unknown as { replyModeInEffect: string }).replyModeInEffect, 'when-addressed');
    assert.equal((f.runtime.updateMetadata('team', thread, { replyMode: 'inherit' }) as unknown as { replyModeInEffect: string }).replyModeInEffect, 'agent-decides');
    assert.equal(JSON.parse(readFileSync(f.filename, 'utf8')).threads[0].replyMode, undefined);
  } finally { await f.cleanup(); }
});

test('reply modes are off without the option: single-user and plain shared runtimes refuse replyMode and send no mode', async () => {
  const f = listeningFixture({ replyMode: undefined });
  try {
    const thread = randomUUID();
    await f.runtime.create('team', thread, 'Plain', mia);
    assert.throws(() => f.runtime.updateMetadata('team', thread, { replyMode: 'always' }), (e: unknown) => e instanceof RuntimeFault && e.code === 'invalid_input');
    const summary = f.runtime.list('team')[0] as Record<string, unknown>;
    assert.equal(summary.replyMode, undefined); assert.equal(summary.replyModeInEffect, undefined);
    const run = turn(thread, 'hello');
    await f.runtime.start('team', run, mia);
    await until(() => status(f.runtime, run.id) === 'completed');
    assert.doesNotMatch(f.sent[0]!.text, /Reply mode/);
    assert.throws(() => new ThreadRuntime({ open: async () => { throw new Error('x'); }, close: async () => {} }, join(tmpdir(), `x-${randomUUID()}.json`), 'o', { replyMode: 'auto' }), /shared runtime/);
  } finally { await f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* Batching                                                            */
/* ------------------------------------------------------------------ */

test('batching: queued messages of a group conversation are sent once, together, in order, each keeping its author; withdrawal works until sent', async () => {
  const f = listeningFixture();
  try {
    const thread = randomUUID();
    await f.runtime.create('team', thread, 'Plans', mia);
    // Two people, so the conversation is a group (agent decides) and batching applies.
    const warm = turn(thread, 'hello'); await f.runtime.start('team', warm, otto); await until(() => status(f.runtime, warm.id) === 'completed');
    const hold = turn(thread, 'hold please'); await f.runtime.start('team', hold, mia);
    await until(() => f.gates.size === 1, 'hold running');
    const a = turn(thread, 'Lunch at noon?'), b = turn(thread, 'Or 1pm?'), c = turn(thread, 'Never mind this one'), d = turn(thread, 'Pizza!');
    for (const [run, who] of [[a, mia], [b, otto], [c, mia], [d, otto]] as const) assert.equal((await f.runtime.start('team', run, who)).status, 'queued');
    // Withdraw one before the batch is sent; it is never delivered.
    f.runtime.cancel('team', c.id);
    assert.equal(status(f.runtime, c.id), 'cancelled');
    const before = f.sent.length;
    f.release(f.runtime['state'].threads.find((t: { id: string }) => t.id === thread)!.conversationId!);
    await until(() => [a, b, d].every(r => status(f.runtime, r.id) === 'completed'), 'batch completed');
    // Exactly one more send, with the three remaining messages in order and their authors.
    assert.equal(f.sent.length, before + 1, 'exactly one combined turn after the held one');
    const combined = f.sent.at(-1)!;
    assert.equal(combined.otid, a.id, 'the turn carries the first message\'s ID');
    assert.match(combined.text, /These 3 messages were sent while you were busy[\s\S]*They are from Mia \(mia@example.com\), Otto \(otto@example.com\)\./);
    assert.ok(combined.text.endsWith('[Mia] Lunch at noon?\n\n[Otto] Or 1pm?\n\n[Otto] Pizza!'), combined.text);
    assert.doesNotMatch(combined.text, /Never mind/);
    // Runs: one turn, three messages; the others point at the first.
    const runs = f.runtime['state'].runs as { id: string; batch?: string[]; batchOf?: string; status: string }[];
    assert.deepEqual(runs.find(r => r.id === a.id)!.batch, [a.id, b.id, d.id]);
    assert.equal(runs.find(r => r.id === b.id)!.batchOf, a.id);
    // History shows each message as its own bubble with its author, then one reply.
    const view = await f.runtime.view('team', thread) as { messages: UIMessage[] };
    const tail = view.messages.slice(-4).map(m => [m.role, m.role === 'user' ? (m.metadata as { author?: RunAuthor }).author?.name : '', m.parts.map(p => p.type === 'text' ? p.text : '').join('')]);
    assert.deepEqual(tail, [['user', 'Mia', 'Lunch at noon?'], ['user', 'Otto', 'Or 1pm?'], ['user', 'Otto', 'Pizza!'], ['assistant', '', 'Reply']]);
    // Nothing is ever replayed: a restart keeps the delivered batch and sends nothing.
    const sentBefore = f.sent.length;
    await f.runtime.close();
    const reopened = new ThreadRuntime({ parallel: true, open: async () => { throw new Error('must not open'); }, close: async () => {} }, f.filename, 'team', { queue: true, parallel: true, replyMode: 'auto' });
    assert.equal(reopened.events('team', b.id, 0).status, 'completed');
    assert.equal(f.sent.length, sentBefore);
    await reopened.close();
  } finally { try { await f.cleanup(); } catch { /* already closed */ } }
});

test('batching: solo conversations, and messages with images, are sent one per turn; withdrawing a message being sent is refused', async () => {
  const f = listeningFixture();
  try {
    const thread = randomUUID();
    await f.runtime.create('team', thread, 'Solo', mia);
    const hold = turn(thread, 'hold'); await f.runtime.start('team', hold, mia);
    await until(() => f.gates.size === 1);
    const a = turn(thread, 'one'), b = turn(thread, 'two');
    await f.runtime.start('team', a, mia); await f.runtime.start('team', b, mia);
    f.release(conversationOf(f, thread));
    await until(() => status(f.runtime, b.id) === 'completed');
    assert.deepEqual(f.sent.map(s => s.text.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\n/, '')), ['hold', 'one', 'two'], 'one turn per message when one person writes');
    // A group conversation where the next message has an image: it is sent on its own.
    const group = randomUUID();
    await f.runtime.create('team', group, 'Group', mia);
    const w = turn(group, 'hello'); await f.runtime.start('team', w, otto); await until(() => status(f.runtime, w.id) === 'completed');
    const h = turn(group, 'hold'); await f.runtime.start('team', h, mia); await until(() => f.gates.size === 1);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
    const x = turn(group, 'text first'), y = { ...turn(group, 'look'), images: [{ mediaType: 'image/png', data: png }] }, z = turn(group, 'after');
    await f.runtime.start('team', x, mia); await f.runtime.start('team', y, otto); await f.runtime.start('team', z, mia);
    const sentBefore = f.sent.length;
    f.release(conversationOf(f, group));
    await until(() => [x, y, z].every(r => status(f.runtime, r.id) === 'completed'), 'image batch');
    assert.equal(f.sent.length, sentBefore + 3, 'held turn, x alone (an image follows), y alone; z alone');
    // Withdrawing a message that is already part of a turn being sent is refused (and never leaves it half-sent).
    f.runtime['sending'].add(z.id);
    const fake = f.runtime['state'].runs.find((r: { id: string }) => r.id === z.id)!; const saved = fake.status; fake.status = 'queued';
    assert.throws(() => f.runtime.cancel('team', z.id), (e: unknown) => e instanceof RuntimeFault && e.code === 'already_sent');
    fake.status = saved; f.runtime['sending'].delete(z.id);
  } finally { await f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* Listened turns                                                      */
/* ------------------------------------------------------------------ */

test('a listened turn completes with a "listened" event and its reasoning, and shows no reply', async () => {
  const f = listeningFixture();
  try {
    const thread = randomUUID();
    await f.runtime.create('team', thread, 'Chat', mia);
    const w = turn(thread, 'hello'); await f.runtime.start('team', w, otto); await until(() => status(f.runtime, w.id) === 'completed');
    const chat = turn(thread, 'chat: Otto, lunch?');
    await f.runtime.start('team', chat, mia);
    await until(() => status(f.runtime, chat.id) === 'completed');
    const events = f.runtime.events('team', chat.id, 0).events;
    assert.deepEqual(events.map(e => e.type), ['started', 'reasoning', 'listened', 'completed']);
    assert.deepEqual(events.find(e => e.type === 'listened')!.data, { reason: 'Not for me.' });
    assert.ok(!events.some(e => e.type === 'text' && String(e.data.text).trim()), 'no reply text');
    const run = f.runtime['state'].runs.find((r: { id: string }) => r.id === chat.id)!;
    assert.equal(run.listened, true); assert.equal(run.replyMode, 'agent-decides');
    // The live display (before history reloads) is a listened marker with the reasoning, never a reply bubble.
    const lane = [...f.runtime['lanes'].values()].find((l: { current?: { conversationId: string } }) => l.current?.conversationId === conversationOf(f, thread))!;
    const last = lane.current!.history.at(-1)!;
    assert.deepEqual(last.parts.map(p => p.type), ['reasoning', 'data-listened']);
    // Ending without a word (after a tool) in a turn that may be silent is listened too, live and in reloaded history.
    const wordless = turn(thread, 'wordless: count this');
    await f.runtime.start('team', wordless, mia);
    await until(() => status(f.runtime, wordless.id) === 'completed');
    assert.ok(f.runtime.events('team', wordless.id, 0).events.some(e => e.type === 'listened'));
    const history = await f.runtime.history('team', thread);
    const after = history.messages.slice(history.messages.findIndex(m => (m.metadata as { otid?: string } | undefined)?.otid === wordless.id) + 1);
    assert.deepEqual(after[0]!.parts.map(p => p.type), ['dynamic-tool', 'data-listened']);
    // A stay_silent result for another call is a protocol error: the turn fails closed (never guessed as listened).
    const odd = turn(thread, 'chat: mismatch');
    await f.runtime.start('team', odd, otto);
    await until(() => !['running', 'queued'].includes(status(f.runtime, odd.id)));
    assert.equal(status(f.runtime, odd.id), 'failed');
  } finally { await f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* Typing presence                                                     */
/* ------------------------------------------------------------------ */

test('typing presence: expires after the last signal, ends on stop or send, wakes /v1/changes, and only accepts { typing }', async () => {
  const f = listeningFixture({ typingMs: 80 });
  try {
    const thread = randomUUID();
    await f.runtime.create('team', thread, 'Typing', mia);
    const typing = () => (f.runtime.list('team')[0] as { typing?: { id: string; name: string }[] }).typing?.map(p => p.name) ?? [];
    let version = f.runtime.version;
    f.runtime.typing('team', thread, mia, { typing: true });
    assert.deepEqual(typing(), ['Mia']); assert.ok(f.runtime.version > version, 'starting to type is a change');
    f.runtime.typing('team', thread, otto, { typing: true });
    assert.deepEqual(typing(), ['Mia', 'Otto']);
    // A heartbeat is not a change (no wake-ups while someone types).
    version = f.runtime.version; f.runtime.typing('team', thread, mia, { typing: true }); assert.equal(f.runtime.version, version);
    // Stopping: immediate.
    f.runtime.typing('team', thread, otto, { typing: false }); assert.deepEqual(typing(), ['Mia']);
    // Expiry: gone shortly after the last heartbeat, and everyone waiting is woken.
    version = f.runtime.version;
    const woke = f.runtime.waitForChange(version, 2000);
    assert.ok(await woke > version); assert.deepEqual(typing(), []);
    // Sending a message ends your typing.
    f.runtime.typing('team', thread, otto, { typing: true });
    const run = turn(thread, 'hello'); await f.runtime.start('team', run, otto);
    assert.deepEqual(typing(), []);
    // Never text: anything but exactly { typing: boolean } is refused, and nothing is stored or sent to the agent.
    for (const body of [{ typing: true, text: 'my draft' }, { draft: 'x' }, { typing: 'yes' }, [], null]) assert.throws(() => f.runtime.typing('team', thread, mia, body), (e: unknown) => e instanceof RuntimeFault && e.code === 'invalid_input');
    await until(() => status(f.runtime, run.id) === 'completed');
    const state = readFileSync(f.filename, 'utf8');
    assert.doesNotMatch(state, /typing|my draft/);
    assert.ok(f.sent.every(s => !/typing/i.test(s.text)), 'the agent never hears about typing');
    // No author (single-user) → not available.
    assert.throws(() => f.runtime.typing('team', thread, undefined, { typing: true }), (e: unknown) => e instanceof RuntimeFault && e.code === 'not_found');
  } finally { await f.cleanup(); }
});

test('batching race: a message queued while the batch is being sent waits for the next turn (exactly once, nothing lost)', async () => {
  const f = listeningFixture();
  try {
    const thread = randomUUID();
    await f.runtime.create('team', thread, 'Race', mia);
    const w = turn(thread, 'hello'); await f.runtime.start('team', w, otto); await until(() => status(f.runtime, w.id) === 'completed');
    const hold = turn(thread, 'hold'); await f.runtime.start('team', hold, mia); await until(() => f.gates.size === 1);
    const a = turn(thread, 'first hold'), b = turn(thread, 'second');
    await f.runtime.start('team', a, mia); await f.runtime.start('team', b, otto);
    f.release(conversationOf(f, thread));
    // The batch (a, b) is running and holding; a late message must not join it.
    await until(() => f.gates.size === 1 && status(f.runtime, a.id) === 'running', 'batch running');
    assert.equal(status(f.runtime, b.id), 'running', 'b was sent with a');
    const late = turn(thread, 'late one'); await f.runtime.start('team', late, mia);
    assert.equal(status(f.runtime, late.id), 'queued');
    f.release(conversationOf(f, thread));
    await until(() => status(f.runtime, late.id) === 'completed');
    const texts = f.sent.map(s => s.text.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\n/, ''));
    assert.deepEqual(texts.slice(-3), ['hold', '[Mia] first hold\n\n[Otto] second', 'late one']);
    assert.equal(texts.filter(t => t.includes('second')).length, 1, 'b delivered exactly once');
  } finally { await f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

test('team HTTP: typing route (members only, presence only), reply mode PATCH, capabilities and agent replyMode in the session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-listen-http-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const directory = new TeamDirectory(join(dir, 'team', 'team.json'), ['owner@example.com']);
  directory.bootstrap(['desk']);
  const f = listeningFixture();
  const agents = new Map<string, TeamAgent>([['desk', { info: { id: 'desk', name: 'Desk', replyMode: 'auto' }, runtime: f.runtime }]]);
  const server = teamApp({ port: 0, assets, agents, directory, origins: ['https://m.example.ts.net'] }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const raw = (method: string, path: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; json(): unknown }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${address.port}${path}`, { method, headers }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, json: () => JSON.parse(text) })); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  const owner = { host: 'm.example.ts.net', 'tailscale-user-login': 'owner@example.com', 'tailscale-user-name': 'Olivia' };
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { ...owner };
    if (method !== 'GET') { headers.origin = 'https://m.example.ts.net'; headers['x-csrf-token'] = ((await raw('GET', '/api/session', owner)).json() as { csrf: string }).csrf; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    return raw(method, path, headers, body === undefined ? undefined : JSON.stringify(body));
  };
  try {
    const session = (await call('GET', '/api/session')).json() as { agents: { replyMode?: string }[] };
    assert.equal(session.agents[0]!.replyMode, 'auto');
    assert.deepEqual(((await call('GET', '/api/agents/desk/v1/capabilities')).json() as { replyModes: unknown }).replyModes, { agent: 'auto', batching: true });
    const thread = randomUUID();
    assert.equal((await call('POST', '/api/agents/desk/v1/threads', { id: thread, title: 'T' })).status, 201);
    assert.equal((await call('POST', `/api/agents/desk/v1/threads/${thread}/typing`, { typing: true })).status, 200);
    const listed = (await call('GET', '/api/agents/desk/v1/threads')).json() as { typing?: { name: string }[]; replyModeInEffect: string }[];
    assert.deepEqual(listed[0]!.typing?.map(p => p.name), ['Olivia']); assert.equal(listed[0]!.replyModeInEffect, 'always');
    assert.equal((await call('POST', `/api/agents/desk/v1/threads/${thread}/typing`, { typing: true, text: 'secret draft' })).status, 400);
    assert.equal((await call('PATCH', `/api/agents/desk/v1/threads/${thread}`, { replyMode: 'when-addressed' })).status, 200);
    assert.equal((await call('PATCH', `/api/agents/desk/v1/threads/${thread}`, { replyMode: 'never' })).status, 400);
    // Typing needs the CSRF token like any mutation.
    assert.equal((await raw('POST', `/api/agents/desk/v1/threads/${thread}/typing`, { ...owner, origin: 'https://m.example.ts.net', 'content-type': 'application/json' }, '{"typing":true}')).status, 403);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await f.cleanup(); rmSync(dir, { recursive: true, force: true });
  }
});
