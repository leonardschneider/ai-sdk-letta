import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { LettaAgent, ToolInteractions, projectHistory, consultVoicesTool, REFLECTION_PART, CONSULT_LIMITS, type InnerVoice } from 'ai-sdk-letta';
import { ThreadRuntime, turnStep, DefinitionVoices, checkVoiceSettings, storedVoices, reviewPolicy, voiceCounsellor, counselRequest, runReply, DEFAULT_VOICES, type RuntimeHost, type VoiceSettings } from '../src/index.js';
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
            reflecting = /:reflect\d?$/.test(options?.otid ?? '');
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
  assert.doesNotMatch(f.sent[2]!, /inner voices (reviewed|debated)/);
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

test('voices off: no review; on: every turn is heard, even a quick reply without tools (old settings migrate)', async () => {
  const f = fixture();
  let settings: VoiceSettings = DEFAULT_VOICES;
  const asked = counting(f, () => settings);
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Every');
  const off = await turn(f, threadId, 'while off');
  assert.equal(runOf(f, off).counsel, undefined);
  assert.doesNotMatch(f.sent[0]!, /consult_voices/, 'no voices note while off');
  // An old "only long turns" setting: every turn is heard now.
  settings = checkVoiceSettings({ ...on, speakAfter: 'long' });
  const quick = await turn(f, threadId, 'quick question');
  assert.equal(asked.length, 2);
  assert.equal(runOf(f, quick).counsel?.outcome, 'kept');
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

/* ---------------- revision rounds, modes, the agent's choice ---------------- */

test('settings: bounds are validated (min ≤ max); earlier settings migrate (decides, default mode and speakAfter are dropped)', () => {
  const ok = checkVoiceSettings({ ...on, minimum: 'debate', maximum: 'debate', maxRevisions: 3 });
  assert.deepEqual(reviewPolicy(ok), { minimum: 'debate', maximum: 'debate', maxRevisions: 3 });
  assert.deepEqual(reviewPolicy(DEFAULT_VOICES), { minimum: 'calibrated', maximum: 'debate', maxRevisions: 1 });
  for (const bad of [{ minimum: 'debate', maximum: 'calibrated' }, { maxRevisions: 0 }, { maxRevisions: 4 }, { decides: 'nobody' }, { defaultMode: 'loud' }, { minimum: 'some' }, { maximum: 'skip' }]) {
    assert.throws(() => checkVoiceSettings(bad), (error: Error & { code?: string }) => error.code === 'invalid_input', JSON.stringify(bad));
  }
  // Earlier settings: accepted, the agent no longer chooses (decides/defaultMode dropped), a minimum below calibrated becomes calibrated.
  const old = checkVoiceSettings({ ...on, decides: 'fixed', defaultMode: 'skip', minimum: 'calibrated_if_tools', maximum: 'debate' });
  assert.deepEqual(Object.keys(old).sort(), ['ambition', 'maximum', 'minimum', 'prudence']);
  assert.equal(old.minimum, 'calibrated');
  assert.equal(checkVoiceSettings({ minimum: 'none' }).minimum, 'calibrated');
  assert.deepEqual(storedVoices({ ...on, decides: 'agent', defaultMode: 'calibrated', minimum: 'none', maximum: 'debate', maxRevisions: 2 }), { ...on, minimum: 'calibrated', maximum: 'debate', maxRevisions: 2 });
  assert.equal('speakAfter' in checkVoiceSettings({ speakAfter: 'long' }), false);
});

test('rounds: a revision is reviewed again (the new version) until KEEP; each round has its own hidden OTID, and rebuilt history hides them all', async () => {
  const f = fixture();
  const asked = counting(f, () => ({ ...on, maxRevisions: 3 }));
  let round = 0;
  f.state.reflection = () => (++round === 1 ? 'Revision one.' : round === 2 ? 'Revision two.' : 'KEEP');
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Rounds');
  const id = await turn(f, threadId, 'Estimate my ELO');
  const run = runOf(f, id);
  assert.equal(run.counsel?.outcome, 'revised');
  assert.equal(run.counsel?.revisions, 2);
  assert.deepEqual(run.counsel?.rounds?.map(r => [r.outcome, r.text]), [['revised', 'Got: Estimate my ELO. Plan: play 2 more games.'], ['revised', 'Revision one.'], ['kept', 'Revision two.']]);
  assert.equal(runReply(run as never), 'Revision two.');
  assert.equal(asked.length, 6, 'two voices per round');
  assert.deepEqual(asked.filter(a => a.startsWith('prudence')).map(a => a.split(':').slice(2).join(':')), ['Got: Estimate my ELO. Plan: play 2 more games.', 'Revision one.', 'Revision two.'], 'each round reads the new version');
  const records = [...f.rows.values()][0]!;
  assert.deepEqual(records.filter(r => String(r.otid ?? '').includes(':reflect')).map(r => r.otid), [`${id}:reflect`, `${id}:reflect2`, `${id}:reflect3`]);
  assert.match(String(records.find(r => r.otid === `${id}:reflect2`)!.content), /reviewed your revised reply/);
  // Rebuilt from the backend's records (as after a reload): no hidden prompt is a user message; each round's marker carries its outcome.
  const rebuilt = projectHistory(structuredClone(records) as never, []);
  assert.deepEqual(rebuilt.filter(m => m.role === 'user').map(m => m.parts.map(p => (p as { text?: string }).text).join('')), ['Estimate my ELO']);
  const view = await viewOf(f, threadId);
  assert.deepEqual(userTexts(view.messages), ['Estimate my ELO']);
  assert.deepEqual(view.messages.flatMap(m => m.parts).filter(p => p.type === REFLECTION_PART).map(p => [p.data?.otid, p.data?.outcome]), [[`${id}:reflect`, 'revised'], [`${id}:reflect2`, 'revised'], [`${id}:reflect3`, 'kept']]);
});

test('rounds stop at the limit: the latest revision stands', async () => {
  const f = fixture();
  const asked = counting(f, () => ({ ...on, maxRevisions: 2 }));
  let round = 0;
  f.state.reflection = () => `Revision ${++round}.`;
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Limit');
  const id = await turn(f, threadId, 'Estimate my ELO');
  const run = runOf(f, id);
  assert.equal(run.counsel?.rounds?.length, 2);
  assert.equal(run.counsel?.revisions, 2);
  assert.equal(runReply(run as never), 'Revision 2.');
  assert.equal(asked.length, 4);
  assert.equal(f.sent.length, 3, 'the draft and two reflections');
  assert.doesNotMatch(f.sent[2]!, /A revision is reviewed again/, 'the last round says nothing more follows');
  assert.match(f.sent[1]!, /A revision is reviewed again/);
});

test('debate: the voices get the debate stance; KEEP with a rebuttal keeps the draft and records the rebuttal', async () => {
  const f = fixture();
  const modes: string[] = [];
  f.runtime.voices = voiceCounsellor({ settings: () => ({ ...on, minimum: 'debate', maximum: 'debate' }), agentModel: () => 'openai-codex/gpt-5.5', directory: f.directory, available: async () => [],
    voice: name => async request => { modes.push(`${name}:${request.mode}`); return { points: [`${name} point`], confidence: 'medium' }; } });
  f.state.reflection = () => 'KEEP — the counterexample assumes a rated pool the person ruled out.';
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Debate');
  const id = await turn(f, threadId, 'Is 1600 right?');
  const run = runOf(f, id);
  assert.deepEqual(modes.sort(), ['ambition:debate', 'prudence:debate']);
  assert.equal(run.counsel?.mode, 'debate');
  assert.equal(run.counsel?.outcome, 'kept');
  assert.equal(run.counsel?.rounds?.[0]?.rebuttal, 'the counterexample assumes a rated pool the person ruled out.');
  assert.equal(runReply(run as never), 'Got: Is 1600 right?. Plan: play 2 more games.');
  assert.match(f.sent[1]!, /debated your draft reply[\s\S]*KEEP followed by a one-line rebuttal/);
});

/** A synthetic finished draft: its text and tool calls (name, input). */
/** A run whose events hold these tool calls (and results), then a reply. */
function draftRun(tools: [string, unknown, unknown?][] = []) {
  let sequence = 0;
  return { id: randomUUID(), threadId: 't', input: 'q', parentRunId: null, status: 'running', events: [
    ...tools.flatMap(([name, input, output]) => [
      { sequence: ++sequence, type: 'tool_started', data: { toolCallId: `c${sequence}`, name, input } },
      ...(output !== undefined ? [{ sequence: ++sequence, type: 'tool_completed', data: { toolCallId: `c${sequence - 1}`, name, output } }] : []),
    ]),
    { sequence: ++sequence, type: 'text', data: { text: 'An answer.' } },
  ] };
}
const reviewOf = (f: ReturnType<typeof fixture>, run: ReturnType<typeof draftRun>) => f.runtime['reviewOf'](run as never) as { mode: string; maxRounds: number } | undefined;
const noted = (voices: string[]) => JSON.stringify({ ok: true, mode: 'calibrated', question: 'q', notes: Object.fromEntries(voices.map(v => [v, { points: ['p'], confidence: 'high' }])) });

test('the end-of-turn review runs only when the turn did not consult its voices; its stance is the minimum', () => {
  const f = fixture();
  let settings: VoiceSettings = { ...on, minimum: 'calibrated', maximum: 'debate', maxRevisions: 2 };
  counting(f, () => settings);
  assert.deepEqual(reviewOf(f, draftRun()), { mode: 'calibrated', maxRounds: 2 }, 'no tools: still reviewed');
  assert.equal(reviewOf(f, draftRun([['Bash', { command: 'ls' }, 'ok']]))?.mode, 'calibrated');
  assert.equal(reviewOf(f, draftRun([['consult_voices', { question: 'c3?' }, noted(['prudence'])]])), undefined, 'consulted (one voice is enough)');
  assert.equal(reviewOf(f, draftRun([['consult_voices', { question: 'c3?' }, { ok: true, notes: { ambition: { points: ['p'], confidence: 'low' } } }]])), undefined, 'an object result too');
  assert.equal(reviewOf(f, draftRun([['consult_voices', { question: 'c3?' }, JSON.stringify({ ok: true, notes: { prudence: { error: 'voice_timeout' } } })]]))?.mode, 'calibrated', 'no note came back: reviewed');
  assert.equal(reviewOf(f, draftRun([['consult_voices', { question: 'c3?' }, JSON.stringify({ ok: false, error: 'invalid_input' })]]))?.mode, 'calibrated', 'a failed call: reviewed');
  assert.equal(reviewOf(f, draftRun([['consult_voices', { question: 'c3?' }]]))?.mode, 'calibrated', 'a call without a result: reviewed');
  // An old inner_voices "skip" no longer skips anything.
  assert.equal(reviewOf(f, draftRun([['inner_voices', { mode: 'skip', reason: 'hi' }, 'ok']]))?.mode, 'calibrated');
  settings = { ...on, minimum: 'debate', maximum: 'debate' };
  assert.equal(reviewOf(f, draftRun())?.mode, 'debate');
  settings = DEFAULT_VOICES;
  assert.equal(reviewOf(f, draftRun()), undefined, 'voices off');
});

test('consult_voices: offered while a voice is on; mode clamped to the bounds; the agent picks which voices', async () => {
  const f = fixture();
  let settings: VoiceSettings = DEFAULT_VOICES;
  const asked = counting(f, () => settings);
  assert.equal(f.runtime.voiceConsultant(), undefined, 'voices off: not offered');
  assert.equal(new ThreadRuntime({ open: async () => { throw new Error('x'); }, close: async () => {} }, join(f.directory, 'other.json'), 'owner').voiceConsultant(), undefined, 'no voices at all');
  settings = { ...on, minimum: 'calibrated', maximum: 'calibrated' };
  const consultant = f.runtime.voiceConsultant()!;
  assert.deepEqual(consultant.enabled, ['ambition', 'prudence']);
  assert.deepEqual(consultant.bounds, { minimum: 'calibrated', maximum: 'calibrated' });
  let taken = 0;
  const tool = consultVoicesTool(() => f.runtime.voiceConsultant(), () => 'conv-x', () => ++taken <= 2);
  const call = (input: unknown) => tool.execute!(input as never, { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal, context: {} } as never) as unknown as Promise<Record<string, unknown>>;
  const both = await call({ question: 'Is 4.c3 sound?', context: 'FEN …; legal: c3 d3 O-O', mode: 'debate' });
  assert.equal(both.ok, true);
  assert.equal(both.mode, 'calibrated', 'debate lowered to the maximum');
  assert.equal(both.requested, 'debate');
  assert.deepEqual(Object.keys(both.notes as object).sort(), ['ambition', 'prudence']);
  assert.deepEqual(asked, ['ambition::FEN …; legal: c3 d3 O-O', 'prudence::FEN …; legal: c3 d3 O-O'], 'they read the context it gave');
  const one = await call({ question: 'And now?', context: 'After the correction', voices: ['prudence'] });
  assert.deepEqual(Object.keys(one.notes as object), ['prudence'], 'only the voice it asked');
  assert.equal((await call({ question: 'Third' })).error, 'limit_reached', 'bounded per turn');
  assert.equal((await call({ question: '' })).error, 'invalid_input');
  assert.equal((await call({ question: 'x', voices: ['courage'] })).error, 'invalid_input');
  settings = { ...on, ambition: { enabled: false, model: 'auto' } };
  assert.equal((await call({ question: 'x', voices: ['ambition'] })).error, 'voice_off');
  settings = DEFAULT_VOICES;
  assert.equal((await call({ question: 'x' })).error, 'voices_unavailable');
  assert.equal(CONSULT_LIMITS.perTurn, 8);
});

test('a turn that consults its voices mid-turn gets no end-of-turn review; the note tells the agent about consult_voices', async () => {
  const f = fixture();
  const asked = counting(f, () => on);
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Consult');
  // The person's message is part of what a consultation weighs.
  const id = randomUUID();
  const done = f.runtime.start('owner', { id, threadId, text: 'Play the pilot', parentRunId: null });
  await done;
  await until(() => !f.runtime.busy, 'turn ended');
  assert.match(f.sent[0]!, /consult_voices/);
  assert.match(f.sent[0]!, /If you do not consult them in a turn, they review your final reply/);
  assert.equal(runOf(f, id).counsel?.outcome, 'kept', 'not consulted: reviewed at the end');
  // A consultation during a running turn weighs the person's message of that turn (found by conversation).
  const conversationId = (f.runtime['state'].threads as { id: string; conversationId?: string }[]).find(t => t.id === threadId)!.conversationId!;
  f.runtime['lane'](threadId).active = { run: { ...draftRun(), threadId, input: 'Play the pilot game as White' } as never, control: new AbortController() };
  await f.runtime.voiceConsultant()!.ask({ question: 'Is 4.c3 sound?', context: 'position', mode: 'calibrated', voices: ['prudence'], conversationId }, new AbortController().signal);
  assert.equal(asked.at(-1), 'prudence:Play the pilot game as White:position');
  f.runtime['lane'](threadId).active = undefined;
  // Simulate a consulted turn: a completed consult_voices with a note means no end review.
  const run = draftRun([['consult_voices', { question: 'q' }, noted(['ambition', 'prudence'])]]);
  assert.equal(reviewOf(f, run), undefined);
  assert.equal(asked.length, 3);
});

test('the session offers consult_voices while the voices are on, and reopens when that changes', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../ai-sdk-letta/src/runtime.ts', import.meta.url), 'utf8');
  // The LettaAgent refuses calls to tools it does not know ("Unexpected tool call"): consult_voices must be among them.
  assert.match(source, /tools: \(voicesOffered \? \{ \.\.\.agentTools, \[CONSULT_VOICES_TOOL\]/);
  assert.match(source, /voicesOffered !== !!options\.innerVoices\?\.\(\)/);
  assert.match(source, /turnConsults = 0;/, 'the per-turn count resets each turn');
});
