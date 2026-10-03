import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolInteractions } from 'ai-sdk-letta';
import { withPreviews } from '../src/terminal.js';

test('the terminal shows a web research result (not the query arguments) in its approval prompt', async () => {
  const interactions = new ToolInteractions();
  const seen: { title: string; details?: string }[] = [];
  withPreviews(interactions).connect(async request => { seen.push({ title: request.title, ...(request.details ? { details: request.details } : {}) }); return { id: request.id, approved: false }; });
  const signal = new AbortController().signal;
  await interactions.request({ kind: 'approval', toolCallId: 't1', tool: 'web_search', title: 'Approve web_search?', details: '{"query":"x"}', preview: { kind: 'web-research', title: 'x', text: 'Web research: x\n\nSummary text\n\nSources:\n[1] Notes: https://example.com' } }, signal);
  await interactions.request({ kind: 'approval', toolCallId: 't2', tool: 'other', title: 'Approve other?', details: '{"a":1}' }, signal);
  assert.match(seen[0]!.title, /Review web research/);
  assert.match(seen[0]!.details!, /Sources:\n\[1\] Notes: https:\/\/example\.com/);
  assert.deepEqual(seen[1], { title: 'Approve other?', details: '{"a":1}' });
});
