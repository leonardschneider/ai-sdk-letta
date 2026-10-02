import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { tool, jsonSchema } from 'ai';
import { LettaAgent, ToolInteractions, createToolBridge, decisionTools, DECISIONS_CONTEXT, DECISION_TOOL_PERMISSIONS } from 'ai-sdk-letta';
import {
  AutomationService, AutomationStore, automationApp, createToken, DecisionBoard, guiApp, teamApp, TeamDirectory, ThreadRuntime,
  type AutomationAgent, type RuntimeHost, type RunAuthor, type TeamAgent,
} from '../src/index.js';

/* ------------------------------------------------------------------ */
/* Fixture: a scripted agent that calls the real decision tools         */
/* ------------------------------------------------------------------ */

const tools = {
  ...decisionTools,
  text_stats: tool({ inputSchema: jsonSchema<{ text: string }>({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }), execute: async ({ text }) => { calls.push(text); return { words: text.split(/\s+/).length }; } }),
};
const permissions = { ...DECISION_TOOL_PERMISSIONS, text_stats: 'allow' } as const;
let calls: string[] = [];
const OPTIONS = [{ id: 'md', label: 'Markdown' }, { id: 'csv', label: 'CSV table' }, { id: 'memo', label: 'One-page memo' }];

type Sent = { conversationId: string; text: string; otid?: string };
/**
 * A runtime over a scripted agent. Messages with "decide" call
 * request_decision (and "greedy" then tries another tool); "change" asks a
 * different question (superseding); "withdraw" calls cancel_decision; any
 * other message, including a decision's outcome, gets a reply.
 */
