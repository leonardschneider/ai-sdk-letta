import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { DECISION_LIMITS, LOCAL_USER_ID, decisionMessage, pendingDecisionNote, provenanceLabel, webResearchMessage, researchAge, type DecisionDesk, type DecisionOption, type DecisionRequest, type MemoryReview, type TurnActor, type WebResearch, type WebResearchOutcome } from 'ai-sdk-letta';
import { RuntimeFault, type RunAuthor, type RunAutomation, type RunDecision, type ThreadRuntime } from './runtime.js';

/**
 * Decisions of one agent (see `request_decision` in ai-sdk-letta): what the
 * agent asked, who may decide (every member of the agent), who decided and
 * when, and the turn that brings the outcome back to the agent.
 *
 * Kept next to the runtime's state (`decisions.json`, 0600, written
 * atomically), so they survive restarts. Deciding is exactly once: the first
 * decider wins, and the outcome is delivered as one new turn of the
 * conversation, through its normal queue. A delivery that the runtime confirms
 * was never sent (for example, a queued turn withdrawn by a restart) is sent
 * again; one that may have reached the agent never is.
 */

/** Where a decision stands. `stopped`: someone decided to stop the work. `cancelled`: withdrawn by the agent, replaced by a newer one, or its conversation was archived. */
export type DecisionStatus = 'pending' | 'decided' | 'stopped' | 'cancelled';
/** A person who decided (their display name at the time). */
export type DecisionPerson = { id: string; name: string; login?: string; avatar?: string };
/** A decision as stored. */
export type DecisionRecord = {
  id: string; threadId: string; conversationId: string;
  /** The turn that asked, and its tool call. */
  runId?: string; toolCallId: string;
  question: string; options: DecisionOption[]; context?: string; allowComment: boolean;
  /** Who the asking turn was for: a person (its author), and the automation that started it, if any. */
  requestedBy: { person?: DecisionPerson; source?: { via: string; name: string; tokenId?: string } };
  createdAt: string; status: DecisionStatus;
  decidedBy?: DecisionPerson; choice?: string; comment?: string; decidedAt?: string;
  cancelledAt?: string; cancelReason?: 'withdrawn' | 'superseded' | 'archived' | 'rewound'; supersededBy?: string;
  /**
   * The turn that brings the outcome to the agent. `runIds`: every attempt,
   * the last one current (a new attempt only when the previous was never sent).
   * `state`: `pending` (not recorded by the runtime yet), `queued` (recorded,
   * waiting), `delivered` (sent to the agent), `blocked` (cannot be sent: the
   * conversation is read-only or archived; `error` says why).
   */
  resume?: { runIds: string[]; state: 'pending' | 'queued' | 'delivered' | 'blocked'; error?: string };
  /**
   * `web-research`: a web search result nobody reviewed in time (see
   * `DecisionDesk.review`). Its options are `approve`, `reject` and, once the
   * result is older than `staleAfterMs`, `search_again`. Only the person whose
   * turn searched (`requestedBy.person`), or an admin, may decide it.
   */
  kind?: 'web-research' | 'memory-review';
  research?: WebResearch;
  staleAfterMs?: number;
  /**
   * `memory-review`: a memory change Jiminy held for a person (`ask_human`).
   * It is removed from memory until decided: `approve` re-applies it,
   * `reject` keeps it removed. No agent turn follows. Protected files: admins
   * only; otherwise the person whose turn made it, or an admin.
   */
  memory?: MemoryReviewView;
};
/** What a memory review decision shows (the review, without internals). */
export type MemoryReviewView = { reviewId: string; files: MemoryReview['files']; diff: string; provenance: string; protected: boolean; verdict?: string; trust?: number; reason?: string; model?: string; kind: 'turn' | 'dream'; outcome?: string };
type State = { version: 1; decisions: DecisionRecord[] };

/** Bounds of the decisions of one agent. */
export const DECISION_BOARD_LIMITS = Object.freeze({ pendingPerAgent: 200, remembered: 2000, pendingPerConversation: 1 });

