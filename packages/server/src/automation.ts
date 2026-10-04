import express from 'express';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import type { Server } from 'node:http';
import { DEFAULT_AUTOMATION_FLOOR, LOCAL_USER_ID, MAX_INPUT_CHARACTERS, REPLY_MODES, type ReplyMode, type ScheduleRequest, type ScheduledTask, type TaskScheduler, type TurnActor } from 'ai-sdk-letta';
import { RuntimeFault, type Run, type RunAuthor, type RunAutomation, type RunSource, type ThreadRuntime } from './runtime.js';
import { contentDisposition } from './http.js';
import type { Orchestrator, OrchestratorHandle } from './scheduler.js';
import type { PublicDecision } from './decisions.js';

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

/** What an automation token is for, shown in the app ("via n8n"). */
export type AutomationVia = RunSource['via'];
export const AUTOMATION_VIAS: readonly AutomationVia[] = Object.freeze(['n8n', 'conductor', 'api']);
/** A person a token acts for (the local user, or a member of the agent). */
export type AutomationActor = { id: string; name: string; login?: string };
/**
 * An automation token as stored: only a SHA-256 hash of the secret and its
 * last four characters (to tell tokens apart). The secret is shown once, when
 * the token is created, and never stored or logged.
 */
export type AutomationToken = {
  id: string; name: string; via: AutomationVia; hash: string; hint: string;
  /** Who the token's turns act for (their tools use this person's accounts, for example Atlassian). */
  actor: AutomationActor;
  /** Tools whose `'ask'` calls run without asking in this token's turns. Questions are never pre-approved. */
  preApproved: string[];
  /** Reply mode of its turns on a team server. @default 'always' */
  replyMode?: ReplyMode;
  /**
   * The starting verdict of its turns' memory changes when they read untrusted
   * content (web research, documents, tool output): `accept`, `flag` (kept,
   * shown) or `ask_human` (removed until a person approves). The reviewer can
   * only make it stricter. @default 'flag'
   */
  memoryFloor?: MemoryFloor;
  createdAt: string; createdBy: AutomationActor;
  lastUsedAt?: string; lastRunId?: string;
};
/** The starting verdicts a token may set for its untrusted memory writes. */
export const MEMORY_FLOORS = Object.freeze(['accept', 'flag', 'ask_human'] as const);
export type MemoryFloor = typeof MEMORY_FLOORS[number];
/** A run started through the automation API (or by a scheduled task): its idempotency key and where it runs. */
type ServiceRun = { id: string; tokenId?: string; scheduleId?: string; key?: string; fingerprint?: string; threadId?: string; createdAt: string; error?: string };
/** A task the agent scheduled (`schedule_task`), held by an orchestrator until it fires. */
export type ScheduleRecord = {
  id: string; at: string; prompt: string; conversation: 'current' | 'new'; threadId?: string; title?: string;
  actor: AutomationActor; createdAt: string; orchestrator: Orchestrator['kind'];
  state: 'scheduling' | 'scheduled' | 'fired' | 'cancelled' | 'failed';
  /** SHA-256 of the single-use secret the orchestrator presents when the task is due. */
  hash: string;
  handle?: OrchestratorHandle; runId?: string; firedAt?: string; error?: string; cleanedAt?: string;
  /** The turn that scheduled it (its run ID), when known: a rewind of that turn cancels the task. */
  requestedBy?: string;
  /** Cancelled because the turn that scheduled it was rewound. */
  rewound?: boolean;
};
type StoreState = { version: 1; tokens: AutomationToken[]; runs: ServiceRun[]; schedules: ScheduleRecord[] };

/** Bounds of the automation API. */
export const AUTOMATION_LIMITS = Object.freeze({
  tokensPerAgent: 50,
  /** Turns a token may start per minute. */
  runsPerMinute: 10,
  /** Requests a token may make per minute (polls included). */
  requestsPerMinute: 240,
  /** Turns of one token that may be queued or running at once. */
  concurrentRuns: 2,
  /** Failed sign-ins per client address in 5 minutes before it is refused for a while. */
  failedAuthPer5Minutes: 30,
  /** Longest `wait` of one request (seconds). */
  maxWaitSeconds: 120,
  /** Runs (and their idempotency keys) remembered per agent; the oldest are forgotten first. */
  rememberedRuns: 1000,
  /** Tasks waiting in the orchestrator per agent. */
  pendingSchedules: 50,
  /** How long a run waits for the agent (single-user runtime busy, or its session opening) before it is given up. */
  startTimeoutMs: 10 * 60_000,
});
const TOKEN_PREFIX = 'lta_';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const newSecret = () => `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
const KEY = /^[A-Za-z0-9._:-]{1,200}$/;
const visible = (value: string, max: number) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The automation records of one agent (`<state>/server/<id>/automation.json`,
 * 0600, written atomically). Re-read when the file changes, and changed under
 * a lock file, so the command line can create and revoke tokens while the
 * server runs.
 */
export class AutomationStore {
  private cache?: { mtimeMs: number; size: number; state: StoreState };
  constructor(readonly filename: string) {}
  read(): StoreState {
    if (!existsSync(this.filename)) return { version: 1, tokens: [], runs: [], schedules: [] };
    if (lstatSync(this.filename).isSymbolicLink()) throw new Error('Unsafe automation file');
    const info = statSync(this.filename);
    if (this.cache && this.cache.mtimeMs === info.mtimeMs && this.cache.size === info.size) return this.cache.state;
    const state = JSON.parse(readFileSync(this.filename, 'utf8')) as StoreState;
    if (state.version !== 1 || !Array.isArray(state.tokens) || !Array.isArray(state.runs) || !Array.isArray(state.schedules)) throw new Error('Invalid automation file');
    this.cache = { mtimeMs: info.mtimeMs, size: info.size, state };
    return state;
  }
  /** Change the records under the lock (re-read first). */
  update<T>(change: (state: StoreState) => T): T {
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const lock = `${this.filename}.lock`;
    let fd: number | undefined;
    for (let attempt = 0; fd === undefined; attempt++) {
      try { fd = openSync(lock, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A lock older than 30 seconds was left by a process that died while writing.
        try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; } } catch { continue; }
        if (attempt > 200) throw new RuntimeFault('automation_busy', 503);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      this.cache = undefined;
      const state = structuredClone(this.read());
      const result = change(state);
      const tmp = `${this.filename}.tmp`;
      try { unlinkSync(tmp); } catch { /* none */ }
      const out = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(out, JSON.stringify(state)); fsyncSync(out); } finally { closeSync(out); }
      renameSync(tmp, this.filename);
      this.cache = undefined;
      return result;
    } finally { closeSync(fd); try { unlinkSync(lock); } catch { /* gone */ } }
  }
}

/** Public view of a token (never its hash). */
export const tokenSummary = (token: AutomationToken) => ({ id: token.id, name: token.name, via: token.via, hint: `…${token.hint}`, actor: { name: token.actor.name, ...(token.actor.login ? { login: token.actor.login } : {}) },
  preApproved: [...token.preApproved], replyMode: token.replyMode ?? 'always', memoryFloor: token.memoryFloor ?? DEFAULT_AUTOMATION_FLOOR, createdAt: token.createdAt, createdBy: { name: token.createdBy.name }, ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}) });

/**
 * Create a token for an agent. Returns its record and the secret, which is
 * never stored: show it once.
 */
export function createToken(store: AutomationStore, input: unknown, context: { actor: AutomationActor; createdBy: AutomationActor; preApprovable: readonly string[] }): { token: AutomationToken; secret: string } {
  const { name, via = 'api', preApproved = [], replyMode, memoryFloor } = (input ?? {}) as { name?: unknown; via?: unknown; preApproved?: unknown; replyMode?: unknown; memoryFloor?: unknown };
  if (typeof name !== 'string' || !visible(name, 80) || !AUTOMATION_VIAS.includes(via as AutomationVia) || !Array.isArray(preApproved) || preApproved.length > 50
    || preApproved.some(tool => typeof tool !== 'string' || !context.preApprovable.includes(tool)) || (replyMode !== undefined && !REPLY_MODES.includes(replyMode as ReplyMode)) || (memoryFloor !== undefined && !MEMORY_FLOORS.includes(memoryFloor as MemoryFloor))) throw new RuntimeFault('invalid_input', 400);
  const secret = newSecret();
  const token: AutomationToken = { id: randomUUID(), name: visible(name, 80), via: via as AutomationVia, hash: sha256(secret), hint: secret.slice(-4), actor: { ...context.actor },
    preApproved: [...new Set(preApproved as string[])], ...(replyMode ? { replyMode: replyMode as ReplyMode } : {}), ...(memoryFloor ? { memoryFloor: memoryFloor as MemoryFloor } : {}), createdAt: new Date().toISOString(), createdBy: { ...context.createdBy } };
  store.update(state => {
    if (state.tokens.length >= AUTOMATION_LIMITS.tokensPerAgent) throw new RuntimeFault('capacity_reached');
    state.tokens.push(token);
  });
  return { token, secret };
}
/** Change a token's memory floor (its later turns use it). */
export function setTokenMemoryFloor(store: AutomationStore, id: string, input: unknown): AutomationToken {
  const floor = (input as { memoryFloor?: unknown } | undefined)?.memoryFloor;
  if (!MEMORY_FLOORS.includes(floor as MemoryFloor)) throw new RuntimeFault('invalid_input', 400);
  let updated: AutomationToken | undefined;
  store.update(state => { const token = state.tokens.find(t => t.id === id); if (token) { token.memoryFloor = floor as MemoryFloor; updated = { ...token }; } });
  if (!updated) throw new RuntimeFault('not_found', 404);
  return updated;
}
/** Revoke (delete) a token. Turns it already started keep running. */
export function revokeToken(store: AutomationStore, id: string): boolean {
  return store.update(state => { const before = state.tokens.length; state.tokens = state.tokens.filter(token => token.id !== id); return state.tokens.length !== before; });
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

/** One agent served to automations. */
export type AutomationAgent = {
  id: string; name: string; runtime: ThreadRuntime; owner: string; store: AutomationStore;
  /** Tools whose approvals a token may give in advance (permission `'ask'`, or tools that can ask per call). */
  preApprovable: readonly string[];
  /** The agent's runtime has reply modes (team servers). */
  replyModes: boolean;
};
/** Options of {@link AutomationService}. */
export type AutomationServiceOptions = {
  agents: readonly AutomationAgent[];
  /**
   * Team servers: who may act for whom. `member(agentId, userId)` is the
   * person's record when they are (still) a member of the agent; tokens of
   * people who are not stop working.
   */
  members?: (agentId: string, userId: string) => RunAuthor | undefined;
  /** Agent self-scheduling: the orchestrator and the URL it calls this API under (for example `http://host.docker.internal:4402`). */
  scheduler?: { orchestrator: Orchestrator; callbackUrl: string };
  /** Log sink for one line per scheduling problem (never a secret). */
  log?: (line: string) => void;
};

