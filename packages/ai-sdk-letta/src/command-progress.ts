import { JOB_LIMITS, JOBS_CONTEXT, agentJobActive, jobLine, type JobContext, type JobEndRequest, type JobUpdateRequest } from './jobs.js';

/**
 * Live progress of long commands (UI only): while `run_command` runs, the
 * sandbox's output files are read every second (from ~3 s on), and the
 * command is shown as an automatic job card: its goal is the command, its
 * log the latest output lines, its bar what tqdm, `N/M` or `NN%` say.
 * What the model gets is unchanged.
 */

export const COMMAND_PROGRESS = Object.freeze({
  /** Commands shorter than this cost nothing (no polling, no card). */
  delayMs: 3000,
  /** How often the output is read while the command runs. */
  intervalMs: 1000,
  /** Bytes of new output read per stream on each poll (the newest). */
  tailBytes: 4096,
  /** New log lines sent per poll (the newest). */
  maxLinesPerUpdate: 10,
  maxGoalCharacters: 80,
});

/** New output of a running command: what each stream gained since the last read, and their full sizes. */
export type CommandOutputChunk = { stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number };
/** Progress read from output: steps done and total, and tqdm's rate and time left when it prints them. */
export type ParsedProgress = { done: number; total: number; ratePerSecond?: number; etaSeconds?: number };

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const SCALE: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
const scaled = (value: string, suffix = '') => Number(value) * (SCALE[suffix] ?? 1);
/** "01:02", "1:02:03" → seconds. */
const clock = (value: string) => { const parts = value.split(':').map(Number); return parts.some(n => !Number.isFinite(n)) ? undefined : parts.reduce((total, n) => total * 60 + n, 0); };
const TQDM = new RegExp(String.raw`(${NUMBER})%\s*\|[^|\n]*\|\s*(${NUMBER})([kMGT]?)\s*\/\s*(${NUMBER})([kMGT]?)(?:\s*\[([^\]]*)\])?`);
const RATIO = new RegExp(String.raw`(?:^|[\s(\[:,=])(${NUMBER})\s*([kMGT]?(?:i?B)?)\s*\/\s*(${NUMBER})\s*([kMGT]?(?:i?B)?)(?=$|[\s)\],:;]|\s*[a-zA-Z])`);
const PERCENT = new RegExp(String.raw`(?:^|[^\w.])(${NUMBER})\s?%`);
const BYTES: Record<string, number> = { '': 1, B: 1, kB: 1e3, KB: 1e3, KiB: 1024, MB: 1e6, MiB: 1024 ** 2, GB: 1e9, GiB: 1024 ** 3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };

/**
 * Progress in one line of output: tqdm (`45%|████▌ | 9/20 [00:12<00:15, 1.35it/s]`),
 * a pip download (`1.2/3.4 MB 2.1 MB/s eta 0:00:01`), `N/M` (`step 9/20`), or `NN%`.
 * @returns `undefined` when the line says nothing about progress
 */
export function parseProgressLine(line: string): ParsedProgress | undefined {
  const tqdm = TQDM.exec(line);
  if (tqdm) {
    const done = scaled(tqdm[2]!, tqdm[3]); const total = scaled(tqdm[4]!, tqdm[5]);
    if (!(total > 0) || done > total * 1.0001) return undefined;
    const out: ParsedProgress = { done, total };
    const info = tqdm[6];
    if (info) {
      const times = /^\s*([\d:]+)\s*<\s*([\d:]+|\?)/.exec(info);
      const eta = times && times[2] !== '?' ? clock(times[2]!) : undefined;
      if (eta !== undefined) out.etaSeconds = eta;
      const perSecond = new RegExp(String.raw`(${NUMBER})([kMGT]?)\s*[A-Za-z]*\/s\b`).exec(info);
      const perStep = new RegExp(String.raw`(${NUMBER})\s*s\/[A-Za-z]+`).exec(info);
      if (perSecond) out.ratePerSecond = scaled(perSecond[1]!, perSecond[2]);
      else if (perStep && Number(perStep[1]) > 0) out.ratePerSecond = 1 / Number(perStep[1]);
    }
    return out;
  }
  const ratio = RATIO.exec(line);
  if (ratio) {
    const [, a, ua = '', b, ub = ''] = ratio;
    // pip prints "1.2/3.4 MB": the unit of the total applies to both.
    const unitA = ua || ub; const unitB = ub || ua;
    const done = Number(a) * (BYTES[unitA] ?? 1); const total = Number(b) * (BYTES[unitB] ?? 1);
    // Not a date (2024/10), not a fraction larger than its whole.
    if (total > 0 && done <= total && !(Number.isInteger(Number(a)) && Number(a) > 1900 && Number(a) < 2100 && !ua)) {
      const out: ParsedProgress = { done: unitA ? Math.round(done) : done, total: unitB ? Math.round(total) : total };
      const eta = /\beta\s+(\d+(?::\d+)+)/i.exec(line);
      if (eta) { const seconds = clock(eta[1]!); if (seconds !== undefined) out.etaSeconds = seconds; }
      return out;
    }
  }
  const percent = PERCENT.exec(line);
  if (percent) {
    const value = Number(percent[1]);
    if (value >= 0 && value <= 100) return { done: value, total: 100 };
  }
  return undefined;
}

/** What a terminal shows for one line: the last non-empty part after a carriage return (tqdm redraws with `\r`). */
export function visibleLine(segment: string): string {
  const parts = segment.split('\r');
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i]!.trim()) return parts[i]!;
  return '';
}

