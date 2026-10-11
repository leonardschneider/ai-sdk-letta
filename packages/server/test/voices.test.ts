import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { LettaAgent, ToolInteractions, type InnerVoice } from 'ai-sdk-letta';
import { ThreadRuntime, DefinitionVoices, checkVoiceSettings, voiceCounsellor, counselRequest, DEFAULT_VOICES, type RuntimeHost, type VoiceSettings } from '../src/index.js';
import type { RunCounsel } from '../src/runtime.js';

/** A runtime over a scripted agent that replies "Got: <first line>", recording what was sent (with reminders). */
function fixture(directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-voices-'))) {
  const sent: string[] = [];
  const histories = new Map<string, UIMessage[]>();
  const host: RuntimeHost = {
    async close() {},
    async open(target) {
      const conversationId = 'conversationId' in target ? target.conversationId : `conv-${randomUUID()}`;
      const history = histories.get(conversationId) ?? []; histories.set(conversationId, history);
      let input = '';
      const agent = new LettaAgent({ id: 'fixture', tools: {}, lettaAgentId: 'agent-v', interactions: new ToolInteractions(),
        open: () => ({
          async send(message: SendMessage, options?: { otid?: string }) {
            const full = typeof message === 'string' ? message : message.map(item => item.type === 'text' ? item.text : '').join('');
            input = full.replace(/^(<system-reminder>[\s\S]*?<\/system-reminder>\n)+/, '');
            sent.push(full);
            history.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: input }], metadata: { otid: options?.otid } });
          },
          async abort() {}, close() {},
          async *stream() {
            if (input.startsWith('FAIL')) throw new Error('boom');
            if (input.startsWith('SILENT')) { yield { type: 'result', success: true, uuid: 'r2', durationMs: 1, conversationId } as SDKMessage; return; }
            const reply = `Got: ${input.split('\n')[0]!.slice(0, 80)}. Plan: play 2 more games.`;
            yield { type: 'assistant', content: reply, uuid: 'r1' } as SDKMessage;
            history.push({ id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: reply }] });
            yield { type: 'result', success: true, uuid: 'r2', durationMs: 1, conversationId } as SDKMessage;
          },
        }) });
      return { agent, agentId: 'agent-v', conversationId, history: structuredClone(history) };
    },
  };
  const runtime = new ThreadRuntime(host, join(directory, 'state.json'), 'owner');
  return { directory, runtime, sent };
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

