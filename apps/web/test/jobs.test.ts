import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandJobOf, durationText, jobOfCall, mergeJob, progressLine, rateText, statusText, type JobView } from '../src/jobs-model.js';
import { grouped } from '../src/activity-model.js';

const job = (over: Partial<JobView> = {}): JobView => ({ id: 'job-1', threadId: 't', toolCallId: 'call-1', goal: 'Play', status: 'running', lines: [], startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1, progress: {}, ...over });

test('progress line: tqdm-like, parts left out when unknown', () => {
  assert.equal(progressLine(job({ done: 9, total: 20, unit: 'games', progress: { percent: 45, ratePerSecond: 3.1 / 60, etaSeconds: 240 } })), '9/20 games · 45% · 3.1/min · ETA 4 min');
  assert.equal(progressLine(job({ done: 3 })), '3');
  assert.equal(progressLine(job()), '');
  assert.equal(progressLine(job({ status: 'done', done: 20, total: 20, progress: { percent: 100, ratePerSecond: 2, etaSeconds: 5 } })), '20/20 · 100% · 2.0/s');
});

test('rates and durations read naturally', () => {
  assert.equal(rateText(0.5), '30/min'); assert.equal(rateText(12), '12/s'); assert.equal(rateText(1 / 3600), '1.0/h'); assert.equal(rateText(0), undefined);
  assert.equal(durationText(12), '12 s'); assert.equal(durationText(250), '4 min'); assert.equal(durationText(3900), '1 h 5 min');
  assert.equal(statusText(job({ status: 'done', progress: { elapsedSeconds: 90 } })), 'Done in 2 min');
  assert.match(statusText(job({ status: 'interrupted' })), /Interrupted/);
});

test('merge: newer versions win, older never; the card finds its job', () => {
  const list = mergeJob([], job({ version: 2, done: 2 }));
  assert.equal(mergeJob(list, job({ version: 1, done: 1 }))[0]!.done, 2);
  assert.equal(mergeJob(list, job({ version: 3, done: 3 }))[0]!.done, 3);
  assert.equal(jobOfCall(list, 'call-1', undefined)?.id, 'job-1');
  assert.equal(jobOfCall(list, 'other', JSON.stringify({ jobId: 'job-1' }))?.id, 'job-1');
  assert.equal(jobOfCall(list, 'other', { error: 'x' }), undefined);
});

test('activity: a Jobs group after Turns', () => {
  const groups = grouped([{ id: 'a', group: 'jobs', kind: 'job', label: 'Play' }, { id: 'b', group: 'turns', kind: 'turn', label: 'Replying' }]);
  assert.deepEqual(groups.map(g => g.label), ['Turns', 'Jobs']);
});

test('command jobs: found by their call, only when they are command jobs', () => {
  const base = { threadId: 't', goal: '$ ls', status: 'running' as const, lines: [], startedAt: '', updatedAt: '', version: 1, progress: {} };
  const jobs = [{ ...base, id: 'a', toolCallId: 'c1' }, { ...base, id: 'b', toolCallId: 'c2', kind: 'command' as const }];
  assert.equal(commandJobOf(jobs, 'c1'), undefined);
  assert.equal(commandJobOf(jobs, 'c2')?.id, 'b');
});
