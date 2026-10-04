import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { LettaAgent, ToolInteractions, type ConversationCheck, type InteractionRequest } from 'ai-sdk-letta';
import { ThreadRuntime, displayRun, usableRun, type RuntimeHost, type Run } from '../src/index.js';
import { soloRefusal } from '../src/rewind.js';
import { tools } from './fixtures.js';

const MIN = 60_000;
/** Let pending promise callbacks run (fake timers only move time). */
async function flush(rounds = 30) { for (let i = 0; i < rounds; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
async function until(fn: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await flush(5); }
  throw new Error(`Fixture deadline: ${label}`);
}

/**
 * A host whose turns the test drives: `input` decides what the fake Letta
 * session does. Stop (abort) is confirmed by the fake harness with an
 * "interrupted" result, as the real one does after cancelling the run.
 * `check` stands in for the read-only Check and unlock.
 */
function fixture(options: { limits?: { idleMs?: number; maxMs?: number }; confirmAbort?: boolean; checkResult?: Partial<ConversationCheck> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-limits-'));
  const filename = join(directory, 'state.json');
  const sent: { text: string; otid?: string }[] = [];
  const checks: { conversationId: string; otid?: string }[] = [];
  let activeRuns = 0;
  let current: LettaAgent<typeof tools> | undefined;
  const pushers: ((event: SDKMessage) => void)[] = [];
  const host: RuntimeHost = {
    async close() { current?.close(); current = undefined; },
    async check(conversationId, otid) { checks.push({ conversationId, ...(otid ? { otid } : {}) }); return { unlocked: activeRuns === 0, active: activeRuns > 0, delivered: true, reply: 'partial', tools: { calls: 1, unfinished: 1 }, pending: true, ...options.checkResult }; },
    async open(target) {
      const conversationId = 'conversationId' in target ? target.conversationId : `local-conv-${randomUUID()}`;
      const interactions = new ToolInteractions();
      let input = '';
      const queue: SDKMessage[] = [];
      let wake: (() => void) | undefined;
      const push = (event: SDKMessage) => { queue.push(event); wake?.(); };
      const agent = current = new LettaAgent({ id: 'limits', tools, lettaAgentId: 'agent-local-limits', interactions, ...(options.limits ? { limits: options.limits } : {}), open: signal => ({
        async send(message, sendOptions) { input = String(message); sent.push({ text: input, ...(sendOptions?.otid ? { otid: sendOptions.otid } : {}) }); activeRuns = 1; queue.length = 0; },
        async abort() { if (options.confirmAbort !== false) { activeRuns = 0; push({ type: 'result', success: false, errorCode: 'interrupted', durationMs: 1, conversationId, uuid: 'int' } as SDKMessage); } },
        close() {},
        async *stream() {
          pushers.push(push);
          if (input === 'quick') { yield { type: 'assistant', content: 'Done', uuid: 'q' } as SDKMessage; activeRuns = 0; yield { type: 'result', success: true, durationMs: 1, conversationId, uuid: 'qr' } as SDKMessage; return; }
          if (input === 'lost') { yield { type: 'assistant', content: 'half', uuid: 'l' } as SDKMessage; throw new Error('transport lost'); }
          if (input === 'approve') {
            yield { type: 'tool_call', toolCallId: 'tool-1', toolName: 'text_stats', toolInput: { text: 'x' }, uuid: 'a1' } as SDKMessage;
            const answer = await interactions.request({ toolCallId: 'tool-1', tool: 'text_stats', kind: 'approval', title: 'Allow?' }, signal).catch(() => undefined);
            if (answer) yield { type: 'tool_result', toolCallId: 'tool-1', content: '{"ok":true}', uuid: 'a2' } as SDKMessage;
          }
          // Otherwise: a partial reply, then whatever the test pushes (or a stop).
          yield { type: 'assistant', content: 'partial reply', uuid: 'p' } as SDKMessage;
          while (true) {
            if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
            wake = undefined;
            const event = queue.shift();
            if (!event) continue;
            if (event.type === 'result') activeRuns = 0;
            yield event;
            if (event.type === 'result') return;
          }
        },
      }) });
      return { agent, agentId: 'agent-local-limits', conversationId, history: [] as UIMessage[] };
    },
  };
  const runtime = new ThreadRuntime(host, filename, 'owner');
  return { runtime, host, filename, sent, checks, active: () => activeRuns, push: (event: SDKMessage) => pushers.at(-1)!(event),
    cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const start = (threadId: string, text: string, parentRunId: string | null = null) => ({ id: randomUUID(), threadId, text, parentRunId });
const status = (f: ReturnType<typeof fixture>, id: string) => f.runtime.events('owner', id, 0).status;

test('Stop: the run is stopped (not failed), the partial reply is kept, Letta has no active run, and the conversation stays usable', async () => {
  const f = fixture();
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Stop');
    const run = start(thread, 'long'); await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).events.some(e => e.type === 'text'), 'partial');
    f.runtime.cancel('owner', run.id);
    await until(() => status(f, run.id) === 'stopped', 'stopped');
    const last = f.runtime.events('owner', run.id, 0).events.at(-1)!;
    assert.equal(last.type, 'stopped'); assert.equal(last.data.code, 'cancelled');
    assert.equal(f.active(), 0, 'no lingering backend run');
    const view = await f.runtime.view('owner', thread);
    assert.equal(view.status, 'stopped');
    // The partial reply is shown as stopped (from history, or the run's observations).
    assert.equal(displayRun(f.runtime.runRecord('owner', run.id)!)[1]!.parts.some(p => p.type === 'text' && p.text.includes('partial reply')), true);
    const next = start(thread, 'quick', run.id); await f.runtime.start('owner', next);
    await until(() => status(f, next.id) === 'completed', 'next completed');
    assert.deepEqual(f.sent.map(s => s.text), ['long', 'quick']);
  } finally { await f.cleanup(); }
});

test('idle timeout and hard cap stop the turn with a known outcome; an active 15-minute turn is not cut', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ limits: { idleMs: 10 * MIN, maxMs: 60 * MIN } });
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Limits');
    // Active for 20 minutes (progress every 5): not cut.
    const active = start(thread, 'long'); await f.runtime.start('owner', active);
    await until(() => f.runtime.events('owner', active.id, 0).events.some(e => e.type === 'text'), 'started');
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(5 * MIN); await flush(); f.push({ type: 'assistant', content: '.', uuid: `d${i}` } as SDKMessage); await flush(); }
    assert.equal(status(f, active.id), 'running');
    f.push({ type: 'result', success: true, durationMs: 1, conversationId: 'c', uuid: 'end' } as SDKMessage);
    await until(() => status(f, active.id) === 'completed', 'completed');
    // Idle: no progress for 10 minutes.
    const idle = start(thread, 'long', active.id); await f.runtime.start('owner', idle);
    await until(() => f.runtime.events('owner', idle.id, 0).events.some(e => e.type === 'text'), 'idle started');
    t.mock.timers.tick(10 * MIN); await flush();
    await until(() => status(f, idle.id) === 'stopped', 'idle stopped');
    assert.equal(f.runtime.events('owner', idle.id, 0).events.at(-1)?.data.code, 'idle_timeout');
    // Hard cap: progress every 9 minutes, stopped at 60.
    const capped = start(thread, 'long', idle.id); await f.runtime.start('owner', capped);
    await until(() => f.runtime.events('owner', capped.id, 0).events.some(e => e.type === 'text'), 'cap started');
    for (let i = 0; i < 7 && status(f, capped.id) === 'running'; i++) { t.mock.timers.tick(9 * MIN); await flush(); if (status(f, capped.id) === 'running') { f.push({ type: 'assistant', content: '.', uuid: `c${i}` } as SDKMessage); await flush(); } }
    await until(() => status(f, capped.id) === 'stopped', 'capped');
    assert.equal(f.runtime.events('owner', capped.id, 0).events.at(-1)?.data.code, 'max_duration');
    assert.equal(f.active(), 0);
    // Still usable.
    const next = start(thread, 'quick', capped.id); await f.runtime.start('owner', next);
    await until(() => status(f, next.id) === 'completed', 'usable');
  } finally { await f.cleanup(); }
});

