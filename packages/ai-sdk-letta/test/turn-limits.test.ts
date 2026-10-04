import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListMessagesResult, SDKMessage } from '@letta-ai/letta-agent-sdk';
import {
  LettaAgent, TurnClock, TurnLimitError, ToolInteractions, acquireIdentity, assertHistorySettled, defineAgent, resolveTurnLimits, turnLimits,
  DEFAULT_TURN_IDLE_MS, DEFAULT_TURN_MAX_MS, SDK_TURN_TIMEOUT_MS, TURN_TIMEOUT_MS, type DeliveryHooks, type TurnSession,
} from '../src/index.js';
import { definition, registry } from './fixtures.js';

const MIN = 60_000;
const rows = (...messages: Record<string, unknown>[]) => messages as unknown as ListMessagesResult['messages'];

/** Let pending promise callbacks run (fake timers only move time). */
async function flush(rounds = 20) { for (let i = 0; i < rounds; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

/**
 * A scripted Letta session driven by the test: `push` streams an event,
 * `abort` (as the harness does) ends the turn with an "interrupted" result
 * once the backend confirmed the run ended.
 */
function scripted(options: { confirmAbort?: boolean } = {}) {
  const queue: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const log = { sent: [] as { message: unknown; otid?: string }[], aborts: 0, activeRuns: 0 };
  const push = (event: SDKMessage) => { queue.push(event); wake?.(); };
  const session: TurnSession = {
    async send(message, sendOptions) { log.sent.push({ message, otid: sendOptions?.otid }); log.activeRuns = 1; },
    async abort() {
      log.aborts++;
      // The harness cancels the backend run, closes open tools as interrupted, and ends the turn.
      if (options.confirmAbort !== false) { log.activeRuns = 0; push({ type: 'result', success: false, errorCode: 'interrupted', durationMs: 1, conversationId: 'c', uuid: 'r' } as SDKMessage); }
    },
    close() {},
    async *stream() {
      while (!ended) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
        const event = queue.shift();
        if (!event) continue;
        if (event.type === 'result') { ended = true; log.activeRuns = 0; }
        yield event;
      }
    },
  };
  return { session, push, log };
}

function agentWith(s: ReturnType<typeof scripted>, options: { limits?: { idleMs?: number; maxMs?: number }; delivery?: DeliveryHooks; interactions?: ToolInteractions } = {}) {
  return new LettaAgent({ id: 'limits', tools: registry, open: () => s.session, ...(options.limits ? { limits: options.limits } : {}), ...(options.delivery ? { delivery: options.delivery } : {}), ...(options.interactions ? { interactions: options.interactions } : {}) });
}
const say = (text: string, uuid: string) => ({ type: 'assistant', content: text, uuid } as SDKMessage);
const call = (id: string, name = 'text_stats') => ({ type: 'tool_call', toolCallId: id, toolName: name, toolInput: { text: 'x' }, uuid: `c-${id}` } as SDKMessage);
const result = (id: string) => ({ type: 'tool_result', toolCallId: id, content: '{"ok":true}', isError: false, uuid: `r-${id}` } as SDKMessage);
const done = () => ({ type: 'result', success: true, durationMs: 1, conversationId: 'c', uuid: 'done' } as SDKMessage);

test('defaults: 10 minutes idle, 6 hours of work; env names and the older deadline variable; the SDK timer never ends a turn first', () => {
  assert.deepEqual(resolveTurnLimits(), { idleMs: DEFAULT_TURN_IDLE_MS, maxMs: DEFAULT_TURN_MAX_MS });
  assert.equal(DEFAULT_TURN_IDLE_MS, 10 * MIN); assert.equal(DEFAULT_TURN_MAX_MS, 6 * 60 * MIN);
  assert.deepEqual(turnLimits({}), { idleMs: 10 * MIN, maxMs: 6 * 60 * MIN });
  assert.deepEqual(turnLimits({ AI_SDK_LETTA_TURN_IDLE_MS: '120000', AI_SDK_LETTA_TURN_MAX_MS: '0' }), { idleMs: 120_000, maxMs: 0 });
  // The older variable (a fixed per-turn budget) is the hard cap now.
  assert.deepEqual(turnLimits({ AI_SDK_LETTA_TURN_DEADLINE_MS: '3600000' }), { idleMs: 10 * MIN, maxMs: 3_600_000 });
  assert.equal(turnLimits({ AI_SDK_LETTA_TURN_DEADLINE_MS: '1000', AI_SDK_LETTA_TURN_MAX_MS: '7200000' }).maxMs, 7_200_000);
  assert.throws(() => turnLimits({ AI_SDK_LETTA_TURN_IDLE_MS: 'soon' }), /AI_SDK_LETTA_TURN_IDLE_MS/);
  assert.throws(() => turnLimits({ AI_SDK_LETTA_TURN_MAX_MS: '500' }), /or 0 to disable/);
  // The SDK's single wall-clock turn timer (appServer.requestTimeoutMs) is effectively unbounded: our limits stop turns first.
  assert.ok(SDK_TURN_TIMEOUT_MS >= 24 * 24 * 60 * MIN);
  assert.equal(TURN_TIMEOUT_MS, SDK_TURN_TIMEOUT_MS);
  // Definitions validate their own limits.
  assert.deepEqual(defineAgent({ ...baseInput(), turnLimits: { maxMs: 0 } }).turnLimits, { maxMs: 0 });
  assert.throws(() => defineAgent({ ...baseInput(), turnLimits: { idleMs: 10 } }), /idleMs/);
  assert.throws(() => defineAgent({ ...baseInput(), turnLimits: { hours: 1 } as never }), /Unknown turnLimits/);
});
const baseInput = () => ({ id: 'x', name: 'X', model: 'a/b', instructions: 'i', tools: {} });

test('clock: progress resets idle; a running tool is not idle; human waits pause both limits; the cap counts work only', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fired: string[] = [];
  const clock = new TurnClock({ idleMs: 10 * MIN, maxMs: 60 * MIN }, reason => fired.push(reason));
  clock.start();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(9 * MIN); clock.progress(); }
  assert.deepEqual(fired, []);
  clock.setBusy(true); t.mock.timers.tick(14 * MIN); assert.deepEqual(fired, [], 'a 14-minute tool call is not idleness');
  clock.setBusy(false);
  clock.pause(); t.mock.timers.tick(5 * 60 * MIN); assert.deepEqual(fired, [], 'five hours waiting for a person count for nothing');
  clock.resume();
  assert.equal(clock.workMs, 59 * MIN);
  t.mock.timers.tick(MIN);
  assert.deepEqual(fired, ['max_duration']);
  const idle: string[] = [];
  const other = new TurnClock({ idleMs: 10 * MIN, maxMs: 0 }, reason => idle.push(reason));
  other.start(); t.mock.timers.tick(10 * MIN - 1); assert.deepEqual(idle, []); t.mock.timers.tick(1); assert.deepEqual(idle, ['idle_timeout']);
});

