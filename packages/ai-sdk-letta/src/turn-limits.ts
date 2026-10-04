/**
 * How long a turn may run (see {@link TurnClock}).
 *
 * - `idleMs`: a turn with no progress for this long is stopped. Progress is
 *   any streamed event (text, reasoning, a tool call or its result); while a
 *   tool call is still running (a sandbox command, a build) the turn is not
 *   idle. A long but active turn is never cut by it.
 * - `maxMs`: the hard cap on a turn's working time. `0` disables it.
 *
 * Time spent waiting for a person (an approval, a question) counts toward
 * neither: the clock pauses while a prompt is open.
 *
 * A turn that reaches either limit is stopped like a press of Stop: the
 * backend run is cancelled, the conversation stays usable, and the partial
 * reply is kept (see `LettaAgent.lastTurn`).
 */
export type TurnLimits = { idleMs: number; maxMs: number };
/** Why a turn was stopped: by the application (`aborted`), or by a {@link TurnLimits} limit. */
export type TurnStopReason = 'aborted' | 'idle_timeout' | 'max_duration';

/** Default idle timeout: ten minutes without progress. */
export const DEFAULT_TURN_IDLE_MS = 10 * 60_000;
/** Default hard cap: six hours of work. */
export const DEFAULT_TURN_MAX_MS = 6 * 60 * 60_000;
/** Longest timer Node can run (about 24.8 days). */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Environment variables read by {@link turnLimits}:
 * - `AI_SDK_LETTA_TURN_IDLE_MS`: the idle timeout (ms, at least 1000);
 * - `AI_SDK_LETTA_TURN_MAX_MS`: the hard cap (ms; `0` disables it);
 * - `AI_SDK_LETTA_TURN_DEADLINE_MS`: the older name of the hard cap (it was
 *   a fixed per-turn work budget), used when `AI_SDK_LETTA_TURN_MAX_MS` is
 *   not set.
 */
export const TURN_LIMIT_ENV = { idle: 'AI_SDK_LETTA_TURN_IDLE_MS', max: 'AI_SDK_LETTA_TURN_MAX_MS', deadline: 'AI_SDK_LETTA_TURN_DEADLINE_MS' } as const;

const parse = (value: string | undefined, name: string, zero: boolean): number | undefined => {
  if (value === undefined || !value.trim()) return undefined;
  const number = Number(value.trim());
  if (!Number.isSafeInteger(number) || (zero ? number < 0 || (number > 0 && number < 1000) : number < 1000) || number > MAX_TIMER_MS) throw new Error(`${name} must be a whole number of milliseconds, at least 1000${zero ? ' (or 0 to disable)' : ''}`);
  return number;
};

/** Validate limits and fill in defaults. @throws on invalid values */
export function resolveTurnLimits(limits: Partial<TurnLimits> = {}): TurnLimits {
  const idleMs = limits.idleMs ?? DEFAULT_TURN_IDLE_MS;
  const maxMs = limits.maxMs ?? DEFAULT_TURN_MAX_MS;
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > MAX_TIMER_MS) throw new Error('Turn idle timeout must be a positive whole number of milliseconds');
  if (!Number.isSafeInteger(maxMs) || maxMs < 0 || maxMs > MAX_TIMER_MS) throw new Error('Turn hard cap must be 0 (none) or a positive whole number of milliseconds');
  return Object.freeze({ idleMs, maxMs });
}

/** The limits the environment sets (see {@link TURN_LIMIT_ENV}); only those that are set. @throws on invalid values */
export function envTurnLimits(env: NodeJS.ProcessEnv = process.env): Partial<TurnLimits> {
  const idle = parse(env[TURN_LIMIT_ENV.idle], TURN_LIMIT_ENV.idle, false);
  const max = parse(env[TURN_LIMIT_ENV.max], TURN_LIMIT_ENV.max, true) ?? parse(env[TURN_LIMIT_ENV.deadline], TURN_LIMIT_ENV.deadline, true);
  return { ...(idle !== undefined ? { idleMs: idle } : {}), ...(max !== undefined ? { maxMs: max } : {}) };
}

