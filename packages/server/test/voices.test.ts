import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { LettaAgent, ToolInteractions, projectHistory, REFLECTION_PART, type InnerVoice } from 'ai-sdk-letta';
import { ThreadRuntime, turnStep, DefinitionVoices, checkVoiceSettings, voiceCounsellor, counselRequest, runReply, DEFAULT_VOICES, type RuntimeHost, type VoiceSettings } from '../src/index.js';
import type { RunCounsel } from '../src/runtime.js';

/**
 * A runtime over a scripted agent that replies "Got: <first line>", recording what was sent (with reminders).
 * Its backend keeps Letta-like records (with OTIDs), projected for display as the real host does. The reflection
 * step (its prompt is the hidden reminder) answers `f.reflection(prompt)`: KEEP or a revision; `f.reflectWait`
 * makes it wait until stopped.
 */
function fixture(directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-voices-'))) {
  const sent: string[] = [];
  const rows = new Map<string, Record<string, unknown>[]>();
  const state = { reflection: (_prompt: string): string => 'KEEP', reflectWait: false, reflectTool: false };
  const host: RuntimeHost = {
    async close() {},
    async open(target) {
      const conversationId = 'conversationId' in target ? target.conversationId : `conv-${randomUUID()}`;
      const records = rows.get(conversationId) ?? []; rows.set(conversationId, records);
      const add = (row: Record<string, unknown>) => records.push({ id: `message-${randomUUID()}`, date: new Date().toISOString(), ...row });
      let input = '';
      let reflecting = false;
      let stop: (() => void) | undefined;
      const agent = new LettaAgent({ id: 'fixture', tools: {}, lettaAgentId: 'agent-v', interactions: new ToolInteractions(),
        open: () => ({
          async send(message: SendMessage, options?: { otid?: string }) {
            const full = typeof message === 'string' ? message : message.map(item => item.type === 'text' ? item.text : '').join('');
            reflecting = !!options?.otid?.endsWith(':reflect');
            input = reflecting ? full : full.replace(/^(<system-reminder>[\s\S]*?<\/system-reminder>\n)+/, '');
            sent.push(full);
            add({ message_type: 'user_message', content: full, ...(options?.otid ? { otid: options.otid } : {}) });
          },
          async abort() { stop?.(); }, close() {},
          async *stream() {
            if (input.startsWith('FAIL')) throw new Error('boom');
            if (input.startsWith('SILENT')) { yield { type: 'result', success: true, uuid: 'r2', durationMs: 1, conversationId } as SDKMessage; return; }
            if (reflecting && state.reflectWait) {
              // Letta confirms the stop (as the harness does after abort).
              await new Promise<void>(resolve => { stop = resolve; });
              yield { type: 'result', success: false, errorCode: 'interrupted', uuid: 'r3', durationMs: 1, conversationId } as SDKMessage; return;
            }
            const reply = reflecting ? state.reflection(input) : `Got: ${input.split('\n')[0]!.slice(0, 80)}. Plan: play 2 more games.`;
            yield { type: 'assistant', content: reply, uuid: 'r1' } as SDKMessage;
            add({ message_type: 'assistant_message', content: reply });
            yield { type: 'result', success: true, uuid: 'r2', durationMs: 1, conversationId } as SDKMessage;
          },
        }) });
      return { agent, agentId: 'agent-v', conversationId, history: projectHistory(structuredClone(records) as never, []) };
    },
  };
  const runtime = new ThreadRuntime(host, join(directory, 'state.json'), 'owner');
  return { directory, runtime, sent, state, rows };
}
async function until(fn: () => boolean, label = 'condition', ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error(`deadline: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const lastRun = new Map<string, string>();
async function turn(f: ReturnType<typeof fixture>, threadId: string, text: string) {
  const id = randomUUID();
  await f.runtime.start('owner', { id, threadId, text, parentRunId: lastRun.get(threadId) ?? null });
  lastRun.set(threadId, id);
  await until(() => !f.runtime.busy, 'turn ended');
  return id;
}
const on: VoiceSettings = { ambition: { enabled: true, model: 'auto' }, prudence: { enabled: true, model: 'auto' } };

test('voice settings are validated; a voice left out keeps its setting', () => {
  assert.deepEqual(checkVoiceSettings({ ambition: { enabled: true, model: 'auto' } }), { ambition: { enabled: true, model: 'auto' }, prudence: { enabled: false, model: 'auto' } });
  assert.deepEqual(checkVoiceSettings({ prudence: { enabled: true, model: 'anthropic/claude-sonnet-5' } }, on).prudence, { enabled: true, model: 'anthropic/claude-sonnet-5' });
  for (const bad of [null, [], { courage: { enabled: true } }, { ambition: { enabled: 'yes' } }, { ambition: { enabled: true, model: '../etc' } }, { ambition: { enabled: true, model: 'auto', extra: 1 } }, { ambition: true }]) {
    assert.throws(() => checkVoiceSettings(bad), (error: Error & { code?: string }) => error.code === 'invalid_input', JSON.stringify(bad));
  }
});

test('the app\'s own agent keeps its voice settings in a private file, off by default', () => {
  const state = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-voices-state-'));
  const changes: VoiceSettings[] = [];
  const voices = new DefinitionVoices('my-agent', state, settings => changes.push(settings));
  assert.deepEqual(voices.get(), DEFAULT_VOICES);
  voices.set({ ambition: { enabled: true, model: 'auto' } });
  assert.equal(statSync(voices.file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(voices.file, 'utf8')).voices.ambition, { enabled: true, model: 'auto' });
  assert.deepEqual(new DefinitionVoices('my-agent', state).get().ambition, { enabled: true, model: 'auto' });
  assert.equal(changes.length, 1);
  assert.throws(() => voices.set({ ambition: { enabled: 1 } }));
});

test('the counsellor picks another family for auto and runs only the voices that are on', async () => {
  const asked: string[] = [];
  let settings: VoiceSettings = { ...DEFAULT_VOICES, prudence: { enabled: true, model: 'auto' } };
  const counsellor = voiceCounsellor({ settings: () => settings, agentModel: () => 'openai-codex/gpt-5.5', directory: '/tmp/unused',
    available: async () => ['openai-codex/gpt-5.5', 'anthropic/claude-sonnet-5'],
    voice: (name, model) => async () => { asked.push(`${name}:${model}`); return { points: [`${name} point`], confidence: 'medium', model }; } });
  assert.deepEqual(counsellor.enabled(), ['prudence']);
  const notes = await counsellor.ask({ goal: 'g', reply: 'r' });
  assert.deepEqual(asked, ['prudence:anthropic/claude-sonnet-5']);
  assert.deepEqual(Object.keys(notes), ['prudence']);
  settings = DEFAULT_VOICES;
  await assert.rejects(counsellor.ask({ goal: 'g', reply: 'r' }), /voices_off/);
});

test('the counsel request is bounded and includes tool results', () => {
  const run = { id: 'r', threadId: 't', input: 'x'.repeat(10_000), parentRunId: null, status: 'completed' as const, events: [
    { sequence: 1, type: 'text', data: { text: 'y'.repeat(20_000) } },
    { sequence: 2, type: 'tool_completed', data: { name: 'Bash', output: 'games: 2\nwins: 1' } },
    { sequence: 3, type: 'tool_failed', data: { name: 'Read', reason: 'missing' } },
  ] };
  const request = counselRequest(run);
  assert.equal(request.goal.length, 4000);
  assert.equal(request.reply.length, 8000);
  assert.equal(request.toolResults, '- Bash: games: 2 wins: 1\n- Read: failed: missing');
});

/* ---------------- in-turn reflection ---------------- */

/** Voices that count their calls; `delay` (ms) before each answer; `fail`: these voices throw. */
function counting(f: ReturnType<typeof fixture>, settings: () => VoiceSettings, options: { delay?: () => number; fail?: () => string[] } = {}) {
  const asked: string[] = [];
  const voice = (name: string): InnerVoice => async request => {
    asked.push(`${name}:${request.goal}:${request.reply}`);
    await new Promise(resolve => setTimeout(resolve, options.delay?.() ?? 0));
    if (options.fail?.().includes(name)) throw new Error('voice_failed');
    return { points: [`${name} on ${request.goal.slice(0, 20)}`], confidence: 'medium' };
  };
  f.runtime.voices = voiceCounsellor({ settings, agentModel: () => 'openai-codex/gpt-5.5', directory: f.directory, available: async () => [], voice: name => voice(name) });
  return asked;
}
const runOf = (f: ReturnType<typeof fixture>, id: string) => f.runtime['run']('owner', id) as unknown as { status: string; events: { type: string; data: Record<string, unknown> }[]; counsel?: RunCounsel };
type ViewMessage = { role: string; parts: { type: string; text?: string; data?: { otid?: string; outcome?: string } }[]; metadata?: { otid?: string } };
async function viewOf(f: ReturnType<typeof fixture>, threadId: string) { return await f.runtime.view('owner', threadId) as unknown as { messages: ViewMessage[]; counsels?: Record<string, RunCounsel> }; }
const userTexts = (messages: ViewMessage[]) => messages.filter(m => m.role === 'user').map(m => m.parts.map(p => p.text ?? '').join(''));

test('kept: the voices review the draft, the agent answers KEEP in a second step, and the draft is the final reply', async () => {
  const f = fixture();
  const asked = counting(f, () => on);
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Kept');
  const id = await turn(f, threadId, 'Plan my chess bot ELO measurement');
  const run = runOf(f, id);
  assert.equal(run.status, 'completed');
  assert.equal(asked.length, 2, 'both voices, once each');
  assert.ok(asked.every(a => a.endsWith('Got: Plan my chess bot ELO measurement. Plan: play 2 more games.')), 'they read the draft');
  assert.equal(run.counsel?.outcome, 'kept');
  assert.equal(run.counsel?.draft, undefined);
  assert.deepEqual(Object.keys(run.counsel!.notes).sort(), ['ambition', 'prudence']);
  assert.deepEqual(run.events.filter(e => e.type === 'reflecting').map(e => e.data.phase), ['review', 'reflect']);
  // The activity step while reviewing and reflecting reads "Reflecting".
  const upTo = (type: string) => ({ events: run.events.slice(0, run.events.findIndex(e => e.type === type) + 1) as never });
  assert.equal(turnStep(upTo('reflecting')), 'reflecting');
  assert.equal(turnStep({ events: [{ sequence: 1, type: 'text', data: { text: 'x', phase: 'reflection' } }] }), 'reflecting');
  assert.equal(runReply(run as never), 'Got: Plan my chess bot ELO measurement. Plan: play 2 more games.');
  // The hidden prompt: one more message of the same conversation, a reminder only, tagged `<run>:reflect`.
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1]!, /^<system-reminder>\nYour inner voices reviewed your draft reply \(advisory; they may be wrong\):\nAmbition \(medium confidence\)[\s\S]*answer exactly KEEP\.\n<\/system-reminder>$/);
  const records = [...f.rows.values()][0]!;
  assert.equal(records.find(r => String(r.content).includes('inner voices reviewed'))?.otid, `${id}:reflect`);
  // Never a user message: live (the session's display) and rebuilt from history.
  for (const view of [await viewOf(f, threadId), await viewOf(f, threadId)]) {
    assert.deepEqual(userTexts(view.messages), ['Plan my chess bot ELO measurement']);
    const marker = view.messages.flatMap(m => m.parts).find(p => p.type === REFLECTION_PART);
    assert.equal(marker?.data?.outcome, 'kept');
    assert.equal(view.counsels?.[id]?.outcome, 'kept');
  }
  // The next turn is a normal turn: no reminder of the notes, and its own review.
  await turn(f, threadId, 'go on');
  assert.doesNotMatch(f.sent[2]!, /inner voices/);
  assert.equal(asked.length, 4);
});

test('revised: the reflection\'s text is the final reply and the draft is kept with the notes; one reflection only', async () => {
  const f = fixture();
  const asked = counting(f, () => on);
  f.state.reflection = () => 'Two games cannot give an exact ELO. Estimate: about 1600 ± 400.';
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Revised');
  const id = await turn(f, threadId, 'Give me the exact ELO of my bot from these 2 games');
  const run = runOf(f, id);
  assert.equal(run.counsel?.outcome, 'revised');
  assert.equal(run.counsel?.draft, 'Got: Give me the exact ELO of my bot from these 2 games. Plan: play 2 more games.');
  assert.equal(runReply(run as never), 'Two games cannot give an exact ELO. Estimate: about 1600 ± 400.');
  assert.equal(asked.length, 2, 'the voices never review the revision');
  assert.equal(f.sent.length, 2, 'one reflection');
  assert.ok(run.events.some(e => e.type === 'text' && e.data.phase === 'reflection'));
  const view = await viewOf(f, threadId);
  assert.deepEqual(userTexts(view.messages), ['Give me the exact ELO of my bot from these 2 games']);
  const parts = view.messages.filter(m => m.role === 'assistant').flatMap(m => m.parts);
  assert.deepEqual(parts.map(p => p.type === 'text' ? p.text : p.type), ['Got: Give me the exact ELO of my bot from these 2 games. Plan: play 2 more games.', REFLECTION_PART, 'Two games cannot give an exact ELO. Estimate: about 1600 ± 400.']);
  assert.equal(parts[1]!.data?.outcome, 'revised');
});

test('skipped: no voice answered; failed and listened drafts are not reviewed', async () => {
  const f = fixture();
  let fail: string[] = ['ambition', 'prudence'];
  const asked = counting(f, () => on, { fail: () => fail });
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Skip');
  const none = await turn(f, threadId, 'hello');
  assert.equal(runOf(f, none).status, 'completed');
  assert.equal(runOf(f, none).counsel?.outcome, 'skipped');
  assert.equal(runOf(f, none).counsel?.reason, 'no_notes');
  assert.equal(f.sent.length, 1, 'no reflection step');
  // One voice failing: the other's note is enough.
  fail = ['prudence'];
  const one = await turn(f, threadId, 'again');
  assert.equal(runOf(f, one).counsel?.outcome, 'kept');
  assert.doesNotMatch(f.sent.at(-1)!, /Prudence \(/);
  assert.match(f.sent.at(-1)!, /Ambition \(/);
  const before = asked.length;
  await turn(f, threadId, 'SILENT please');
  const failed = await turn(f, threadId, 'FAIL now');
  assert.equal(asked.length, before, 'reply-less and failed turns are not reviewed');
  assert.equal(runOf(f, failed).counsel, undefined);
});

test('voices off, and "only long turns": a quick reply without tools is not reviewed', async () => {
  const f = fixture();
  let settings: VoiceSettings = DEFAULT_VOICES;
  const asked = counting(f, () => settings);
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Long');
  await turn(f, threadId, 'while off');
  settings = { ...on, speakAfter: 'long' };
  const quick = await turn(f, threadId, 'quick question');
  assert.equal(asked.length, 0);
  assert.equal(runOf(f, quick).counsel, undefined);
  assert.equal(f.sent.length, 2);
  assert.equal(checkVoiceSettings({ speakAfter: 'long' }).speakAfter, 'long');
  assert.throws(() => checkVoiceSettings({ speakAfter: 'sometimes' }), /invalid_input/);
});

test('Stop while the voices review or while the agent reflects keeps the draft as the final reply', async () => {
  const f = fixture();
  counting(f, () => on, { delay: () => 400 });
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Stop');
  // During the review.
  let id = randomUUID();
  await f.runtime.start('owner', { id, threadId, text: 'first', parentRunId: null });
  await until(() => runOf(f, id).events.some(e => e.type === 'reflecting'), 'reviewing');
  f.runtime.cancel('owner', id);
  await until(() => !f.runtime.busy, 'turn ended');
  assert.equal(runOf(f, id).status, 'completed');
  assert.equal(runOf(f, id).counsel?.outcome, 'skipped');
  assert.equal(runOf(f, id).counsel?.reason, 'stopped');
  assert.equal(runReply(runOf(f, id) as never), 'Got: first. Plan: play 2 more games.');
  // During the reflection.
  f.state.reflectWait = true;
  const parent = id; id = randomUUID();
  await f.runtime.start('owner', { id, threadId, text: 'second', parentRunId: parent });
  await until(() => runOf(f, id).events.some(e => e.type === 'reflecting' && e.data.phase === 'reflect'), 'reflecting');
  await new Promise(resolve => setTimeout(resolve, 50));
  f.runtime.cancel('owner', id);
  await until(() => !f.runtime.busy, 'turn ended');
  assert.equal(runOf(f, id).status, 'completed');
  assert.equal(runOf(f, id).counsel?.outcome, 'skipped');
  assert.equal(runReply(runOf(f, id) as never), 'Got: second. Plan: play 2 more games.');
  // The conversation stays usable.
  f.state.reflectWait = false;
  const next = randomUUID();
  await f.runtime.start('owner', { id: next, threadId, text: 'third', parentRunId: id });
  await until(() => !f.runtime.busy, 'turn ended');
  assert.equal(runOf(f, next).status, 'completed');
});
