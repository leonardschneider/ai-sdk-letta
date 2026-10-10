import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JOB_LIMITS, JobError, type JobDesk, type JobEndRequest, type JobImage, type JobImageType, type JobStartRequest, type JobStatus, type JobTurn, type JobUpdateRequest } from 'ai-sdk-letta';

/**
 * The jobs of one agent (visible background work, see the library's job
 * tools): recorded per conversation in `<dir>/jobs.json`, their latest
 * images in `<dir>/job-images/`. Updates are throttled (at most one applied
 * every {@link JOB_BOARD_LIMITS.minUpdateMs}; the latest value wins). Running
 * jobs found at start are marked `interrupted`.
 */

export const JOB_BOARD_LIMITS = Object.freeze({
  /** Updates applied at most this often per job (about 4 per second). */
  minUpdateMs: 250,
  /** Running jobs per conversation. */
  maxRunningPerThread: 20,
  /** Jobs kept per conversation (the oldest ended ones are dropped). */
  maxPerThread: 100,
  /** A running job not updated for this long no longer counts as work in the activity view. */
  staleMs: 10 * 60_000,
});

/** A job as recorded. */
export type JobRecord = {
  id: string; threadId: string; conversationId: string; toolCallId: string;
  goal: string; unit?: string; total?: number; done?: number;
  /** `command`: the automatic job of a long command (its goal is the command). */
  kind?: 'command';
  /** Rate and time left as the work reported them (tqdm), at `updatedAt`. */
  reported?: { ratePerSecond?: number; etaSeconds?: number };
  status: JobStatus; result?: string;
  /** Latest log lines (the newest last). */
  lines: string[];
  /** The latest image: its media type and version (a cache-buster), and the path it was read from (re-read on updates). */
  image?: { mediaType: JobImageType; version: number; path?: string };
  startedAt: string; updatedAt: string; endedAt?: string;
  /** First progress sample (for the rate). */
  firstAt?: string; firstDone?: number;
  version: number;
};
/** A job as the app shows it, with its progress computed by the host. */
export type PublicJob = Omit<JobRecord, 'conversationId' | 'firstAt' | 'firstDone' | 'image' | 'reported'> & {
  image?: { mediaType: JobImageType; version: number };
  progress: JobProgress;
};
/** Progress of a job: `percent` (with a total), `ratePerSecond` and `etaSeconds` once measurable. */
export type JobProgress = { percent?: number; ratePerSecond?: number; etaSeconds?: number; elapsedSeconds: number };

/**
 * A tqdm-like reading of a job: percent done, rate (steps per second since
 * the first progress sample, or since the start), and the time left at that
 * rate. Ended jobs measure up to their end.
 */
export function jobProgress(job: Pick<JobRecord, 'done' | 'total' | 'startedAt' | 'endedAt' | 'firstAt' | 'firstDone' | 'status'> & Partial<Pick<JobRecord, 'reported' | 'updatedAt'>>, now = Date.now()): JobProgress {
  const start = Date.parse(job.startedAt);
  const end = job.endedAt ? Date.parse(job.endedAt) : now;
  const elapsedSeconds = Math.max(0, (end - start) / 1000);
  const percent = job.total && job.done !== undefined ? Math.max(0, Math.min(100, (job.done / job.total) * 100)) : undefined;
  let ratePerSecond: number | undefined;
  if (job.done !== undefined && job.done > 0) {
    const from = job.firstAt && job.firstDone !== undefined && job.done > job.firstDone ? { at: Date.parse(job.firstAt), done: job.firstDone } : { at: start, done: 0 };
    const seconds = (end - from.at) / 1000;
    if (seconds >= 1) ratePerSecond = (job.done - from.done) / seconds;
  }
  // What the work reports (tqdm) wins; its time left counts down from the report.
  if (job.reported?.ratePerSecond !== undefined) ratePerSecond = job.reported.ratePerSecond;
  if (job.status === 'running' && job.reported?.etaSeconds !== undefined) {
    const since = job.updatedAt ? Math.max(0, (now - Date.parse(job.updatedAt)) / 1000) : 0;
    return { elapsedSeconds, ...(percent !== undefined ? { percent } : {}), ...(ratePerSecond !== undefined ? { ratePerSecond } : {}), etaSeconds: Math.max(0, job.reported.etaSeconds - since) };
  }
  const etaSeconds = job.status === 'running' && ratePerSecond && ratePerSecond > 0 && job.total !== undefined && job.done !== undefined && job.total > job.done ? (job.total - job.done) / ratePerSecond : undefined;
  return { elapsedSeconds, ...(percent !== undefined ? { percent } : {}), ...(ratePerSecond !== undefined ? { ratePerSecond } : {}), ...(etaSeconds !== undefined ? { etaSeconds } : {}) };
}