/**
 * A decision as the automation API shows it: what was asked, and once
 * decided, who chose what, and the run that resumed (or stopped) the work.
 */
export type AutomationDecision = {
  id: string; status: 'pending' | 'decided' | 'stopped' | 'cancelled'; question: string; options: { id: string; label: string; description?: string }[];
  conversation: { id: string };
  createdAt: string; decidedAt?: string; decidedBy?: { name: string }; choice?: { id: string; label: string }; comment?: string; cancelReason?: string;
  /** The turn that brought the outcome to the agent: get it with `GET /v1/automation/runs/<runId>`. */
  resume?: { runId: string; state: string; error?: string };
};
/** A run as the automation API shows it. */
export type AutomationRun = {
  /**
   * `decision_pending`: the turn ended by asking people to decide
   * (`request_decision`); `decision` says what, and the work resumes in a new
   * run once someone decides (`decision.resume.runId`). Not a failure.
   */
  id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'decision_pending';
  /** The decision this run asked for (`request_decision`), as it stands now. */
  decision?: AutomationDecision;
  /** This run brings a decision's outcome to the agent (it resumed, or stopped, the work). */
  resumes?: { decisionId: string; outcome: 'decided' | 'stopped'; choice?: { id: string; label: string } };
  conversation?: { id: string; title?: string };
  createdAt: string; startedAt?: string; endedAt?: string;
  /** The agent's reply (all text of the turn). Empty when it listened without replying. */
  text?: string; listened?: boolean;
  tools?: { name: string; status: 'running' | 'completed' | 'failed'; reason?: string }[];
  files?: { path: string; bytes: number; modifiedAt: string }[];
  /** Why it did not complete: `approval_required` and `question_required` name the `tool`. */
  error?: { code: string; message: string; tool?: string };
  source: { via: AutomationVia; name: string };
};

const errorText: Record<string, string> = {
  approval_required: 'needs approval, and nobody can approve it in an unattended run. Nothing was run. Pre-approve the tool for this token, or do this in the app.',
  question_required: 'The agent needed to ask a question, and nobody can answer in an unattended run.',
  conversation_blocked: 'The conversation has an unfinished or uncertain turn and is read-only. Use a new conversation.',
  conversation_archived: 'The conversation is archived. Restore it in the app, or use another one.',
  start_timeout: 'The agent stayed busy for too long; the turn was not sent.',
  timed_out: 'The turn timed out.', cancelled: 'The turn was cancelled.', not_sent: 'The turn was withdrawn before it was sent.',
  idle_timeout: 'The turn made no progress for too long and was stopped; the conversation stays usable.', max_duration: 'The turn reached its time limit and was stopped; the conversation stays usable.',
  delivery_uncertain: 'The server restarted while the turn ran; nothing was replayed.', runtime_failed: 'The turn failed.',
  actor_not_member: 'The token\'s user is no longer a member of this agent.',
};
/** A decision for the automation API (no user IDs). */
export const automationDecision = (decision: PublicDecision): AutomationDecision => ({
  id: decision.id, status: decision.status, question: decision.question, options: decision.options.map(o => ({ ...o })), conversation: { id: decision.threadId }, createdAt: decision.createdAt,
  ...(decision.decidedAt ? { decidedAt: decision.decidedAt } : {}), ...(decision.decidedBy ? { decidedBy: { name: decision.decidedBy.name } } : {}),
  ...(decision.choice ? { choice: { id: decision.choice.id, label: decision.choice.label } } : {}), ...(decision.comment ? { comment: decision.comment } : {}),
  ...(decision.cancelReason ? { cancelReason: decision.cancelReason } : {}), ...(decision.resume ? { resume: { ...decision.resume } } : {}),
});
const message = (code: string, tool?: string) => code === 'approval_required' ? `${tool ?? 'A tool'} ${errorText[code]}` : errorText[code] ?? 'The turn did not complete.';

