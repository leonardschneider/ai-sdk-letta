import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyMessages } from '../src/messages.js';
import { fileAction, rewindError, rewindSections, type RewindSummary } from '../src/rewind-model.js';

const summary: RewindSummary = {
  message: { runId: 'r2', input: 'Plan day two', attachments: 1 },
  turns: [{ runId: 'r2', input: 'Plan day two', kind: 'message' }, { runId: 'r3', input: 'Which format?', kind: 'decision' }],
  resources: { files: [
    { path: 'Trip/plan.md', change: 'modified', status: 'revert' },
    { path: 'Trip/ideas.md', change: 'created', status: 'revert' },
    { path: 'Shared/budget.md', change: 'modified', status: 'conflict', reason: 'changed_later', by: [{ commit: 'c1', subject: 'Agent changes in Other', date: '2026-10-02T10:00:00Z' }] },
  ], kept: [{ commit: 'c2', subject: 'Upload Trip/mine.txt', date: '2026-10-02T10:00:00Z' }] },
  memory: { files: [{ path: 'pet.md', change: 'created', status: 'revert' }], kept: [{ commit: 'c3', subject: 'feat(reflection): consolidate', date: '2026-10-02T10:00:00Z', kind: 'background' }] },
  external: [{ runId: 'r2', tool: 'run_command_online', label: 'Command with internet access', detail: 'pip install requests' }],
  cancel: { decisions: [{ id: 'd1', question: 'Which format?' }], schedules: [{ id: 's1', at: '2026-10-03T09:00:00Z', prompt: 'Remind me', state: 'pending' }] },
};

test('rewind confirmation: every section, in order, with what happens to each file', () => {
  const sections = rewindSections(summary);
  assert.deepEqual(sections.map(s => s.id), ['turns', 'files', 'memory', 'conflicts', 'kept', 'external', 'cancel']);
  assert.equal(sections[0]!.title, 'Removed from this conversation (2 turns)');
  assert.match(sections[0]!.note!, /attachment of the message you edit is not sent again/);
  assert.deepEqual(sections[1]!.lines.map(l => [l.text, l.detail]), [['Trip/plan.md', 'Restored to how it was'], ['Trip/ideas.md', 'Deleted (created by these turns)']]);
  assert.deepEqual(sections[2]!.lines.map(l => l.text), ['pet.md']);
  assert.deepEqual(sections[3]!.lines.map(l => [l.text, l.detail, l.tone]), [['Shared/budget.md', 'Kept as it is now: changed later by “Agent changes in Other”', 'warn']]);
  assert.deepEqual(sections[4]!.lines.map(l => l.detail), ['Not made by these turns; kept', 'Background memory work (dreaming); kept']);
  assert.equal(sections[5]!.lines[0]!.tone, 'danger');
  assert.deepEqual(sections[6]!.lines.map(l => l.text), ['Decision: Which format?', 'Scheduled task: Remind me']);
  assert.equal(fileAction({ change: 'deleted' }), 'Restored (deleted by these turns)');
});

test('rewind confirmation: empty sections are left out', () => {
  const sections = rewindSections({ ...summary, message: { runId: 'r2', input: 'x' }, resources: null, memory: { files: [], kept: [] }, external: [], cancel: { decisions: [], schedules: [] } });
  assert.deepEqual(sections.map(s => s.id), ['turns']);
  assert.equal(sections[0]!.note, undefined);
});

test('rewind errors: fixed codes get plain wording; anything else says nothing changed', () => {
  assert.match(rewindError('rewind_not_solo'), /only you wrote in/);
  assert.match(rewindError('runtime_busy'), /Wait until the agent has finished/);
  assert.equal(rewindError('something_else'), 'Couldn’t rewind. Nothing was changed.');
});

test('history: user messages carry the run they were sent as (their OTID), which Edit uses', () => {
  const messages = historyMessages([
    { id: 'h1', role: 'user', parts: [{ type: 'text', text: 'hello' }], metadata: { otid: '11111111-1111-4111-8111-111111111111' } },
    { id: 'h2', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
    { id: 'h3', role: 'user', parts: [{ type: 'text', text: 'old' }], metadata: { otid: 'not-a-run' } },
  ]);
  assert.equal((messages[0]!.metadata?.custom as { runId?: string }).runId, '11111111-1111-4111-8111-111111111111');
  assert.equal((messages[2]!.metadata?.custom as { runId?: string } | undefined)?.runId, undefined);
});
