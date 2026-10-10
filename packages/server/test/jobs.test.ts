import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import express from 'express';
import { LettaAgent, ToolInteractions } from 'ai-sdk-letta';
import { JobBoard, JOB_BOARD_LIMITS, ThreadRuntime, activityState, agentActivity, jobProgress, runtimeRoutes, type JobRecord, type RuntimeHost } from '../src/index.js';
import { tools } from './fixtures.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const turn = { conversationId: 'conv-1', toolCallId: 'call-1' };

function board(directory: string, clock: { t: number }) {
  const changes: JobRecord[] = [];
  const jobs = new JobBoard(join(directory, 'jobs.json'), { threadOf: id => id === 'conv-1' ? 'thread-1' : undefined, jobChanged: job => changes.push(structuredClone(job)) }, () => clock.t);
  return { jobs, changes };
}

test('progress: percent, rate since the first sample, ETA; ended jobs stop the clock', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const at = (s: number) => new Date(start + s * 1000).toISOString();
  // 9 of 20 after 180 s, first sample (1 done) at 20 s: 8 per 160 s = 0.05/s; 11 left → 220 s.
  const p = jobProgress({ startedAt: at(0), firstAt: at(20), firstDone: 1, done: 9, total: 20, status: 'running' }, start + 180_000);
  assert.equal(p.percent, 45);
  assert.ok(Math.abs(p.ratePerSecond! - 0.05) < 1e-9);
  assert.ok(Math.abs(p.etaSeconds! - 220) < 1e-6);
  assert.equal(p.elapsedSeconds, 180);
  // No total: no percent, no ETA; under a second: no rate.
  assert.deepEqual(jobProgress({ startedAt: at(0), done: 3, status: 'running' }, start + 500), { elapsedSeconds: 0.5 });
  const ended = jobProgress({ startedAt: at(0), endedAt: at(60), done: 20, total: 20, status: 'done' }, start + 999_000);
  assert.equal(ended.elapsedSeconds, 60); assert.equal(ended.percent, 100); assert.equal(ended.etaSeconds, undefined);
  assert.equal(jobProgress({ startedAt: at(0), done: 30, total: 20, status: 'running' }, start).percent, 100);
});