test('an approval wait longer than every limit does not end the turn (the human-wait budget does, cleanly)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ limits: { idleMs: 2 * MIN, maxMs: 3 * MIN } });
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Approval');
    const run = start(thread, 'approve'); await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).events.some(e => e.type === 'interaction'), 'asked');
    t.mock.timers.tick(3 * MIN + 30_000); await flush();
    assert.equal(status(f, run.id), 'running', 'the turn limits paused while a person was asked');
    const request = f.runtime.events('owner', run.id, 0).events.find(e => e.type === 'interaction')!.data as InteractionRequest;
    f.runtime.answer('owner', run.id, { id: request.id, approved: true });
    await until(() => f.runtime.events('owner', run.id, 0).events.some(e => e.type === 'tool_completed'), 'tool done');
    f.push({ type: 'result', success: true, durationMs: 1, conversationId: 'c', uuid: 'end' } as SDKMessage);
    await until(() => status(f, run.id) === 'completed', 'completed');
    // Nobody answers: the human-wait budget (4 minutes) stops the turn cleanly; the conversation stays usable.
    const unanswered = start(thread, 'approve', run.id); await f.runtime.start('owner', unanswered);
    await until(() => f.runtime.events('owner', unanswered.id, 0).events.some(e => e.type === 'interaction'), 'asked again');
    t.mock.timers.tick(4 * MIN); await flush();
    await until(() => status(f, unanswered.id) === 'stopped', 'timed out');
    const events = f.runtime.events('owner', unanswered.id, 0).events;
    assert.equal(events.at(-1)?.data.code, 'timed_out');
    assert.equal(events.find(e => e.type === 'interaction_ended')?.data.code, 'timed_out');
  } finally { await f.cleanup(); }
});

