import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiryLabel, researchFromPreview, researchOutcome } from '../src/web-research-model.js';

const data = { query: 'release 4.2', purpose: 'When did it ship?', summary: 'It shipped.', dropped: 2, pagesRead: 3,
  claims: [{ text: 'Shipped on 1 October.', sources: [1, 9] }],
  sources: [{ n: 1, title: 'Release notes', url: 'https://www.example.com/notes', relevance: 0.9, note: 'Official' }, { n: 2, title: 'Bad', url: 'javascript:alert(1)', note: '' }] };

test('the review card reads the web-research preview; only http(s) sources become links', () => {
  assert.equal(researchFromPreview({ kind: 'atlassian-edit', data }), undefined);
  const research = researchFromPreview({ kind: 'web-research', data })!;
  assert.equal(research.query, 'release 4.2'); assert.equal(research.dropped, 2); assert.equal(research.pagesRead, 3);
  assert.equal(research.sources[0]!.href, 'https://www.example.com/notes'); assert.equal(research.sources[0]!.host, 'example.com');
  assert.equal(research.sources[1]!.href, undefined, 'a javascript: URL is never a link');
  assert.deepEqual(research.claims[0]!.sources, [1], 'citations of unknown sources are dropped');
});

test('a finished web_search shows one line: approved (reviewed or not), dismissed with the note, or why it did not run', () => {
  const delivered = { untrusted: true, kind: 'web_research', reviewed: true, notice: 'n', query: 'release 4.2', summary: 'It shipped.', claims: [], sources: [{ n: 1, title: 'Notes', url: 'https://example.com/n', note: '' }] };
  const approved = researchOutcome({ query: 'release 4.2' }, JSON.stringify(delivered));
  assert.equal(approved.label, 'Web research approved: release 4.2');
  assert.equal(approved.state === 'approved' && approved.research.sources.length, 1);
  assert.equal(researchOutcome({ query: 'q' }, { ...delivered, reviewed: false }).label, 'Web research (pre-approved, not reviewed): release 4.2');
  const dismissed = researchOutcome({ query: 'q' }, { error: 'user_denied', message: 'm', note: 'Too old' });
  assert.equal(dismissed.label, 'Web research dismissed: q'); assert.equal(dismissed.state === 'dismissed' && dismissed.note, 'Too old');
  assert.equal(researchOutcome({ query: 'q' }, { error: 'approval_required', tool: 'web_search' }).state, 'needed-approval');
  assert.equal(researchOutcome({ query: 'q' }, { results: 0, query: 'q', message: 'm' }).label, 'Web research found nothing relevant: q');
  const failed = researchOutcome({ query: 'q' }, { error: 'search_unavailable', message: 'm' });
  assert.equal(failed.state, 'failed'); assert.equal('detail' in failed && failed.detail, 'The search engine couldn’t be reached');
});

test('an expired review shows "Web research expired", and the card says when it expires', () => {
  const expired = researchOutcome({ query: 'q' }, { error: 'review_expired', message: 'Web research expired: …' });
  assert.equal(expired.state, 'expired'); assert.equal(expired.label, 'Web research expired: q');
  assert.equal(expiryLabel('2026-10-02T16:52:00Z', () => '4:52 PM'), 'Expires at 4:52 PM if nobody reviews it.');
  assert.equal(expiryLabel(undefined), undefined);
});

test('an escalated review: the line points at its decision; the outcome line reads approved with its age, dismissed or a new search; only the searcher or an admin may review', async () => {
  const { researchOutcome: outcome } = await import('../src/web-research-model.js');
  const { outcomeSummary, mayReview } = await import('../src/decisions-model.js');
  const awaiting = outcome({ query: 'q' }, { awaiting_review: true, decision: 'd1', query: 'q', message: 'm' });
  assert.deepEqual([awaiting.state, 'decision' in awaiting && awaiting.decision], ['awaiting', 'd1']);
  const by = { id: 'u-mia', name: 'Mia' };
  assert.equal(outcomeSummary({ outcome: 'decided', by, kind: 'web-research', question: 'release 4.2', age: '2 hours ago', choice: { id: 'approve', label: 'Approve' } }), 'Web research approved by Mia · from 2 hours ago: release 4.2');
  assert.equal(outcomeSummary({ outcome: 'decided', by, kind: 'web-research', question: 'q', choice: { id: 'reject', label: 'Reject' } }), 'Web research dismissed by Mia: q');
  assert.equal(outcomeSummary({ outcome: 'decided', by, kind: 'web-research', question: 'q', choice: { id: 'search_again', label: 'Search again' } }), 'Mia asked for a new search: q');
  const decision = { kind: 'web-research' as const, reviewer: { id: 'u-mia', name: 'Mia' } };
  assert.equal(mayReview(decision, 'u-mia', false), true); assert.equal(mayReview(decision, 'u-sam', false), false);
  assert.equal(mayReview(decision, 'u-sam', true), true); assert.equal(mayReview(decision, undefined, false), true);
  assert.equal(mayReview({}, 'u-sam', false), true, 'ordinary decisions: any member');
});