/**
 * The automation API of a server: per-trigger tokens, turns started by
 * orchestrators (n8n, Conductor, scripts), and tasks the agent scheduled.
 * See {@link automationApp} for the HTTP routes.
 */
export class AutomationService {
  readonly agents: ReadonlyMap<string, AutomationAgent>;
  private readonly members?: AutomationServiceOptions['members'];
  readonly scheduler?: AutomationServiceOptions['scheduler'];
  private readonly log: (line: string) => void;
  /** Runs this process is still starting (waiting for the agent): id → stop. */
  private starting = new Map<string, AbortController>();
  private changes = 0;
  private waiting = new Set<() => void>();
  private windows = new Map<string, number[]>();
  private closed = false;
  constructor(options: AutomationServiceOptions) {
    this.agents = new Map(options.agents.map(agent => [agent.id, agent]));
    this.members = options.members;
    this.scheduler = options.scheduler;
    this.log = options.log ?? (() => {});
    // Runs that were still waiting to start when the server stopped are given up (never sent).
    for (const agent of this.agents.values()) {
      const stale = agent.store.read().runs.filter(run => !run.error && !agent.runtime.runRecord(agent.owner, run.id) && Date.now() - Date.parse(run.createdAt) < 7 * 86_400_000);
      if (stale.length) agent.store.update(state => { for (const run of state.runs) if (stale.some(s => s.id === run.id)) run.error ??= 'not_sent'; });
    }
  }
  private changed() { this.changes++; const waiting = [...this.waiting]; this.waiting.clear(); for (const wake of waiting) wake(); }
  /** Sliding-window rate limit: true (and counted) when `key` is still within `limit` per `windowMs`. */
  allow(key: string, limit: number, windowMs = 60_000): boolean {
    if (this.count(key, windowMs) >= limit) return false;
    this.hit(key);
    return true;
  }
  /** Hits of `key` in the last `windowMs`. */
  count(key: string, windowMs = 60_000): number {
    const now = Date.now();
    const hits = (this.windows.get(key) ?? []).filter(time => now - time < windowMs);
    this.windows.set(key, hits);
    return hits.length;
  }
  /** Count one hit of `key`. */
  hit(key: string) {
    const now = Date.now();
    this.windows.set(key, [...(this.windows.get(key) ?? []).filter(time => now - time < 10 * 60_000), now]);
    if (this.windows.size > 10_000) for (const [k, v] of this.windows) if (!v.some(time => now - time < 10 * 60_000)) this.windows.delete(k);
  }

  /* ---------------- tokens ---------------- */

  /** The token (and its agent) a bearer secret belongs to. Constant-time comparison of hashes. */
  authenticate(secret: string | undefined): { agent: AutomationAgent; token: AutomationToken } | undefined {
    if (!secret || !secret.startsWith(TOKEN_PREFIX) || secret.length > 100) return undefined;
    const hash = Buffer.from(sha256(secret), 'hex');
    let found: { agent: AutomationAgent; token: AutomationToken } | undefined;
    for (const agent of this.agents.values()) for (const token of agent.store.read().tokens) {
      if (timingSafeEqual(Buffer.from(token.hash, 'hex'), hash)) found = { agent, token };
    }
    return found;
  }
  /** The author of a token's turns (team servers: the member, refreshed; single-user: none). @throws `actor_not_member` */
  private authorOf(agent: AutomationAgent, actor: AutomationActor): RunAuthor | undefined {
    if (!this.members) { if (actor.id !== LOCAL_USER_ID) throw new RuntimeFault('actor_not_member', 403); return undefined; }
    const author = this.members(agent.id, actor.id);
    if (!author) throw new RuntimeFault('actor_not_member', 403);
    return author;
  }

  /* ---------------- runs ---------------- */

