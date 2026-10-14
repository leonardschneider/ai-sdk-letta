import { test } from 'node:test';
import assert from 'node:assert/strict';

test('long conversations show their latest messages, starting on a question when possible', async () => {
  const { latestMessages, SHOWN_WINDOW } = await import('../src/messages.js');
  const msgs = Array.from({ length: 200 }, (_, i) => ({ id: String(i), role: i % 2 === 0 ? 'user' : 'assistant' }));
  assert.equal(SHOWN_WINDOW, 60);
  const short = latestMessages(msgs.slice(0, 10), 60);
  assert.equal(short.hidden, 0);
  assert.equal(short.messages.length, 10);
  const long = latestMessages(msgs, 61);
  assert.equal(long.messages[0]!.role, 'user', 'starts on a user message');
  assert.equal(long.hidden + long.messages.length, 200);
  assert.ok(long.messages.length >= 61 && long.messages.length <= 67);
  assert.equal(long.messages.at(-1)!.id, '199', 'always ends with the latest');
});

test('an unchanged message keeps its identity across updates (no redraw of the whole conversation)', async () => {
  const { withReplyRuns } = await import('../src/messages.js');
  const user = { id: 'u', role: 'user' as const, content: 'q', metadata: { custom: { runId: 'r1' } } };
  const reply = { id: 'a', role: 'assistant' as const, content: 'answer' };
  const first = withReplyRuns([user, reply] as never);
  const second = withReplyRuns([user, reply, { id: 'b', role: 'assistant', content: 'live…' }] as never);
  assert.equal(second[1], first[1], 'same object for the same input message');
  assert.equal((first[1] as unknown as { metadata: { custom: { replyRun: string } } }).metadata.custom.replyRun, 'r1');
  const changed = { ...reply, content: 'edited' };
  assert.notEqual(withReplyRuns([user, changed] as never)[1], first[1], 'a changed message is a new object');
});

test('streamed text is drawn at most every 100 ms; state changes at once', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(event\.type === 'text' \|\| event\.type === 'reasoning'\) renderSoon\(\);/);
  assert.match(source, /setTimeout\(\(\) => \{ drawTimer = undefined; if \(stream\.current === control\) render\(\); \}, 100\)/);
  assert.match(source, /Show earlier messages \(\{windowed\.hidden\}\)/);
});