test('an active turn of more than 15 minutes is not cut; the conversation goes on', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = scripted();
  const agent = agentWith(s);
  const running = agent.generate({ prompt: 'long build' });
  await flush();
  // 20 minutes: text every 4 minutes, then a 13-minute tool call (a sandbox build), then the reply.
  for (let i = 0; i < 2; i++) { s.push(say(`step ${i} `, `s${i}`)); await flush(); t.mock.timers.tick(4 * MIN); }
  s.push(call('build')); await flush(); t.mock.timers.tick(13 * MIN); await flush();
  s.push(result('build')); await flush(); t.mock.timers.tick(3 * MIN);
  s.push(say('built.', 'end')); s.push(done());
  const reply = await running;
  assert.equal(reply.text, 'step 0 step 1 built.');
  assert.deepEqual(await agent.lastTurn(), { end: 'completed' });
  assert.equal(s.log.aborts, 0);
});

test('idle timeout: the turn is stopped like Stop, the backend run is cancelled, and the agent stays usable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = scripted();
  const settled: { otid?: string }[] = [];
  const delivery: DeliveryHooks = { begin() {}, complete() {}, async settle(turn) { settled.push(turn); return { delivered: true }; } };
  const agent = agentWith(s, { delivery });
  const stream = await agent.stream({ prompt: 'think', otid: 'run-1' });
  const parts: string[] = [];
  const reading = (async () => { for await (const part of stream.fullStream) parts.push(part.type); })();
  await flush();
  s.push(say('partial', 'p')); await flush();
  t.mock.timers.tick(10 * MIN - 1); await flush();
  assert.equal(s.log.aborts, 0);
  t.mock.timers.tick(1); await flush();
  await reading;
  assert.equal(s.log.aborts, 1, 'the backend run was cancelled');
  assert.ok(parts.includes('abort'));
  assert.deepEqual(await agent.lastTurn(), { end: 'stopped', reason: 'idle_timeout', delivered: true });
  assert.deepEqual(settled, [{ otid: 'run-1' }]);
  assert.equal(s.log.activeRuns, 0, 'no lingering backend run');
  // Usable: the next turn is sent.
  const next = scripted(); (agent as unknown as { open: () => TurnSession }).open = () => next.session;
  const again = agent.generate({ prompt: 'again' }); await flush(); next.push(say('ok', 'o')); next.push(done());
  assert.equal((await again).text, 'ok');
});