function fixture(options: { team?: boolean; directory?: string; members?: number } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'ai-sdk-letta-decisions-'));
  const conversations = new Map<string, UIMessage[]>();
  const sent: Sent[] = [];
  let runtime: ThreadRuntime | undefined;
  const host: RuntimeHost = {
    ...(options.team ? { parallel: true } : {}),
    async close() {},
    async open(target) {
      const conversationId = 'conversationId' in target ? target.conversationId : `local-conv-${randomUUID()}`;
      if (!conversations.has(conversationId)) conversations.set(conversationId, []);
      const history = conversations.get(conversationId)!;
      let paused = false;
      let input = '';
      const bridge = createToolBridge({ tools, permissions, interactions: new ToolInteractions(), paused: () => paused,
        context: () => runtime?.decisions ? { [DECISIONS_CONTEXT]: { desk: runtime.decisions.desk, conversationId, requested: () => { paused = true; } } } : {} });
      const agent = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'agent-local-decisions', interactions: new ToolInteractions(), ...(options.team ? { listening: true, name: 'Desk' } : {}),
        open: () => {
          paused = false;
          return {
            async send(message: SendMessage, sendOptions?: { otid?: string }) {
              const full = typeof message === 'string' ? message : message.map(item => item.type === 'text' ? item.text : '').join('');
              input = full.replace(/^(<system-reminder>[\s\S]*?<\/system-reminder>\n)+/, '');
              sent.push({ conversationId, text: full, ...(sendOptions?.otid ? { otid: sendOptions.otid } : {}) });
              history.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: input }], metadata: { otid: sendOptions?.otid } });
            },
            async abort() {}, close() {},
            async *stream() {
              const call = async function* (name: string, args: Record<string, unknown>) {
                const id = `call-${randomUUID()}`;
                yield { type: 'tool_call', toolCallId: id, toolName: name, toolInput: args, uuid: `${id}-a` } as SDKMessage;
                const result = await bridge.execute(name, id, args);
                yield { type: 'tool_result', toolCallId: id, content: result.content[0]!.text!, isError: result.isError, uuid: `${id}-b` } as SDKMessage;
              };
              let reply = `Done: ${input.slice(0, 60)}`;
              if (input.startsWith('[Decision]')) reply = `Resumed: ${input.split('\n')[0]}`;
              else if (input.includes('withdraw')) { yield* call('cancel_decision', {}); reply = 'Withdrawn.'; }
              else if (input.includes('decide') || input.includes('change')) {
                yield* call('request_decision', { question: input.includes('change') ? 'Which colour?' : 'Which report format?', options: OPTIONS, context: 'Three formats are possible.' });
                if (input.includes('greedy')) yield* call('text_stats', { text: 'should not run' });
                reply = 'I need you to pick a format.';
              }
              yield { type: 'assistant', content: reply, uuid: 'r1' } as SDKMessage;
              history.push({ id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: reply }] });
              yield { type: 'result', success: true, uuid: 'r2', durationMs: 1, conversationId } as SDKMessage;
            },
          };
        } });
      return { agent, agentId: 'agent-local-decisions', conversationId, history: structuredClone(history), ...(options.team ? { reload: async () => structuredClone(history), close: async () => { agent.close(); } } : {}) };
    },
  };
  const owner = options.team ? 'team' : 'owner';
  runtime = options.team
    ? new ThreadRuntime(host, join(directory, 'state.json'), owner, { queue: true, parallel: true, replyMode: 'auto', agentName: 'Desk', members: () => options.members ?? 2 })
    : new ThreadRuntime(host, join(directory, 'state.json'), owner);
  const board = new DecisionBoard(join(directory, 'decisions.json'), runtime, owner, { id: 'desk', name: 'Desk' });
  const rt = runtime;
  return { directory, runtime: rt, board, owner, sent, conversations,
    /** Start a turn and wait until it ended. */
    async turn(threadId: string, text: string, author?: RunAuthor) {
      const id = randomUUID();
      await rt.start(owner, { id, threadId, text, parentRunId: rt.latestRun(owner, threadId)?.id ?? null }, author);
      await until(() => ['completed', 'failed', 'cancelled'].includes(rt.runRecord(owner, id)?.status ?? ''), `turn ${text}`);
      return id;
    },
    async thread(title = 'Report') { const id = randomUUID(); await rt.create(owner, id, title); return id; },
    close: () => rt.close(),
    cleanup: async () => { await rt.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean | Promise<boolean>, label = 'condition') {
  for (let i = 0; i < 800; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Fixture deadline: ${label}`);
}
const mia: RunAuthor = { id: 'u-mia', login: 'mia@example.com', name: 'Mia Member' };
const olivia: RunAuthor = { id: 'u-olivia', login: 'owner@example.com', name: 'Olivia Owner' };
const outcomes = (sent: Sent[]) => sent.filter(s => s.text.includes('[Decision]'));

/* ------------------------------------------------------------------ */
/* The agent asks; the decision is kept                                */
/* ------------------------------------------------------------------ */

test('request_decision records a pending decision (0600, atomic), the turn ends with a reply, and later tools of the turn never run', async () => {
  const f = fixture();
  try {
    calls = [];
    const threadId = await f.thread();
    const runId = await f.turn(threadId, 'Write the report; decide the format first (greedy)');
    const run = f.runtime.runRecord(f.owner, runId)!;
    assert.equal(run.status, 'completed');
    assert.deepEqual(calls, [], 'text_stats was refused: the work is paused');
    assert.ok(run.events.some(e => e.type === 'tool_failed' && e.data.name === 'text_stats'));
    const [pending] = f.board.pending();
    assert.ok(pending);
    assert.equal(pending.question, 'Which report format?'); assert.equal(pending.status, 'pending');
    assert.equal(pending.threadId, threadId); assert.equal(pending.runId, runId);
    assert.deepEqual(pending.options.map(o => o.id), ['md', 'csv', 'memo']);
    assert.equal(pending.requestedBy.name, 'You', 'the single-user app acts for the local user');
    assert.equal(statSync(join(f.directory, 'decisions.json')).mode & 0o777, 0o600);
    // The thread list says a decision waits there.
    assert.equal(f.runtime.list(f.owner).find(t => t.id === threadId)?.pendingDecision, pending.id);
    // An ordinary turn while it is pending: the agent is reminded, the decision stays open.
    await f.turn(threadId, 'What are the trade-offs?');
    assert.match(f.sent.at(-1)!.text, /decision you requested is still pending.*Which report format\?.*md: Markdown/s);
    assert.equal(f.board.pending().length, 1);
  } finally { await f.cleanup(); }
});

test('decisions survive a restart: still pending and decidable; the outcome resumes the work once', async () => {
  const f = fixture();
  const threadId = await f.thread();
  await f.turn(threadId, 'Please decide a format');
  const id = f.board.pending()[0]!.id;
  await f.close();
  // Restart: a new runtime and board over the same files.
  const g = fixture({ directory: f.directory });
  try {
    g.board.resumeAll();
    assert.deepEqual(g.board.pending().map(d => d.id), [id]);
    const decided = g.board.decide(id, { id: 'local', name: 'You' }, { choice: 'csv', comment: 'Keep it short' });
    assert.equal(decided.status, 'decided'); assert.equal(decided.choice?.label, 'CSV table'); assert.equal(decided.decidedBy?.name, 'You');
    await until(() => g.board.get(id).resume?.state === 'delivered' && g.runtime.runRecord(g.owner, g.board.get(id).resume!.runId)?.status === 'completed', 'outcome delivered');
    const [outcome] = outcomes(g.sent);
    assert.match(outcome!.text, /\[Decision\] The user chose “CSV table” \(option csv\) for “Which report format\?” \(decision [0-9a-f-]+\)\.\nComment: Keep it short$/);
    assert.match(outcome!.text, /Resume the paused work now/, 'the outcome carries what to do now');
    assert.equal(outcome!.otid, decided.resume!.runId, 'the outcome turn is tagged with its run ID (shown as a compact line)');
    // Delivering again, or restarting again, never sends a second outcome.
    await g.board.deliver(id); g.board.resumeAll();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(outcomes(g.sent).length, 1);
    const view = await g.runtime.view(g.owner, threadId);
    const tagged = view.messages.find(m => (m.metadata as { decision?: { id: string } } | undefined)?.decision?.id === id);
    assert.ok(tagged, 'history marks the outcome message with its decision');
  } finally { await g.cleanup(); }
});

test('a decision decided before a restart but not yet sent is sent once after it (single-user); a delivered one never again', async () => {
  const f = fixture();
  const threadId = await f.thread();
  await f.turn(threadId, 'decide please');
  const id = f.board.pending()[0]!.id;
  // Simulate a crash right after deciding: the record says decided, nothing reached the runtime.
  const file = join(f.directory, 'decisions.json');
  await f.close();
  const state = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(state.decisions[0], { status: 'decided', choice: 'md', decidedBy: { id: 'local', name: 'You' }, decidedAt: new Date().toISOString(), resume: { runIds: [randomUUID()], state: 'pending' } });
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const g = fixture({ directory: f.directory });
  try {
    g.board.resumeAll();
    await until(() => g.board.get(id).resume?.state === 'delivered', 'sent after restart');
    await until(() => g.runtime.latestRun(g.owner, threadId)?.status === 'completed', 'outcome turn completed');
    assert.equal(outcomes(g.sent).length, 1);
    await g.close();
    const h = fixture({ directory: f.directory });
    try {
      h.board.resumeAll();
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(outcomes(h.sent).length, 0, 'delivered outcomes are never sent again');
    } finally { await h.cleanup(); }
  } catch (error) { await g.cleanup(); throw error; }
});

test('team: a queued outcome withdrawn by a restart is sent again once; the outcome is addressed to the agent and never batched', async () => {
  const f = fixture({ team: true });
  const threadId = await f.thread();
  await f.turn(threadId, 'decide the format', olivia);
  const id = f.board.pending()[0]!.id;
  const decided = f.board.decide(id, mia, { choice: 'memo' });
  assert.equal(decided.decidedBy?.name, 'Mia Member');
  await until(() => f.board.get(id).resume?.state === 'delivered', 'delivered');
  await until(() => f.runtime.latestRun(f.owner, threadId)?.status === 'completed', 'done');
  const outcome = outcomes(f.sent)[0]!;
  assert.match(outcome.text, /This turn mentions you \(Desk\): reply\./, 'the outcome is addressed to the agent in a group');
  assert.match(outcome.text, /\[Decision\] Mia Member chose “One-page memo”/);
  // The outcome is Mia's message (her name above it in the app).
  const run = f.runtime.runRecord(f.owner, decided.resume!.runId)!;
  assert.equal(run.author?.id, 'u-mia'); assert.equal(run.decision?.choice?.id, 'memo');
  await f.cleanup();

  // A restart withdraws queued turns: an outcome still queued then is sent again (once), with a new run ID.
  const g = fixture({ team: true });
  try {
    const thread2 = await g.thread();
    await g.turn(thread2, 'decide now', olivia);
    const second = g.board.pending()[0]!.id;
    const file = join(g.directory, 'state.json');
    const board = join(g.directory, 'decisions.json');
    await g.close();
    const runs = JSON.parse(readFileSync(file, 'utf8'));
    const queuedId = randomUUID();
    runs.runs.push({ id: queuedId, threadId: thread2, input: '[Decision] …', parentRunId: null, status: 'queued', events: [], decision: { id: second, outcome: 'decided', question: 'Which report format?', by: { id: 'u-mia', name: 'Mia Member' }, choice: { id: 'md', label: 'Markdown' } } });
    writeFileSync(file, JSON.stringify(runs));
    const decisions = JSON.parse(readFileSync(board, 'utf8'));
    Object.assign(decisions.decisions[0], { status: 'decided', choice: 'md', decidedBy: { id: 'u-mia', name: 'Mia Member', login: 'mia@example.com' }, decidedAt: new Date().toISOString(), resume: { runIds: [queuedId], state: 'queued' } });
    writeFileSync(board, JSON.stringify(decisions));
    const h = fixture({ team: true, directory: g.directory });
    try {
      assert.equal(h.runtime.runRecord(h.owner, queuedId)?.notSent, true, 'the restart withdrew the queued outcome');
      h.board.resumeAll();
      await until(() => h.board.get(second).resume?.state === 'delivered', 'resent');
      await until(() => h.runtime.latestRun(h.owner, thread2)?.status === 'completed', 'resent completed');
      assert.equal(outcomes(h.sent).length, 1, 'sent exactly once');
      const resume = h.board.find(second)!.resume!;
      assert.equal(resume.runIds.length, 2); assert.notEqual(resume.runIds[1], queuedId);
    } finally { await h.cleanup(); }
  } catch (error) { await g.cleanup().catch(() => {}); throw error; }
});

test('exactly once: the first decider wins; concurrent and later attempts get already_decided with who decided', async () => {
  const f = fixture({ team: true });
  try {
    const threadId = await f.thread();
    await f.turn(threadId, 'decide', olivia);
    const id = f.board.pending()[0]!.id;
    const results = await Promise.allSettled([mia, olivia].map(async who => f.board.decide(id, who, { choice: who === mia ? 'csv' : 'md' })));
    const won = results.filter(r => r.status === 'fulfilled');
    const lost = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(won.length, 1); assert.equal(lost.length, 1);
    assert.equal(lost[0]!.reason.code, 'already_decided');
    assert.equal(lost[0]!.reason.decision.decidedBy.name, 'Mia Member');
    assert.throws(() => f.board.decide(id, olivia, { stop: true }), (error: { code?: string }) => error.code === 'already_decided');
    await until(() => f.board.get(id).resume?.state === 'delivered', 'delivered');
    await until(() => f.runtime.latestRun(f.owner, threadId)?.status === 'completed', 'done');
    assert.equal(outcomes(f.sent).length, 1);
    // Invalid input is refused before anything is decided.
    await f.turn(threadId, 'decide again', olivia);
    const next = f.board.pending()[0]!.id;
    for (const bad of [{}, { choice: 'nope' }, { choice: 'md', stop: true }, { stop: false }, { choice: 'md', extra: 1 }, { choice: 'md', comment: 'x'.repeat(1001) }, null, []]) {
      assert.throws(() => f.board.decide(next, mia, bad), (error: { code?: string }) => error.code === 'invalid_input', JSON.stringify(bad));
    }
    assert.equal(f.board.get(next).status, 'pending');
  } finally { await f.cleanup(); }
});

test('"Stop this work": the agent is told to stop, and the decision reads stopped', async () => {
  const f = fixture();
  try {
    const threadId = await f.thread();
    await f.turn(threadId, 'decide the format');
    const id = f.board.pending()[0]!.id;
    const stopped = f.board.decide(id, { id: 'local', name: 'You' }, { stop: true, comment: 'Not needed any more' });
    assert.equal(stopped.status, 'stopped'); assert.equal(stopped.choice, undefined);
    await until(() => f.runtime.latestRun(f.owner, threadId)?.status === 'completed' && outcomes(f.sent).length === 1, 'stop delivered');
    const outcome = outcomes(f.sent)[0]!.text;
    assert.match(outcome, /\[Decision\] The user decided to stop this work: “Which report format\?”/);
    assert.match(outcome, /Comment: Not needed any more/);
    assert.match(outcome, /Do not continue it/);
    assert.equal(f.runtime.runRecord(f.owner, stopped.resume!.runId)?.decision?.outcome, 'stopped');
  } finally { await f.cleanup(); }
});

test('supersede, withdraw and archive: one open decision per conversation; cancelled ones cannot be decided', async () => {
  const f = fixture();
  try {
    const threadId = await f.thread();
    await f.turn(threadId, 'decide the format');
    const first = f.board.pending()[0]!.id;
    await f.turn(threadId, 'change the question');
    const [second] = f.board.pending();
    assert.equal(f.board.pending().length, 1);
    assert.equal(second!.question, 'Which colour?');
    const old = f.board.get(first);
    assert.equal(old.status, 'cancelled'); assert.equal(old.cancelReason, 'superseded'); assert.equal(old.supersededBy, second!.id);
    assert.throws(() => f.board.decide(first, { id: 'local', name: 'You' }, { choice: 'md' }), (error: { code?: string }) => error.code === 'decision_cancelled');
    // The agent withdraws it.
    await f.turn(threadId, 'withdraw it, we agreed');
    assert.equal(f.board.get(second!.id).status, 'cancelled'); assert.equal(f.board.get(second!.id).cancelReason, 'withdrawn');
    assert.equal(f.board.pending().length, 0);
    // Archiving a conversation cancels its pending decision.
    await f.turn(threadId, 'decide again');
    const third = f.board.pending()[0]!.id;
    f.runtime.updateMetadata(f.owner, threadId, { archived: true });
    assert.equal(f.board.get(third).cancelReason, 'archived');
    assert.equal(outcomes(f.sent).length, 0, 'nothing was decided, nothing sent');
  } finally { await f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* HTTP: who sees and decides                                           */
/* ------------------------------------------------------------------ */

async function teamServer() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-decisions-team-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const directory = new TeamDirectory(join(dir, 'team', 'team.json'), ['owner@example.com']);
  directory.bootstrap(['alpha', 'beta']);
  const a = fixture({ team: true }), b = fixture({ team: true });
  const agents = new Map<string, TeamAgent>([
    ['alpha', { info: { id: 'alpha', name: 'Alpha' }, runtime: a.runtime }],
    ['beta', { info: { id: 'beta', name: 'Beta' }, runtime: b.runtime }],
  ]);
  const server = teamApp({ port: 0, assets, agents, directory, origins: ['https://machine.example.ts.net'] }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const people = {
    owner: { 'tailscale-user-login': 'owner@example.com', 'tailscale-user-name': 'Olivia Owner' },
    member: { 'tailscale-user-login': 'mia@example.com', 'tailscale-user-name': 'Mia Member' },
    outsider: { 'tailscale-user-login': 'otto@example.com', 'tailscale-user-name': 'Otto Outsider' },
    beta: { 'tailscale-user-login': 'bo@example.com', 'tailscale-user-name': 'Bo Beta' },
  };
  const raw = (method: string, path: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; json(): Promise<any> }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const req = httpRequest(`${base}${path}`, { method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text) }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  const call = async (who: keyof typeof people, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { host: 'machine.example.ts.net', ...people[who] };
    if (method !== 'GET') {
      const session = await (await raw('GET', '/api/session', { ...headers })).json() as { csrf?: string };
      headers.origin = 'https://machine.example.ts.net'; headers['x-csrf-token'] = session.csrf ?? '';
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    return raw(method, path, headers, body === undefined ? undefined : JSON.stringify(body));
  };
  return { call, directory, a, b,
    cleanup: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await a.cleanup(); await b.cleanup(); rmSync(dir, { recursive: true, force: true }); } };
}

test('team HTTP: any member sees and decides (recorded with who and when); non-members get 404; the bell feed lists only your agents', async () => {
  const t = await teamServer();
  try {
    const owner = await (await t.call('owner', 'GET', '/api/session')).json() as { user: { id: string } };
    assert.equal((await t.call('owner', 'POST', '/api/agents/alpha/members', { login: 'mia@example.com', role: 'member' })).status, 201);
    const session = await (await t.call('member', 'GET', '/api/session')).json() as { agents: { id: string; decisions?: boolean }[] };
    assert.deepEqual(session.agents.map(a => [a.id, a.decisions]), [['alpha', true]]);
    // Olivia's turn asks for a decision in alpha.
    const threadId = randomUUID();
    assert.equal((await t.call('owner', 'POST', '/api/agents/alpha/v1/threads', { id: threadId, title: 'Quarterly report' })).status, 201);
    const runId = randomUUID();
    assert.equal((await t.call('owner', 'POST', '/api/agents/alpha/v1/runs', { id: runId, threadId, text: '@Desk decide the format', parentRunId: null })).status, 202);
    await until(() => t.a.board.pending().length === 1, 'requested');
    // The bell: both members see it, with the agent and the conversation; the outsider sees nothing.
    const feed = await (await t.call('member', 'GET', '/api/decisions')).json() as { version: number; decisions: { id: string; agent: { id: string; name: string }; thread: { title: string }; requestedBy: { name: string } }[] };
    assert.equal(feed.decisions.length, 1);
    assert.deepEqual([feed.decisions[0]!.agent.name, feed.decisions[0]!.thread.title, feed.decisions[0]!.requestedBy.name], ['Alpha', 'Quarterly report', 'Olivia Owner']);
    assert.equal((await (await t.call('owner', 'GET', '/api/decisions')).json() as { decisions: unknown[] }).decisions.length, 1);
    assert.deepEqual((await (await t.call('outsider', 'GET', '/api/decisions')).json() as { decisions: unknown[] }).decisions, []);
    const id = feed.decisions[0]!.id;
    // Non-members: 404 on the agent's decisions, the same as an unknown agent (someone in no agent has no CSRF token, so changes are refused even earlier, 403).
    assert.equal((await t.call('outsider', 'GET', `/api/agents/alpha/v1/decisions/${id}`)).status, 404);
    assert.equal((await t.call('outsider', 'POST', `/api/agents/alpha/v1/decisions/${id}/decide`, { choice: 'md' })).status, 403);
    // A member of another agent (beta only): 404.
    assert.equal((await t.call('owner', 'POST', '/api/agents/beta/members', { login: 'bo@example.com', role: 'member' })).status, 201);
    assert.equal((await t.call('beta', 'GET', `/api/agents/alpha/v1/decisions/${id}`)).status, 404);
    assert.equal((await t.call('beta', 'POST', `/api/agents/alpha/v1/decisions/${id}/decide`, { choice: 'md' })).status, 404);
    assert.equal((await t.call('beta', 'GET', `/api/agents/alpha/v1/decisions?thread=${threadId}`)).status, 404);
    assert.deepEqual((await (await t.call('beta', 'GET', '/api/decisions')).json() as { decisions: unknown[] }).decisions, [], 'beta\'s bell never lists alpha\'s decisions');
    assert.equal(t.a.board.get(id).status, 'pending');
    // The feed long-polls: it answers when the decision changes.
    const waiting = t.call('owner', 'GET', `/api/decisions?since=${feed.version}`);
    // Mia decides (she did not ask): anyone in the group can.
    const decided = await t.call('member', 'POST', `/api/agents/alpha/v1/decisions/${id}/decide`, { choice: 'csv', comment: 'Finance wants a table' });
    assert.equal(decided.status, 200);
    const body = await decided.json() as { status: string; decidedBy: { name: string; id: string }; decidedAt: string; comment: string };
    assert.equal(body.status, 'decided'); assert.equal(body.decidedBy.name, 'Mia Member'); assert.ok(Date.parse(body.decidedAt));
    assert.notEqual(body.decidedBy.id, owner.user.id);
    const after = await (await waiting).json() as { version: number; decisions: unknown[] };
    assert.ok(after.version > feed.version); assert.deepEqual(after.decisions, [], 'the bell clears for everyone');
    // Olivia, a moment later: already decided, by Mia.
    const late = await t.call('owner', 'POST', `/api/agents/alpha/v1/decisions/${id}/decide`, { stop: true });
    assert.equal(late.status, 409);
    const conflict = await late.json() as { error: string; decision: { decidedBy: { name: string }; choice: { id: string } } };
    assert.equal(conflict.error, 'already_decided'); assert.equal(conflict.decision.decidedBy.name, 'Mia Member'); assert.equal(conflict.decision.choice.id, 'csv');
    // The conversation's decisions (for the card), and the outcome turn in its history.
    await until(() => t.a.board.get(id).resume?.state === 'delivered', 'delivered');
    await until(() => t.a.runtime.latestRun('team', threadId)?.status === 'completed', 'resumed');
    const list = await (await t.call('member', 'GET', `/api/agents/alpha/v1/decisions?thread=${threadId}`)).json() as { decisions: { id: string; status: string }[] };
    assert.deepEqual(list.decisions.map(d => [d.id, d.status]), [[id, 'decided']]);
    const view = await (await t.call('member', 'GET', `/api/agents/alpha/v1/threads/${threadId}/view`)).json() as { messages: UIMessage[] };
    const outcome = view.messages.find(m => (m.metadata as { decision?: unknown } | undefined)?.decision);
    assert.ok(outcome);
    assert.deepEqual((outcome!.metadata as { author: { name: string } }).author.name, 'Mia Member');
    assert.equal(outcomes(t.a.sent).length, 1);
  } finally { await t.cleanup(); }
});

test('single-user HTTP: the bell feed and deciding, as the local user', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-decisions-gui-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const server: Server = guiApp(f.runtime, f.owner, 0, dir, { id: 'desk', name: 'Desk' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const sessionResponse = await fetch(`${base}/api/session`);
    const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0]!;
    const session = await sessionResponse.json() as { csrf: string; agent: { decisions?: boolean } };
    assert.equal(session.agent.decisions, true);
    const threadId = await f.thread();
    await f.turn(threadId, 'decide');
    const feed = await (await fetch(`${base}/api/decisions`, { headers: { cookie } })).json() as { decisions: { id: string; requestedBy: { name: string }; agent: { name: string } }[] };
    assert.equal(feed.decisions.length, 1); assert.equal(feed.decisions[0]!.agent.name, 'Desk');
    const id = feed.decisions[0]!.id;
    const csrfless = await fetch(`${base}/api/v1/decisions/${id}/decide`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: base }, body: JSON.stringify({ choice: 'md' }) });
    assert.equal(csrfless.status, 403, 'deciding needs the CSRF token');
    const decided = await fetch(`${base}/api/v1/decisions/${id}/decide`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: base, 'x-csrf-token': session.csrf }, body: JSON.stringify({ choice: 'md' }) });
    assert.equal(decided.status, 200);
    assert.equal((await decided.json() as { decidedBy: { name: string } }).decidedBy.name, 'You');
    await until(() => f.runtime.latestRun(f.owner, threadId)?.status === 'completed' && outcomes(f.sent).length === 1, 'resumed');
  } finally { server.closeAllConnections(); server.close(); await f.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ */
/* Automations                                                         */
/* ------------------------------------------------------------------ */

test('automation: a run that asks for a decision ends as decision_pending (not failed); the wait endpoint follows the decision to the run that resumed', async () => {
  const f = fixture();
  const store = new AutomationStore(join(f.directory, 'automation.json'));
  const agent: AutomationAgent = { id: 'desk', name: 'Desk', runtime: f.runtime, owner: f.owner, store, preApprovable: [], replyModes: false };
  const service = new AutomationService({ agents: [agent] });
  const server: Server = automationApp(service).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { secret } = createToken(store, { name: 'Weekly report', via: 'n8n' }, { actor: { id: 'local', name: 'You' }, createdBy: { id: 'local', name: 'You' }, preApprovable: [] });
  const other = createToken(store, { name: 'Other', via: 'api' }, { actor: { id: 'local', name: 'You' }, createdBy: { id: 'local', name: 'You' }, preApprovable: [] }).secret;
  const api = async (path: string, body?: unknown, token = secret) => {
    const response = await fetch(`${url}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  try {
    const started = await api('/v1/automation/runs?wait=20', { text: 'Write the weekly report; decide the format', idempotencyKey: 'week-40' });
    assert.equal(started.status, 200);
    assert.equal(started.body.status, 'decision_pending');
    assert.equal(started.body.error, undefined, 'not a failure');
    const decision = started.body.decision;
    assert.equal(decision.status, 'pending'); assert.equal(decision.question, 'Which report format?');
    assert.match(f.sent[0]!.text, /call request_decision/, 'the unattended note tells the agent it may ask for a decision');
    assert.equal(f.board.pending()[0]!.requestedBy.via, 'n8n');
    // Only this token's decisions: another token gets 404.
    assert.equal((await api(`/v1/automation/decisions/${decision.id}`, undefined, other)).status, 404);
    // Waiting: answers when someone decides in the app.
    const waiting = api(`/v1/automation/decisions/${decision.id}?wait=20`);
    await new Promise(resolve => setTimeout(resolve, 50));
    f.board.decide(decision.id, { id: 'local', name: 'You' }, { choice: 'memo' });
    const outcome = await waiting;
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.status, 'decided'); assert.equal(outcome.body.choice.id, 'memo'); assert.equal(outcome.body.decidedBy.name, 'You');
    const resumeId = outcome.body.resume.runId;
    // The resumed run: same conversation, same token, unattended, retrievable.
    const resumed = await api(`/v1/automation/runs/${resumeId}?wait=20`);
    assert.equal(resumed.body.status, 'completed');
    assert.equal(resumed.body.conversation.id, started.body.conversation.id);
    assert.deepEqual(resumed.body.resumes, { decisionId: decision.id, outcome: 'decided', choice: { id: 'memo', label: 'One-page memo' } });
    assert.match(resumed.body.text, /Resumed: \[Decision\]/);
    assert.equal((await api(`/v1/automation/runs/${resumeId}`, undefined, other)).status, 404);
    const record = f.runtime.runRecord(f.owner, resumeId)!;
    assert.equal(record.source?.via, 'n8n'); assert.ok(record.unattended, 'the resumed work is unattended like the run that asked');
    // The first run now shows the decision as decided, and its status completed.
    const first = await api(`/v1/automation/runs/${started.body.id}`);
    assert.equal(first.body.status, 'completed'); assert.equal(first.body.decision.status, 'decided'); assert.equal(first.body.decision.resume.runId, resumeId);
    // Retrying the same idempotency key returns the same run, never a second decision.
    assert.equal((await api('/v1/automation/runs', { text: 'Write the weekly report; decide the format', idempotencyKey: 'week-40' })).body.id, started.body.id);
    assert.equal(outcomes(f.sent).length, 1);
  } finally { service.close(); server.closeAllConnections(); server.close(); await f.cleanup(); }
});
