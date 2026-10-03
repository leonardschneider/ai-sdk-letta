import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryJournal, TurnCommits } from './memory-journal.js';
import { AGENT_EMAIL, harnessCommit } from './memory-journal.js';
import { changedBy, commitsSince, headOf, type GitRunner } from './revert.js';
import { adminClean, blameProvenance, commitTrailers, parseProvenanceTrailers, PROVENANCE_TRAILERS, provenanceLabel, provenanceTrailers, sections, untrusted, type TurnProvenance } from './provenance.js';
import type { DreamRequest, DreamResponse } from './dream-review.js';
import { stricter, type JiminyVerdict, type MemoryReviewer, type Verdict } from './jiminy.js';

/**
 * Memory protection and review: the harness side of the agent's conscience.
 *
 * **Protected files.** Some memory files hold the agent's directives (by
 * default `persona.md`, `rules.md`, `goals.md`, `MEMORY.md`, and the older
 * layout's `system/**`). Only an *admin turn with no untrusted content* may
 * change them: an attended turn of a person whose role is `admin` that read
 * no web research, attachment, Atlassian content or other tool output.
 * {@link MemoryGuard.allows} refuses any other write to them (also under
 * another letter case), and any new root `.md` file from an untrusted turn
 * (root files are in the system prompt).
 *
 * **Changes outside turns** (dreaming, or anything else that commits to
 * memory) that touch a protected file are reverted at once, without asking
 * anyone ({@link MemoryGuard.watch}).
 *
 * **Review.** Every memory-changing turn, and every dream merge, is reviewed
 * in the background by Jiminy (a {@link MemoryReviewer}). The harness decides
 * a floor first ({@link reviewFloor}); Jiminy can only make it stricter.
 *
 * - `accept`: kept.
 * - `flag`: kept, and shown to people.
 * - `reject`: reverted at once (a new commit; see `MemoryJournal.revertCommits`).
 * - `ask_human`: reverted at once too ("removed until approved"), and a
 *   *memory review* decision is opened; approving it re-applies the change
 *   (a new commit whose provenance names who approved), rejecting keeps it removed.
 * - A review that fails (the reviewer errs or times out) counts as `flag`,
 *   or `reject` when a protected file changed.
 *
 * The next turn of the agent waits for pending reviews of turns that
 * touched protected files ({@link MemoryGuard.settled}).
 *
 * Nothing here is ever written into memory files: provenance and review
 * outcomes live in commit trailers and the guard's records.
 *
 * @module
 */

/** Which memory files are protected (see the module notes). Patterns: exact paths, or a folder with `/**`. Matched case-insensitively. */
export const DEFAULT_PROTECTED_MEMORY = Object.freeze(['persona.md', 'rules.md', 'goals.md', 'MEMORY.md', 'system/**']);
/**
 * Whether a change to a protected file is only index upkeep: `MEMORY.md`
 * (the index of memory files) gaining or losing link lines to files that
 * exist, nothing else. Dreaming does this whenever it adds a file; reverting
 * it would leave the new file unindexed, so it is allowed (the new file
 * itself is reviewed). Anything else in the index, or any other protected
 * file, is not upkeep.
 */
export function isIndexUpkeep(path: string, diff: string): boolean {
  if (path.toLowerCase() !== 'memory.md') return false;
  const changed = diff.split('\n').filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)).map(line => line.slice(1).trim()).filter(Boolean);
  return changed.length > 0 && changed.every(line => /^[-*] \[[^\]\n]{1,120}\]\((?!\w+:)[\w ./-]{1,200}\.md\)$/.test(line));
}

/** How memory is protected and reviewed (the definition's `memory` setting). */
export interface MemorySafetySettings {
  /** Protected files. @default {@link DEFAULT_PROTECTED_MEMORY} */
  protected: readonly string[];
  /**
   * The reviewer's model: a handle, `'auto'` (another model family than the
   * agent's when one is connected, else the agent's model), or `'off'` (no
   * review; protected files stay protected). @default 'auto'
   */
  reviewer: string;
  /** Most time one review may take before it counts as failed. @default 90000 */
  reviewTimeoutMs: number;
}
export const DEFAULT_MEMORY_SAFETY: Readonly<MemorySafetySettings> = Object.freeze({ protected: DEFAULT_PROTECTED_MEMORY, reviewer: 'auto', reviewTimeoutMs: 90_000 });

