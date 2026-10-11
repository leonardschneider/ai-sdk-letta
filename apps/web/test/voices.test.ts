import test from 'node:test';
import assert from 'node:assert/strict';
import { withReplyRuns } from '../src/messages.js';

test('each assistant reply carries the run of the message before it (what the inner voices weigh)', () => {
  const messages = withReplyRuns([
    { id: 'u1', role: 'user', content: 'hi', metadata: { custom: { runId: 'r1' } } },
    { id: 'a1', role: 'assistant', content: 'hello' },
    { id: 'u2', role: 'user', content: 'from history without a run' },
    { id: 'a2', role: 'assistant', content: 'ok' },
  ]);
  assert.equal((messages[1]!.metadata?.custom as { replyRun?: string }).replyRun, 'r1');
  assert.equal((messages[3]!.metadata?.custom as { replyRun?: string } | undefined)?.replyRun, undefined);
});
