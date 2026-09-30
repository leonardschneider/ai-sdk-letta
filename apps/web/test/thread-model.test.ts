import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityTimes, dateGroup, deriveTitle, groupByDate, isDefaultTitle, legacyTitleTime, matchesSearch, nextAfterArchive, sortThreads, validTitle, type ThreadSummary } from '../src/thread-model.js';

test('derived titles are short, readable and valid for the backend', () => {
  assert.equal(deriveTitle('  plan my **trip** to `Rome` next week  '), 'Plan my trip to Rome next week');
  assert.equal(deriveTitle('What is 2+2? And why does it matter so much to people?'), 'What is 2+2?');
  assert.equal(deriveTitle('Use text_stats to count words. Then answer.'), 'Use text_stats to count words');
  assert.equal(deriveTitle('# Heading\n> quoted text'), 'Heading quoted text');
  assert.equal(deriveTitle('See [the docs](https://example.com) please'), 'See the docs please');
  const long = deriveTitle('word '.repeat(40))!;
  assert.ok(long.length <= 61 && long.endsWith('…') && !long.includes('  '), long);
  assert.equal(deriveTitle('```\nonly code\n```'), undefined);
  assert.equal(deriveTitle('Reply with a short ```python code block please'), 'Reply with a short python code block please');
  assert.equal(deriveTitle('Explain this:\n```js\nconst a = 1;\n```\nthanks'), 'Explain this: thanks');
  assert.equal(deriveTitle('   '), undefined);
  assert.equal(deriveTitle('bad\u202etitle'), 'Bad title');
  assert.ok(validTitle(deriveTitle('x'.repeat(500))!));
});
test('only the exact default title is replaced; legacy and custom titles are kept', () => {
  assert.equal(isDefaultTitle('New conversation'), true);
  assert.equal(isDefaultTitle('Conversation 9/28/2026, 9:57:54 PM'), false);
  assert.equal(isDefaultTitle('New conversationParent UX review'), false);
  assert.equal(isDefaultTitle('My plans'), false);
  assert.equal(validTitle(''), false); assert.equal(validTitle('a'.repeat(121)), false); assert.equal(validTitle('\u001b[31m'), false); assert.equal(validTitle('Fine'), true);
});
test('legacy titles yield their local creation time', () => {
  assert.equal(legacyTitleTime('Conversation 9/28/2026, 9:57:54 PM'), new Date(2026, 8, 28, 21, 57, 54).getTime());
  assert.equal(legacyTitleTime('Conversation 1/2/2026, 12:05 AM'), new Date(2026, 0, 2, 0, 5).getTime());
  assert.equal(legacyTitleTime('New conversation'), undefined);
});
test('activity times use recorded values, then legacy titles, then creation-order floors', () => {
  const threads: ThreadSummary[] = [
    { id: 'a', title: 'Conversation 9/28/2026, 9:57:54 PM', state: 'ready' },
    { id: 'b', title: 'New conversation', state: 'ready' },
    { id: 'c', title: 'Recent', state: 'ready', createdAt: '2026-09-29T08:00:00Z', lastActivityAt: '2026-09-29T09:00:00Z' },
    { id: 'd', title: 'Invalid', state: 'ready', lastActivityAt: 'nope' },
  ];
  const times = activityTimes(threads);
  assert.equal(times.get('a'), new Date(2026, 8, 28, 21, 57, 54).getTime());
  assert.equal(times.get('b'), times.get('a'), 'untimed legacy thread is at least as recent as earlier ones');
  assert.equal(times.get('c'), Date.parse('2026-09-29T09:00:00Z'));
  assert.equal(times.get('d'), Date.parse('2026-09-29T08:00:00Z'));
  assert.deepEqual(sortThreads(threads, times).map(t => t.id), ['c', 'd', 'b', 'a']);
});
test('date groups follow local calendar days', () => {
  const now = new Date(2026, 8, 29, 10, 0);
  assert.equal(dateGroup(new Date(2026, 8, 29, 0, 0).getTime(), now), 'today');
  assert.equal(dateGroup(new Date(2026, 8, 28, 23, 59).getTime(), now), 'yesterday');
  assert.equal(dateGroup(new Date(2026, 8, 22, 12).getTime(), now), 'week');
  assert.equal(dateGroup(new Date(2026, 8, 21, 23).getTime(), now), 'older');
  assert.equal(dateGroup(undefined, now), 'older');
  const threads: ThreadSummary[] = [
    { id: 't', title: 'Today chat', state: 'ready', lastActivityAt: new Date(2026, 8, 29, 9).toISOString() },
    { id: 'y', title: 'Yesterday chat', state: 'ready', lastActivityAt: new Date(2026, 8, 28, 9).toISOString() },
    { id: 'o', title: 'Old chat', state: 'ready', lastActivityAt: new Date(2026, 5, 1).toISOString() },
  ];
  const groups = groupByDate(threads, activityTimes(threads), now, t => matchesSearch(t.title, 'chat'));
  assert.deepEqual(groups.map(g => [g.label, g.items.map(i => [i.thread.id, i.index])]), [['Today', [['t', 0]]], ['Yesterday', [['y', 1]]], ['Older', [['o', 2]]]]);
  assert.deepEqual(groupByDate(threads, activityTimes(threads), now, t => matchesSearch(t.title, 'old')).map(g => g.key), ['older']);
});
test('search matches every word, ignoring case and accents', () => {
  assert.equal(matchesSearch('Café plans for Rome', 'cafe rome'), true);
  assert.equal(matchesSearch('Café plans for Rome', 'ROME  plans'), true);
  assert.equal(matchesSearch('Café plans for Rome', 'paris'), false);
  assert.equal(matchesSearch('Anything', '   '), true);
});
test('archiving the open conversation picks the next one below, then above, skipping archived/unavailable', () => {
  const list: ThreadSummary[] = [
    { id: 'a', title: 'A', state: 'ready' }, { id: 'b', title: 'B', state: 'ready' },
    { id: 'c', title: 'C', state: 'creating' }, { id: 'd', title: 'D', state: 'ready', archived: true }, { id: 'e', title: 'E', state: 'ready' },
  ];
  assert.equal(nextAfterArchive(list, 'b'), 'e');
  assert.equal(nextAfterArchive(list, 'e'), 'b');
  assert.equal(nextAfterArchive([{ id: 'x', title: 'X', state: 'ready' }], 'x'), undefined);
});