test('uncertain: a transport failure locks the conversation; Check and unlock inspects Letta and unlocks it without replaying', async () => {
  const f = fixture();
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Uncertain');
    const ok = start(thread, 'quick'); await f.runtime.start('owner', ok);
    await until(() => status(f, ok.id) === 'completed', 'first');
    await assert.rejects(f.runtime.check('owner', thread), /not_locked/);
    const lost = start(thread, 'lost', ok.id); await f.runtime.start('owner', lost);
    await until(() => status(f, lost.id) === 'failed', 'failed');
    await assert.rejects(f.runtime.start('owner', start(thread, 'quick', lost.id)), /delivery_uncertain/);
    assert.equal((await f.runtime.view('owner', thread)).status, 'failed');
    // The backend still has an active run: still locked.
    const busy = await withActive(f, () => f.runtime.check('owner', thread));
    assert.equal(busy.unlocked, false); assert.equal(busy.active, true);
    await assert.rejects(f.runtime.start('owner', start(thread, 'quick', lost.id)), /delivery_uncertain/);
    // Idle: unlocked; what Letta has is reported; the turn's OTID (its run ID) was asked about; nothing was resent.
    const checked = await f.runtime.check('owner', thread);
    assert.equal(checked.unlocked, true); assert.equal(checked.delivered, true); assert.equal(checked.reply, 'partial'); assert.equal(checked.status, 'failed');
    assert.deepEqual(f.checks.at(-1)?.otid, lost.id);
    assert.deepEqual(f.sent.map(s => s.text), ['quick', 'lost']);
    assert.ok(f.runtime.runRecord('owner', lost.id)!.checked);
    const next = start(thread, 'quick', lost.id); await f.runtime.start('owner', next);
    await until(() => status(f, next.id) === 'completed', 'usable after check');
  } finally { await f.cleanup(); }
});
/** Run `fn` while the fake backend reports an active run. */
async function withActive<T>(f: ReturnType<typeof fixture>, fn: () => Promise<T>): Promise<T> {
  const original = f.host.check!;
  f.host.check = async (id, otid) => ({ ...(await original(id, otid)), unlocked: false, active: true });
  try { return await fn(); } finally { f.host.check = original; }
}

test('a stop Letta never confirms stays uncertain (read-only), and a restart mid-turn still locks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ confirmAbort: false });
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Unconfirmed');
    const run = start(thread, 'long'); await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).events.some(e => e.type === 'text'), 'started');
    f.runtime.cancel('owner', run.id); await flush();
    t.mock.timers.tick(60_000); await flush();
    await until(() => status(f, run.id) === 'cancelled', 'cancelled');
    await assert.rejects(f.runtime.start('owner', start(thread, 'quick', run.id)), /delivery_uncertain/);
  } finally { await f.cleanup(); }
  // A restart while a turn ran: interrupted, locked (never replayed).
  const g = fixture();
  try {
    const thread = randomUUID(); await g.runtime.create('owner', thread, 'Restart');
    const run = start(thread, 'quick'); await g.runtime.start('owner', run);
    await until(() => status(g, run.id) === 'completed', 'done');
    await g.runtime.close();
    const state = JSON.parse(readFileSync(g.filename, 'utf8')); state.runs[0].status = 'running'; writeFileSync(g.filename, JSON.stringify(state));
    const restored = new ThreadRuntime(g.host, g.filename, 'owner');
    assert.equal(restored.events('owner', run.id, 0).status, 'interrupted');
    await assert.rejects(restored.start('owner', start(thread, 'again', run.id)), /delivery_uncertain/);
    assert.equal((await restored.check('owner', thread)).unlocked, true);
    assert.equal(restored.latestRun('owner', thread)?.usable, true);
    await restored.close();
  } finally { rmSync(dirOf(g.filename), { recursive: true, force: true }); }
});
const dirOf = (file: string) => file.slice(0, file.lastIndexOf('/'));

test('usable-run rule shared by start, enqueue, rewind and decisions: stopped and checked turns are usable, uncertain ones are not', () => {
  const run = (id: string, extra: Partial<Run> = {}): Run => ({ id, threadId: 't', input: id, parentRunId: null, status: 'completed', events: [], tagged: true, ...extra });
  assert.equal(usableRun(run('a')), true);
  assert.equal(usableRun(run('a', { status: 'stopped' })), true);
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    assert.equal(usableRun(run('a', { status })), false);
    assert.equal(usableRun(run('a', { status, checked: { at: 'now' } })), true);
  }
  // Rewind: a stopped turn may be rewound like a completed one; an uncertain one may not.
  assert.equal(soloRefusal([run('a')], [run('a', { status: 'stopped' })], undefined, false), undefined);
  assert.equal(soloRefusal([run('a')], [run('a', { status: 'failed' })], undefined, false), 'delivery_uncertain');
  assert.equal(soloRefusal([run('a')], [run('a', { status: 'cancelled' })], undefined, false), 'delivery_uncertain');
  // Display: an interrupted tool of a stopped turn says so.
  const shown = displayRun(run('a', { status: 'stopped', events: [{ sequence: 1, type: 'tool_started', data: { toolCallId: 'x', name: 'run_command', input: {} } }] }));
  assert.deepEqual(shown[1]!.parts.map(p => p.type === 'dynamic-tool' && p.state === 'output-error' ? p.errorText : null), ['Interrupted: the turn was stopped.']);
});
