import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECTIONS, groupByTimeThenAgent, NEW_CHAT, openPlan, readSections, savedThreadKey } from '../src/nav-model.js';
import type { ThreadSummary } from '../src/thread-model.js';

const now = new Date(2026, 9, 10, 15, 0);
const at = (daysAgo: number, hour = 12) => new Date(2026, 9, 10 - daysAgo, hour).toISOString();
const t = (id: string, title: string, lastActivityAt: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({ id, title, state: 'ready', createdAt: lastActivityAt, lastActivityAt, ...extra });

const lists = [
  { agentId: 'main', agentName: 'Main', threads: [t('m1', 'Old plan', at(30)), t('m2', 'Morning notes', at(0, 9)), t('m3', 'Gone', at(0, 10), { archived: true })] },
  { agentId: 'chess', agentName: 'chess', threads: [t('c1', 'Next blog idea', at(0, 14)), t('c2', 'Opening prep', at(1, 8)), t('c3', 'Endgames', at(0, 11))] },
  { agentId: 'docs', agentName: 'docs', threads: [t('d1', 'Release notes', at(1, 20))] },
  { agentId: 'empty', agentName: 'empty', threads: [] },
];

test('conversations group by time first, then by agent ordered by their most recent conversation', () => {
  const groups = groupByTimeThenAgent(lists, now);
  assert.deepEqual(groups.map(g => g.label), ['Today', 'Yesterday', 'Older']);
  const today = groups[0]!;
  assert.deepEqual(today.agents.map(a => a.agentName), ['chess', 'Main']);
  assert.deepEqual(today.agents[0]!.items.map(i => i.thread.id), ['c1', 'c3']);
  assert.deepEqual(today.agents[1]!.items.map(i => i.thread.id), ['m2']);
  // Yesterday: docs (20:00) before chess (08:00).
  assert.deepEqual(groups[1]!.agents.map(a => [a.agentId, a.items.map(i => i.thread.id)]), [['docs', ['d1']], ['chess', ['c2']]]);
  assert.deepEqual(groups[2]!.agents.map(a => a.agentId), ['main']);
});

test('archived conversations, empty agents and empty groups are left out', () => {
  const groups = groupByTimeThenAgent(lists, now);
  const ids = groups.flatMap(g => g.agents.flatMap(a => a.items.map(i => i.thread.id)));
  assert.ok(!ids.includes('m3'));
  assert.ok(!groups.some(g => g.agents.some(a => a.agentId === 'empty')));
  assert.ok(!groups.some(g => g.key === 'week'));
  assert.deepEqual(groupByTimeThenAgent([], now), []);
});

test('search covers every agent', () => {
  const groups = groupByTimeThenAgent(lists, now, 'NOTES');
  assert.deepEqual(groups.flatMap(g => g.agents.flatMap(a => a.items.map(i => `${a.agentId}/${i.thread.id}`))), ['main/m2', 'docs/d1']);
  assert.deepEqual(groupByTimeThenAgent(lists, now, 'nothing here'), []);
});

test('opening a conversation of the same agent selects it; of another, saves it under that agent and switches', () => {
  assert.deepEqual(openPlan('main', 'main', 'm2', {}), { kind: 'select', threadId: 'm2' });
  assert.deepEqual(openPlan('main', 'main', undefined, {}), { kind: 'new' });
  assert.deepEqual(openPlan('main', 'chess', 'c1', { adopted: true }), { kind: 'switch', agentId: 'chess', save: { key: 'ai-sdk-letta-thread:chess', value: 'c1' } });
  // Back to the app's own agent: its single key.
  assert.deepEqual(openPlan('chess', 'main', 'm1', { adopted: false }), { kind: 'switch', agentId: 'main', save: { key: 'ai-sdk-letta-thread', value: 'm1' } });
  // A new chat with another agent.
  assert.deepEqual(openPlan('main', 'docs', undefined, { team: true }), { kind: 'switch', agentId: 'docs', save: { key: 'ai-sdk-letta-thread:docs', value: NEW_CHAT } });
  assert.equal(savedThreadKey('x', { team: true }), 'ai-sdk-letta-thread:x');
});

test('the accordion state defaults to conversations open, agents closed, and survives bad storage', () => {
  assert.deepEqual(readSections(null), DEFAULT_SECTIONS);
  assert.deepEqual(readSections('nope'), DEFAULT_SECTIONS);
  assert.deepEqual(readSections('{"agents":true}'), { conversations: true, agents: true });
  assert.deepEqual(readSections('{"conversations":false,"agents":"x"}'), { conversations: false, agents: false });
});