/** A decision as the app and the automation API show it. */
export type PublicDecision = {
  id: string; threadId: string; question: string; options: DecisionOption[]; context?: string; allowComment: boolean;
  status: DecisionStatus; createdAt: string;
  requestedBy: { name: string; via?: string; automation?: string };
  /** The turn that asked (its run ID). */
  runId?: string;
  decidedBy?: DecisionPerson; choice?: DecisionOption; comment?: string; decidedAt?: string;
  cancelledAt?: string; cancelReason?: string; supersededBy?: string;
  resume?: { runId: string; state: string; error?: string };
  /** A web search result waiting for review (see {@link DecisionRecord.kind}), the person who may review it (or an admin), and whether "Search again" is offered. */
  kind?: 'web-research' | 'memory-review'; research?: WebResearch; reviewer?: { id: string; name: string }; stale?: boolean; staleAt?: string;
  /** A memory change held for a person (see {@link DecisionRecord.memory}); `adminOnly`: it touches protected files. */
  memory?: MemoryReviewView & { adminOnly: boolean };
};

/** The options of a web research decision. `search_again` is only accepted once the result is stale. */
export const WEB_RESEARCH_OPTIONS: readonly DecisionOption[] = Object.freeze([
  { id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }, { id: 'search_again', label: 'Search again' },
]);
const isResearch = (record: DecisionRecord) => record.kind === 'web-research';
const isMemory = (record: DecisionRecord) => record.kind === 'memory-review';
/** Decisions kept apart from the conversation's one pending decision (reviews of web research or memory). */
const isReview = (record: DecisionRecord) => isResearch(record) || isMemory(record);
/** The options of a memory review decision. */
export const MEMORY_REVIEW_OPTIONS: readonly DecisionOption[] = Object.freeze([
  { id: 'approve', label: 'Approve: re-apply it' }, { id: 'reject', label: 'Reject: keep it removed' },
]);
const staleAt = (record: DecisionRecord) => record.research && record.staleAfterMs ? Date.parse(record.research.searchedAt) + record.staleAfterMs : Infinity;

/** A decision someone else made first, or that is no longer open. */
export class DecisionConflict extends RuntimeFault {
  constructor(readonly decision: PublicDecision) { super(decision.status === 'cancelled' ? 'decision_cancelled' : 'already_decided', 409); }
}

const visible = (value: string, max: number) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const commentText = (value: string) => value.replace(/\r\n?/g, '\n').replace(/[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Cc}\n]/gu, '').replace(/\n{3,}/g, '\n\n').trim();