/** Turn limits from the environment (see {@link TURN_LIMIT_ENV}), with defaults. @throws on invalid values */
export function turnLimits(env: NodeJS.ProcessEnv = process.env): TurnLimits { return resolveTurnLimits(envTurnLimits(env)); }

/**
 * The Letta SDK's per-turn timer (`appServer.requestTimeoutMs` of the
 * sessions that run turns). In the installed SDK (0.8.22) it is one
 * wall-clock timer per turn, started when the turn becomes active and never
 * extended (not by progress, not by human waits); when it fires, the turn
 * fails like a transport error and its delivery is uncertain. The runtime's
 * own clock (see {@link TurnLimits}) excludes human waits, so no finite
 * margin over the hard cap is always enough: the SDK timer is effectively
 * unbounded (the longest Node timer, about 24.8 days) and the runtime's
 * limits stop turns cleanly first. The same option is the default of other
 * requests on those sessions, so the runtime gives every setup and status
 * request (start, status, history, stop) an explicit timeout of its own.
 */
export const SDK_TURN_TIMEOUT_MS = MAX_TIMER_MS;

/** A readable duration ("10 min", "6 h", "90 s"). */
export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}

/**
 * The clock of one turn (see {@link TurnLimits}). Call {@link progress} on
 * every streamed event, {@link setBusy} while a tool call runs, and
 * {@link pause}/{@link resume} around human waits; `onExpire` runs at most
 * once, with the limit that was reached. Uses `setTimeout` and `Date.now`
 * only (fake timers work).
 */
export class TurnClock {
  private idleTimer?: ReturnType<typeof setTimeout>;
  private capTimer?: ReturnType<typeof setTimeout>;
  private waiting = 0;
  private busy = false;
  private workedMs = 0;
  private resumedAt = 0;
  private state: 'new' | 'running' | 'done' = 'new';
  constructor(private readonly limits: TurnLimits, private readonly onExpire: (reason: Exclude<TurnStopReason, 'aborted'>) => void) {}
  /** Start counting. */
  start(): void { if (this.state !== 'new') return; this.state = 'running'; this.resumedAt = Date.now(); this.arm(); }
  /** Something happened (a streamed event): the idle timeout starts again. */
  progress(): void { if (this.state === 'running') this.armIdle(); }
  /** A tool call is running (`true`) or none is (`false`): a running tool is not idle; its end counts as progress. */
  setBusy(busy: boolean): void { if (this.busy === busy) return; this.busy = busy; if (this.state === 'running') this.armIdle(); }
  /** A person is being asked something: neither limit counts until {@link resume}. Nests. */
  pause(): void {
    if (this.waiting++ > 0 || this.state !== 'running') return;
    this.workedMs += Date.now() - this.resumedAt;
    this.clear();
  }
  /** The person answered (or the prompt closed). */
  resume(): void {
    if (this.waiting === 0 || --this.waiting > 0 || this.state !== 'running') return;
    this.resumedAt = Date.now(); this.arm();
  }
  /** Stop counting (the turn ended or is being stopped). */
  stop(): void { this.state = 'done'; this.clear(); }
  /** Working time so far (human waits excluded). */
  get workMs(): number { return this.workedMs + (this.state === 'running' && !this.waiting ? Date.now() - this.resumedAt : 0); }
  private clear() { clearTimeout(this.idleTimer); clearTimeout(this.capTimer); this.idleTimer = this.capTimer = undefined; }
  private expire(reason: Exclude<TurnStopReason, 'aborted'>) { if (this.state !== 'running') return; this.stop(); this.onExpire(reason); }
  private arm() { this.armIdle(); this.armCap(); }
  private armIdle() {
    clearTimeout(this.idleTimer); this.idleTimer = undefined;
    if (this.waiting || this.busy) return;
    this.idleTimer = setTimeout(() => this.expire('idle_timeout'), this.limits.idleMs);
  }
  private armCap() {
    clearTimeout(this.capTimer); this.capTimer = undefined;
    if (this.waiting || !this.limits.maxMs) return;
    this.capTimer = setTimeout(() => this.expire('max_duration'), Math.max(1, this.limits.maxMs - this.workedMs));
  }
}