test('hard cap: a turn that keeps making progress is stopped at the cap; generate rejects with TurnLimitError', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = scripted();
  const agent = agentWith(s, { limits: { idleMs: 10 * MIN, maxMs: 30 * MIN } });
  const running = agent.generate({ prompt: 'forever' });
  running.catch(() => {});
  await flush();
  for (let i = 0; i < 6; i++) { s.push(say('.', `d${i}`)); await flush(); t.mock.timers.tick(5 * MIN); await flush(); }
  await assert.rejects(running, (error: unknown) => error instanceof TurnLimitError && error.reason === 'max_duration' && /30 min/.test(error.message));
  assert.deepEqual(await agent.lastTurn(), { end: 'stopped', reason: 'max_duration' });
  assert.equal(s.log.aborts, 1);
});

test('approval and question waits never consume the budget, however long', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = scripted();
  const interactions = new ToolInteractions();
  let answer: ((value: unknown) => void) | undefined;
  interactions.connect(() => new Promise(resolve => { answer = resolve; }));
  const agent = agentWith(s, { limits: { idleMs: 10 * MIN, maxMs: 20 * MIN }, interactions });
  const running = agent.generate({ prompt: 'needs approval' });
  await flush();
  s.push(say('working', 'w')); await flush(); t.mock.timers.tick(9 * MIN);
  // The tool asks a person; nobody answers for 3 hours.
  s.push(call('a', 'approval_demo')); await flush();
  const control = new AbortController();
  const asked = interactions.request({ toolCallId: 'a', tool: 'approval_demo', kind: 'approval', title: 'Allow?' }, control.signal);
  await flush();
  t.mock.timers.tick(3 * 60 * MIN); await flush();
  assert.equal(s.log.aborts, 0, 'neither limit counted the wait');
  answer!({ id: (await requestId(interactions)), approved: true });
  await asked;
  s.push(result('a')); await flush();
  t.mock.timers.tick(9 * MIN); await flush();
  s.push(say(' done', 'd')); s.push(done());
  assert.equal((await running).text, 'working done');
  assert.equal(s.log.aborts, 0);
});
/** The open request's ID (the broker gives the renderer a copy). */
async function requestId(interactions: ToolInteractions): Promise<string> {
  const active = (interactions as unknown as { active?: { request: { id: string } } }).active;
  return active!.request.id;
}

test('Stop: the backend confirms the run ended, the stop is recorded, and the agent stays usable', async () => {
  const s = scripted();
  const marks: string[] = [];
  const delivery: DeliveryHooks = { begin: otid => marks.push(`begin:${otid}`), complete: () => marks.push('complete'), async settle(turn) { marks.push(`settle:${turn.otid}`); return { delivered: true }; } };
  const agent = agentWith(s, { delivery });
  const control = new AbortController();
  const stream = await agent.stream({ prompt: 'stop me', otid: 'run-2', abortSignal: control.signal });
  const reading = (async () => { for await (const part of stream.fullStream) if (part.type === 'text-delta') control.abort(); })();
  await flush(); s.push(say('partial', 'p'));
  await reading;
  assert.deepEqual(await agent.lastTurn(), { end: 'stopped', reason: 'aborted', delivered: true });
  assert.deepEqual(marks, ['begin:run-2', 'settle:run-2']);
});