/** The decisions of one agent's runtime. See the module comment. */
export class DecisionBoard {
  private state: State;
  private changes = 0;
  private waiting = new Set<() => void>();
  private delivering = new Set<string>();
  private closed = false;
  constructor(readonly filename: string, readonly runtime: ThreadRuntime, readonly owner: string, readonly agent: { id: string; name: string }) {
    if (existsSync(filename)) {
      if (lstatSync(filename).isSymbolicLink()) throw new Error('Unsafe decisions file');
      const state = JSON.parse(readFileSync(filename, 'utf8')) as State;
      if (state.version !== 1 || !Array.isArray(state.decisions)) throw new Error('Invalid decisions file');
      this.state = state;
    } else this.state = { version: 1, decisions: [] };
    runtime.decisions = this;
  }
  private save() {
    const tmp = `${this.filename}.tmp`;
    try { unlinkSync(tmp); } catch { /* none */ }
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.filename);
    const directory = openSync(dirname(this.filename), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  private changed() {
    this.changes++;
    this.runtime.decisionsChanged();
    const waiting = [...this.waiting]; this.waiting.clear();
    for (const wake of waiting) wake();
  }
  /** Increases whenever a decision changes. */
  get version(): number { return this.changes; }
  /** Resolves with the new {@link version} once it differs from `since`, or after `timeoutMs`. */
  waitForChange(since: number, timeoutMs = 25_000, signal?: AbortSignal): Promise<number> {
    if (since !== this.changes || signal?.aborted) return Promise.resolve(this.changes);
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiting.delete(done); signal?.removeEventListener('abort', done); resolve(this.changes); };
      const timer = setTimeout(done, timeoutMs);
      this.waiting.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /* ---------------- what the agent does (the DecisionDesk) ---------------- */

  /** The desk the agent's `request_decision` and `cancel_decision` tools use. */
  /**
   * Memory reviews: what to do when a memory review decision is decided
   * (the server binds the agent's memory guard).
   */
  memoryReviews?: { decide(reviewId: string, choice: 'approve' | 'reject', by: { id: string; name: string }): Promise<unknown> };
  /**
   * A memory change held for a person (Jiminy answered ask_human): one
   * decision per review, in the conversation of the turn that made it (a
   * dream's in the most recent conversation). `requestedBy`: the turn's author.
   */
  memoryReview(review: MemoryReview, threadId: string | undefined, author?: { id: string; name: string }): string | undefined {
    if (!threadId) return undefined;
    const existing = this.state.decisions.find(d => d.memory?.reviewId === review.id);
    if (existing) return existing.id;
    const isProtected = review.files.some(f => f.protected);
    const paths = review.files.map(f => f.path).join(', ');
    const record: DecisionRecord = {
      id: randomUUID(), threadId, conversationId: review.conversationId ?? '', toolCallId: `memory-review:${review.id}`,
      question: visible(`Memory review: keep the ${review.kind === 'dream' ? 'dream' : 'change'} to ${paths}?`, DECISION_LIMITS.maxQuestionCharacters),
      options: MEMORY_REVIEW_OPTIONS.map(o => ({ ...o })), ...(review.jiminy?.reason ? { context: visible(review.jiminy.reason, DECISION_LIMITS.maxContextCharacters) } : {}), allowComment: false,
      requestedBy: { ...(author ? { person: { id: author.id, name: author.name } } : {}) },
      createdAt: new Date().toISOString(), status: 'pending', kind: 'memory-review',
      memory: { reviewId: review.id, files: structuredClone(review.files), diff: (review.diff ?? '').slice(0, 8000), provenance: provenanceLabel(review.provenance), protected: isProtected, kind: review.kind,
        ...(review.verdict ? { verdict: review.verdict } : {}), ...(review.jiminy ? { trust: review.jiminy.trust, reason: review.jiminy.reason, ...(review.jiminy.model ? { model: review.jiminy.model } : {}) } : {}), ...(review.outcome ? { outcome: review.outcome } : {}) },
    };
    this.state.decisions.push(record);
    this.forget();
    this.save(); this.changed();
    return record.id;
  }

  readonly desk: DecisionDesk = {
    request: async (request, turn) => this.request(request, turn),
    cancel: async (turn, id) => this.cancel(turn.conversationId, id),
    review: async (request, turn) => this.review(request.research, request.staleAfterMs, turn),
  };
  private threadOf(conversationId: string) {
    const threadId = this.runtime.threadOfConversation(this.owner, conversationId);
    const thread = threadId ? this.runtime.threadSummary(this.owner, threadId) : undefined;
    if (!threadId || !thread || thread.archived) throw new Error('conversation_unavailable');
    return threadId;
  }
  private request(request: DecisionRequest, turn: { conversationId: string; toolCallId: string; actor?: TurnActor }) {
    const threadId = this.threadOf(turn.conversationId);
    const run = this.runtime.activeRun(threadId);
    const pending = this.state.decisions.filter(d => d.status === 'pending');
    if (pending.filter(d => d.threadId !== threadId).length >= DECISION_BOARD_LIMITS.pendingPerAgent) throw new Error('decision_limit');
    const now = new Date().toISOString();
    const person: DecisionPerson | undefined = run?.author ? { id: run.author.id, name: run.author.name, login: run.author.login, ...(run.author.avatar ? { avatar: run.author.avatar } : {}) }
      : !run?.source && turn.actor ? { id: turn.actor.id, name: turn.actor.name ?? 'You', ...(turn.actor.login ? { login: turn.actor.login } : {}) } : undefined;
    const record: DecisionRecord = {
      id: randomUUID(), threadId, conversationId: turn.conversationId, ...(run ? { runId: run.id } : {}), toolCallId: turn.toolCallId,
      question: request.question, options: request.options.map(o => ({ ...o })), ...(request.context ? { context: request.context } : {}), allowComment: request.allowComment,
      requestedBy: { ...(person ? { person } : {}), ...(run?.source ? { source: { via: run.source.via, name: run.source.name, tokenId: run.source.tokenId } } : {}) },
      createdAt: now, status: 'pending',
    };
    // One open decision per conversation: a new one replaces the pending one.
    let replaced: string | undefined;
    for (const old of pending.filter(d => d.threadId === threadId && !isReview(d))) {
      Object.assign(old, { status: 'cancelled', cancelledAt: now, cancelReason: 'superseded', supersededBy: record.id });
      replaced = old.id;
    }
    this.state.decisions.push(record);
    this.forget();
    this.save(); this.changed();
    return { id: record.id, ...(replaced ? { replaced } : {}) };
  }
  /** A web search result nobody reviewed in time: kept as a decision only its searcher (or an admin) may take. */
  private review(research: WebResearch, staleAfterMs: number, turn: { conversationId: string; toolCallId: string; actor?: TurnActor }) {
    const threadId = this.threadOf(turn.conversationId);
    const run = this.runtime.activeRun(threadId);
    if (this.state.decisions.filter(d => d.status === 'pending').length >= DECISION_BOARD_LIMITS.pendingPerAgent) throw new Error('decision_limit');
    const person: DecisionPerson | undefined = run?.author ? { id: run.author.id, name: run.author.name, login: run.author.login, ...(run.author.avatar ? { avatar: run.author.avatar } : {}) }
      : turn.actor ? { id: turn.actor.id, name: turn.actor.name ?? 'You', ...(turn.actor.login ? { login: turn.actor.login } : {}) } : undefined;
    const record: DecisionRecord = {
      id: randomUUID(), threadId, conversationId: turn.conversationId, ...(run ? { runId: run.id } : {}), toolCallId: turn.toolCallId,
      question: visible(`Review web research: “${research.query}”`, DECISION_LIMITS.maxQuestionCharacters), options: WEB_RESEARCH_OPTIONS.map(o => ({ ...o })), allowComment: true,
      requestedBy: { ...(person ? { person } : {}), ...(run?.source ? { source: { via: run.source.via, name: run.source.name, tokenId: run.source.tokenId } } : {}) },
      createdAt: new Date().toISOString(), status: 'pending', kind: 'web-research', research: structuredClone(research), staleAfterMs,
    };
    this.state.decisions.push(record);
    this.forget();
    this.save(); this.changed();
    return { id: record.id };
  }
  /**
   * Whether `who` may decide a decision: anyone for ordinary decisions; for
   * web research, the person whose turn searched, or an admin.
   */
  mayDecide(id: string, who: { id: string }, admin: boolean): boolean {
    const record = this.record(id);
    // Memory reviews of protected files (persona, rules, goals): admins only.
    if (isMemory(record) && record.memory?.protected) return admin;
    return !isReview(record) || admin || (!!record.requestedBy.person && record.requestedBy.person.id === who.id);
  }
  private cancel(conversationId: string, id?: string): string | undefined {
    const threadId = this.runtime.threadOfConversation(this.owner, conversationId);
    const record = this.state.decisions.find(d => d.status === 'pending' && d.threadId === threadId && !isReview(d) && (!id || d.id === id));
    if (!record) return undefined;
    Object.assign(record, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: 'withdrawn' });
    this.save(); this.changed();
    return record.id;
  }
  /** Keep at most {@link DECISION_BOARD_LIMITS.remembered} decisions: the oldest settled ones are forgotten first. */
  private forget() {
    const extra = this.state.decisions.length - DECISION_BOARD_LIMITS.remembered;
    if (extra <= 0) return;
    const drop = new Set(this.state.decisions.filter(d => d.status !== 'pending' && (!d.resume || d.resume.state === 'delivered' || d.resume.state === 'blocked')).slice(0, extra).map(d => d.id));
    this.state.decisions = this.state.decisions.filter(d => !drop.has(d.id));
  }

