import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automationError, relativeTime, scheduleState, sourceLabel } from '../src/automations-model.js';
import { historyMessages } from '../src/messages.js';
import { failureText, toolLabel } from '../src/presentation.js';

test('the via badge names what started a turn', () => {
  assert.equal(sourceLabel({ kind: 'automation', via: 'n8n' }), 'via n8n');
  assert.equal(sourceLabel({ kind: 'automation', via: 'conductor' }), 'via Conductor');
  assert.equal(sourceLabel({ kind: 'automation', via: 'api' }), 'via API');
  assert.equal(sourceLabel({ kind: 'schedule', via: 'n8n' }), 'scheduled · n8n');
  assert.equal(sourceLabel(undefined), undefined);
});

test('history keeps a well-formed source on user messages only, and drops malformed ones', () => {
  const messages = historyMessages([
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Nightly summary' }], metadata: { source: { kind: 'automation', via: 'n8n', name: 'Nightly' } } },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Done' }], metadata: { source: { kind: 'automation', via: 'n8n', name: 'Nightly' } } },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Hi' }], metadata: { source: { kind: 'automation', via: 'zapier', name: 'x' } } },
    { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'Me' }] },
  ]);
  const sources = messages.map(m => (m.metadata?.custom as { source?: unknown } | undefined)?.source);
  assert.deepEqual(sources, [{ kind: 'automation', via: 'n8n', name: 'Nightly' }, undefined, undefined, undefined]);
});

test('unattended refusals read as such in tool lines', () => {
  assert.equal(toolLabel('publish', 'error', { error: 'approval_required' }), 'Needed approval: Publish');
  assert.equal(toolLabel('ask_user', 'error', { error: 'question_required' }), 'Needed an answer (unattended)');
  assert.match(failureText({ error: 'approval_required' }), /started by an automation/);
});

test('scheduled task states and relative times', () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  assert.equal(relativeTime('2026-10-02T10:00:20Z', now), 'just now');
  assert.match(relativeTime('2026-10-02T12:00:00Z', now), /2 hours/);
  assert.match(scheduleState({ state: 'scheduled', at: '2026-10-02T10:30:00Z' }, now), /^Runs in 30 minutes$/);
  assert.equal(scheduleState({ state: 'cancelled', at: '2026-10-02T10:30:00Z' }, now), 'Cancelled');
  assert.equal(scheduleState({ state: 'fired', at: '2026-10-02T09:00:00Z', run: { id: 'r', threadId: 't', status: 'failed', error: 'approval_required' } }, now), 'Ran, but needed approval');
  assert.equal(scheduleState({ state: 'fired', at: '2026-10-02T09:00:00Z', firedAt: '2026-10-02T09:00:00Z', run: { id: 'r', threadId: 't', status: 'completed' } }, now), 'Ran 1 hour ago');
  assert.equal(automationError('admin_required'), 'Only admins of this agent manage automations.');
  assert.equal(automationError('anything'), 'That didn’t work. Nothing was changed.');
});