test('board: throttled updates (latest wins, lines accumulate), end, persistence, interrupted on restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jobs-board-'));
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  try {
    const { jobs, changes } = board(directory, clock);
    const { id } = jobs.desk.start({ goal: 'Play 20 games', total: 20, unit: 'games' }, turn) as { id: string };
    assert.match(id, /^job-[0-9a-f-]{36}$/);
    assert.throws(() => jobs.desk.start({ goal: 'x' }, { ...turn, conversationId: 'unknown' }), /jobs_unavailable/);
    // The first update applies at once; the next ones within 250 ms wait and merge.
    jobs.desk.update(id, { done: 1, message: 'game 1' }, turn);
    assert.equal(changes.at(-1)!.done, 1);
    const applied = changes.length;
    jobs.desk.update(id, { done: 2, message: 'game 2' }, turn);
    jobs.desk.update(id, { done: 3, message: 'game 3', image: { bytes: PNG, mediaType: 'image/png' }, imageRef: 'chart.png' }, turn);
    assert.equal(changes.length, applied);
    clock.t += JOB_BOARD_LIMITS.minUpdateMs;
    await new Promise(resolve => setTimeout(resolve, JOB_BOARD_LIMITS.minUpdateMs + 50));
    assert.equal(changes.length, applied + 1);
    const latest = changes.at(-1)!;
    assert.equal(latest.done, 3);
    assert.deepEqual(latest.lines, ['game 1', 'game 2', 'game 3']);
    assert.equal(latest.image?.version, 1); assert.equal(latest.image?.path, 'chart.png');
    assert.equal(jobs.desk.imageRef?.(id, turn), 'chart.png');
    assert.deepEqual([...jobs.image('thread-1', id)!.bytes], [...PNG]);
    assert.equal(jobs.image('thread-2', id), undefined);
    // Wrong conversation: not found.
    assert.throws(() => jobs.desk.update(id, { done: 4 }, { ...turn, conversationId: 'conv-2' }), /job_not_found/);
    // Lines are capped.
    clock.t += 1000;
    jobs.desk.update(id, { message: Array.from({ length: 80 }, (_, i) => `l${i}`).join('\n') }, turn);
    assert.equal(jobs.forThread('thread-1')[0]!.lines.length, 50);
    // A second job keeps running across the "restart".
    const other = (jobs.desk.start({ goal: 'Train' }, turn) as { id: string }).id;
    clock.t += 1000;
    jobs.desk.end(id, { status: 'done', result: 'Won 14 of 20' }, turn);
    const done = jobs.forThread('thread-1').find(j => j.id === id)!;
    assert.equal(done.status, 'done'); assert.equal(done.done, 20); assert.equal(done.result, 'Won 14 of 20'); assert.equal(done.progress.percent, 100);
    assert.throws(() => jobs.desk.update(id, { done: 1 }, turn), /job_ended/);
    assert.deepEqual(jobs.running().map(j => j.id), [other]);
    // Public jobs never expose the conversation ID or the image path.
    assert.equal('conversationId' in done, false); assert.equal(JSON.stringify(done).includes('chart.png'), false);
    jobs.close();
    const again = board(directory, clock).jobs;
    const restored = again.forThread('thread-1');
    assert.equal(restored.find(j => j.id === id)!.status, 'done');
    assert.equal(restored.find(j => j.id === other)!.status, 'interrupted');
    assert.equal(again.running().length, 0);
    assert.ok(again.image('thread-1', id));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('board: command jobs carry their kind and the reported rate and ETA; only agent jobs count as active', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jobs-board-'));
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  try {
    const { jobs } = board(directory, clock);
    assert.equal(jobs.desk.agentJobActive!('conv-1'), false);
    const { id } = jobs.desk.start({ goal: '$ python play.py', kind: 'command' }, turn) as { id: string };
    assert.equal(jobs.desk.agentJobActive!('conv-1'), false, 'a command job is not the agent\'s');
    jobs.desk.update(id, { done: 9, total: 20, ratePerSecond: 1.35, etaSeconds: 15, message: '45%|####| 9/20' }, turn);
    clock.t += 5000;
    const shown = jobs.forThread('thread-1')[0]!;
    assert.equal(shown.kind, 'command');
    assert.equal(shown.progress.ratePerSecond, 1.35);
    assert.equal(shown.progress.etaSeconds, 10, 'the reported time left counts down');
    assert.equal((shown as Record<string, unknown>).reported, undefined, 'internal');
    jobs.desk.end(id, { status: 'failed', result: 'Exit code 1' }, turn);
    assert.equal(jobs.forThread('thread-1')[0]!.status, 'failed');
    const agent = jobs.desk.start({ goal: 'Play 20 games' }, turn) as { id: string };
    assert.equal(jobs.desk.agentJobActive!('conv-1'), true);
    assert.equal(jobs.desk.agentJobActive!('conv-2'), false);
    clock.t += JOB_BOARD_LIMITS.staleMs + 1;
    assert.equal(jobs.desk.agentJobActive!('conv-1'), false, 'a stale job no longer counts');
    jobs.desk.end(agent.id, { status: 'done' }, turn);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('board: running jobs per conversation are limited', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jobs-limit-'));
  try {
    const { jobs } = board(directory, { t: Date.now() });
    for (let i = 0; i < JOB_BOARD_LIMITS.maxRunningPerThread; i++) jobs.desk.start({ goal: `g${i}` }, turn);
    assert.throws(() => jobs.desk.start({ goal: 'one more' }, turn), /job_limit/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

/** A runtime whose 'slow' turn streams until released, with a job board. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jobs-runtime-'));
  let release = () => {};
  const conversations: string[] = [];
  const host: RuntimeHost = {
    async close() {},
    async open(options) {
      const conversationId = 'conversationId' in options ? options.conversationId : randomUUID();
      conversations.push(conversationId);
      let input = '';
      const agent = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'agent-a', interactions: new ToolInteractions(), open: signal => ({
        async send(text) { input = String(text); }, async abort() {}, close() {},
        async *stream() {
          if (input === 'slow') { yield { type: 'assistant', content: 'Working', uuid: '1' } as SDKMessage; await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); }); }
          yield { type: 'assistant', content: 'Done', uuid: '3' } as SDKMessage;
          yield { type: 'result', success: true, uuid: '4', durationMs: 1, conversationId } as SDKMessage;
        },
      }) });
      return { agent, agentId: 'agent-a', conversationId, history: [] };
    },
  };
  const runtime = new ThreadRuntime(host, join(directory, 'state.json'), 'owner');
  const jobs = new JobBoard(join(directory, 'jobs.json'), { threadOf: id => runtime.threadOfConversationAny(id), jobChanged: job => runtime.jobChanged(job) });
  runtime.jobs = jobs;
  return { runtime, jobs, conversations, release: () => release(), cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('runtime: job events reach the live run, activity lists running jobs, routes serve jobs and images', async () => {
  const f = fixture();
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Games');
    const conversationId = f.conversations[0]!;
    const run = { id: randomUUID(), threadId: thread, text: 'slow', parentRunId: null };
    await f.runtime.start('owner', run);
    for (let i = 0; i < 400 && !f.runtime.activeRun(thread); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const seen: { type: string; data: Record<string, unknown> }[] = [];
    const unsubscribe = f.runtime.subscribe(run.id, event => seen.push(event));
    const version = f.runtime.version;
    const { id } = f.jobs.desk.start({ goal: 'Play 20 games', total: 20, unit: 'games' }, { conversationId, toolCallId: 'c1' }) as { id: string };
    f.jobs.desk.update(id, { done: 9, message: 'game 9: won', image: { bytes: PNG, mediaType: 'image/png' } }, { conversationId, toolCallId: 'c2' });
    assert.ok(f.runtime.version > version);
    const jobEvents = seen.filter(e => e.type === 'job');
    assert.equal(jobEvents.length, 2);
    assert.equal((jobEvents[1]!.data.job as { done: number }).done, 9);
    // Job events are display-only: never recorded in the run.
    assert.equal(f.runtime.events('owner', run.id, 0).events.some(e => e.type === 'job'), false);
    const activity = agentActivity(f.runtime, 'owner');
    const item = activity.items.find(i => i.kind === 'job')!;
    assert.equal(item.group, 'jobs'); assert.equal(item.label, 'Play 20 games'); assert.equal(item.detail, 'game 9: won'); assert.equal(item.threadId, thread);
    assert.equal(item.progress?.percent, 45); assert.equal(item.progress?.done, 9);
    assert.equal(activity.working, 2);
    assert.deepEqual(activityState([{ group: 'jobs', kind: 'job', status: 'quiet' }]), { state: 'idle', working: 0, waiting: 0 });
    // Routes.
    const app = express(); app.use(express.json()); runtimeRoutes(app, f.runtime, 'owner');
    const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const list = await (await fetch(`${base}/v1/threads/${thread}/jobs`)).json() as { jobs: { id: string; goal: string; image?: { version: number } }[] };
      assert.equal(list.jobs[0]!.goal, 'Play 20 games'); assert.equal(list.jobs[0]!.image?.version, 1);
      const image = await fetch(`${base}/v1/threads/${thread}/jobs/${id}/image?v=1`);
      assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
      assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/);
      assert.equal(image.headers.get('cache-control'), 'private, no-store');
      assert.equal((await fetch(`${base}/v1/threads/${thread}/jobs/job-${randomUUID()}/image`)).status, 404);
      assert.equal((await fetch(`${base}/v1/threads/${randomUUID()}/jobs`)).status, 404);
    } finally { server.close(); }
    unsubscribe();
    f.release();
    for (let i = 0; i < 400 && f.runtime.activeRun(thread); i++) await new Promise(resolve => setTimeout(resolve, 5));
    // The job outlives the turn: still running, still listed.
    assert.equal(agentActivity(f.runtime, 'owner').items.filter(i => i.kind === 'job').length, 1);
    f.jobs.desk.end(id, { status: 'done' }, { conversationId, toolCallId: 'c3' });
    assert.equal(agentActivity(f.runtime, 'owner').items.filter(i => i.kind === 'job').length, 0);
  } finally { await f.cleanup(); }
});
