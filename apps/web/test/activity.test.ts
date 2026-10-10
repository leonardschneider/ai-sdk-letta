import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionLabel, actionPath, grouped, pill, span, timing, type ActivityItem } from '../src/activity-model.js';

test('pill: idle, working, waiting, and other agents', () => {
  assert.equal(pill(undefined).text, 'Idle');
  assert.equal(pill({ state: 'idle', working: 0, waiting: 0 }).state, 'idle');
  assert.equal(pill({ state: 'working', working: 2, waiting: 0 }).text, 'Working · 2');
  const waiting = pill({ state: 'waiting', working: 1, waiting: 1 });
  assert.equal(waiting.text, 'Needs you · 1'); assert.equal(waiting.state, 'waiting');
  const others = pill({ state: 'idle', working: 0, waiting: 0 }, [{ name: 'blog', state: 'working' }, { name: 'ops', state: 'idle' }]);
  assert.equal(others.others, 1); assert.equal(others.othersWaiting, false);
  assert.match(others.label, /Also busy: blog \(working\)/);
  assert.equal(pill(undefined, [{ name: 'ops', state: 'waiting' }]).othersWaiting, true);
});

test('groups in order, empty ones left out', () => {
  const items: ActivityItem[] = [
    { id: 'a', group: 'services', kind: 'app', label: 'App' },
    { id: 'b', group: 'turns', kind: 'turn', label: 'Replying' },
    { id: 'c', group: 'waiting', kind: 'approval', label: 'Permission' },
  ];
  assert.deepEqual(grouped(items).map(g => [g.key, g.items.map(i => i.id)]), [['waiting', ['c']], ['turns', ['b']], ['services', ['a']]]);
});

test('timing: elapsed, idle countdown, schedules', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(span(12_000), '12 s'); assert.equal(span(125_000), '2 min'); assert.equal(span(3_900_000), '1 h 5 min'); assert.equal(span(7_200_000), '2 h');
  assert.equal(timing({ kind: 'turn', since: '2026-10-10T11:57:00Z' }, now), '3 min');
  assert.equal(timing({ kind: 'container', until: '2026-10-10T12:12:00Z' }, now), 'Services stop in 12 min if idle');
  assert.equal(timing({ kind: 'container', until: '2026-10-10T11:59:00Z' }, now), 'Stopping (idle)');
  assert.equal(timing({ kind: 'schedule', until: '2026-10-10T13:00:00Z' }, now), 'Due in 1 h');
  assert.equal(timing({ kind: 'app' }, now), undefined);
});

test('actions map to the existing routes', () => {
  assert.equal(actionPath('stop', { ref: 'run-1' }), '/v1/runs/run-1/cancel');
  assert.equal(actionPath('stop-dev-server', { threadId: 't1' }), '/v1/threads/t1/preview/stop-dev-server');
  assert.equal(actionPath('stop-app', { ref: 'dev-notes' }), '/v1/apps/dev-notes/stop');
  assert.equal(actionPath('restart-app', { ref: 'dev-notes' }), '/v1/apps/dev-notes/restart');
  assert.equal(actionPath('stop', {}), undefined);
  assert.equal(actionLabel('stop', { kind: 'queued' }), 'Withdraw');
  assert.equal(actionLabel('restart-app', { kind: 'app' }), 'Restart');
});