  /* ---------------- what people see ---------------- */

  /** A decision as shown to people and automations. */
  view(record: DecisionRecord): PublicDecision {
    const choice = record.choice ? record.options.find(o => o.id === record.choice) : undefined;
    const source = record.requestedBy.source;
    const runId = record.resume?.runIds.at(-1);
    return {
      id: record.id, threadId: record.threadId, question: record.question, options: record.options.map(o => ({ ...o })), ...(record.context ? { context: record.context } : {}), allowComment: record.allowComment,
      status: record.status, createdAt: record.createdAt, ...(record.runId ? { runId: record.runId } : {}),
      requestedBy: { name: record.requestedBy.person?.name ?? (source ? source.name : 'You'), ...(source ? { via: source.via, automation: source.name } : {}) },
      ...(record.decidedBy ? { decidedBy: { ...record.decidedBy } } : {}), ...(choice ? { choice: { ...choice } } : {}), ...(record.comment ? { comment: record.comment } : {}), ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
      ...(record.cancelledAt ? { cancelledAt: record.cancelledAt, cancelReason: record.cancelReason } : {}), ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
      ...(record.resume && runId ? { resume: { runId, state: record.resume.state, ...(record.resume.error ? { error: record.resume.error } : {}) } } : {}),
      ...(isResearch(record) ? { kind: 'web-research' as const, research: structuredClone(record.research!), stale: Date.now() >= staleAt(record), ...(Number.isFinite(staleAt(record)) ? { staleAt: new Date(staleAt(record)).toISOString() } : {}),
        ...(record.requestedBy.person ? { reviewer: { id: record.requestedBy.person.id, name: record.requestedBy.person.name } } : {}) } : {}),
      ...(isMemory(record) && record.memory ? { kind: 'memory-review' as const, memory: { ...structuredClone(record.memory), adminOnly: record.memory.protected },
        ...(record.requestedBy.person && !record.memory.protected ? { reviewer: { id: record.requestedBy.person.id, name: record.requestedBy.person.name } } : {}) } : {}),
    };
  }
  /** Pending decisions of conversations that are not archived, oldest first. */
  pending(): PublicDecision[] {
    return this.state.decisions.filter(d => d.status === 'pending').map(d => this.view(d));
  }
  /** The decisions of one conversation (the newest 50), oldest first. */
  forThread(threadId: string): PublicDecision[] {
    return this.state.decisions.filter(d => d.threadId === threadId).slice(-50).map(d => this.view(d));
  }
  /** One decision. @throws 404 */
  get(id: string): PublicDecision { return this.view(this.record(id)); }
  record(id: string): DecisionRecord {
    const record = this.state.decisions.find(d => d.id === id);
    if (!record) throw new RuntimeFault('not_found', 404);
    return record;
  }
  /** The record (a copy), or `undefined`. */
  find(id: string): DecisionRecord | undefined { const found = this.state.decisions.find(d => d.id === id); return found ? structuredClone(found) : undefined; }
  /** The decision a run asked for (its latest), if any. */
  requestedBy(runId: string): DecisionRecord | undefined { const found = this.state.decisions.filter(d => d.runId === runId).at(-1); return found ? structuredClone(found) : undefined; }
  /** The note for an ordinary turn of a conversation with a pending decision. */
  pendingNote(threadId: string): string | undefined {
    const pending = this.state.decisions.find(d => d.status === 'pending' && d.threadId === threadId && !isReview(d));
    const research = this.state.decisions.filter(d => d.status === 'pending' && d.threadId === threadId && isResearch(d));
    const notes = [...(pending ? [pendingDecisionNote(pending)] : []),
      ...(research.length ? [`Web research waiting for review in the app: ${research.map(d => `“${visible(d.research!.query, 200).replace(/[<>]/g, '')}” (decision ${d.id})`).join('; ')}. You have none of it; do not search for the same thing again unless asked. If it is approved, it arrives as a message starting with "[Web research]".`] : [])];
    return notes.length ? notes.join(' ') : undefined;
  }