/** Splits a stream into lines as it grows: finished lines, and the line being drawn (after `\r` handling). */
export class OutputLines {
  private carry = '';
  push(chunk: string): { complete: string[]; current?: string } {
    const text = (this.carry + chunk).replace(/\r\n/g, '\n');
    const parts = text.split('\n');
    // Keep only the tail of a line that never ends (a progress bar redrawn for minutes).
    this.carry = parts.pop()!.slice(-8192);
    const complete = parts.map(visibleLine).filter(line => line.trim());
    const current = visibleLine(this.carry);
    return { complete, ...(current.trim() ? { current } : {}) };
  }
}

/** The goal of a command's job: `$ python play.py --games 20`, its first line, shortened. */
export function commandGoal(command: string): string {
  const first = command.trim().split('\n')[0]!.trim();
  const more = command.trim().includes('\n');
  const line = jobLine(first, 400);
  const max = COMMAND_PROGRESS.maxGoalCharacters - 2;
  return `$ ${line.length > max || more ? `${line.slice(0, line.length > max ? max - 1 : max).trimEnd()}…` : line}`;
}

/** How a command ended, for its job: a result, a timeout, or an error (`cancelled` when stopped). */
export type CommandEnd =
  | { exitCode: number; timedOut: boolean; timeoutMs?: number; stdout: { head: string; tail?: string; bytes: number }; stderr: { head: string; tail?: string; bytes: number } }
  | { error: 'failed' | 'cancelled'; message?: string };

/** The automatic job of one command. */
export interface CommandJob {
  /** New output read while the command runs (the job starts on the first). */
  output(chunk: CommandOutputChunk): Promise<void>;
  /** The command ended: the last output, then the end. */
  finish(end: CommandEnd): Promise<void>;
  /** The job's ID once it started. */
  readonly jobId: string | undefined;
}

const tailOf = (text: string, bytes: number) => {
  const buffer = Buffer.from(text);
  return bytes >= buffer.length ? text : buffer.subarray(buffer.length - bytes).toString('utf8');
};

/**
 * The automatic job card of a `run_command` call, if the turn has jobs.
 * Started on the first output read (the command ran ~3 s), unless the agent
 * reports its own job; ended with the command (done on exit code 0, else
 * failed with the code, or timed out). Never throws: the card is only a view.
 */
export function commandJob(context: Readonly<Record<string, unknown>> | undefined, toolCallId: string, command: string): CommandJob | undefined {
  const bound = context?.[JOBS_CONTEXT] as JobContext | undefined;
  if (!bound) return undefined;
  const turn = { conversationId: bound.conversationId, toolCallId };
  const streams = { stdout: new OutputLines(), stderr: new OutputLines() };
  const read = { stdout: 0, stderr: 0 };
  let id: string | undefined;
  let skipped = false;
  let lastCurrent: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  const serial = (task: () => Promise<void>) => { chain = chain.then(task).catch(() => {}); return chain; };

  const apply = async (chunk: CommandOutputChunk) => {
    if (skipped) return;
    if (!id) {
      if (agentJobActive(bound)) { skipped = true; return; }
      id = (await bound.desk.start({ goal: commandGoal(command), kind: 'command' }, turn)).id;
    }
    read.stdout = Math.max(read.stdout, chunk.stdoutBytes); read.stderr = Math.max(read.stderr, chunk.stderrBytes);
    const out = streams.stdout.push(chunk.stdout); const err = streams.stderr.push(chunk.stderr);
    const complete = [...out.complete, ...err.complete];
    // The line being drawn: a progress bar (usually on stderr) first.
    const currents = [err.current, out.current].filter((line): line is string => !!line);
    const current = currents.find(line => parseProgressLine(line)) ?? currents[0];
    const lines = complete.slice(-COMMAND_PROGRESS.maxLinesPerUpdate);
    if (current && current !== lastCurrent) lines.push(current);
    lastCurrent = current;
    let progress: ParsedProgress | undefined;
    for (const line of [...currents, ...[...complete].reverse()]) { progress = parseProgressLine(line); if (progress) break; }
    const message = lines.map(line => jobLine(line, JOB_LIMITS.maxMessageCharacters)).filter(Boolean).join('\n');
    if (!message && !progress) return;
    const request: JobUpdateRequest = { ...(message ? { message } : {}), ...(progress ? { done: progress.done, total: progress.total, ...(progress.ratePerSecond !== undefined ? { ratePerSecond: progress.ratePerSecond } : {}), ...(progress.etaSeconds !== undefined ? { etaSeconds: progress.etaSeconds } : {}) } : {}) };
    await bound.desk.update(id, request, turn);
  };

  return {
    get jobId() { return id; },
    output: chunk => serial(() => apply(chunk)),
    finish: end => serial(async () => {
      if (!id) return;
      let request: JobEndRequest;
      if ('error' in end) request = { status: end.error, ...(end.message ? { result: jobLine(end.message, JOB_LIMITS.maxResultCharacters) } : {}) };
      else {
        // What was printed after the last read.
        const rest = (stream: { head: string; tail?: string; bytes: number }, seen: number) => tailOf(stream.tail ?? stream.head, Math.min(COMMAND_PROGRESS.tailBytes, Math.max(0, stream.bytes - seen)));
        try { await apply({ stdout: rest(end.stdout, read.stdout), stderr: rest(end.stderr, read.stderr), stdoutBytes: end.stdout.bytes, stderrBytes: end.stderr.bytes }); } catch { /* the end still counts */ }
        request = end.timedOut ? { status: 'failed', result: `Timed out after ${Math.round((end.timeoutMs ?? 0) / 1000)} s (exit code ${end.exitCode})` }
          : end.exitCode === 0 ? { status: 'done', result: 'Exit code 0' } : { status: 'failed', result: `Exit code ${end.exitCode}` };
      }
      await bound.desk.end(id, request, turn);
    }),
  };
}
