import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { visibleLine, type CommandJob } from './command-progress.js';

/**
 * Background commands: long sandbox commands (`run_command` with
 * `background: true`) that keep running after the turn ends. Each runs
 * detached in the conversation's sandbox, marked with
 * {@link BACKGROUND_MARK} (so the sandbox's process sweep spares it), with
 * its output in `/workspace/.jobs/<id>/{out,err}`, a heartbeat file the
 * watchdog touches every second, and `exit` once it ends. The host reads
 * those files through the mounted workspace (no command runs for that), so
 * a command is followed across turns, closed sessions and restarts:
 * its live card is updated, it can be stopped (a `stop` file the watchdog
 * obeys), and when it ends the host is told ({@link BackgroundCommands.onEnded})
 * and can bring the agent a notification turn.
 */

/** Environment marker of every process of a background command (and its watchdog). */
export const BACKGROUND_MARK = 'AI_SDK_LETTA_BACKGROUND=1';
/** Environment variable naming a background command's ID, set on the command's own processes (so a stop finds them). */
export const BACKGROUND_JOB_VAR = 'AI_SDK_LETTA_JOB';

export const BACKGROUND_LIMITS = Object.freeze({
  /** Default wall-clock limit of one background command (configurable: `sandbox.backgroundTimeoutMs`). */
  defaultLimitMs: 6 * 3600_000,
  /** Largest wall-clock limit. */
  maxLimitMs: 48 * 3600_000,
  /** How often the host reads the files of running commands. */
  pollMs: 1000,
  /** A running command whose heartbeat did not change for this long is gone (its sandbox stopped): `interrupted`. */
  staleMs: 20_000,
  /** Running background commands per conversation. */
  maxRunningPerConversation: 5,
  /** Records kept (the oldest ended ones are dropped). */
  maxRecords: 300,
  /** Bytes read per stream and poll (the newest). */
  tailBytes: 4096,
  /** Most characters `command_output` returns. */
  maxOutputChars: 12_000,
  /** Default and largest number of lines `command_output` returns per stream. */
  defaultTailLines: 60,
  maxTailLines: 400,
  /** Last lines quoted in a notification. */
  notifyLines: 4,
  notifyLineChars: 160,
});

/** `running`, or how it ended: exit code 0, another code, its wall-clock limit, stopped, or its sandbox went away. */
export type BackgroundState = 'running' | 'done' | 'failed' | 'timed_out' | 'stopped' | 'interrupted';
/** One background command, as recorded. Paths are host paths. */
export type BackgroundRecord = {
  id: string;
  /** The sandbox owner (`<agentId>.<conversationId>`) and the conversation. */
  owner: string; conversationId: string;
  command: string; cwd: string;
  /** Host folder of its files (`<workspace>/.jobs/<id>`). */
  dir: string;
  startedAt: string; limitMs: number;
  /** Bring the agent a turn when it ends. */
  notify: boolean;
  state: BackgroundState; exitCode?: number; endedAt?: string;
  /** Who stopped it: the agent (`command_stop`, no notification) or a person. */
  stoppedBy?: 'agent' | 'person';
  /** Its ending was delivered to the agent (a notification turn was accepted). */
  notified?: boolean;
  /** The tool call that started it, and its live card's job ID. */
  toolCallId?: string; cardJobId?: string;
  /** The last lines it printed, kept at its end (for the notification). */
  lastLines?: string[];
};
/** A background command's view for the agent and the app. */
export type BackgroundSummary = { jobId: string; command: string; cwd: string; state: BackgroundState; startedAt: string; elapsedSeconds: number; exitCode?: number; endedAt?: string };

type Live = { job?: CommandJob; offsets: { stdout: number; stderr: number }; alive?: number; aliveSeenAt: number; stopping?: boolean };
type Handle = { stop(): Promise<void> };
type State = { version: 1; commands: BackgroundRecord[] };