  /* ---------------- deciding ---------------- */

  /**
   * Decide: choose an option (`choice`, with an optional `comment` when the
   * decision allows it), or `stop: true` to stop the work. Exactly once: the
   * first decider wins; later attempts get {@link DecisionConflict} (409
   * `already_decided`) with the decision as decided. The outcome is then sent
   * to the agent as a new turn of the conversation.
   */
  decide(id: string, who: DecisionPerson, input: unknown): PublicDecision {
    const record = this.record(id);
    const { choice, stop, comment } = (input ?? {}) as { choice?: unknown; stop?: unknown; comment?: unknown };
    if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['choice', 'stop', 'comment'].includes(key))) throw new RuntimeFault('invalid_input', 400);
    if (isMemory(record)) {
      // Approve (re-apply) or Reject (keep removed); no comment, no stop, and no agent turn follows.
      if (stop !== undefined || (choice !== 'approve' && choice !== 'reject') || comment !== undefined) throw new RuntimeFault('invalid_input', 400);
      if (record.status !== 'pending') throw new DecisionConflict(this.view(record));
      Object.assign(record, { status: 'decided', decidedBy: { id: who.id, name: visible(who.name, 120) || 'Someone', ...(who.login ? { login: who.login } : {}), ...(who.avatar ? { avatar: who.avatar } : {}) }, choice, decidedAt: new Date().toISOString() });
      this.save(); this.changed();
      const reviewId = record.memory!.reviewId;
      void this.memoryReviews?.decide(reviewId, choice as 'approve' | 'reject', { id: who.id, name: visible(who.name, 120) || 'Someone' }).then(
        () => { record.memory!.outcome = choice === 'approve' ? 'reapplied' : 'kept_removed'; this.save(); this.changed(); },
        () => { record.memory!.outcome = 'failed'; this.save(); this.changed(); });
      return this.view(record);
    }
    if (isResearch(record)) {
      // Approve (no note), Reject (an optional note for the agent), or, once the result is stale, Search again.
      if (stop !== undefined || !['approve', 'reject', 'search_again'].includes(choice as string) || (comment !== undefined && (typeof comment !== 'string' || comment.length > DECISION_LIMITS.maxCommentCharacters)) || (choice === 'approve' && typeof comment === 'string' && comment.trim())) throw new RuntimeFault('invalid_input', 400);
      if (record.status === 'pending' && choice === 'search_again' && Date.now() < staleAt(record)) throw new RuntimeFault('not_stale', 409);
    }
    if ((stop !== undefined && stop !== true) || (stop === true) === (choice !== undefined) || (choice !== undefined && (typeof choice !== 'string' || !record.options.some(o => o.id === choice)))) throw new RuntimeFault('invalid_input', 400);
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > DECISION_LIMITS.maxCommentCharacters)) throw new RuntimeFault('invalid_input', 400);
    const text = typeof comment === 'string' ? commentText(comment) : '';
    if (text && !record.allowComment && stop !== true) throw new RuntimeFault('invalid_input', 400);
    if (record.status !== 'pending') throw new DecisionConflict(this.view(record));
    const thread = this.runtime.threadSummary(this.owner, record.threadId);
    if (!thread || thread.archived) throw new RuntimeFault('conversation_archived', 409);
    // Decided here, synchronously: nothing else can decide it between this check and the write.
    Object.assign(record, { status: stop === true ? 'stopped' : 'decided', decidedBy: { id: who.id, name: visible(who.name, 120) || 'Someone', ...(who.login ? { login: who.login } : {}), ...(who.avatar ? { avatar: who.avatar } : {}) },
      ...(stop === true ? {} : { choice }), ...(text ? { comment: text } : {}), decidedAt: new Date().toISOString(), resume: { runIds: [randomUUID()], state: 'pending' } });
    this.save(); this.changed();
    void this.deliver(record.id);
    return this.view(record);
  }

  /**
   * Send a decided decision's outcome to the agent, once. Waits while the
   * conversation is busy (one turn at a time in the single-user app; its
   * queue on a team server). Called after deciding and again on startup.
   */
  async deliver(id: string): Promise<void> {
    if (this.delivering.has(id) || this.closed) return;
    this.delivering.add(id);
    try {
      for (let attempt = 0; !this.closed; attempt++) {
        const record = this.state.decisions.find(d => d.id === id);
        if (!record?.resume || record.status === 'pending' || record.status === 'cancelled' || record.resume.state === 'delivered' || record.resume.state === 'blocked') return;
        const runId = record.resume.runIds.at(-1)!;
        const run = this.runtime.runRecord(this.owner, runId);
        if (run) {
          if (run.notSent) {
            // Never sent (withdrawn by a restart, or the queue was cleared): a new attempt is safe.
            if (record.resume.runIds.length >= 20) { this.block(record, 'not_sent'); return; }
            record.resume.runIds.push(randomUUID()); record.resume.state = 'pending'; this.save(); this.changed(); continue;
          }
          if (run.status === 'queued') {
            if (record.resume.state !== 'queued') { record.resume.state = 'queued'; this.save(); this.changed(); }
            await this.runtime.waitForChange(this.runtime.version, 2000);
            continue;
          }
          record.resume.state = 'delivered'; this.save(); this.changed(); return;
        }
        const thread = this.runtime.threadSummary(this.owner, record.threadId);
        if (!thread || thread.archived) { this.block(record, 'conversation_archived'); return; }
        const latest = this.runtime.latestRun(this.owner, record.threadId);
        if (!this.runtime.queueing && latest && latest.status !== 'completed') {
          if (latest.status === 'running') { await this.runtime.waitForChange(this.runtime.version, 2000); continue; }
          this.block(record, 'conversation_blocked'); return;
        }
        try {
          await this.runtime.start(this.owner, { id: runId, threadId: record.threadId, text: this.outcomeText(record), parentRunId: latest?.id ?? null }, this.authorOf(record), this.automationOf(record), { decision: this.runDecision(record) });
        } catch (error) {
          const code = error instanceof RuntimeFault ? error.code : 'runtime_failed';
          // Busy (another turn, or the conversation being opened), or a full queue: try again shortly.
          if (['runtime_busy', 'history_conflict', 'queue_full'].includes(code)) { await this.pause(); continue; }
          this.block(record, code === 'delivery_uncertain' ? 'conversation_blocked' : code === 'thread_archived' ? 'conversation_archived' : code);
          return;
        }
      }
    } finally { this.delivering.delete(id); }
  }
  private pause() { return new Promise<void>(resolve => { const timer = setTimeout(resolve, 1500); timer.unref?.(); }); }
  private block(record: DecisionRecord, error: string) {
    if (!record.resume) return;
    record.resume.state = 'blocked'; record.resume.error = error;
    this.save(); this.changed();
  }
  /** The outcome message (what the agent receives, and the app shows as a compact line). */
  outcomeText(record: DecisionRecord): string {
    if (isResearch(record)) return webResearchMessage(this.researchOutcome(record));
    const choice = record.options.find(o => o.id === record.choice);
    // The single-user app's person is "You" on screen, "The user" to the agent.
    const by = !record.decidedBy ? 'Someone' : record.decidedBy.id === LOCAL_USER_ID ? 'The user' : record.decidedBy.name;
    return decisionMessage({ id: record.id, question: record.question, outcome: record.status === 'stopped' ? 'stopped' : 'decided', by,
      ...(choice ? { choice: { id: choice.id, label: choice.label } } : {}), ...(record.comment ? { comment: record.comment } : {}) });
  }
  private researchOutcome(record: DecisionRecord): WebResearchOutcome {
    const by = !record.decidedBy ? 'Someone' : record.decidedBy.id === LOCAL_USER_ID ? 'The user' : record.decidedBy.name;
    const at = Date.parse(record.decidedAt ?? new Date().toISOString());
    const research = record.research!;
    if (record.choice === 'approve') return { outcome: 'approve', by, research, at, id: record.id };
    if (record.choice === 'search_again') return { outcome: 'search_again', by, query: research.query, ...(research.purpose ? { purpose: research.purpose } : {}), searchedAt: research.searchedAt, at, ...(record.comment ? { note: record.comment } : {}), id: record.id };
    return { outcome: 'reject', by, query: research.query, ...(record.comment ? { note: record.comment } : {}), id: record.id };
  }
  private runDecision(record: DecisionRecord): RunDecision {
    if (isResearch(record)) {
      const research = record.research!;
      const choice = record.options.find(o => o.id === record.choice);
      return { id: record.id, outcome: 'decided', kind: 'web-research', question: research.query, by: { id: record.decidedBy!.id, name: record.decidedBy!.name },
        ...(choice ? { choice: { id: choice.id, label: choice.label } } : {}), ...(record.comment ? { comment: record.comment } : {}),
        age: researchAge(research.searchedAt, Date.parse(record.decidedAt ?? new Date().toISOString())) };
    }
    const choice = record.options.find(o => o.id === record.choice);
    return { id: record.id, outcome: record.status === 'stopped' ? 'stopped' : 'decided', question: record.question, by: { id: record.decidedBy!.id, name: record.decidedBy!.name },
      ...(choice ? { choice: { id: choice.id, label: choice.label } } : {}), ...(record.comment ? { comment: record.comment } : {}) };
  }
  /** Team servers: the outcome is the decider's message (their name above it, their accounts for tools). */
  private authorOf(record: DecisionRecord): RunAuthor | undefined {
    if (!this.runtime.queueing || !record.decidedBy || record.decidedBy.id === LOCAL_USER_ID) return undefined;
    return { id: record.decidedBy.id, login: record.decidedBy.login ?? record.decidedBy.id, name: record.decidedBy.name, ...(record.decidedBy.avatar ? { avatar: record.decidedBy.avatar } : {}) };
  }
  /** Work an automation started stays an automation's: unattended, with its pre-approvals, so its workflow can follow it. */
  private automationOf(record: DecisionRecord): RunAutomation | undefined {
    const asking = record.runId ? this.runtime.runRecord(this.owner, record.runId) : undefined;
    if (!asking?.source) return undefined;
    return { source: { ...asking.source }, preApproved: [...(asking.unattended?.preApproved ?? [])], ...(asking.unattended?.onBehalfOf ? { onBehalfOf: asking.unattended.onBehalfOf } : {}), ...(asking.replyModeOverride ? { replyMode: 'always' } : {}) };
  }

  /**
   * Decisions and web research reviews of a conversation that a rewind
   * withdraws: the ones these turns asked for (`runIds`) that are pending,
   * or decided but whose outcome was not sent to the agent yet.
   */
  rewindable(threadId: string, runIds: ReadonlySet<string>): DecisionRecord[] {
    return this.state.decisions.filter(d => d.threadId === threadId && d.runId && runIds.has(d.runId)
      && (d.status === 'pending' || ((d.status === 'decided' || d.status === 'stopped') && d.resume && (d.resume.state === 'pending' || d.resume.state === 'queued')))).map(d => structuredClone(d));
  }
  /** A rewind removed these turns: withdraw what they asked for (see {@link rewindable}). Idempotent. Returns the withdrawn IDs. */
  rewound(threadId: string, runIds: ReadonlySet<string>): string[] {
    const now = new Date().toISOString();
    const open = this.state.decisions.filter(d => d.threadId === threadId && d.runId && runIds.has(d.runId) && (d.status === 'pending' || ((d.status === 'decided' || d.status === 'stopped') && d.resume && (d.resume.state === 'pending' || d.resume.state === 'queued'))));
    if (!open.length) return [];
    for (const record of open) {
      if (record.status === 'pending') Object.assign(record, { status: 'cancelled', cancelledAt: now, cancelReason: 'rewound' });
      // A decided outcome not sent yet is never sent: the turn it would resume is gone.
      else if (record.resume) { record.resume.state = 'blocked'; record.resume.error = 'rewound'; }
    }
    this.save(); this.changed();
    return open.map(d => d.id);
  }
  /** A conversation was archived: its pending decision can no longer be decided. */
  archived(threadId: string) {
    const now = new Date().toISOString();
    const open = this.state.decisions.filter(d => d.status === 'pending' && d.threadId === threadId);
    if (!open.length) return;
    for (const record of open) Object.assign(record, { status: 'cancelled', cancelledAt: now, cancelReason: 'archived' });
    this.save(); this.changed();
  }
  /** Deliver every decided outcome that was not sent yet (after a restart). */
  resumeAll() {
    for (const record of this.state.decisions) if (record.status !== 'pending' && record.status !== 'cancelled' && record.resume && (record.resume.state === 'pending' || record.resume.state === 'queued')) void this.deliver(record.id);
  }
  close() { this.closed = true; for (const wake of [...this.waiting]) wake(); }
}