test('notes are stored with the run, shown in the view, and go to the agent once in its next turn', async () => {
  const f = fixture();
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Chess');
  const first = await turn(f, threadId, 'I want to measure my chess bot ELO; I played 2 games, what next?');
  await assert.rejects(f.runtime.counsel('owner', threadId, first), /voices_off/);
  const ambition: InnerVoice = async request => { assert.match(request.goal, /chess bot ELO/); assert.match(request.reply, /Plan: play 2 more games/); return { points: ['Aim for a published rating.'], confidence: 'high', suggestion: 'Set up a gauntlet vs Stockfish levels.' }; };
  const prudence: InnerVoice = async () => { throw new Error('voice_timeout'); };
  f.runtime.voices = voiceCounsellor({ settings: () => on, agentModel: () => 'openai-codex/gpt-5.5', directory: f.directory, available: async () => [], voice: name => name === 'ambition' ? ambition : prudence });
  await assert.rejects(f.runtime.counsel('owner', randomUUID(), first), /not_found/);
  const result = await f.runtime.counsel('owner', threadId, first);
  assert.equal(result.runId, first);
  assert.deepEqual(result.counsel.notes.ambition, { points: ['Aim for a published rating.'], confidence: 'high', suggestion: 'Set up a gauntlet vs Stockfish levels.' });
  assert.deepEqual(result.counsel.notes.prudence, { error: 'voice_timeout' });
  // Persisted with the run, and in the thread's view.
  const stored = JSON.parse(readFileSync(join(f.directory, 'state.json'), 'utf8')) as { runs: { id: string; counsel?: unknown }[] };
  assert.ok(stored.runs.find(r => r.id === first)?.counsel);
  const view = await f.runtime.view('owner', threadId) as { counsels?: Record<string, unknown> };
  assert.ok(view.counsels?.[first]);
  // Next turn: once, as a reminder.
  const second = await turn(f, threadId, 'ok, what now?');
  assert.match(f.sent.at(-1)!, /<system-reminder>[\s\S]*Your inner voices weighed in[\s\S]*advisory notes; you decide[\s\S]*Ambition \(high confidence\): Aim for a published rating\./);
  assert.doesNotMatch(f.sent.at(-1)!, /Prudence \(/);
  const delivered = (await f.runtime.view('owner', threadId) as { counsels: Record<string, { delivered?: string }> }).counsels[first]!;
  assert.equal(delivered.delivered, second);
  await turn(f, threadId, 'and then?');
  assert.doesNotMatch(f.sent.at(-1)!, /inner voices/);
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

/* ---------------- automatic counsel ---------------- */

/** Voices that count their calls; `delay` (ms) before each answer. */
function counting(f: ReturnType<typeof fixture>, settings: () => VoiceSettings, delay = () => 0) {
  const asked: string[] = [];
  const voice = (name: string): InnerVoice => async request => {
    asked.push(`${name}:${request.goal}`);
    await new Promise(resolve => setTimeout(resolve, delay()));
    return { points: [`${name} on ${request.goal.slice(0, 20)}`], confidence: 'medium' };
  };
  f.runtime.voices = voiceCounsellor({ settings, agentModel: () => 'openai-codex/gpt-5.5', directory: f.directory, available: async () => [], voice: name => voice(name) });
  return asked;
}
const counselsOf = (f: ReturnType<typeof fixture>, threadId: string) => f.runtime.threadCounsels('owner', threadId);
async function settled(f: ReturnType<typeof fixture>, threadId: string) { await until(() => !counselsOf(f, threadId).pending.length, 'counsel settled'); }

test('the voices speak on their own after a completed reply, once, and the next turn hears them', async () => {
  const f = fixture();
  const asked = counting(f, () => on);
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Auto');
  const first = await turn(f, threadId, 'Plan my chess bot ELO measurement');
  await settled(f, threadId);
  const stored = counselsOf(f, threadId).counsels[first] as RunCounsel;
  assert.equal(stored.auto, true);
  assert.deepEqual(Object.keys(stored.notes).sort(), ['ambition', 'prudence']);
  assert.equal(asked.length, 2, 'one call per voice');
  // Never twice for the same run: viewing again, or a later turn, does not re-run it.
  await f.runtime.view('owner', threadId);
  const second = await turn(f, threadId, 'go on');
  assert.match(f.sent.at(-1)!, /Your inner voices weighed in[\s\S]*Ambition \(medium confidence\): ambition on Plan my chess bot/);
  await settled(f, threadId);
  assert.equal(asked.filter(a => a.endsWith('Plan my chess bot ELO measurement')).length, 2);
  assert.ok(counselsOf(f, threadId).counsels[second], 'the second reply was weighed too');
  // "Ask again" re-runs it on request (and only then).
  await f.runtime.counsel('owner', threadId, first);
  assert.equal(asked.filter(a => a.endsWith('Plan my chess bot ELO measurement')).length, 4);
});

test('no automatic counsel after failed or reply-less (listened) turns, or when the voices are off', async () => {
  const f = fixture();
  let settings: VoiceSettings = on;
  const asked = counting(f, () => settings);
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Skip');
  await turn(f, threadId, 'SILENT please');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(asked.length, 0, 'no reply: nothing to weigh');
  settings = DEFAULT_VOICES;
  await turn(f, threadId, 'hello while off');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(asked.length, 0, 'voices off');
  settings = on;
  const failed = await turn(f, threadId, 'FAIL now');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(asked.length, 0, 'a failed turn is not weighed');
  assert.equal(counselsOf(f, threadId).counsels[failed], undefined);
});

test('"only long turns": a quick reply without tools is not weighed', async () => {
  const f = fixture();
  const asked = counting(f, () => ({ ...on, speakAfter: 'long' }));
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Long');
  await turn(f, threadId, 'quick question');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(asked.length, 0);
  assert.equal(checkVoiceSettings({ speakAfter: 'long' }).speakAfter, 'long');
  assert.throws(() => checkVoiceSettings({ speakAfter: 'sometimes' }), /invalid_input/);
});

test('the next turn waits briefly for notes still being written, then proceeds; late notes are shown, never injected', async () => {
  const f = fixture();
  let delay = 300;
  const asked = counting(f, () => on, () => delay);
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Wait');
  await turn(f, threadId, 'first message');
  assert.equal(counselsOf(f, threadId).pending.length, 1, 'thinking');
  // Sent at once: waits (300 ms < 10 s) and hears them.
  await turn(f, threadId, 'second message');
  assert.match(f.sent.at(-1)!, /ambition on first message/);
  await settled(f, threadId);
  // Too slow: the turn proceeds after the wait (here 100 ms) without them.
  f.runtime.counselWaitMs = 100;
  delay = 600;
  const fifth = await turn(f, threadId, 'fifth message');
  const started = Date.now();
  await turn(f, threadId, 'sixth message');
  assert.ok(Date.now() - started < 550, 'proceeded before the notes were ready');
  assert.doesNotMatch(f.sent.at(-1)!, /ambition on fifth message/, 'not waited for longer than the limit');
  await settled(f, threadId);
  const late = counselsOf(f, threadId).counsels[fifth]!;
  assert.equal(late.late, true);
  assert.equal(late.delivered, undefined);
  await turn(f, threadId, 'seventh message');
  assert.doesNotMatch(f.sent.at(-1)!, /ambition on fifth message/, 'late notes are never injected');
  assert.ok(asked.length >= 6);
});