/** A stable run ID for a command's notification turn: the same after a restart (so it is never sent twice). */
export function backgroundRunId(id: string): string {
  const hex = createHash('sha256').update(`ai-sdk-letta.background:${id}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Read up to `max` bytes of a regular file (never a link) from `from`; `undefined` when it is missing or not a plain file. */
function readSlice(path: string, from: number, max: number): { text: string; size: number } | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return undefined; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return undefined;
    const size = info.size;
    const start = Math.max(from, size - max, 0);
    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) { const n = readSync(fd, buffer, read, length - read, start + read); if (n <= 0) break; read += n; }
    return { text: buffer.subarray(0, read).toString('utf8'), size };
  } catch { return undefined; } finally { closeSync(fd); }
}
const mtime = (path: string) => { try { const info = lstatSync(path); return info.isFile() ? info.mtimeMs : undefined; } catch { return undefined; } };
/** Is the command's folder a real folder (not a link the command made)? */
const safeDir = (dir: string) => { try { return lstatSync(dir).isDirectory() && lstatSync(dirname(dir)).isDirectory(); } catch { return false; } };
/** The last non-empty visible lines of a text (progress bars redrawn with `\r` count once). */
export function lastLines(text: string, count: number, max = BACKGROUND_LIMITS.notifyLineChars): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').map(visibleLine).map(line => line.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()).filter(Boolean).slice(-count).map(line => line.length > max ? `${line.slice(0, max - 1)}…` : line);
}
const formatSpan = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`; };

/**
 * The note an ended command brings the agent: one compact line, e.g.
 * "[Background command finished] `python play.py` · exit 0 · 14 min · last lines: …".
 */
export function backgroundNotice(record: BackgroundRecord): string {
  const command = record.command.trim().split('\n')[0]!.slice(0, 120) + (record.command.trim().length > 120 || record.command.trim().includes('\n') ? '…' : '');
  const span = formatSpan(Date.parse(record.endedAt ?? new Date().toISOString()) - Date.parse(record.startedAt));
  const how = record.state === 'done' ? 'exit 0' : record.state === 'failed' ? `exit ${record.exitCode ?? '?'}` : record.state === 'timed_out' ? `stopped at its ${formatSpan(record.limitMs)} limit` : record.state === 'stopped' ? 'stopped by a person' : 'interrupted (its sandbox stopped)';
  const head = record.state === 'done' || record.state === 'failed' ? 'finished' : record.state === 'timed_out' ? 'timed out' : record.state;
  const lines = record.lastLines?.length ? ` · last lines: ${record.lastLines.join(' ⏎ ')}` : '';
  return `[Background command ${head}] \`${command.replace(/`/g, "'")}\` · ${how} · ${span} · job ${record.id}${lines}`;
}

/** What the agent is told with a notification turn. */
export const BACKGROUND_NOTE = 'This message is a notice from the harness, not from a person: a background command you started has ended. Check its results (command_output with its jobId, and any files it wrote), then report the outcome to the person in a few lines. Do not start it again unless they ask.';

/**
 * The background commands of one agent: recorded in a JSON file (when
 * given), followed by reading their files on the host, and stopped through
 * a `stop` file. Survives sessions closing: a sandbox whose session closed
 * while commands run is parked here ({@link park}) and stopped once they
 * end; a session opened again for the conversation takes it back ({@link adopt}).
 */
export class BackgroundCommands {
  private state: State = { version: 1, commands: [] };
  private readonly live = new Map<string, Live>();
  private readonly parked = new Map<string, Promise<Handle>>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly endListeners = new Set<(record: BackgroundRecord) => void>();
  private readonly changeListeners = new Set<() => void>();
  /** Be told once when a command ends (any state): the host may deliver a notification, then calls {@link markNotified}. Returns the unsubscribe. */
  onEnded(listener: (record: BackgroundRecord) => void): () => void { this.endListeners.add(listener); return () => { this.endListeners.delete(listener); }; }
  /** Be told of every change (start, end), e.g. to refresh open pages. Returns the unsubscribe. */
  onChange(listener: () => void): () => void { this.changeListeners.add(listener); return () => { this.changeListeners.delete(listener); }; }

