import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duration, exposureLine, filesLine, memoryError, refusalReason, revertToast, reviewerOptions, sourceChip, trustChip, verdictChip, type MemoryReviewView } from '../src/memory-model.js';
import { mayReview, memoryDecisionSummary } from '../src/decisions-model.js';
import { rewindSections, type RewindSummary } from '../src/rewind-model.js';

const review = (over: Partial<MemoryReviewView> = {}): MemoryReviewView => ({ id: 'r1', kind: 'turn', files: [{ path: 'notes/ops.md', protected: false, change: 'modified' }], status: 'done', verdict: 'accept', outcome: 'kept', createdAt: '2026-10-03T10:00:00Z', provenance: 'Bob (member) · read web research', ...over });

test('memory chips: verdict, trust and source', () => {
  assert.deepEqual(verdictChip(review()), { label: 'Accepted', tone: 'ok' });
  assert.deepEqual(verdictChip(review({ status: 'pending' })), { label: 'Reviewing…', tone: 'pending' });
  assert.deepEqual(verdictChip(review({ verdict: 'flag' })), { label: 'Flagged', tone: 'flag' });
  assert.deepEqual(verdictChip(review({ verdict: 'flag', error: 'review_timeout' })), { label: 'Kept · review failed', tone: 'flag' });
  assert.deepEqual(verdictChip(review({ verdict: 'reject', outcome: 'reverted' })), { label: 'Reverted', tone: 'reverted' });
  assert.deepEqual(verdictChip(review({ verdict: 'ask_human', outcome: 'removed' })), { label: 'Removed until approved', tone: 'held' });
  assert.deepEqual(verdictChip(review({ verdict: 'ask_human', outcome: 'reapplied' })), { label: 'Approved and re-applied', tone: 'ok' });
  assert.deepEqual(verdictChip(review({ kind: 'dream', verdict: 'reject', outcome: 'blocked', beforeMerge: { decision: 'reject', branch: 'b' } })), { label: 'Blocked before merging', tone: 'reverted' });
  assert.equal(trustChip(review({ jiminy: { trust: 0.9234, verdict: 'accept', reason: 'fine' } })), 'trust 0.92');
  assert.equal(trustChip(review()), undefined);
  assert.equal(sourceChip(review({ kind: 'dream' })), 'Dream');
  assert.equal(sourceChip(review()), 'Bob (member) · read web research');
  assert.equal(filesLine(review({ files: [{ path: 'a.md', protected: true, change: 'modified' }, { path: 'b.md', protected: false, change: 'created' }] })), 'a.md, b.md');
});

test('dream exposure window: none before merging; otherwise how long it was in memory', () => {
  assert.equal(exposureLine(review()), undefined);
  assert.equal(exposureLine(review({ kind: 'dream', beforeMerge: { decision: 'reject', branch: 'b' } })), 'Reviewed before it merged: never in memory unreviewed.');
  assert.equal(exposureLine(review({ kind: 'dream', outcome: 'reverted', exposureMs: 7400 })), 'Merged before review: in memory for 7.4 s until it was removed.');
  assert.equal(exposureLine(review({ kind: 'dream', outcome: 'kept', exposureMs: 45_000 })), 'Merged before review; reviewed 45 s later.');
  assert.equal(duration(180_000), '3 min');
});

test('toasts and errors', () => {
  assert.equal(revertToast({ files: ['notes/ops.md'], held: false, kind: 'turn', reason: 'credential exfiltration' }), 'A memory change to notes/ops.md was reverted by the memory review: credential exfiltration');
  assert.equal(revertToast({ files: ['a.md', 'b.md', 'c.md'], held: true, kind: 'dream' }), 'A dream’s memory change to a.md, b.md +1 was removed until someone approves it (see the bell).');
  assert.match(revertToast({ files: ['n.md'], held: false, kind: 'turn', reason: 'Unattended automation writing from untrusted web source instructs copying deploy keys to an external escrow URL, classic exfiltration attempt here' }), /escrow URL, classic exfiltration…$/);
  assert.match(memoryError('admin_required'), /Only an admin/);
  assert.match(memoryError('weird'), /Couldn’t load/);
  assert.match(refusalReason({ code: 'protected_memory' }), /Protected file/);
  assert.match(refusalReason({ code: 'new_root_file' }), /New root file/);
  assert.deepEqual(reviewerOptions(['openai-codex/gpt-5.5', 'anthropic/claude-sonnet-5'], 'anthropic/claude-haiku-4-5').map(o => o.value), ['auto', 'anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-5', 'openai-codex/gpt-5.5']);
});

test('memory review decisions: protected files are for admins; others for the turn\'s author or an admin', () => {
  const base = { kind: 'memory-review' as const, reviewer: { id: 'u-bob', name: 'Bob' } };
  const memory = { reviewId: 'r', files: [], diff: '', provenance: '', protected: false, adminOnly: false, kind: 'turn' as const };
  assert.equal(mayReview({ ...base, memory }, 'u-bob', false), true);
  assert.equal(mayReview({ ...base, memory }, 'u-mia', false), false);
  assert.equal(mayReview({ ...base, memory: { ...memory, protected: true, adminOnly: true } }, 'u-bob', false), false);
  assert.equal(mayReview({ ...base, memory: { ...memory, protected: true, adminOnly: true } }, 'u-alice', true), true);
  assert.equal(mayReview({ ...base, memory }, undefined, false), true, 'single-user app');
  assert.equal(memoryDecisionSummary({ status: 'decided', decidedBy: { id: 'u-mia', name: 'Mia' }, choice: { id: 'approve', label: 'Approve' }, memory: { ...memory, outcome: 'reapplied' } }), 'Approved by Mia: re-applied');
  assert.equal(memoryDecisionSummary({ status: 'decided', decidedBy: { id: 'local', name: 'You' }, choice: { id: 'reject', label: 'Reject' } }), 'Rejected by you: kept removed');
});

test('rewind confirmation lists the turns\' memory commits with provenance chips', () => {
  const summary = { message: { runId: 'r1', input: 'x' }, turns: [{ runId: 'r1', input: 'x', kind: 'message' }], resources: null,
    memory: { files: [], kept: [{ commit: 'k1', subject: 'merge(reflection): x', date: '', kind: 'background', provenance: 'Dreaming', review: 'reject · trust 0.05' }],
      commits: [{ commit: 'c1', subject: 'Agent memory changes', date: '', provenance: 'You (admin)', review: 'accept · trust 0.95' }] },
    external: [], cancel: { decisions: [], schedules: [] } } as unknown as RewindSummary;
  const sections = rewindSections(summary);
  const commits = sections.find(s => s.id === 'memory-commits')!;
  assert.equal(commits.title, 'Memory changes these turns made (1 commit)');
  assert.deepEqual(commits.lines[0]!.chips, ['You (admin)', 'accept · trust 0.95']);
  assert.deepEqual(sections.find(s => s.id === 'kept')!.lines[0]!.chips, ['Dreaming', 'reject · trust 0.05']);
});
