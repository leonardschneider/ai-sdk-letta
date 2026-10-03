/** Pure model of the Memory view: reviews of the agent's memory changes, their chips, and toast wording. No I/O. */

export type MemoryFile = { path: string; protected: boolean; change: 'created' | 'modified' | 'deleted' };
/** A memory review as the server shows it (`PublicMemoryReview` in @ai-sdk-letta/server). */
export type MemoryReviewView = {
  id: string; kind: 'turn' | 'dream'; files: MemoryFile[]; status: 'pending' | 'done';
  verdict?: 'accept' | 'flag' | 'ask_human' | 'reject'; floor?: string; rule?: string;
  outcome?: 'kept' | 'reverted' | 'removed' | 'reapplied' | 'kept_removed' | 'blocked';
  decision?: string; mergedAt?: string; createdAt: string; settledAt?: string; error?: string;
  beforeMerge?: { decision: 'approve' | 'reject' | 'approve_paths'; paths?: string[]; branch: string };
  provenance: string; threadId?: string; diff?: string;
  jiminy?: { trust: number; verdict: string; reason: string; model?: string; ms?: number };
  exposureMs?: number;
};
/** A memory write the guard refused (protected file, or a new root file from an untrusted turn). */
export type MemoryRefusalView = { path: string; code: 'protected_memory' | 'new_root_file' | string; tool: string; at: string; provenance?: string; threadId?: string };
export type MemoryData = { reviews: MemoryReviewView[]; refused?: MemoryRefusalView[]; reviewer?: { model: string; available: string[] } };
/** Why a write was refused, in a few words. */
export const refusalReason = (refusal: Pick<MemoryRefusalView, 'code'>) => refusal.code === 'protected_memory' ? 'Protected file: only an admin’s own turn with no untrusted content may change it' : refusal.code === 'new_root_file' ? 'New root file from a turn that read untrusted content' : 'Refused';
export type MemoryRevert = { id: string; at: string; files: string[]; reason?: string; held: boolean; kind: 'turn' | 'dream' };
/** One section of a memory file's provenance (`GET /v1/memory/provenance`). */
export type ProvenanceSection = { lines: string; from: number; to: number; by: string; at: string; turn?: string; commit: string; review?: string };

/** Tone of a chip: how the change came out. */
export type ChipTone = 'ok' | 'flag' | 'held' | 'reverted' | 'pending' | 'neutral';

/** The verdict chip of a review: "Accepted", "Flagged", "Removed until approved", "Reverted", "Approved and re-applied", "Reviewing…". */
export function verdictChip(review: Pick<MemoryReviewView, 'status' | 'verdict' | 'outcome' | 'beforeMerge' | 'error'>): { label: string; tone: ChipTone } {
  if (review.status === 'pending') return { label: 'Reviewing…', tone: 'pending' };
  if (review.outcome === 'blocked') return { label: 'Blocked before merging', tone: 'reverted' };
  if (review.outcome === 'reapplied') return { label: 'Approved and re-applied', tone: 'ok' };
  if (review.outcome === 'kept_removed') return { label: 'Rejected by a person', tone: 'reverted' };
  if (review.outcome === 'removed') return { label: 'Removed until approved', tone: 'held' };
  if (review.outcome === 'reverted') return { label: 'Reverted', tone: 'reverted' };
  if (review.verdict === 'flag') return { label: review.error ? 'Kept · review failed' : 'Flagged', tone: 'flag' };
  if (review.beforeMerge?.decision === 'approve_paths') return { label: 'Partly approved before merging', tone: 'flag' };
  if (review.beforeMerge) return { label: 'Approved before merging', tone: 'ok' };
  return { label: 'Accepted', tone: 'ok' };
}
/** The trust chip: "trust 0.92" (two decimals), or nothing when Jiminy did not answer. */
export const trustChip = (review: Pick<MemoryReviewView, 'jiminy'>) => review.jiminy ? `trust ${review.jiminy.trust.toFixed(2)}` : undefined;
/** What the review was about: "Dream", or the turn's provenance. */
export const sourceChip = (review: Pick<MemoryReviewView, 'kind' | 'provenance'>) => review.kind === 'dream' ? 'Dream' : review.provenance;
/** The files line: "notes/ops.md, human.md" (protected ones marked with a lock in the view). */
export const filesLine = (review: Pick<MemoryReviewView, 'files'>) => review.files.map(f => f.path).join(', ');

/** "1.2 s", "45 s", "3 min": how long a dream was in memory before its review removed it. */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
/** The exposure line of a dream: before merging none; merged then reviewed, how long it was in memory. */
export function exposureLine(review: Pick<MemoryReviewView, 'kind' | 'beforeMerge' | 'exposureMs' | 'outcome'>): string | undefined {
  if (review.kind !== 'dream') return undefined;
  if (review.beforeMerge) return 'Reviewed before it merged: never in memory unreviewed.';
  if (review.exposureMs === undefined) return undefined;
  return review.outcome === 'reverted' || review.outcome === 'removed'
    ? `Merged before review: in memory for ${duration(review.exposureMs)} until it was removed.`
    : `Merged before review; reviewed ${duration(review.exposureMs)} later.`;
}

/** Toast wording for a change the guard reverted or held. */
export function revertToast(revert: Pick<MemoryRevert, 'files' | 'held' | 'kind' | 'reason'>): string {
  const what = revert.kind === 'dream' ? 'A dream’s memory change' : 'A memory change';
  const files = revert.files.slice(0, 2).join(', ') + (revert.files.length > 2 ? ` +${revert.files.length - 2}` : '');
  return revert.held
    ? `${what} to ${files} was removed until someone approves it (see the bell).`
    : `${what} to ${files} was reverted by the memory review${revert.reason ? `: ${clip(revert.reason, 140)}` : '.'}`;
}
/** Text shortened at a word boundary, with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

/** Wording for the Memory view's failures (fixed server codes). */
export function memoryError(code: string): string {
  return ({
    memory_unavailable: 'Open a conversation first: the memory review starts with the agent.',
    not_found: 'That memory file doesn’t exist (any more).',
    invalid_input: 'Memory paths are Markdown files inside the agent’s memory, such as human.md.',
    admin_required: 'Only an admin of this agent can change the reviewer.',
    session_required: 'The local server restarted. Refresh the page.', csrf_required: 'The local server restarted. Refresh the page.',
  } as Record<string, string>)[code] ?? 'Couldn’t load the memory review. Try again.';
}

/** The reviewer options: Automatic first, then the connected models. */
export function reviewerOptions(available: readonly string[], current: string): { value: string; label: string }[] {
  const models = [...new Set([...available, ...(current !== 'auto' ? [current] : [])])].sort();
  return [{ value: 'auto', label: 'Automatic (prefers another model family)' }, ...models.map(model => ({ value: model, label: model }))];
}