  constructor(private readonly options: { file?: string; pollMs?: number; staleMs?: number; now?: () => number } = {}) {
    const file = options.file;
    if (file && existsSync(file)) {
      if (lstatSync(file).isSymbolicLink()) throw new Error('Unsafe background commands file');
      const loaded = JSON.parse(readFileSync(file, 'utf8')) as State;
      if (loaded.version === 1 && Array.isArray(loaded.commands)) this.state = loaded;
    }
    // After a restart: running commands are followed again by their files (they end, or their heartbeat stops: interrupted).
    for (const record of this.state.commands) if (record.state === 'running') this.live.set(record.id, { offsets: { stdout: 0, stderr: 0 }, alive: mtime(join(record.dir, 'alive')), aliveSeenAt: this.now() });
    if (this.live.size) this.schedule();
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private save() {
    const file = this.options.file;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    try { unlinkSync(tmp); } catch { /* none */ }
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  }
  private changed() { for (const listener of this.changeListeners) { try { listener(); } catch { /* the host */ } } }
  private schedule() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.poll(), this.options.pollMs ?? BACKGROUND_LIMITS.pollMs);
    this.timer.unref?.();
  }

  /** Record a command that was just started in the sandbox; `job` is its live card. */
  add(record: Omit<BackgroundRecord, 'state' | 'startedAt'> & { startedAt?: string }, job?: CommandJob): BackgroundRecord {
    const full: BackgroundRecord = { ...record, startedAt: record.startedAt ?? new Date(this.now()).toISOString(), state: 'running' };
    if (job?.jobId) full.cardJobId = job.jobId;
    // The oldest ended records make room.
    const overflow = this.state.commands.length + 1 - BACKGROUND_LIMITS.maxRecords;
    if (overflow > 0) { const drop = new Set(this.state.commands.filter(r => r.state !== 'running' && (r.notified || !r.notify)).slice(0, overflow).map(r => r.id)); this.state.commands = this.state.commands.filter(r => !drop.has(r.id)); }
    this.state.commands.push(full);
    this.live.set(full.id, { ...(job ? { job } : {}), offsets: { stdout: 0, stderr: 0 }, aliveSeenAt: this.now() });
    this.save(); this.changed(); this.schedule();
    return { ...full };
  }
  /** Is any command of this sandbox owner running? */
  running(owner: string): boolean { return this.state.commands.some(r => r.owner === owner && r.state === 'running'); }
  /** How many commands of this owner run now. */
  runningCount(owner: string): number { return this.state.commands.filter(r => r.owner === owner && r.state === 'running').length; }
  /** A record by ID (a copy). */
  get(id: string): BackgroundRecord | undefined { const r = this.state.commands.find(c => c.id === id); return r ? structuredClone(r) : undefined; }
  /** The record whose live card is this job. */
  byCard(jobId: string): BackgroundRecord | undefined { const r = this.state.commands.find(c => c.cardJobId === jobId); return r ? structuredClone(r) : undefined; }
  /** All records (copies), oldest first; `filter` narrows them. */
  list(filter: { owner?: string; conversationId?: string; state?: BackgroundState } = {}): BackgroundRecord[] {
    return this.state.commands.filter(r => (!filter.owner || r.owner === filter.owner) && (!filter.conversationId || r.conversationId === filter.conversationId) && (!filter.state || r.state === filter.state)).map(r => structuredClone(r));
  }
  /** What the agent and the app see of a record. */
  summary(record: BackgroundRecord): BackgroundSummary {
    const end = record.endedAt ? Date.parse(record.endedAt) : this.now();
    return { jobId: record.id, command: record.command, cwd: record.cwd, state: record.state, startedAt: record.startedAt, elapsedSeconds: Math.max(0, Math.round((end - Date.parse(record.startedAt)) / 1000)), ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}), ...(record.endedAt ? { endedAt: record.endedAt } : {}) };
  }
  /** Ended commands whose notification is still owed (to deliver after a restart). */
  pendingNotifications(): BackgroundRecord[] { return this.state.commands.filter(r => r.state !== 'running' && r.notify && !r.notified).map(r => structuredClone(r)); }
  /** The notification of a command was delivered (or given up): never again. */
  markNotified(id: string) {
    const record = this.state.commands.find(r => r.id === id);
    if (!record || record.notified) return;
    record.notified = true; this.save();
  }

  /**
   * The latest output of a command: up to `tail` lines of each stream, the
   * newest, at most {@link BACKGROUND_LIMITS.maxOutputChars} in all.
   */
  output(id: string, tail: number = BACKGROUND_LIMITS.defaultTailLines): { record: BackgroundRecord; stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number } | undefined {
    const record = this.state.commands.find(r => r.id === id);
    if (!record) return undefined;
    const lines = Math.max(1, Math.min(BACKGROUND_LIMITS.maxTailLines, Math.floor(tail)));
    const budget = BACKGROUND_LIMITS.maxOutputChars;
    const read = (name: string) => safeDir(record.dir) ? readSlice(join(record.dir, name), 0, budget * 2) : undefined;
    const out = read('out'); const err = read('err');
    const pick = (text: string | undefined, chars: number) => { const kept = (text ?? '').replace(/\r\n/g, '\n').split('\n').map(visibleLine).slice(-lines - 1).join('\n').replace(/^\n+/, ''); return kept.length > chars ? `…${kept.slice(-chars)}` : kept; };
    const errText = pick(err?.text, Math.floor(budget / 3));
    return { record: structuredClone(record), stdout: pick(out?.text, budget - errText.length), stderr: errText, stdoutBytes: out?.size ?? 0, stderrBytes: err?.size ?? 0 };
  }

  /**
   * Stop a command: its watchdog sees the `stop` file within a second and
   * kills it (and what it started). Resolves once it ended or after
   * `waitMs`. A command whose sandbox is gone is marked stopped right away.
   * @returns the record, or `undefined` if there is none with this ID
   */
  async stop(id: string, by: 'agent' | 'person', waitMs = 8000): Promise<BackgroundRecord | undefined> {
    const record = this.state.commands.find(r => r.id === id);
    if (!record) return undefined;
    if (record.state !== 'running') return structuredClone(record);
    record.stoppedBy = by;
    const live = this.live.get(id);
    if (live) live.stopping = true;
    if (safeDir(record.dir)) { try { closeSync(openSync(join(record.dir, 'stop'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); } catch { /* already asked */ } }
    this.save();
    const deadline = this.now() + waitMs;
    while (this.state.commands.find(r => r.id === id)?.state === 'running' && Date.now() < deadline && !this.closed) {
      await new Promise(resolve => setTimeout(resolve, 200));
      this.poll();
    }
    // Still not ended: its sandbox does not answer; it counts as stopped (the heartbeat would mark it interrupted anyway).
    const now = this.state.commands.find(r => r.id === id)!;
    if (now.state === 'running' && (!live || this.now() - live.aliveSeenAt > 3000)) await this.end(now, 'stopped');
    return structuredClone(this.state.commands.find(r => r.id === id)!);
  }

  /** Read the files of every running command: new output to its card; its end; a stopped heartbeat. */
  poll() {
    if (this.closed) return;
    const staleMs = this.options.staleMs ?? BACKGROUND_LIMITS.staleMs;
    for (const record of this.state.commands.filter(r => r.state === 'running')) {
      const live = this.live.get(record.id) ?? { offsets: { stdout: 0, stderr: 0 }, aliveSeenAt: this.now() };
      this.live.set(record.id, live);
      if (!safeDir(record.dir)) { if (this.now() - live.aliveSeenAt > staleMs) void this.end(record, 'interrupted'); continue; }
      const exit = readSlice(join(record.dir, 'exit'), 0, 64);
      if (exit && /\n$/.test(exit.text)) { void this.finish(record, live, exit.text.trim()); continue; }
      const beat = mtime(join(record.dir, 'alive'));
      if (beat !== undefined && beat !== live.alive) { live.alive = beat; live.aliveSeenAt = this.now(); }
      else if (this.now() - live.aliveSeenAt > staleMs) { void this.end(record, record.stoppedBy ? 'stopped' : 'interrupted'); continue; }
      // Host backstop of the wall-clock limit (the sandbox's `timeout` stops it first).
      if (!live.stopping && this.now() - Date.parse(record.startedAt) > record.limitMs + 60_000) { live.stopping = true; try { closeSync(openSync(join(record.dir, 'stop'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); } catch { /* asked */ } }
      if (live.job) {
        const out = readSlice(join(record.dir, 'out'), live.offsets.stdout, BACKGROUND_LIMITS.tailBytes);
        const err = readSlice(join(record.dir, 'err'), live.offsets.stderr, BACKGROUND_LIMITS.tailBytes);
        if ((out && out.size > live.offsets.stdout) || (err && err.size > live.offsets.stderr)) {
          const chunk = { stdout: out && out.size > live.offsets.stdout ? out.text : '', stderr: err && err.size > live.offsets.stderr ? err.text : '', stdoutBytes: out?.size ?? live.offsets.stdout, stderrBytes: err?.size ?? live.offsets.stderr };
          live.offsets = { stdout: chunk.stdoutBytes, stderr: chunk.stderrBytes };
          void live.job.output(chunk).catch(() => {});
        }
      }
    }
    if (!this.state.commands.some(r => r.state === 'running') && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private async finish(record: BackgroundRecord, live: Live, code: string) {
    if (record.state !== 'running') return;
    const exitCode = /^-?\d+$/.test(code) ? Number(code) : -1;
    const stopped = existsSync(join(record.dir, 'stop'));
    const elapsed = this.now() - Date.parse(record.startedAt);
    const state: BackgroundState = code === 'nocwd' ? 'failed' : (exitCode === 124 || exitCode === 137) && elapsed >= record.limitMs - 1000 ? 'timed_out' : stopped || record.stoppedBy ? 'stopped' : exitCode === 0 ? 'done' : 'failed';
    await this.end(record, state, exitCode, live);
  }

  private async end(record: BackgroundRecord, state: Exclude<BackgroundState, 'running'>, exitCode?: number, live = this.live.get(record.id)) {
    if (record.state !== 'running') return;
    record.state = state;
    if (state === 'stopped' && !record.stoppedBy) record.stoppedBy = 'person';
    if (exitCode !== undefined) record.exitCode = exitCode;
    record.endedAt = new Date(this.now()).toISOString();
    const out = safeDir(record.dir) ? readSlice(join(record.dir, 'out'), 0, 4096) : undefined;
    const err = safeDir(record.dir) ? readSlice(join(record.dir, 'err'), 0, 4096) : undefined;
    const lines = lastLines(out?.text ?? '', BACKGROUND_LIMITS.notifyLines);
    if (state !== 'done' && err?.text) lines.push(...lastLines(err.text, 2));
    if (lines.length) record.lastLines = lines.slice(-BACKGROUND_LIMITS.notifyLines);
    // The agent stopped it itself: it knows; no notification.
    if (record.stoppedBy === 'agent') record.notified = true;
    this.live.delete(record.id);
    try { this.save(); } catch { /* the next change retries */ }
    // The card ends with the command: the last output, then its status.
    if (live?.job) {
      const stream = (text: string | undefined, size: number | undefined) => ({ head: text ?? '', bytes: size ?? 0 });
      try {
        if (state === 'interrupted' || state === 'stopped') { await live.job.output({ stdout: '', stderr: '', stdoutBytes: live.offsets.stdout, stderrBytes: live.offsets.stderr }); await live.job.finish({ error: 'cancelled', message: state === 'stopped' ? 'Stopped' : 'Interrupted: the sandbox stopped' }); }
        else await live.job.finish({ exitCode: exitCode ?? -1, timedOut: state === 'timed_out', timeoutMs: record.limitMs, stdout: stream(out?.text, out?.size), stderr: stream(err?.text, err?.size) });
      } catch { /* the card is only a view */ }
    }
    this.changed();
    for (const wake of this.watchers.get(record.owner) ?? []) { try { wake(); } catch { /* watcher */ } }
    // A parked sandbox whose last command ended is stopped now.
    if (!this.running(record.owner)) { const parked = this.parked.get(record.owner); if (parked) { this.parked.delete(record.owner); void parked.then(h => h.stop(), () => {}).catch(() => {}); } }
    for (const listener of this.endListeners) { try { listener(structuredClone(record)); } catch { /* the host */ } }
  }

  /** Keep a sandbox whose session closed while commands of `owner` run; it is stopped when they end. */
  park(owner: string, handle: Promise<Handle>) {
    if (!this.running(owner)) { void handle.then(h => h.stop(), () => {}).catch(() => {}); return; }
    const previous = this.parked.get(owner);
    if (previous && previous !== handle) void previous.then(h => h.stop(), () => {}).catch(() => {});
    this.parked.set(owner, handle);
  }
  /** Take back the parked sandbox of `owner`, if any. */
  adopt<T extends Handle>(owner: string): Promise<T> | undefined {
    const parked = this.parked.get(owner);
    this.parked.delete(owner);
    return parked as Promise<T> | undefined;
  }
  /** Be told when a command of `owner` ends (the sandbox's idle timer resumes). Returns the unsubscribe. */
  watch(owner: string, wake: () => void): () => void {
    let set = this.watchers.get(owner);
    if (!set) { set = new Set(); this.watchers.set(owner, set); }
    set.add(wake);
    return () => { set!.delete(wake); };
  }
  /** Stop following (process exit). Parked sandboxes are stopped. */
  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const parked of this.parked.values()) void parked.then(h => h.stop(), () => {}).catch(() => {});
    this.parked.clear();
  }
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** Stops every process whose environment has `mark` (`tr`/`grep`, which the image has), except the caller. */
const killMarked = (mark: string, signal: string) => `for p in /proc/[0-9]*; do n=\${p#/proc/}; [ "$n" = "$$" ] && continue; if tr '\\0' '\\n' <"$p/environ" 2>/dev/null | grep -qx ${quote(mark)}; then kill -${signal} "$n" 2>/dev/null; fi; done`;

/**
 * The script that starts one background command (run through the sandbox
 * session; returns at once). The watchdog, marked with
 * {@link BACKGROUND_MARK}, runs detached in its own session: it runs the
 * command under `timeout` (the wall-clock limit) with an empty environment
 * plus `env` and the marker, touches `alive` every second, obeys a `stop`
 * file, kills what the command left, and writes `exit` last (atomically).
 * Prints `<<ai-sdk-letta-bg:<id>>>:started` when launched.
 */
export function backgroundScript(options: { id: string; command: string; cwd: string; env: Record<string, string>; limitSeconds: number; root?: string }): string {
  const { id } = options;
  if (!/^[a-z0-9-]{4,40}$/.test(id)) throw new Error('Invalid background command ID');
  for (const key of Object.keys(options.env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name ${key}`);
  const dir = `${options.root ?? '/workspace'}/.jobs/${id}`;
  const exports = [BACKGROUND_MARK, `${BACKGROUND_JOB_VAR}=${id}`, ...Object.entries(options.env).map(([key, value]) => `${key}=${quote(value)}`)].join(' ');
  const jobMark = `${BACKGROUND_JOB_VAR}=${id}`;
  const watchdog = [
    `D=${quote(dir)}`,
    'date +%s >"$D/alive"',
    `if ! cd -- ${quote(options.cwd)} 2>/dev/null; then printf 'nocwd\\n' >"$D/exit.tmp"; mv -f "$D/exit.tmp" "$D/exit"; exit 0; fi`,
    'B=/bin/bash; [ -x "$B" ] || B=/bin/sh',
    `timeout -k 10 ${Math.max(1, Math.round(options.limitSeconds))} env -i ${exports} "$B" -c ${quote(options.command)} </dev/null >"$D/out" 2>"$D/err" &`,
    'c=$!',
    `( while kill -0 "$c" 2>/dev/null; do date +%s >"$D/alive"; if [ -e "$D/stop" ]; then kill -TERM "$c" 2>/dev/null; ${killMarked(jobMark, 'TERM')}; sleep 2; ${killMarked(jobMark, 'KILL')}; kill -KILL "$c" 2>/dev/null; exit 0; fi; sleep 1; done ) &`,
    'w=$!',
    'wait "$c"; e=$?',
    'kill "$w" 2>/dev/null',
    `${killMarked(jobMark, 'KILL')}`,
    'printf \'%s\\n\' "$e" >"$D/exit.tmp"; mv -f "$D/exit.tmp" "$D/exit"',
  ].join('\n');
  return [
    `D=${quote(dir)}; mkdir -p "$D" || exit 125; : >"$D/out"; : >"$D/err"; rm -f "$D/exit" "$D/stop"`,
    'S=$(command -v setsid || true)',
    `env -i ${BACKGROUND_MARK} PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin $S /bin/sh -c ${quote(watchdog)} </dev/null >/dev/null 2>&1 &`,
    `printf '%s\\n' ${quote(`<<ai-sdk-letta-bg:${id}>>:started`)}`,
  ].join('\n');
}

const shared = new Map<string, BackgroundCommands>();
/**
 * The background commands recorded under a state directory
 * (`<root>/background-commands.json`): one instance per process and
 * directory, shared by every agent and session there (they outlive sessions).
 */
export function backgroundCommandsAt(root: string): BackgroundCommands {
  let commands = shared.get(root);
  if (!commands) { commands = new BackgroundCommands({ file: join(root, 'background-commands.json') }); shared.set(root, commands); }
  return commands;
}