type State = { version: 1; jobs: JobRecord[] };
type Pending = { request: JobUpdateRequest; timer?: ReturnType<typeof setTimeout> };

/** What the board needs from its runtime. */
export interface JobHost {
  /** The thread of a conversation, if known. */
  threadOf(conversationId: string): string | undefined;
  /** Something visible changed (a job started, progressed or ended); `job` for the live run stream. */
  jobChanged(job: JobRecord): void;
}

export class JobBoard {
  private state: State;
  private pending = new Map<string, Pending>();
  private lastApplied = new Map<string, number>();
  private readonly images: string;
  private changes = 0;
  private waiting = new Set<() => void>();
  constructor(private readonly filename: string, private readonly host: JobHost, private readonly now: () => number = Date.now) {
    this.images = join(dirname(filename), 'job-images');
    if (existsSync(filename)) {
      if (lstatSync(filename).isSymbolicLink()) throw new Error('Unsafe jobs file');
      const state = JSON.parse(readFileSync(filename, 'utf8')) as State;
      if (state.version !== 1 || !Array.isArray(state.jobs)) throw new Error('Invalid jobs file');
      this.state = state;
    } else this.state = { version: 1, jobs: [] };
    // A restart ends what was running: its progress is no longer reported.
    let interrupted = false;
    for (const job of this.state.jobs) if (job.status === 'running') { job.status = 'interrupted'; job.endedAt = new Date(this.now()).toISOString(); job.version++; interrupted = true; }
    if (interrupted) this.save();
  }
  private save() {
    const tmp = `${this.filename}.tmp`;
    try { unlinkSync(tmp); } catch { /* none */ }
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.filename);
  }
  private changed(job: JobRecord) {
    this.changes++;
    const waiting = [...this.waiting]; this.waiting.clear();
    for (const wake of waiting) wake();
    try { this.host.jobChanged(job); } catch { /* the runtime */ }
  }
  /** Increases whenever a job changes. */
  get version(): number { return this.changes; }
  /** Resolves with the new {@link version} once it differs from `since`, or after `timeoutMs`. */
  waitForChange(since: number, timeoutMs = 25_000, signal?: AbortSignal): Promise<number> {
    if (since !== this.changes || signal?.aborted) return Promise.resolve(this.changes);
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiting.delete(done); signal?.removeEventListener('abort', done); resolve(this.changes); };
      const timer = setTimeout(done, timeoutMs); timer.unref?.();
      this.waiting.add(done); signal?.addEventListener('abort', done, { once: true });
    });
  }
  private job(id: string, conversationId: string) {
    const job = this.state.jobs.find(j => j.id === id);
    if (!job || job.conversationId !== conversationId) throw new JobError('job_not_found');
    return job;
  }
  private writeImage(id: string, image: JobImage) {
    mkdirSync(this.images, { recursive: true, mode: 0o700 });
    const file = join(this.images, id);
    const tmp = `${file}.tmp`;
    try { unlinkSync(tmp); } catch { /* none */ }
    writeFileSync(tmp, image.bytes, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  }

  /** The desk the agent's job tools use. */
  readonly desk: JobDesk = {
    start: (request: JobStartRequest, turn: JobTurn) => {
      const threadId = this.host.threadOf(turn.conversationId);
      if (!threadId) throw new JobError('jobs_unavailable');
      const mine = this.state.jobs.filter(j => j.threadId === threadId);
      if (mine.filter(j => j.status === 'running').length >= JOB_BOARD_LIMITS.maxRunningPerThread) throw new JobError('job_limit');
      // The oldest ended jobs of the conversation make room.
      const overflow = mine.length + 1 - JOB_BOARD_LIMITS.maxPerThread;
      if (overflow > 0) {
        const drop = new Set(mine.filter(j => j.status !== 'running').slice(0, overflow).map(j => j.id));
        this.state.jobs = this.state.jobs.filter(j => !drop.has(j.id));
        for (const id of drop) try { unlinkSync(join(this.images, id)); } catch { /* none */ }
      }
      const at = new Date(this.now()).toISOString();
      const job: JobRecord = { id: `job-${randomUUID()}`, threadId, conversationId: turn.conversationId, toolCallId: turn.toolCallId, goal: request.goal, ...(request.kind === 'command' ? { kind: 'command' as const } : {}), ...(request.unit ? { unit: request.unit } : {}), ...(request.total !== undefined ? { total: request.total } : {}),
        status: 'running', lines: [], startedAt: at, updatedAt: at, version: 1 };
      this.state.jobs.push(job); this.save(); this.changed(job);
      return { id: job.id };
    },
    update: (id: string, request: JobUpdateRequest, turn: JobTurn) => {
      const job = this.job(id, turn.conversationId);
      if (job.status !== 'running') throw new JobError('job_ended');
      // Latest wins: merge into what waits (log lines accumulate), apply at most every minUpdateMs.
      const pending = this.pending.get(id) ?? { request: {} };
      const lines = [pending.request.message, request.message].filter(Boolean).join('\n');
      pending.request = { ...pending.request, ...request, ...(lines ? { message: lines } : {}) };
      this.pending.set(id, pending);
      const wait = (this.lastApplied.get(id) ?? 0) + JOB_BOARD_LIMITS.minUpdateMs - this.now();
      if (wait <= 0) { if (pending.timer) clearTimeout(pending.timer); this.flush(id); }
      else pending.timer ??= setTimeout(() => this.flush(id), wait);
    },
    end: (id: string, request: JobEndRequest, turn: JobTurn) => {
      const job = this.job(id, turn.conversationId);
      if (job.status !== 'running') throw new JobError('job_ended');
      this.flush(id);
      job.status = request.status; job.endedAt = job.updatedAt = new Date(this.now()).toISOString(); job.version++;
      if (request.result) job.result = request.result;
      // Done: the bar reads full.
      if (request.status === 'done' && job.total !== undefined) job.done = job.total;
      this.save(); this.changed(job);
    },
    imageRef: (id: string, turn: JobTurn) => { try { return this.job(id, turn.conversationId).image?.path; } catch { return undefined; } },
    agentJobActive: (conversationId: string) => this.state.jobs.some(j => j.conversationId === conversationId && j.kind !== 'command' && j.status === 'running' && this.fresh(j)),
  };

  /** Apply a job's waiting update now. */
  private flush(id: string) {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (pending?.timer) clearTimeout(pending.timer);
    const job = this.state.jobs.find(j => j.id === id);
    if (!pending || !job || job.status !== 'running') return;
    const { done, total, message, image, imageRef, ratePerSecond, etaSeconds } = pending.request;
    const at = new Date(this.now()).toISOString();
    if (total !== undefined) job.total = total;
    if (done !== undefined) {
      if (job.firstAt === undefined) { job.firstAt = at; job.firstDone = done; }
      job.done = done;
    }
    if (ratePerSecond !== undefined || etaSeconds !== undefined) job.reported = { ...(ratePerSecond !== undefined && Number.isFinite(ratePerSecond) && ratePerSecond >= 0 ? { ratePerSecond } : {}), ...(etaSeconds !== undefined && Number.isFinite(etaSeconds) && etaSeconds >= 0 ? { etaSeconds } : {}) };
    else if (done !== undefined) delete job.reported;
    if (message) job.lines = [...job.lines, ...message.split('\n')].slice(-JOB_LIMITS.maxLines);
    if (image) {
      try { this.writeImage(id, image); job.image = { mediaType: image.mediaType, version: (job.image?.version ?? 0) + 1, ...(imageRef ? { path: imageRef } : {}) }; } catch { /* the previous image stays */ }
    }
    job.updatedAt = at; job.version++;
    this.lastApplied.set(id, this.now());
    try { this.save(); } catch { /* the next change retries */ }
    this.changed(job);
  }

  /** Apply every waiting update (tests, shutdown). */
  flushAll() { for (const id of [...this.pending.keys()]) this.flush(id); }
  close() { this.flushAll(); }

  /** A thread's jobs (oldest first), as the app shows them. */
  forThread(threadId: string): PublicJob[] { return this.state.jobs.filter(j => j.threadId === threadId).map(j => publicJob(j, this.now())); }
  /** Running jobs of every conversation. */
  running(): PublicJob[] { return this.state.jobs.filter(j => j.status === 'running').map(j => publicJob(j, this.now())); }
  /** A job's latest image, if it has one and belongs to the thread. */
  image(threadId: string, id: string): { bytes: Buffer; mediaType: JobImageType } | undefined {
    const job = this.state.jobs.find(j => j.id === id && j.threadId === threadId);
    if (!job?.image || !/^job-[0-9a-f-]{36}$/.test(id)) return undefined;
    try { return { bytes: readFileSync(join(this.images, id)), mediaType: job.image.mediaType }; } catch { return undefined; }
  }
  /** Is a running job still reporting (updated recently)? */
  fresh(job: Pick<JobRecord, 'updatedAt'>): boolean { return this.now() - Date.parse(job.updatedAt) < JOB_BOARD_LIMITS.staleMs; }
}

export function publicJob(job: JobRecord, now = Date.now()): PublicJob {
  const { conversationId: _c, firstAt: _f, firstDone: _d, image, reported: _r, ...rest } = job;
  return { ...rest, lines: [...job.lines], ...(image ? { image: { mediaType: image.mediaType, version: image.version } } : {}), progress: jobProgress(job, now) };
}