test('uncertain: a stop Letta never confirms, a failed settle, or a transport failure leaves the agent locked', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // The backend never confirms the run ended (abort is lost): after STOP_CONFIRM_MS the delivery is uncertain.
  const lost = scripted({ confirmAbort: false });
  const delivery: DeliveryHooks = { begin() {}, complete() {}, async settle() { return {}; } };
  const agent = agentWith(lost, { delivery });
  const control = new AbortController();
  const running = agent.generate({ prompt: 'x', abortSignal: control.signal });
  running.catch(() => {});
  await flush(); lost.push(say('a', 'a')); await flush();
  control.abort(); await flush();
  t.mock.timers.tick(60_000); await flush();
  await assert.rejects(running);
  assert.deepEqual(await agent.lastTurn(), { end: 'failed' });
  await assert.rejects(agent.generate({ prompt: 'next' }), /uncertain/);
  // The backend confirmed the end, but recording it (or checking it is idle) failed.
  const s = scripted();
  const failing = agentWith(s, { delivery: { begin() {}, complete() {}, async settle() { throw new Error('still busy'); } } });
  const stop = new AbortController();
  const second = failing.generate({ prompt: 'x', abortSignal: stop.signal });
  second.catch(() => {});
  await flush(); s.push(say('a', 'a')); await flush(); stop.abort(); await flush();
  await assert.rejects(second);
  assert.deepEqual(await failing.lastTurn(), { end: 'failed' });
  // Delivery hooks without settle: never assumed safe.
  const t3 = scripted();
  const noSettle = agentWith(t3, { delivery: { begin() {}, complete() {} } });
  const stop3 = new AbortController();
  const third = noSettle.generate({ prompt: 'x', abortSignal: stop3.signal });
  third.catch(() => {});
  await flush(); t3.push(say('a', 'a')); await flush(); stop3.abort(); await flush();
  assert.deepEqual(await noSettle.lastTurn(), { end: 'failed' });
});

test('a stop before anything was sent is known and usable without a settle', async () => {
  const s = scripted();
  const agent = agentWith(s, { delivery: { begin() {}, complete() {} } });
  await assert.rejects(agent.generate({ prompt: 'x', abortSignal: AbortSignal.abort() }));
  assert.equal(s.log.sent.length, 0);
  const again = agent.generate({ prompt: 'y' }); await flush(); s.push(say('ok', 'o')); s.push(done());
  assert.equal((await again).text, 'ok');
});

test('per-call limits only tighten the agent\'s', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = scripted();
  const agent = agentWith(s, { limits: { idleMs: 10 * MIN, maxMs: 60 * MIN } });
  const running = agent.generate({ prompt: 'x', limits: { idleMs: 60 * MIN, maxMs: 0 } });
  running.catch(() => {});
  await flush();
  t.mock.timers.tick(10 * MIN); await flush();
  await assert.rejects(running, (error: unknown) => error instanceof TurnLimitError && error.reason === 'idle_timeout');
  await assert.rejects(agent.generate({ prompt: 'x', limits: { hours: 2 } as never }), /Invalid limits/);
});

test('history: a recorded settled turn unlocks an unanswered message and an interrupted tool; later trouble still locks', () => {
  const stopped = rows(
    { id: 'u1', message_type: 'user_message', content: 'build the site', otid: 'run-1' },
    { id: 't1', message_type: 'tool_call_message', tool_call: { tool_call_id: 'call-1', name: 'run_command', arguments: '{}' } },
  );
  assert.throws(() => assertHistorySettled(stopped), /unfinished or uncertain/);
  assert.doesNotThrow(() => assertHistorySettled(stopped, { through: 't1' }));
  // Something after the settled point is checked as usual.
  assert.throws(() => assertHistorySettled(rows(...(stopped as unknown as Record<string, unknown>[]), { id: 'u2', message_type: 'user_message', content: 'again' }), { through: 't1' }), /unfinished/);
  // An unknown record settles nothing.
  assert.throws(() => assertHistorySettled(stopped, { through: 'elsewhere' }), /unfinished/);
});

test('identity: settleTurn records the turn and clears the pending marker; pendingTurn keeps the OTID', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-limits-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lease = await acquireIdentity(directory, definition, '/backend', { create: async () => 'agent-local-limits', validate: async () => {} });
  try {
    lease.beginTurn('local-conv-1', 'run-7');
    assert.deepEqual({ ...lease.pendingTurn('local-conv-1'), createdAt: 'x' }, { createdAt: 'x', otid: 'run-7' });
    assert.throws(() => lease.assertNoPendingTurn('local-conv-1'), /Check and unlock/);
    lease.settleTurn('local-conv-1', { outcome: 'stopped', delivered: true, otid: 'run-7', through: 'msg-9' });
    assert.equal(lease.pendingTurn('local-conv-1'), undefined);
    assert.doesNotThrow(() => lease.assertNoPendingTurn('local-conv-1'));
    const settled = lease.settledTurn('local-conv-1')!;
    assert.equal(settled.outcome, 'stopped'); assert.equal(settled.through, 'msg-9'); assert.equal(settled.delivered, true);
    // A later settle replaces it (the newest settled point counts).
    lease.settleTurn('local-conv-1', { outcome: 'reconciled', through: 'msg-12' });
    assert.equal(lease.settledTurn('local-conv-1')!.through, 'msg-12');
  } finally { lease.release(); }
});