/** Whether `path` (relative to the memory root, `/`-separated) is protected by one of `patterns` (case-insensitive). */
export function isProtectedPath(path: string, patterns: readonly string[] = DEFAULT_PROTECTED_MEMORY): boolean {
  const lower = path.toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
  return patterns.some(pattern => {
    const p = pattern.toLowerCase();
    return p.endsWith('/**') ? lower.startsWith(p.slice(0, -2)) : lower === p;
  });
}

/** Why a memory write is refused (fixed codes, with the message the agent gets). */
export type MemoryRefusal = { code: 'protected_memory' | 'new_root_file'; path: string; message: string };

/**
 * The harness floor of a review: what the change gets whatever Jiminy says.
 * Protected files changed outside an admin turn with no untrusted content
 * are rejected (they should have been refused or reverted already; this is
 * defence in depth). Everything else starts at `accept`.
 */
export function reviewFloor(files: readonly { path: string; protected: boolean; upkeep?: boolean }[], provenance: Pick<TurnProvenance, 'actor' | 'unattended' | 'sources' | 'writer'>): { floor: Verdict; rule?: string } {
  // Index upkeep (see isIndexUpkeep) is not a directive change.
  const touchesProtected = files.some(f => f.protected && !f.upkeep);
  if (touchesProtected && provenance.writer !== 'agent') return { floor: 'reject', rule: 'protected file changed outside a turn' };
  if (touchesProtected && !adminClean(provenance)) return { floor: 'reject', rule: 'protected file changed outside an admin turn with no untrusted content' };
  return { floor: 'accept' };
}
/** What a failed review counts as: `flag`, or `reject` when a protected file changed. */
export function failedReview(files: readonly { protected: boolean; upkeep?: boolean }[]): Verdict { return files.some(f => f.protected && !f.upkeep) ? 'reject' : 'flag'; }

/** One review, as recorded and shown. */
export type MemoryReview = {
  id: string;
  /** What was reviewed: a turn's commits, or a dream (reflection) merge. */
  kind: 'turn' | 'dream';
  turn?: string; conversationId?: string;
  commits: string[];
  /** `upkeep`: a protected index changed only by link lines (see {@link isIndexUpkeep}). */
  files: { path: string; protected: boolean; change: 'created' | 'modified' | 'deleted'; upkeep?: boolean }[];
  provenance: Omit<TurnProvenance, 'conversationId'>;
  status: 'pending' | 'done';
  /** The final verdict (floor and Jiminy's, the stricter), and how it came about. */
  verdict?: Verdict; floor?: Verdict; rule?: string;
  jiminy?: Pick<JiminyVerdict, 'trust' | 'verdict' | 'reason' | 'alters_directives' | 'evidence'> & { model?: string; ms?: number; costUsd?: number };
  error?: string;
  /** What happened to the change: kept, reverted (`revert` commit), removed until a person decides, re-applied after approval. */
  outcome?: 'kept' | 'reverted' | 'removed' | 'reapplied' | 'kept_removed' | 'blocked';
  revert?: string; reapply?: string;
  /** The memory review decision (ask_human). */
  decision?: string;
  /** Dreams: when the merge happened and when the review settled it (the exposure window). */
  mergedAt?: string;
  /** Dreams reviewed before merging (the harness asked first): what was answered. Exposure window: none. */
  beforeMerge?: { decision: DreamResponse['decision']; paths?: string[]; branch: string };
  createdAt: string; settledAt?: string;
  /** The (bounded) diff that was reviewed, for people. */
  diff?: string;
  /** Only these paths of the commits were reviewed (the others were reverted already). */
  paths?: string[];
};

/** What the guard tells the application (the server): a review settled, a change was reverted, a person must decide. */
export interface MemoryGuardEvents {
  /** A review needs a person (`ask_human`): open a memory review decision. Resolves with its ID. */
  askHuman?(review: MemoryReview): Promise<string | undefined>;
  /** Something changed (a review started or settled, a revert): refresh views. `reverted`: a change was reverted (show a toast). */
  changed?(review: MemoryReview, event: 'started' | 'settled' | 'reverted'): void;
}

/** Options of {@link MemoryGuard}. */
export interface MemoryGuardOptions {
  journal: MemoryJournal;
  settings?: Partial<MemorySafetySettings>;
  /** Reviews memory changes; without it, nothing is reviewed (protected files stay protected). */
  reviewer?: MemoryReviewer;
  /** The author name the agent's own commits use (to tell dreaming from turns). */
  events?: MemoryGuardEvents;
  /** Most reviews kept in memory for display. @default 200 */
  keep?: number;
  /** Where reviews are kept across restarts (JSON). Optional. */
  file?: string;
  log?: (line: string) => void;
}

