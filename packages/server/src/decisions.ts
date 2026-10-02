import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { DECISION_LIMITS, LOCAL_USER_ID, decisionMessage, pendingDecisionNote, type DecisionDesk, type DecisionOption, type DecisionRequest, type TurnActor } from 'ai-sdk-letta';
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
  cancelledAt?: string; cancelReason?: 'withdrawn' | 'superseded' | 'archived'; supersededBy?: string;
  /**
   * The turn that brings the outcome to the agent. `runIds`: every attempt,
   * the last one current (a new attempt only when the previous was never sent).
   * `state`: `pending` (not recorded by the runtime yet), `queued` (recorded,
   * waiting), `delivered` (sent to the agent), `blocked` (cannot be sent: the
   * conversation is read-only or archived; `error` says why).
   */
  resume?: { runIds: string[]; state: 'pending' | 'queued' | 'delivered' | 'blocked'; error?: string };
};
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
};

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
  readonly desk: DecisionDesk = {
    request: async (request, turn) => this.request(request, turn),
    cancel: async (turn, id) => this.cancel(turn.conversationId, id),
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
    for (const old of pending.filter(d => d.threadId === threadId)) {
      Object.assign(old, { status: 'cancelled', cancelledAt: now, cancelReason: 'superseded', supersededBy: record.id });
      replaced = old.id;
    }
    this.state.decisions.push(record);
    this.forget();
    this.save(); this.changed();
    return { id: record.id, ...(replaced ? { replaced } : {}) };
  }
  private cancel(conversationId: string, id?: string): string | undefined {
    const threadId = this.runtime.threadOfConversation(this.owner, conversationId);
    const record = this.state.decisions.find(d => d.status === 'pending' && d.threadId === threadId && (!id || d.id === id));
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
    const pending = this.state.decisions.find(d => d.status === 'pending' && d.threadId === threadId);
    return pending ? pendingDecisionNote(pending) : undefined;
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
    const choice = record.options.find(o => o.id === record.choice);
    // The single-user app's person is "You" on screen, "The user" to the agent.
    const by = !record.decidedBy ? 'Someone' : record.decidedBy.id === LOCAL_USER_ID ? 'The user' : record.decidedBy.name;
    return decisionMessage({ id: record.id, question: record.question, outcome: record.status === 'stopped' ? 'stopped' : 'decided', by,
      ...(choice ? { choice: { id: choice.id, label: choice.label } } : {}), ...(record.comment ? { comment: record.comment } : {}) });
  }
  private runDecision(record: DecisionRecord): RunDecision {
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