  /**
   * Start a turn for a token. `idempotencyKey` is required: the same key with
   * the same input returns the same run (an orchestrator retry never starts a
   * second turn); with other input it is refused (`idempotency_conflict`).
   */
  startRun(agent: AutomationAgent, token: AutomationToken, input: unknown): AutomationRun {
    // Orchestrators send `null` for inputs a workflow left empty: the same as leaving them out.
    const body = Object.fromEntries(Object.entries((input ?? {}) as Record<string, unknown>).filter(([, value]) => value !== null && value !== '')) as Record<string, unknown>;
    const { text, idempotencyKey, threadId, title, newConversation, replyMode } = body as { text?: unknown; idempotencyKey?: unknown; threadId?: unknown; title?: unknown; newConversation?: unknown; replyMode?: unknown };
    if (typeof idempotencyKey !== 'string' || !KEY.test(idempotencyKey)) throw new RuntimeFault('idempotency_key_required', 400);
    if (Object.keys(body).some(key => !['text', 'idempotencyKey', 'threadId', 'title', 'newConversation', 'replyMode', 'wait'].includes(key))) throw new RuntimeFault('invalid_input', 400);
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_INPUT_CHARACTERS || (threadId !== undefined && typeof threadId !== 'string') || (title !== undefined && (typeof title !== 'string' || !visible(title, 120)))
      || (newConversation !== undefined && typeof newConversation !== 'boolean') || (replyMode !== undefined && !REPLY_MODES.includes(replyMode as ReplyMode)) || (threadId !== undefined && (title !== undefined || newConversation))) throw new RuntimeFault('invalid_input', 400);
    const fingerprint = sha256(JSON.stringify([text, threadId ?? null, title ?? null, !!newConversation, replyMode ?? null]));
    const previous = agent.store.read().runs.find(run => run.tokenId === token.id && run.key === idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new RuntimeFault('idempotency_conflict', 409);
      return this.view(agent, previous);
    }
    const author = this.authorOf(agent, token.actor);
    if (threadId !== undefined) {
      const thread = agent.runtime.threadSummary(agent.owner, threadId);
      if (!thread || thread.state !== 'ready') throw new RuntimeFault('not_found', 404);
      if (thread.archived) throw new RuntimeFault('conversation_archived', 409);
    }
    if (this.activeRuns(agent, token.id) >= AUTOMATION_LIMITS.concurrentRuns) throw new RuntimeFault('concurrency_limit', 429);
    if (!this.allow(`runs:${token.id}`, AUTOMATION_LIMITS.runsPerMinute)) throw new RuntimeFault('rate_limited', 429);
    const record: ServiceRun = { id: randomUUID(), tokenId: token.id, key: idempotencyKey, fingerprint, ...(typeof threadId === 'string' ? { threadId } : {}), createdAt: new Date().toISOString() };
    const now = record.createdAt;
    agent.store.update(state => {
      state.runs.push(record);
      if (state.runs.length > AUTOMATION_LIMITS.rememberedRuns) state.runs.splice(0, state.runs.length - AUTOMATION_LIMITS.rememberedRuns);
      const stored = state.tokens.find(t => t.id === token.id);
      if (stored) { stored.lastUsedAt = now; stored.lastRunId = record.id; }
    });
    const automation: RunAutomation = { source: { kind: 'automation', via: token.via, tokenId: token.id, name: token.name }, preApproved: token.preApproved,
      // Pre-approval covers calls on someone's own account (Atlassian) only when that person created the token.
      ...(token.createdBy.id === token.actor.id ? { onBehalfOf: token.actor.id } : {}),
      ...(agent.replyModes ? { replyMode: (replyMode as ReplyMode | undefined) ?? token.replyMode ?? 'always' } : {}),
      memoryFloor: token.memoryFloor ?? DEFAULT_AUTOMATION_FLOOR };
    void this.launch(agent, record, { text, title: typeof title === 'string' ? visible(title, 120) : token.name, newConversation: !!newConversation }, automation, author);
    return this.view(agent, record);
  }
  /** Queued or running turns of a token (including ones still waiting to start). */
  private activeRuns(agent: AutomationAgent, tokenId: string) {
    return agent.store.read().runs.filter(run => run.tokenId === tokenId && !run.error && (this.starting.has(run.id) || ['queued', 'running'].includes(agent.runtime.runRecord(agent.owner, run.id)?.status ?? ''))).length;
  }
  private fail(agent: AutomationAgent, record: ServiceRun, code: string) {
    agent.store.update(state => { const run = state.runs.find(r => r.id === record.id); if (run) run.error = code; });
    record.error = code; this.changed();
  }
  /**
   * Find or create the conversation, then hand the turn to the runtime. A
   * single-user runtime runs one turn at a time: while it is busy, the turn
   * waits here (status `queued`) and is sent when it is free, or given up
   * after {@link AUTOMATION_LIMITS.startTimeoutMs}.
   */
  private async launch(agent: AutomationAgent, record: ServiceRun, input: { text: string; title: string; newConversation: boolean }, automation: RunAutomation, author?: RunAuthor) {
    const control = new AbortController();
    this.starting.set(record.id, control);
    const deadline = Date.now() + AUTOMATION_LIMITS.startTimeoutMs;
    const pause = () => new Promise<void>(resolve => { const timer = setTimeout(resolve, 1500); control.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    const { runtime, owner } = agent;
    try {
      while (true) {
        if (control.signal.aborted) return this.fail(agent, record, this.closed ? 'not_sent' : 'cancelled');
        if (Date.now() > deadline) return this.fail(agent, record, 'start_timeout');
        try {
          if (!record.threadId) {
            const existing = input.newConversation ? undefined : runtime.threadByTitle(owner, input.title);
            const threadId = existing?.id ?? randomUUID();
            if (!existing) await runtime.create(owner, threadId, input.title, author);
            record.threadId = threadId;
            agent.store.update(state => { const run = state.runs.find(r => r.id === record.id); if (run) run.threadId = threadId; });
          }
          const latest = runtime.latestRun(owner, record.threadId);
          if (!runtime.queueing && latest && !latest.usable) {
            if (latest.status === 'running') { await pause(); continue; }
            return this.fail(agent, record, 'conversation_blocked');
          }
          await runtime.start(owner, { id: record.id, threadId: record.threadId, text: input.text, parentRunId: latest?.id ?? null }, author, automation);
          this.changed();
          return;
        } catch (error) {
          const code = error instanceof RuntimeFault ? error.code : 'runtime_failed';
          // Busy (another turn, or the conversation being opened): try again shortly.
          if (code === 'runtime_busy' || code === 'history_conflict') { await pause(); continue; }
          return this.fail(agent, record, code === 'delivery_uncertain' ? 'conversation_blocked' : code === 'thread_archived' ? 'conversation_archived' : code);
        }
      }
    } finally { this.starting.delete(record.id); this.changed(); }
  }
  /** A run of an agent, as the API shows it. */
  view(agent: AutomationAgent, record: ServiceRun): AutomationRun {
    const run = agent.runtime.runRecord(agent.owner, record.id);
    const token = record.tokenId ? agent.store.read().tokens.find(t => t.id === record.tokenId) : undefined;
    const schedule = record.scheduleId ? agent.store.read().schedules.find(s => s.id === record.scheduleId) : undefined;
    const source = run?.source ? { via: run.source.via, name: run.source.name } : { via: token?.via ?? schedule?.orchestrator ?? 'api', name: token?.name ?? 'Scheduled task' };
    const threadId = run?.threadId ?? record.threadId;
    const thread = threadId ? agent.runtime.threadSummary(agent.owner, threadId) : undefined;
    const base = { id: record.id, createdAt: record.createdAt, source, ...(threadId ? { conversation: { id: threadId, ...(thread ? { title: thread.title } : {}) } } : {}) };
    if (!run) {
      if (record.error) return { ...base, status: record.error === 'cancelled' ? 'cancelled' : 'failed', error: { code: record.error, message: message(record.error) } };
      return { ...base, status: this.starting.has(record.id) ? 'queued' : 'failed', ...(this.starting.has(record.id) ? {} : { error: { code: 'not_sent', message: message('not_sent') } }) };
    }
    const tools = toolsOf(run);
    const text = run.events.filter(event => event.type === 'text').map(event => String(event.data.text)).join('');
    const ended = !['queued', 'running'].includes(run.status);
    const times = { ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.endedAt ? { endedAt: run.endedAt } : {}) };
    if (!ended) return { ...base, ...times, status: run.status === 'queued' ? 'queued' : 'running', ...(tools.length ? { tools } : {}) };
    const asked = agent.runtime.decisions?.requestedBy(run.id);
    const decision = asked ? automationDecision(agent.runtime.decisions!.view(asked)) : undefined;
    const resumes = run.decision ? { resumes: { decisionId: run.decision.id, outcome: run.decision.outcome, ...(run.decision.choice ? { choice: { ...run.decision.choice } } : {}) } } : {};
    const result = { ...base, ...times, text, ...(run.listened ? { listened: true } : {}), tools, ...(decision ? { decision } : {}), ...resumes };
    // The turn ended cleanly, but it needed a person: for the automation, that is a failure.
    if (run.refused) return { ...result, status: 'failed', error: { code: run.refused.code, tool: run.refused.tool, message: message(run.refused.code, run.refused.tool) } };
    // It asked people to decide: the work waits for them (not a failure).
    if (run.status === 'completed' && decision?.status === 'pending') return { ...result, status: 'decision_pending' };
    if (run.status === 'completed') return { ...result, status: 'completed' };
    // Stopped with a known outcome (Stop, or a turn limit): the partial reply is the result; the conversation stays usable.
    if (run.status === 'stopped') { const stop = String([...run.events].reverse().find(event => event.type === 'stopped')?.data.code ?? 'cancelled'); return { ...result, status: stop === 'cancelled' ? 'cancelled' : 'failed', error: { code: stop, message: message(stop) } }; }
    const code = String([...run.events].reverse().find(event => event.type === 'failed')?.data.code ?? (run.status === 'interrupted' ? 'delivery_uncertain' : 'runtime_failed'));
    return { ...result, status: run.status === 'cancelled' && code === 'cancelled' ? 'cancelled' : 'failed', error: { code, message: message(code) } };
  }
  /** Files the run created or changed in the agent's resources (once it ended). */
  async withFiles(agent: AutomationAgent, view: AutomationRun): Promise<AutomationRun> {
    if (!view.startedAt || !view.endedAt) return view;
    try { const files = await agent.runtime.changedFiles(agent.owner, view.startedAt, view.endedAt); return { ...view, files }; } catch { return { ...view, files: [] }; }
  }
  /**
   * A token's run by ID (another token's runs are not found). Runs that
   * resumed a decision one of its runs asked for are the token's too.
   */
  record(agent: AutomationAgent, tokenId: string, id: string): ServiceRun {
    const record = agent.store.read().runs.find(run => run.id === id && run.tokenId === tokenId);
    if (record) return record;
    const run = agent.runtime.runRecord(agent.owner, id);
    if (run?.decision && run.source?.tokenId === tokenId) return { id: run.id, tokenId, threadId: run.threadId, createdAt: run.queuedAt ?? run.startedAt ?? new Date().toISOString() };
    throw new RuntimeFault('not_found', 404);
  }
  /** A decision one of the token's runs asked for (others are not found). */
  decision(agent: AutomationAgent, tokenId: string, id: string): AutomationDecision {
    const record = agent.runtime.decisions?.find(id);
    if (!record || record.requestedBy.source?.tokenId !== tokenId) throw new RuntimeFault('not_found', 404);
    return automationDecision(agent.runtime.decisions!.view(record));
  }
  /** Resolves when the decision is no longer pending, or after `timeoutMs`. */
  async waitForDecision(agent: AutomationAgent, tokenId: string, id: string, timeoutMs: number, signal?: AbortSignal): Promise<AutomationDecision> {
    const until = Date.now() + timeoutMs;
    while (true) {
      const decision = this.decision(agent, tokenId, id);
      if (decision.status !== 'pending' || Date.now() >= until || signal?.aborted) return decision;
      await agent.runtime.decisions!.waitForChange(agent.runtime.decisions!.version, Math.min(5000, Math.max(10, until - Date.now())), signal);
    }
  }
  /** Resolves when the run ended, or after `timeoutMs`. */
  async waitFor(agent: AutomationAgent, record: ServiceRun, timeoutMs: number, signal?: AbortSignal): Promise<AutomationRun> {
    const until = Date.now() + timeoutMs;
    while (true) {
      const current = agent.store.read().runs.find(run => run.id === record.id) ?? record;
      const view = this.view(agent, current);
      if (!['queued', 'running'].includes(view.status) || Date.now() >= until || signal?.aborted) return view;
      const since = agent.runtime.version;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.waiting.delete(done); resolve(); };
        const timer = setTimeout(done, Math.min(2000, Math.max(10, until - Date.now())));
        this.waiting.add(done);
        void agent.runtime.waitForChange(since, Math.min(2000, Math.max(10, until - Date.now())), signal).then(done);
      });
    }
  }
  /** Cancel a run: withdraw it while it waits, or stop it while it runs. */
  cancel(agent: AutomationAgent, record: ServiceRun) {
    const starting = this.starting.get(record.id);
    if (starting) { starting.abort(); return; }
    const run = agent.runtime.runRecord(agent.owner, record.id);
    if (run && ['queued', 'running'].includes(run.status)) agent.runtime.cancel(agent.owner, record.id);
  }

  /* ---------------- tasks the agent schedules ---------------- */

  /** The `schedule_task` backend of an agent, when an orchestrator is configured. */
  schedulerFor(agentId: string): TaskScheduler | undefined {
    if (!this.scheduler) return undefined;
    return { schedule: (request, turn) => this.schedule(agentId, request, turn) };
  }
  private async schedule(agentId: string, request: ScheduleRequest, turn: { conversationId: string; actor?: TurnActor }): Promise<ScheduledTask> {
    const agent = this.agents.get(agentId);
    const scheduler = this.scheduler;
    if (!agent || !scheduler) throw new Error('scheduler_unavailable');
    const actor: AutomationActor = this.members ? { id: turn.actor?.id ?? '', name: turn.actor?.name ?? 'Someone', ...(turn.actor?.login ? { login: turn.actor.login } : {}) } : { id: LOCAL_USER_ID, name: 'You' };
    if (this.members && !actor.id) throw new Error('scheduler_failed');
    const threadId = request.conversation === 'current' ? agent.runtime.threadOfConversation(agent.owner, turn.conversationId) : undefined;
    if (request.conversation === 'current' && !threadId) throw new Error('scheduler_failed');
    // The turn that asks (so a rewind of it cancels the task).
    const origin = agent.runtime.threadOfConversation(agent.owner, turn.conversationId);
    const requestedBy = origin ? agent.runtime.activeRun(origin)?.id : undefined;
    const secret = newSecret();
    const record: ScheduleRecord = { id: randomUUID(), at: request.at, prompt: request.prompt, conversation: request.conversation, ...(threadId ? { threadId } : {}), ...(request.title ? { title: request.title } : {}),
      actor, createdAt: new Date().toISOString(), orchestrator: scheduler.orchestrator.kind, state: 'scheduling', hash: sha256(secret), ...(requestedBy ? { requestedBy } : {}) };
    agent.store.update(state => {
      if (state.schedules.filter(s => s.state === 'scheduled' || s.state === 'scheduling').length >= AUTOMATION_LIMITS.pendingSchedules) throw new Error('schedule_limit');
      state.schedules.push(record);
    });
    try {
      const handle = await scheduler.orchestrator.createJob({ id: record.id, at: record.at, token: secret, fireUrl: `${scheduler.callbackUrl.replace(/\/+$/, '')}/v1/automation/schedules/${record.id}/fire`, label: visible(request.prompt, 60) });
      let withdrawn = false;
      agent.store.update(state => { const s = state.schedules.find(x => x.id === record.id); if (s) { s.handle = handle; if (s.state === 'scheduling') s.state = 'scheduled'; else withdrawn = true; } });
      // Cancelled while it was being created (a rewind of the turn): its job goes too.
      if (withdrawn) void this.retire(agent, record.id);
    } catch (error) {
      agent.store.update(state => { const s = state.schedules.find(x => x.id === record.id); if (s) { s.state = 'failed'; s.error = (error as Error).message; } });
      this.log(`Scheduling a task with ${scheduler.orchestrator.kind} failed: ${(error as Error).message}${(error as { detail?: string }).detail ? ` (${(error as { detail?: string }).detail})` : ''}`);
      throw error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error : new Error('scheduler_failed');
    }
    this.changed();
    void this.cleanup(agent);
    return { id: record.id, at: record.at, orchestrator: scheduler.orchestrator.kind, conversation: record.conversation, ...(record.title ? { title: record.title } : {}) };
  }
  /** The schedule a single-use fire secret belongs to. */
  authenticateSchedule(id: string, secret: string | undefined): { agent: AutomationAgent; schedule: ScheduleRecord } | undefined {
    if (!secret || !secret.startsWith(TOKEN_PREFIX) || secret.length > 100) return undefined;
    const hash = Buffer.from(sha256(secret), 'hex');
    for (const agent of this.agents.values()) {
      const schedule = agent.store.read().schedules.find(s => s.id === id);
      if (schedule && timingSafeEqual(Buffer.from(schedule.hash, 'hex'), hash)) return { agent, schedule };
    }
    return undefined;
  }
  /** The orchestrator says a task is due: run it once (unattended, nothing pre-approved). */
  fire(agent: AutomationAgent, schedule: ScheduleRecord): AutomationRun {
    if (schedule.state === 'fired' && schedule.runId) return this.view(agent, this.recordById(agent, schedule.runId));
    if (schedule.state !== 'scheduled') throw new RuntimeFault(schedule.state === 'cancelled' ? 'schedule_cancelled' : 'schedule_unavailable', 410);
    if (Date.now() < Date.parse(schedule.at) - 2 * 60_000) throw new RuntimeFault('too_early', 425);
    const author = this.authorOf(agent, schedule.actor);
    let threadId = schedule.threadId;
    if (threadId) {
      const thread = agent.runtime.threadSummary(agent.owner, threadId);
      // The conversation was archived or removed meanwhile: run it in a new one instead of losing it.
      if (!thread || thread.archived || thread.state !== 'ready') threadId = undefined;
    }
    const record: ServiceRun = { id: randomUUID(), scheduleId: schedule.id, ...(threadId ? { threadId } : {}), createdAt: new Date().toISOString() };
    agent.store.update(state => {
      const s = state.schedules.find(x => x.id === schedule.id);
      if (!s || s.state !== 'scheduled') throw new RuntimeFault('schedule_unavailable', 410);
      s.state = 'fired'; s.firedAt = record.createdAt; s.runId = record.id;
      state.runs.push(record);
      if (state.runs.length > AUTOMATION_LIMITS.rememberedRuns) state.runs.splice(0, state.runs.length - AUTOMATION_LIMITS.rememberedRuns);
    });
    const via = this.scheduler?.orchestrator.kind ?? schedule.orchestrator;
    const automation: RunAutomation = { source: { kind: 'schedule', via, tokenId: `schedule:${schedule.id}`, name: 'Scheduled task' }, preApproved: [], ...(agent.replyModes ? { replyMode: 'always' as ReplyMode } : {}) };
    void this.launch(agent, record, { text: schedule.prompt, title: schedule.title ?? visible(schedule.prompt, 60), newConversation: true }, automation, author);
    return this.view(agent, record);
  }
  runById(agent: AutomationAgent, id: string): ServiceRun { return this.recordById(agent, id); }
  private recordById(agent: AutomationAgent, id: string): ServiceRun {
    const record = agent.store.read().runs.find(run => run.id === id);
    if (!record) throw new RuntimeFault('not_found', 404);
    return record;
  }
  /** After a task fired: take its job out of the orchestrator, once the run ended (so its execution history keeps the outcome). */
  async retire(agent: AutomationAgent, scheduleId: string) {
    // One removal per task at a time (the end of its run and the periodic cleanup may both ask).
    const pending = this.retiring.get(scheduleId);
    if (pending) return pending;
    const work = (async () => {
      const schedule = agent.store.read().schedules.find(s => s.id === scheduleId);
      if (!schedule?.handle || !this.scheduler || schedule.cleanedAt) return;
      try {
        // Deleting is idempotent (missing jobs count as removed); one retry for a busy orchestrator.
        await this.scheduler.orchestrator.deleteJob(schedule.handle).catch(async () => { await new Promise(resolve => setTimeout(resolve, 2000)); await this.scheduler!.orchestrator.deleteJob(schedule.handle!); });
        agent.store.update(state => { const s = state.schedules.find(x => x.id === scheduleId); if (s) s.cleanedAt = new Date().toISOString(); });
      } catch (error) { this.log(`Removing a fired task from ${this.scheduler.orchestrator.kind} failed (it will not fire again; it is retried later): ${(error as Error).message}${(error as { detail?: string }).detail ? ` (${(error as { detail?: string }).detail})` : ''}`); }
    })().finally(() => this.retiring.delete(scheduleId));
    this.retiring.set(scheduleId, work);
    return work;
  }
  private retiring = new Map<string, Promise<void>>();
  /** When the run of a fired task ends, remove its job from the orchestrator (a little later, so its execution is recorded first). */
  retireWhenDone(agent: AutomationAgent, scheduleId: string, runId: string) {
    void (async () => {
      const view = await this.waitFor(agent, this.runById(agent, runId), AUTOMATION_LIMITS.startTimeoutMs + 20 * 60_000).catch(() => undefined);
      if (this.closed || !view || ['queued', 'running'].includes(view.status)) return;
      await new Promise(resolve => setTimeout(resolve, 15_000).unref?.());
      if (!this.closed) await this.retire(agent, scheduleId);
    })();
  }
  /** Remove jobs of tasks that fired (and ended) earlier but are still in the orchestrator (best effort, a few per call). */
  private async cleanup(agent: AutomationAgent) {
    const old = agent.store.read().schedules.filter(s => (s.state === 'fired' || s.state === 'cancelled') && s.handle && !s.cleanedAt && (s.state === 'cancelled' || (s.firedAt && Date.now() - Date.parse(s.firedAt) > 10 * 60_000))).slice(0, 5);
    for (const schedule of old) await this.retire(agent, schedule.id);
  }
  /** Cancel a task that has not fired: its job is removed from the orchestrator. */
  async cancelSchedule(agent: AutomationAgent, id: string) {
    const schedule = agent.store.read().schedules.find(s => s.id === id);
    if (!schedule) throw new RuntimeFault('not_found', 404);
    if (schedule.state !== 'scheduled' && schedule.state !== 'failed') throw new RuntimeFault('schedule_unavailable', 409);
    agent.store.update(state => { const s = state.schedules.find(x => x.id === id); if (s && (s.state === 'scheduled' || s.state === 'failed')) s.state = 'cancelled'; });
    if (schedule.handle && this.scheduler) {
      try { await this.scheduler.orchestrator.deleteJob(schedule.handle); agent.store.update(state => { const s = state.schedules.find(x => x.id === id); if (s) s.cleanedAt = new Date().toISOString(); }); }
      catch { throw new RuntimeFault('scheduler_unreachable', 502); }
    }
    this.changed();
  }
  /** Tasks scheduled by these turns (see `ScheduleRecord.requestedBy`): waiting ones, and ones that already fired. */
  schedulesOf(agent: AutomationAgent, runIds: ReadonlySet<string>): { id: string; at: string; prompt: string; state: 'pending' | 'fired' }[] {
    return agent.store.read().schedules.filter(s => s.requestedBy && runIds.has(s.requestedBy) && ['scheduling', 'scheduled', 'fired'].includes(s.state))
      .map(s => ({ id: s.id, at: s.at, prompt: s.prompt.slice(0, 300), state: s.state === 'fired' ? 'fired' as const : 'pending' as const }));
  }
  /**
   * A rewind removed these turns: the tasks they scheduled that have not
   * fired are cancelled (their jobs removed from the orchestrator; a removal
   * that fails is retried by the periodic cleanup, and the task can no
   * longer fire either way). Idempotent.
   */
  async cancelSchedulesOf(agent: AutomationAgent, runIds: ReadonlySet<string>): Promise<string[]> {
    const cancelled: string[] = [];
    agent.store.update(state => { for (const s of state.schedules) if (s.requestedBy && runIds.has(s.requestedBy) && (s.state === 'scheduled' || s.state === 'scheduling' || s.state === 'failed')) { s.state = 'cancelled'; s.rewound = true; cancelled.push(s.id); } });
    for (const id of cancelled) {
      const schedule = agent.store.read().schedules.find(s => s.id === id);
      if (!schedule?.handle || !this.scheduler) continue;
      try { await this.scheduler.orchestrator.deleteJob(schedule.handle); agent.store.update(state => { const s = state.schedules.find(x => x.id === id); if (s) s.cleanedAt = new Date().toISOString(); }); }
      catch (error) { this.log(`Removing a task cancelled by a rewind from ${this.scheduler.orchestrator.kind} failed (it cannot fire; removal is retried later): ${(error as Error).message}`); }
    }
    if (cancelled.length) this.changed();
    return cancelled;
  }
  /** Tasks of an agent for the app: waiting ones, then the 20 most recent others. */
  schedules(agent: AutomationAgent) {
    const all = agent.store.read().schedules;
    const pending = all.filter(s => s.state === 'scheduled' || s.state === 'scheduling').sort((a, b) => a.at.localeCompare(b.at));
    const recent = all.filter(s => s.state !== 'scheduled' && s.state !== 'scheduling').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
    return [...pending, ...recent].map(s => {
      const run = s.runId ? agent.runtime.runRecord(agent.owner, s.runId) : undefined;
      return { id: s.id, at: s.at, prompt: s.prompt, conversation: s.conversation, ...(s.threadId ? { threadId: s.threadId } : {}), ...(s.title ? { title: s.title } : {}), actor: { name: s.actor.name }, orchestrator: s.orchestrator, state: s.state, createdAt: s.createdAt,
        ...(s.firedAt ? { firedAt: s.firedAt } : {}), ...(run ? { run: { id: run.id, threadId: run.threadId, status: this.statusOf(agent, run), ...(run.refused ? { error: run.refused.code } : {}) } } : {}) };
    });
  }
  /** Tokens of an agent for the app, with the status of each one's last run. */
  tokens(agent: AutomationAgent) {
    return agent.store.read().tokens.map(token => {
      const run = token.lastRunId ? agent.runtime.runRecord(agent.owner, token.lastRunId) : undefined;
      let active = true;
      try { this.authorOf(agent, token.actor); } catch { active = false; }
      return { ...tokenSummary(token), active, ...(run ? { lastRun: { id: run.id, threadId: run.threadId, status: this.statusOf(agent, run), ...(run.refused ? { error: run.refused.code } : {}) } } : {}) };
    });
  }
  /** A run's status for the Automations dialog. */
  private statusOf(agent: AutomationAgent, run: Run): string {
    if (run.refused) return 'failed';
    if (run.status === 'completed' && agent.runtime.decisions?.requestedBy(run.id)?.status === 'pending') return 'decision_pending';
    return run.status;
  }
  close() { this.closed = true; for (const control of this.starting.values()) control.abort(); }
}