const REFLECTION = /reflection/i;
/** One guard per memory directory in this process (several hosts or reopened agents share it, so reviews are never lost between instances). */
const guards = new Map<string, MemoryGuard>();

/** The memory guard of one agent. See the module notes. */
export class MemoryGuard {
  /**
   * The guard of an agent's memory: one per memory directory in this process.
   * A closed guard is replaced by a new one (it reloads the recorded reviews).
   */
  static open(options: MemoryGuardOptions): MemoryGuard {
    const key = options.journal.memoryDirectory;
    const existing = guards.get(key);
    if (existing && !existing.closed) return existing;
    const created = new MemoryGuard(options);
    guards.set(key, created);
    return created;
  }
  readonly settings: MemorySafetySettings;
  private reviews: MemoryReview[] = [];
  private pending = new Map<string, Promise<void>>();
  private lastSeen?: string;
  private watching?: ReturnType<typeof setInterval>;
  closed = false;
  constructor(readonly options: MemoryGuardOptions) {
    this.settings = { ...DEFAULT_MEMORY_SAFETY, ...options.settings };
    if (options.file && existsSync(options.file)) {
      try { const saved = JSON.parse(readFileSync(options.file, 'utf8')) as { reviews?: MemoryReview[]; lastSeen?: string }; this.reviews = saved.reviews ?? []; this.lastSeen = saved.lastSeen; this.interrupted = this.reviews.filter(r => r.status === 'pending').map(r => r.id); }
      catch { /* start empty */ }
    }
  }
  private get git(): GitRunner { return this.options.journal.git; }
  private get root() { return this.options.journal.memoryDirectory; }
  private persist() {
    if (!this.options.file) return;
    try {
      const temporary = `${this.options.file}.tmp-${randomUUID()}`;
      writeFileSync(temporary, JSON.stringify({ version: 1, lastSeen: this.lastSeen, reviews: this.reviews.slice(-(this.options.keep ?? 200)) }), { mode: 0o600 });
      renameSync(temporary, this.options.file);
    } catch { /* display only */ }
  }

  /* ---------------- protected files ---------------- */

