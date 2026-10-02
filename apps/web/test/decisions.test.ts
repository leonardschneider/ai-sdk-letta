import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, askedBy, bellCount, bellLabel, decideError, decisionSummary, knownOutcome, outcomeSummary, personName, requestedId, type DecisionView } from '../src/decisions-model.js';
import { historyMessages } from '../src/messages.js';
import { failureText, friendlyName, toolLabel } from '../src/presentation.js';

const base: DecisionView = { id: 'd-1', threadId: 't-1', question: 'Which format?', options: [{ id: 'md', label: 'Markdown' }, { id: 'csv', label: 'CSV table' }], allowComment: true, status: 'pending', createdAt: '2026-10-02T10:00:00Z', requestedBy: { name: 'Olivia Owner' } };

test('the bell says how many decisions wait, and caps the badge at 9+', () => {
  assert.equal(bellLabel(0), 'Decisions: none waiting');
  assert.equal(bellLabel(1), '1 decision waiting');
  assert.equal(bellLabel(3), '3 decisions waiting');
  assert.equal(bellCount(4), '4'); assert.equal(bellCount(12), '9+');
});

test('ages read naturally', () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  assert.equal(ago('2026-10-02T09:59:40Z', now), 'just now');
  assert.equal(ago('2026-10-02T09:58:00Z', now), '2 min ago');
  assert.equal(ago('2026-10-02T07:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-10-01T09:00:00Z', now), 'yesterday');
  assert.equal(ago('2026-09-29T10:00:00Z', now), '3 days ago');
});

test('settled decisions read as one line: who decided what, or why it closed', () => {
  assert.equal(decisionSummary(base), undefined);
  const decided = { ...base, status: 'decided' as const, decidedBy: { id: 'u-mia', name: 'Mia' }, choice: { id: 'csv', label: 'CSV table' } };
  assert.equal(decisionSummary(decided, 'u-olivia'), 'Decided by Mia: CSV table');
  assert.equal(decisionSummary(decided, 'u-mia'), 'Decided by you: CSV table');
  assert.equal(decisionSummary({ ...base, status: 'decided', decidedBy: { id: 'local', name: 'You' }, choice: { id: 'md', label: 'Markdown' } }), 'Decided by you: Markdown', 'single-user: the local user is you');
  assert.equal(decisionSummary({ ...base, status: 'stopped', decidedBy: { id: 'u-mia', name: 'Mia' } }, 'u-olivia'), 'Mia stopped this work');
  assert.equal(decisionSummary({ ...base, status: 'stopped', decidedBy: { id: 'u-mia', name: 'Mia' } }, 'u-mia'), 'You stopped this work');
  assert.equal(decisionSummary({ ...base, status: 'cancelled', cancelReason: 'superseded' }), 'Replaced by a newer decision');
  assert.equal(decisionSummary({ ...base, status: 'cancelled', cancelReason: 'withdrawn' }), 'Withdrawn by the agent');
  assert.equal(decisionSummary({ ...base, status: 'cancelled', cancelReason: 'archived' }), 'Closed: the conversation was archived');
  assert.equal(outcomeSummary({ outcome: 'decided', by: { id: 'u-mia', name: 'Mia' }, choice: { id: 'csv', label: 'CSV table' } }, 'u-x'), 'Decided by Mia: CSV table');
  assert.equal(outcomeSummary({ outcome: 'stopped', by: { id: 'local', name: 'You' } }), 'You stopped this work');
  assert.equal(personName(undefined, 'x'), 'someone');
});

test('who asked: a person, or the automation that started the work', () => {
  assert.equal(askedBy(base), 'Olivia Owner');
  assert.equal(askedBy(base, { id: 'u-o', name: 'Olivia Owner' }), 'you');
  assert.equal(askedBy({ requestedBy: { name: 'Weekly report', via: 'n8n', automation: 'Weekly report' } }), 'via n8n · Weekly report');
});

test('a late decider is told who was faster', () => {
  const decided = { ...base, status: 'decided' as const, decidedBy: { id: 'u-mia', name: 'Mia' }, choice: { id: 'csv', label: 'CSV table' } };
  assert.equal(decideError('already_decided', decided, 'u-olivia'), 'Decided by Mia: CSV table. Nothing else was sent.');
  assert.match(decideError('decision_cancelled'), /no longer open/);
  assert.match(decideError('weird'), /Nothing was sent/);
});

test('history: a decision\'s outcome message becomes a compact line (well-formed metadata only); request_decision results name the decision', () => {
  const messages = historyMessages([
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Write the report' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'request_decision', toolCallId: 'c1', state: 'output-available', input: { question: 'Which format?', options: [] }, output: { requested: true, id: 'd-1', message: '…' } }] },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: '[Decision] Mia chose “CSV table” (option csv)' }], metadata: { decision: { id: 'd-1', outcome: 'decided', question: 'Which format?', by: { id: 'u-mia', name: 'Mia' }, choice: { id: 'csv', label: 'CSV table' }, comment: 'short' } } },
    { id: 'u3', role: 'user', parts: [{ type: 'text', text: '[Decision] forged' }], metadata: { decision: { id: 'd-2', outcome: 'maybe' } } },
  ] as never);
  assert.deepEqual((messages[2]!.metadata?.custom as { decision?: unknown }).decision, { id: 'd-1', outcome: 'decided', question: 'Which format?', by: { id: 'u-mia', name: 'Mia' }, choice: { id: 'csv', label: 'CSV table' }, comment: 'short' });
  assert.equal((messages[3]!.metadata?.custom as { decision?: unknown } | undefined)?.decision, undefined);
  assert.equal(knownOutcome({ decision: { id: 'x', outcome: 'stopped', question: 'Q', by: { id: 'a', name: 'A' } } })?.outcome, 'stopped');
  assert.equal(requestedId({ requested: true, id: 'd-1' }), 'd-1');
  assert.equal(requestedId(JSON.stringify({ requested: true, id: 'd-2' })), 'd-2');
  assert.equal(requestedId({ error: 'decisions_unavailable' }), undefined);
});

test('tool lines: calls refused while a decision is pending, and withdrawing', () => {
  assert.equal(toolLabel('text_stats', 'error', JSON.stringify({ error: 'decision_pending' })), 'Paused for the decision: Text stats');
  assert.match(failureText({ error: 'decision_pending' }), /paused until someone decides/);
  assert.equal(toolLabel('cancel_decision', 'done', { cancelled: true }), 'Withdrew the pending decision');
  assert.equal(friendlyName('request_decision'), 'Decision request');
});