/** Tool calls of a run: name and outcome (never arguments or outputs). */
function toolsOf(run: Run) {
  const tools = new Map<string, { name: string; status: 'running' | 'completed' | 'failed'; reason?: string }>();
  for (const event of run.events) {
    const id = String(event.data.toolCallId ?? '');
    if (event.type === 'tool_started') tools.set(id, { name: String(event.data.name), status: 'running' });
    else if (event.type === 'tool_completed') tools.set(id, { name: String(event.data.name), status: 'completed' });
    else if (event.type === 'tool_failed') tools.set(id, { name: String(event.data.name), status: 'failed', ...(typeof event.data.reason === 'string' ? { reason: event.data.reason } : {}) });
  }
  return [...tools.values()];
}

/* ------------------------------------------------------------------ */
/* HTTP: the automation API                                            */
/* ------------------------------------------------------------------ */

const bearer = (req: express.Request) => { const value = req.headers.authorization; return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7).trim() : undefined; };
const waitSeconds = (value: unknown) => { const n = Number(value ?? 0); return Number.isFinite(n) ? Math.min(AUTOMATION_LIMITS.maxWaitSeconds, Math.max(0, n)) : 0; };

/**
 * The automation API, for orchestrators and scripts. Every route needs
 * `Authorization: Bearer <token>`; browsers are refused (any `Origin`, or
 * cross-site fetch metadata), and so are Tailscale Funnel requests.
 *
 * - `GET  /v1/automation/whoami`: the token's agent, name, user, pre-approved tools.
 * - `POST /v1/automation/runs`: `{ text, idempotencyKey, threadId? | title?, newConversation?, replyMode? }`
 *   (`?wait=<seconds>` waits up to 120 s for it to end). 202 with the run (200 if it ended).
 * - `GET  /v1/automation/runs/<id>?wait=<seconds>`: the run; waits for it to end.
 * - `GET  /v1/automation/decisions/<id>?wait=<seconds>`: a decision a run asked for; waits until someone decided.
 * - `POST /v1/automation/runs/<id>/cancel`
 * - `GET  /v1/automation/files?path=<path>`: download a file of the agent's resources.
 * - `POST /v1/automation/schedules/<id>/fire`: the orchestrator runs a task the agent scheduled (its single-use token).
 */