  /** The memory-root-relative path of an absolute tool path, or `undefined` outside the memory. */
  relativePath(filePath: string): string | undefined {
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) return undefined;
    let suffix = relative(resolve(this.root), resolve(filePath));
    if (suffix.startsWith(`..${sep}`) || suffix === '..' || isAbsolute(suffix)) {
      try { suffix = relative(realpathSync(this.root), resolve(filePath)); } catch { return undefined; }
      if (suffix.startsWith(`..${sep}`) || suffix === '..' || isAbsolute(suffix)) return undefined;
    }
    return suffix.split(sep).join('/');
  }
  /** Whether a memory-relative path is protected, also under another letter case (case-insensitive file systems), and by its real name. */
  protects(path: string): boolean {
    if (isProtectedPath(path, this.settings.protected)) return true;
    try {
      const real = realpathSync.native(join(this.root, ...path.split('/')));
      const canonical = relative(realpathSync(this.root), real).split(sep).join('/');
      return isProtectedPath(canonical, this.settings.protected);
    } catch { return false; }
  }
  /**
   * Whether a memory tool call may write `filePath` in a turn with this
   * provenance. Protected files: only an admin turn with no untrusted
   * content. A new `.md` file at the memory root (it would join the system
   * prompt): not from a turn that read untrusted content, nor from an
   * unattended one. Everything else: allowed (the review follows).
   */
  allows(tool: string, filePath: unknown, provenance: TurnProvenance | undefined): MemoryRefusal | undefined {
    if (tool !== 'Write' && tool !== 'Edit') return undefined;
    if (typeof filePath !== 'string') return undefined;
    const path = this.relativePath(filePath);
    if (!path) return undefined;
    const clean = !!provenance && adminClean(provenance);
    const refuse = (refusal: MemoryRefusal) => { this.refusals.push({ ...refusal, tool, at: new Date().toISOString(), ...(provenance ? { provenance: provenanceLabel(provenance) } : {}), ...(provenance?.turn ? { turn: provenance.turn } : {}) }); if (this.refusals.length > 100) this.refusals.splice(0, this.refusals.length - 100); return refusal; };
    if (this.protects(path) && !clean) return refuse({ code: 'protected_memory', path, message: `Protected memory file (${path}): only an admin's own turn that read no untrusted content (web research, attachments, Jira or Confluence, tool output) may change it. Do not retry; tell the user an admin can make this change in a turn of their own.` });
    const root = !path.includes('/');
    const exists = (() => { try { lstatSync(join(this.root, path)); return true; } catch { return false; } })();
    const sameNameExists = root && !exists && (() => { try { return readdirSync(this.root).some(name => name.toLowerCase() === path.toLowerCase()); } catch { return false; } })();
    if (root && !exists && !sameNameExists && (!provenance || untrusted(provenance) || provenance.unattended)) return refuse({ code: 'new_root_file', path, message: `New memory file at the root (${path}) refused: root files become part of your instructions, and this turn read untrusted content or nobody is watching it. Put notes in a folder instead (for example notes/${path}).` });
    return undefined;
  }

  /** Memory writes refused recently (newest last; in memory only), for people to see. */
  readonly refusals: (MemoryRefusal & { tool: string; at: string; provenance?: string; turn?: string })[] = [];

  /* ---------------- reviews ---------------- */

  /** Reviews, newest last (copies). */
  list(): MemoryReview[] { return structuredClone(this.reviews); }
  get(id: string): MemoryReview | undefined { const found = this.reviews.find(r => r.id === id); return found ? structuredClone(found) : undefined; }
  /** Reviews of these commits (newest first). */
  reviewsOf(commits: ReadonlySet<string>): MemoryReview[] { return structuredClone(this.reviews.filter(r => r.commits.some(c => commits.has(c)) || (r.revert && commits.has(r.revert)) || (r.reapply && commits.has(r.reapply))).reverse()); }
  /**
   * Resolves when no review of a protected file is pending (the next turn
   * waits for it: the agent must not act on a directive change that may be
   * reverted). `timeoutMs` bounds the wait; reviews keep running after it.
   */
  async settled(timeoutMs = this.settings.reviewTimeoutMs + 5000): Promise<void> {
    const waiting = this.reviews.filter(r => r.status === 'pending' && r.files.some(f => f.protected)).map(r => this.pending.get(r.id)).filter(Boolean);
    if (!waiting.length) return;
    await Promise.race([Promise.allSettled(waiting), new Promise(resolve => setTimeout(resolve, timeoutMs).unref?.())]);
  }
  /** Whether any review is pending. */
  get busy(): boolean { return this.reviews.some(r => r.status === 'pending'); }
  /** Reviews a restart interrupted (recorded as pending): {@link resume} runs them again. */
  private interrupted: string[] = [];
  /**
   * Run again the reviews a stop interrupted (the change is in memory and was
   * never judged). Called once the guard is set up; idempotent.
   */
  async resume(): Promise<void> {
    const ids = this.interrupted.splice(0);
    for (const id of ids) {
      const review = this.reviews.find(r => r.id === id && r.status === 'pending');
      if (!review || this.closed) continue;
      const diff = await this.diffOf(review.commits, 16_000, review.paths);
      const run = this.decide(review, diff).catch(error => { this.options.log?.(`memory review ${review.id} failed: ${error instanceof Error ? error.message : String(error)}`); }).finally(() => this.pending.delete(review.id));
      this.pending.set(review.id, run);
    }
  }
  /** Resolves when every pending review has settled (tests, shutdown). */
  async idle(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending.values()]); }

  /** Files the commits changed (first-parent diffs), with whether each is protected. */
  private async filesOf(commits: readonly string[]): Promise<MemoryReview['files']> {
    const files = new Map<string, 'A' | 'M' | 'D'>();
    for (const commit of commits) for (const [path, kind] of await changedBy(this.git, commit)) { const seen = files.get(path); files.set(path, !seen ? kind : seen === 'A' && kind === 'D' ? 'D' : seen === 'A' ? 'A' : kind); }
    return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, kind]) => ({ path, protected: this.protects(path), change: kind === 'A' ? 'created' : kind === 'D' ? 'deleted' : 'modified' }));
  }
  /** The combined diff of commits (each against its first parent), bounded. */
  private async diffOf(commits: readonly string[], limit = 16_000, paths?: readonly string[]): Promise<string> {
    let text = '';
    for (const commit of commits) {
      text += (await this.git(['show', '--first-parent', '-m', '--format=', '--no-color', '--unified=2', commit, '--', ...(paths?.length ? paths : ['*.md'])])).stdout.toString();
      if (text.length > limit) return `${text.slice(0, limit)}\n[diff truncated]`;
    }
    return text;
  }
  /** The protected files' text now (what Jiminy judges directive changes against), bounded. */
  directives(): string {
    const parts: string[] = [];
    const visit = (folder: string, prefix: string) => {
      let names: string[] = [];
      try { names = readdirSync(folder); } catch { return; }
      for (const name of names.sort()) {
        if (name.startsWith('.')) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        const full = join(folder, name);
        let info; try { info = lstatSync(full); } catch { continue; }
        if (info.isDirectory() && !info.isSymbolicLink()) { if (prefix.split('/').length < 3) visit(full, path); continue; }
        if (info.isFile() && name.endsWith('.md') && this.protects(path)) { try { parts.push(`${path}:\n${readFileSync(full, 'utf8').slice(0, 2000)}`); } catch { /* unreadable */ } }
      }
    };
    visit(this.root, '');
    return parts.join('\n\n').slice(0, 6000);
  }

  /**
   * Review a turn's memory commits in the background (see the module
   * notes). Resolves with the review once it is recorded (not settled).
   */
  async reviewTurn(turn: TurnCommits): Promise<MemoryReview | undefined> {
    if (!turn.commits.length || this.closed) return undefined;
    const provenance = turn.provenance ?? { actor: { kind: 'agent' as const }, sources: [], writer: 'agent' as const };
    const { conversationId: _c, ...stored } = provenance;
    return this.start({ kind: 'turn', turn: turn.turn, ...(turn.conversationId ? { conversationId: turn.conversationId } : {}), commits: turn.commits, provenance: stored });
  }

  /** Start a review in the background. `paths`: only these paths (the others were handled already, such as protected files reverted by the watcher). */
  private async start(base: Pick<MemoryReview, 'kind' | 'commits' | 'provenance'> & Partial<Pick<MemoryReview, 'turn' | 'conversationId' | 'mergedAt'>>, paths?: readonly string[], upkeep: ReadonlySet<string> = new Set()): Promise<MemoryReview> {
    const files = (await this.filesOf(base.commits)).filter(f => !paths || paths.includes(f.path)).map(f => upkeep.has(f.path) ? { ...f, upkeep: true } : f);
    const diff = await this.diffOf(base.commits, 16_000, paths);
    const review: MemoryReview = { id: randomUUID(), ...base, files, status: 'pending', createdAt: new Date().toISOString(), diff: diff.slice(0, 8000), ...(paths ? { paths: [...paths] } : {}) };
    this.reviews.push(review);
    if (this.reviews.length > (this.options.keep ?? 200) * 2) this.reviews = this.reviews.slice(-(this.options.keep ?? 200));
    this.persist();
    this.options.events?.changed?.(structuredClone(review), 'started');
    const run = this.decide(review, diff).catch(error => { this.options.log?.(`memory review ${review.id} failed: ${error instanceof Error ? error.message : String(error)}`); }).finally(() => this.pending.delete(review.id));
    this.pending.set(review.id, run);
    return structuredClone(review);
  }

  private async decide(review: MemoryReview, diff: string) {
    const { floor, rule } = reviewFloor(review.files, review.provenance);
    review.floor = floor; if (rule) review.rule = rule;
    let verdict: Verdict = floor;
    const reviewer = this.settings.reviewer === 'off' ? undefined : this.options.reviewer;
    // A floor of reject needs no opinion: the change goes.
    if (reviewer && floor !== 'reject') {
      const started = Date.now();
      try {
        const answer = await reviewer({ files: review.files, diff, provenance: review.provenance, directives: this.directives() }, AbortSignal.timeout(this.settings.reviewTimeoutMs));
        review.jiminy = { trust: answer.trust, verdict: answer.verdict, reason: answer.reason, alters_directives: answer.alters_directives, evidence: answer.evidence, ...(answer.model ? { model: answer.model } : {}), ms: Date.now() - started, ...(typeof answer.costUsd === 'number' ? { costUsd: answer.costUsd } : {}) };
        verdict = stricter(floor, answer.verdict);
      } catch (error) {
        review.error = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'review_failed';
        verdict = stricter(floor, failedReview(review.files));
      }
    } else if (!reviewer && floor === 'accept') verdict = 'accept';
    review.verdict = verdict;
    if (this.closed) { review.status = 'done'; review.error ??= 'closed'; return; }
    if (verdict === 'accept' || verdict === 'flag') review.outcome = 'kept';
    else {
      // reject and ask_human: the change is removed now (ask_human until a person approves it).
      const reverted = await this.options.journal.revertCommits(`review-${review.id}`, review.commits,
        verdict === 'reject' ? `Memory review: reverted (${review.files.map(f => f.path).join(', ').slice(0, 120)})` : `Memory review: removed until approved (${review.files.map(f => f.path).join(', ').slice(0, 120)})`,
        { [PROVENANCE_TRAILERS.review]: review.id, ...provenanceTrailers({ actor: { kind: 'harness' }, sources: [], writer: 'harness' }) }, review.paths ? new Set(review.paths) : undefined);
      if (reverted.commit) review.revert = reverted.commit;
      review.outcome = verdict === 'reject' ? 'reverted' : 'removed';
      if (verdict === 'ask_human') {
        try { const id = await this.options.events?.askHuman?.(structuredClone(review)); if (id) review.decision = id; }
        catch (error) { this.options.log?.(`memory review ${review.id}: could not open a decision (${error instanceof Error ? error.message : String(error)})`); }
      }
    }
    review.status = 'done'; review.settledAt = new Date().toISOString();
    this.persist();
    this.options.events?.changed?.(structuredClone(review), 'settled');
    if (review.outcome === 'reverted' || review.outcome === 'removed') this.options.events?.changed?.(structuredClone(review), 'reverted');
  }

  /**
   * A person decided a memory review (`ask_human`): `approve` re-applies the
   * change as a new commit whose provenance names them; `reject` keeps it
   * removed. Idempotent: deciding again changes nothing.
   */
  async decideReview(id: string, choice: 'approve' | 'reject', by: { id: string; name: string }): Promise<MemoryReview> {
    const review = this.reviews.find(r => r.id === id);
    if (!review) throw new Error('not_found');
    if (review.outcome === 'reapplied' || review.outcome === 'kept_removed') return structuredClone(review);
    if (review.outcome !== 'removed') throw new Error('not_pending');
    if (choice === 'reject') { review.outcome = 'kept_removed'; review.settledAt = new Date().toISOString(); this.persist(); this.options.events?.changed?.(structuredClone(review), 'settled'); return structuredClone(review); }
    if (!review.revert) { review.outcome = 'reapplied'; this.persist(); return structuredClone(review); }
    // Re-apply: revert the revert, with the original provenance plus who approved.
    const reapplied = await this.options.journal.revertCommits(`approve-${review.id}`, [review.revert],
      `Memory review: re-applied after approval (${review.files.map(f => f.path).join(', ').slice(0, 120)})`,
      { [PROVENANCE_TRAILERS.review]: review.id, ...(review.turn ? { 'X-Turn': review.turn } : {}), ...provenanceTrailers({ ...review.provenance, approvedBy: { id: by.id, name: by.name } }) });
    if (reapplied.commit) review.reapply = reapplied.commit;
    review.outcome = 'reapplied'; review.settledAt = new Date().toISOString();
    this.persist();
    this.options.events?.changed?.(structuredClone(review), 'settled');
    return structuredClone(review);
  }

  /**
   * Record a dream the harness asked about before merging it (see
   * `reviewDreamRequest`). When it is approved and merges, the watcher sees
   * the merge commit; it is not reviewed again.
   */
  recordDream(request: DreamRequest, decided: { verdict: Verdict; files: MemoryReview['files']; response: DreamResponse; jiminy?: JiminyVerdict & { model?: string }; error?: string }) {
    const review: MemoryReview = { id: randomUUID(), kind: 'dream', commits: request.commits.map(c => c.sha).filter(c => /^[a-f0-9]{40}$/.test(c)), files: decided.files,
      provenance: { actor: { kind: 'dreaming' }, sources: request.untrusted_tool_results ? [{ kind: 'tool', label: 'tool results in the reflected transcript' }] : [], writer: 'reflection' },
      status: 'done', verdict: decided.verdict, floor: decided.files.some(f => f.protected) ? 'reject' : 'accept', ...(decided.jiminy ? { jiminy: { trust: decided.jiminy.trust, verdict: decided.jiminy.verdict, reason: decided.jiminy.reason, alters_directives: decided.jiminy.alters_directives, evidence: decided.jiminy.evidence, ...(decided.jiminy.model ? { model: decided.jiminy.model } : {}) } } : {}),
      ...(decided.error ? { error: decided.error } : {}), outcome: decided.response.decision === 'reject' ? 'blocked' : 'kept',
      beforeMerge: { decision: decided.response.decision, ...(decided.response.approve_paths ? { paths: decided.response.approve_paths } : {}), branch: request.branch },
      createdAt: new Date().toISOString(), settledAt: new Date().toISOString(), diff: request.diff.slice(0, 8000) };
    this.reviews.push(review);
    if (decided.response.decision !== 'reject') for (const sha of [request.head, ...request.commits.map(c => c.sha)]) this.approvedDreams.add(sha);
    this.persist();
    this.options.events?.changed?.(structuredClone(review), 'settled');
    if (decided.response.decision === 'reject') this.options.events?.changed?.(structuredClone(review), 'reverted');
  }
  /** Commits of dreams approved before merging (and their heads): their merge is not reviewed again. */
  private approvedDreams = new Set<string>();

  /**
   * Provenance of a memory file, by section: who changed each run of lines
   * (`git blame --first-parent` and the ledger), and how those changes were
   * reviewed. For the `memory_provenance` tool and the app.
   */
  async provenanceOf(path: string): Promise<{ path: string; protected: boolean; sections: { lines: string; from: number; to: number; by: string; at: string; turn?: string; commit: string; review?: string }[] }> {
    const clean = typeof path === 'string' ? path.trim().replace(/^\/+/, '') : '';
    if (!clean || !clean.endsWith('.md') || clean.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('invalid_path');
    let lines;
    // Reverts restore what was there: blame sees through them (re-applied changes keep their own commit and approval).
    // A reverted change (and its revert) wrote nothing that is still there: both are seen through; a re-applied change keeps its re-apply commit.
    const reverts = this.reviews.flatMap(r => r.revert ? [r.revert, ...r.commits] : []);
    try { lines = await blameProvenance(this.git, clean, this.options.journal.recorded(), reverts); }
    catch { throw new Error('not_found'); }
    const reviews = this.reviews;
    return { path: clean, protected: this.protects(clean), sections: sections(lines).slice(0, 200).map(section => {
      const review = reviews.find(r => r.commits.includes(section.commit) || r.reapply === section.commit);
      const label = section.provenance ? provenanceLabel(section.provenance) : /reflection/i.test(section.subject) || /reflection/i.test(section.author) ? 'Dreaming' : 'Unknown (before provenance was recorded)';
      return { lines: section.lines.join('\n').slice(0, 400), from: section.from, to: section.to, by: label, at: section.date, ...(section.turn ? { turn: section.turn } : {}), commit: section.commit.slice(0, 12),
        ...(review ? { review: `${review.verdict ?? 'pending'}${review.jiminy ? ` (trust ${review.jiminy.trust.toFixed(2)}): ${review.jiminy.reason.slice(0, 160)}` : ''}` } : {}) };
    }) };
  }

  /* ---------------- changes outside turns: the watcher ---------------- */

  /**
   * Check commits made since the last check that no turn made (dreaming,
   * anything else): protected files they touched are reverted at once
   * (deterministic; no reviewer), and each dream merge is reviewed like a
   * turn. Call it after every turn and on a timer ({@link watch}).
   */
  async check(): Promise<void> {
    if (this.closed) return;
    await this.options.journal.exclusive(async () => {
      const head = await headOf(this.git);
      if (!head) return;
      if (!this.lastSeen) { this.lastSeen = head; this.persist(); return; }
      if (this.lastSeen === head) return;
      const commits = await commitsSince(this.git, this.lastSeen).catch(() => commitsSince(this.git, undefined).then(all => all.slice(-50)));
      this.lastSeen = head; this.persist();
      // The agent's own commits during a running turn are the turn's (recorded when it ends), not changes outside turns.
      const turnRunning = this.options.journal.running.length > 0;
      const outside = commits.filter(c => !harnessCommit(c.author) && !this.options.journal.entryOf(c.commit) && !c.rewind && !(turnRunning && c.author === AGENT_EMAIL && c.parents <= 1));
      // Dreams approved before merging were reviewed already: their commits (fast-forwarded) and merges.
      for (const c of [...outside]) {
        if (this.approvedDreams.has(c.commit)) { outside.splice(outside.indexOf(c), 1); continue; }
        if (c.parents > 1) {
          const second = (await this.git(['rev-parse', '-q', '--verify', `${c.commit}^2`], { ok1: true })).stdout.toString().trim();
          if (this.approvedDreams.has(second)) outside.splice(outside.indexOf(c), 1);
        }
      }
      if (!outside.length) return;
      this.outside = outside.map(c => ({ commit: c.commit, author: c.author ?? '', parents: c.parents, subject: c.subject, date: c.date }));
    });
    const found = this.outside; this.outside = [];
    if (!found.length) return;
    const trailers = await commitTrailers(this.git, found.map(c => c.commit));
    // Consecutive dream commits (a fast-forwarded reflection branch) are one dream: one review.
    const dreamOf = (c: { parents: number; subject: string; commit: string }) => c.parents > 1 || REFLECTION.test(c.subject) || REFLECTION.test(trailers.get(c.commit)?.author ?? '');
    const groups: (typeof found)[] = [];
    for (const commit of found) {
      const last = groups.at(-1);
      if (last && dreamOf(commit) && dreamOf(last.at(-1)!) && commit.parents <= 1 && last.at(-1)!.parents <= 1) last.push(commit); else groups.push([commit]);
    }
    for (const group of groups) {
      const commit = group.at(-1)!;
      const ids = group.map(c => c.commit);
      const meta = trailers.get(commit.commit);
      // A commit an agent turn made while the journal did not watch (another process) has the turn's trailers: review it as a turn.
      const turn = meta?.trailers['X-Turn'];
      const recorded = meta ? parseProvenanceTrailers(meta.trailers) : undefined;
      const dream = dreamOf(commit);
      const provenance: MemoryReview['provenance'] = turn && recorded ? { ...recorded, turn } : { actor: { kind: dream ? 'dreaming' : 'harness' }, sources: [], writer: dream ? 'reflection' : 'harness' };
      const files = await this.filesOf(ids);
      // Index upkeep (MEMORY.md link lines) by a dream is not a directive change: reviewed with the rest instead of reverted.
      const upkeep = new Set<string>();
      for (const f of files) if (f.protected && dream && isIndexUpkeep(f.path, await this.diffOf(ids, 4000, [f.path]))) upkeep.add(f.path);
      const protectedFiles = files.filter(f => f.protected && !upkeep.has(f.path));
      if (protectedFiles.length && !(turn && recorded && adminClean(recorded))) {
        // Deterministic: a protected file changed outside an admin turn is reverted at once, without review.
        // The deterministic review covers only the protected paths (the rest is reviewed by Jiminy below).
        const review: MemoryReview = { id: randomUUID(), kind: dream ? 'dream' : 'turn', commits: ids, files: protectedFiles, provenance, status: 'done', verdict: 'reject', floor: 'reject', rule: 'protected file changed outside a turn', createdAt: new Date().toISOString(), mergedAt: commit.date, diff: (await this.diffOf(ids, 16_000, protectedFiles.map(f => f.path))).slice(0, 8000), paths: protectedFiles.map(f => f.path), ...(turn ? { turn } : {}) };
        // Only the protected paths are reverted; the rest is reviewed like any change.
        const reverted = await this.options.journal.revertCommits(`watch-${commit.commit}`, ids, `Memory guard: reverted protected file(s) changed outside a turn (${protectedFiles.map(f => f.path).join(', ')})`,
          { [PROVENANCE_TRAILERS.review]: review.id, ...provenanceTrailers({ actor: { kind: 'harness' }, sources: [], writer: 'harness' }) }, new Set(protectedFiles.map(f => f.path)));
        if (reverted.commit) review.revert = reverted.commit;
        review.outcome = 'reverted'; review.settledAt = new Date().toISOString();
        this.reviews.push(review); this.persist();
        this.options.events?.changed?.(structuredClone(review), 'reverted');
        if (files.length > protectedFiles.length) await this.start({ kind: dream ? 'dream' : 'turn', commits: ids, provenance, mergedAt: commit.date, ...(turn ? { turn } : {}) }, files.filter(f => !f.protected || upkeep.has(f.path)).map(f => f.path), upkeep);
        continue;
      }
      if (dream || turn) await this.start({ kind: dream ? 'dream' : 'turn', commits: ids, provenance, mergedAt: commit.date, ...(turn ? { turn } : {}) }, undefined, upkeep);
    }
  }
  private outside: { commit: string; author: string; parents: number; subject: string; date: string }[] = [];

  /** Check for changes outside turns every `intervalMs` (dreams finish in the background). Idempotent. */
  watch(intervalMs = 5000) {
    if (this.watching || this.closed) return;
    this.watching = setInterval(() => { void this.check().catch(error => this.options.log?.(`memory guard: ${error instanceof Error ? error.message : String(error)}`)); }, intervalMs);
    this.watching.unref?.();
  }
  /** Stop watching; pending reviews finish (their outcome is recorded) but nothing new starts. */
  close() { this.closed = true; if (this.watching) clearInterval(this.watching); this.watching = undefined; if (guards.get(this.options.journal.memoryDirectory) === this) guards.delete(this.options.journal.memoryDirectory); }
}
