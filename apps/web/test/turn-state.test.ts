import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSummary, isLocked, lockedNotice, stoppedLine } from '../src/turn-state.js';

test('a stopped turn keeps the conversation usable; uncertain ones lock it', () => {
  for (const status of [null, 'running', 'completed', 'stopped']) assert.equal(isLocked(status), false, String(status));
  for (const status of ['failed', 'cancelled', 'interrupted']) assert.equal(isLocked(status), true, status);
});

test('stopped and locked wording says what happened and what to do', () => {
  assert.match(stoppedLine('idle_timeout'), /idle timeout.*continue/);
  assert.match(stoppedLine('max_duration'), /time limit/);
  assert.match(stoppedLine('cancelled'), /^Stopped\. You can continue/);
  assert.match(lockedNotice('delivery_uncertain'), /server restarted.*Check and unlock.*nothing is resent/);
  assert.match(lockedNotice('runtime_failed'), /runtime_failed/);
});

test('Check and unlock reports what Letta has, and never claims a resend', () => {
  assert.match(checkSummary({ unlocked: false, active: true, tools: { calls: 0, unfinished: 0 }, pending: true }), /still working/);
  assert.equal(checkSummary({ unlocked: true, active: false, delivered: true, reply: 'Hi', tools: { calls: 2, unfinished: 1 }, pending: true }), 'Unlocked. Letta received your message, and replied (shown below). One tool call was interrupted.');
  assert.equal(checkSummary({ unlocked: true, active: false, delivered: false, tools: { calls: 0, unfinished: 0 }, pending: false }), 'Unlocked. Letta never received your message (it was not resent).');
});

test('a stopped turn closes its open tool cards as interrupted (live view)', async () => {
  const { observedParts } = await import('../src/messages.js');
  const { failureText } = await import('../src/presentation.js');
  const parts = observedParts([
    { sequence: 1, type: 'tool_started', data: { toolCallId: 'a', name: 'run_command', input: { command: 'sleep 90' } } },
    { sequence: 2, type: 'stopped', data: { code: 'cancelled' } },
  ]) as { type: string; isError?: boolean; result?: unknown }[];
  assert.equal(parts[0]!.isError, true);
  assert.equal(failureText(parts[0]!.result), 'Interrupted: the turn was stopped before this finished.');
});