export function automationApp(service: AutomationService): express.Express {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    // Not for browsers: a page could never read the answers anyway (no CORS), but it must not even start a turn.
    if (req.headers.origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none') || req.headers['tailscale-funnel-request'] !== undefined) return res.status(403).json({ error: 'forbidden' });
    // Too many failed sign-ins from this address: refuse for a while (only failures count).
    if (service.count(`fail:${req.socket.remoteAddress}`, 5 * 60_000) >= AUTOMATION_LIMITS.failedAuthPer5Minutes) return res.status(429).set('Retry-After', '300').json({ error: 'rate_limited' });
    next();
  });
  const unauthorized = (req: express.Request, res: express.Response) => { service.hit(`fail:${req.socket.remoteAddress}`); return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized', message: 'Missing or invalid token.' }); };
  const json = express.json({ limit: '24kb' });
  type Authed = { agent: AutomationAgent; token: AutomationToken };
  const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const found = service.authenticate(bearer(req));
    if (!found) return unauthorized(req, res);
    if (!service.allow(`requests:${found.token.id}`, AUTOMATION_LIMITS.requestsPerMinute)) return res.status(429).set('Retry-After', '60').json({ error: 'rate_limited' });
    (req as unknown as { authed: Authed }).authed = found;
    next();
  };
  const authed = (req: express.Request) => (req as unknown as { authed: Authed }).authed;
  const until = (req: express.Request, res: express.Response) => { const control = new AbortController(); res.on('close', () => control.abort()); return control.signal; };
  app.get('/v1/automation/whoami', auth, (req, res) => {
    const { agent, token } = authed(req);
    res.json({ agent: { id: agent.id, name: agent.name }, token: tokenSummary(token) });
  });
  app.post('/v1/automation/runs', auth, json, async (req, res) => {
    const { agent, token } = authed(req);
    const wait = waitSeconds(req.query.wait ?? (req.body as { wait?: unknown } | undefined)?.wait);
    let run = service.startRun(agent, token, { ...(req.body ?? {}), ...(typeof req.headers['idempotency-key'] === 'string' && !(req.body ?? {}).idempotencyKey ? { idempotencyKey: req.headers['idempotency-key'] } : {}) });
    if (wait) run = await service.waitFor(agent, service.record(agent, token.id, run.id), wait * 1000, until(req, res));
    run = await service.withFiles(agent, run);
    if (!res.writableEnded && !res.destroyed) res.status(['queued', 'running'].includes(run.status) ? 202 : 200).json(run);
  });
  app.get('/v1/automation/runs', auth, (req, res) => {
    const { agent, token } = authed(req);
    const records = agent.store.read().runs.filter(run => run.tokenId === token.id).slice(-20).reverse();
    res.json({ runs: records.map(record => service.view(agent, record)) });
  });
  app.get('/v1/automation/runs/:id', auth, async (req, res) => {
    const { agent, token } = authed(req);
    const record = service.record(agent, token.id, String(req.params.id));
    const run = await service.withFiles(agent, await service.waitFor(agent, record, waitSeconds(req.query.wait) * 1000, until(req, res)));
    if (!res.writableEnded && !res.destroyed) res.json(run);
  });
  /** A decision one of this token's runs asked for; `?wait=<s>` waits (up to 120 s) until someone decided. */
  app.get('/v1/automation/decisions/:id', auth, async (req, res) => {
    const { agent, token } = authed(req);
    const decision = await service.waitForDecision(agent, token.id, String(req.params.id), waitSeconds(req.query.wait) * 1000, until(req, res));
    if (!res.writableEnded && !res.destroyed) res.json(decision);
  });
  app.post('/v1/automation/runs/:id/cancel', auth, (req, res) => {
    const { agent, token } = authed(req);
    const record = service.record(agent, token.id, String(req.params.id));
    service.cancel(agent, record);
    res.json({ accepted: true });
  });
  app.get('/v1/automation/files', auth, async (req, res) => {
    const { agent } = authed(req);
    const file = await agent.runtime.resourceFile(agent.owner, req.query.path, 25 * 1024 * 1024);
    res.set({ 'Content-Type': file.kind === 'pdf' ? 'application/pdf' : file.kind === 'image' ? file.mediaType : file.kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream', 'Content-Disposition': contentDisposition(file.name), 'Content-Length': String(file.bytes.byteLength) });
    res.end(file.bytes);
  });
  app.post('/v1/automation/schedules/:id/fire', json, async (req, res) => {
    const found = service.authenticateSchedule(String(req.params.id), bearer(req));
    if (!found) return unauthorized(req, res);
    let run = service.fire(found.agent, found.schedule);
    // Remove the job from the orchestrator once the run ended (whether or not this request waited for it).
    service.retireWhenDone(found.agent, found.schedule.id, run.id);
    // Wait for the outcome so the orchestrator's execution shows it (a failed run fails it there too).
    const wait = Math.min(AUTOMATION_LIMITS.maxWaitSeconds, Math.max(0, Number(req.query.wait ?? 0) || 0));
    if (wait) run = await service.waitFor(found.agent, service.runById(found.agent, run.id), wait * 1000, until(req, res)).catch(() => run);
    if (!res.writableEnded && !res.destroyed) res.status(run.status === 'failed' || run.status === 'cancelled' ? 422 : ['queued', 'running'].includes(run.status) ? 202 : 200).json(run);
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return res.end();
    if ((error as { type?: unknown } | undefined)?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (error instanceof RuntimeFault) {
      if (error.status === 429) res.set('Retry-After', '60');
      return res.status(error.status).json({ error: error.code, ...(errorText[error.code] ? { message: message(error.code) } : {}) });
    }
    res.status(error instanceof SyntaxError ? 400 : 503).json({ error: error instanceof SyntaxError ? 'invalid_input' : 'runtime_unavailable' });
  });
  return app;
}

/** Where the automation API listens. */
export type AutomationListenOptions = {
  /** Port. `0` picks a free one. */
  port: number;
  /**
   * Address to bind. @default '127.0.0.1'
   *
   * Docker Desktop (macOS, Windows) forwards `host.docker.internal` to the
   * host's loopback, so the default works for n8n or Conductor in Docker on
   * the same machine. On Linux, bind the Docker bridge address instead (for
   * example `172.17.0.1`, with `--add-host=host.docker.internal:host-gateway`
   * on the container). Unspecified addresses (`0.0.0.0`, `::`) are refused:
   * the API is never opened to the whole network; for other machines, use
   * `tailscale serve` (see the README).
   */
  host?: string;
};

/** Start the automation API listener. */
export async function listenAutomation(service: AutomationService, options: AutomationListenOptions): Promise<{ server: Server; url: string; port: number }> {
  const host = options.host ?? '127.0.0.1';
  if (['0.0.0.0', '::', '[::]', ''].includes(host)) throw new Error('The automation API never listens on all interfaces. Bind 127.0.0.1 (default), a Docker bridge address, or use tailscale serve.');
  const server = automationApp(service).listen(options.port, host);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.once('listening', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener unavailable');
  return { server, url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`, port: address.port };
}

/* ------------------------------------------------------------------ */
/* HTTP: managing tokens and tasks from the app                        */
/* ------------------------------------------------------------------ */

/** Who is managing automations in the app, and what they may do. */
export type AutomationAdminAccess = {
  /** The person (single-user: the local user). */
  actor(req: express.Request): AutomationActor;
  /** Admins of the agent manage tokens and tasks. */
  isAdmin(req: express.Request): boolean;
};
/** Where the API is reachable, shown in the app. */
export type AutomationEndpoint = { url: string; docker?: string; scheduler?: Orchestrator['kind'] };

/**
 * `/automations` routes of the browser app (agent admins only):
 * `GET` (tokens, tasks, pre-approvable tools, endpoint), `POST /tokens`
 * (`{ name, via, preApproved, replyMode? }` → `{ token, secret }`, the secret
 * shown once), `DELETE /tokens/<id>`, `POST /schedules/<id>/cancel`. The
 * caller has already checked the session, origin and CSRF token.
 */
export function automationAdminRoutes(service: AutomationService, agentId: (req: express.Request) => string, access: AutomationAdminAccess, endpoint: AutomationEndpoint): express.Router {
  const router = express.Router();
  const json = express.json({ limit: '24kb' });
  const agentOf = (req: express.Request) => {
    const agent = service.agents.get(agentId(req));
    if (!agent) throw new RuntimeFault('not_found', 404);
    if (!access.isAdmin(req)) throw new RuntimeFault('admin_required', 403);
    return agent;
  };
  router.get('/', (req, res) => {
    const agent = agentOf(req);
    res.json({ tokens: service.tokens(agent), schedules: service.schedules(agent), tools: [...agent.preApprovable], replyModes: agent.replyModes, endpoint });
  });
  router.post('/tokens', json, (req, res) => {
    const agent = agentOf(req);
    const actor = access.actor(req);
    // A token acts for the person who creates it: nobody can make an automation act as someone else from the app.
    const { token, secret } = createToken(agent.store, req.body, { actor, createdBy: actor, preApprovable: agent.preApprovable });
    res.status(201).json({ token: { ...tokenSummary(token), active: true }, secret });
  });
  /** `{ memoryFloor: 'accept' | 'flag' | 'ask_human' }`: the token's starting verdict for untrusted memory writes. */
  router.patch('/tokens/:id', json, (req, res) => {
    const agent = agentOf(req);
    const token = setTokenMemoryFloor(agent.store, String(req.params.id), req.body);
    res.json({ token: tokenSummary(token) });
  });
  router.delete('/tokens/:id', (req, res) => {
    const agent = agentOf(req);
    if (!revokeToken(agent.store, String(req.params.id))) throw new RuntimeFault('not_found', 404);
    res.json({ revoked: true });
  });
  router.post('/schedules/:id/cancel', async (req, res) => {
    const agent = agentOf(req);
    await service.cancelSchedule(agent, String(req.params.id));
    res.json({ cancelled: true });
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return res.end();
    if (error instanceof RuntimeFault) return res.status(error.status).json({ error: error.code });
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'invalid_input' });
    next(error);
  });
  return router;
}
