import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { jsonSchema, tool, type Tool } from 'ai';
import type { ToolPermission } from './definition.js';

/**
 * Jobs: visible background work. The agent states a goal (`job_start`),
 * reports progress, a log line and a live image (`job_update`), and ends it
 * (`job_end`). The host shows each job as a live card in the conversation
 * (goal, a tqdm-like bar with rate and ETA, the latest log line, the image)
 * and in its activity view. Results to the model stay tiny, so updates cost
 * almost no tokens. A job may outlive the turn that started it: the agent
 * can keep updating it in later turns.
 */

export const JOB_START_TOOL = 'job_start';
export const JOB_UPDATE_TOOL = 'job_update';
export const JOB_END_TOOL = 'job_end';
export const JOB_TOOL_NAMES = Object.freeze([JOB_START_TOOL, JOB_UPDATE_TOOL, JOB_END_TOOL] as const);
export type JobToolName = typeof JOB_TOOL_NAMES[number];
/** Key under which the runtime passes the {@link JobContext} to tools. Never from the model. */
export const JOBS_CONTEXT = 'ai-sdk-letta.jobs';

/** Bounds of a job. */
export const JOB_LIMITS = Object.freeze({
  maxGoalCharacters: 200,
  maxUnitCharacters: 24,
  maxMessageCharacters: 300,
  maxResultCharacters: 1000,
  /** Log lines kept per job (the newest). */
  maxLines: 50,
  /** Largest image read from a file. */
  maxImageBytes: 5 * 1024 * 1024,
  /** Largest image given inline as a data URL (it travels through the model). */
  maxDataUrlBytes: 512 * 1024,
  maxCount: 1e12,
});

/** Media types a job image may have. SVG is served as an image only (never as a document that runs). */
export const JOB_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
export type JobImageType = typeof JOB_IMAGE_TYPES[number];
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
/** An image of a job, read and checked: its bytes and sniffed media type. */
export type JobImage = { bytes: Uint8Array; mediaType: JobImageType };
/** `kind: 'command'`: an automatic job of a long `run_command` (its goal is the command). */
export type JobStartRequest = { goal: string; total?: number; unit?: string; kind?: 'command' };
/** `imageRef`: the file path the image was read from (not for data URLs), so the host can re-read it on later updates. */
/** `ratePerSecond`, `etaSeconds`: what the work itself reports (tqdm), preferred over the measured values. */
export type JobUpdateRequest = { done?: number; total?: number; message?: string; image?: JobImage; imageRef?: string; ratePerSecond?: number; etaSeconds?: number };
export type JobEndRequest = { status: 'done' | 'failed' | 'cancelled'; result?: string };
/** The turn a job call belongs to (bound by the runtime). */
export type JobTurn = { conversationId: string; toolCallId: string };

/**
 * Records jobs for the host (it shows them). Implemented by
 * `@ai-sdk-letta/server`. Methods throw an `Error` whose message is a fixed
 * code (`job_not_found`, `job_ended`, `job_limit`, `jobs_unavailable`).
 */
export interface JobDesk {
  start(request: JobStartRequest, turn: JobTurn): { id: string } | Promise<{ id: string }>;
  update(id: string, request: JobUpdateRequest, turn: JobTurn): void | Promise<void>;
  end(id: string, request: JobEndRequest, turn: JobTurn): void | Promise<void>;
  /** The file path a job's image was last read from: an update without `image` re-reads it (the picture follows the file). */
  imageRef?(id: string, turn: JobTurn): string | undefined;
  /** Does the agent report its own job in this conversation now (running, updated recently)? Then commands get no automatic job. */
  agentJobActive?(conversationId: string): boolean;
}
/**
 * Where image paths resolve (host paths): `/workspace/...` under `workspace`,
 * `/project/...` under `project`, relative paths under `folder` (the
 * conversation's folder, where commands start).
 */
export type JobPaths = { workspace: string; folder: string; project?: string };
/** What the runtime binds for a turn. `paths`: absent without resources (only data URL images then). */
export type JobContext = { desk: JobDesk; conversationId: string; paths?: () => JobPaths | undefined };

export type JobStartInput = { goal: string; total?: number; unit?: string };
export type JobUpdateInput = { jobId: string; done?: number; total?: number; message?: string; image?: string };
export type JobEndInput = { jobId: string; result?: string; status?: 'done' | 'failed' | 'cancelled' };
export type JobOutput = { ok: true } | { jobId: string } | { error: string; message: string };

const FAILURES: Record<string, string> = {
  invalid_input: 'Invalid arguments: see the tool description.',
  jobs_unavailable: 'Jobs are not available here; report progress in your reply instead.',
  job_not_found: 'No job with this jobId in this conversation. Start one with job_start.',
  job_ended: 'This job has ended; start a new one with job_start.',
  job_limit: 'Too many running jobs in this conversation; end some with job_end first.',
  image_not_found: 'The image file was not found.',
  image_outside: 'The image must be a file under /workspace, /project or the conversation folder.',
  image_too_large: 'The image is too large (at most 5 MB from a file, 512 KB as a data URL).',
  image_unsupported: 'The image must be a PNG, JPEG, WebP or SVG file (or such a data URL).',
};
const failure = (code: string) => ({ error: code, message: FAILURES[code] ?? 'The job could not be updated.' });
/** An `Error` with a fixed code for a job call. */
export class JobError extends Error { constructor(readonly code: string) { super(code); } }
const errorCode = (error: unknown) => error instanceof JobError ? error.code : error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'job_failed';

/** One line of visible text: controls removed, whitespace collapsed, at most `max` characters. */
export const jobLine = (value: string, max: number) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= JOB_LIMITS.maxCount;

/** `job_start` arguments, cleaned. @returns `undefined` when invalid */
export function parseJobStart(input: unknown): JobStartRequest | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const { goal, total, unit } = input as Partial<JobStartInput>;
  if (typeof goal !== 'string' || (total !== undefined && (!count(total) || total === 0)) || (unit !== undefined && typeof unit !== 'string')) return undefined;
  const g = jobLine(goal, JOB_LIMITS.maxGoalCharacters);
  if (!g) return undefined;
  const u = typeof unit === 'string' ? jobLine(unit, JOB_LIMITS.maxUnitCharacters) : '';
  return { goal: g, ...(total !== undefined ? { total } : {}), ...(u ? { unit: u } : {}) };
}

/** `job_update` arguments, cleaned (the image stays a reference: see {@link readJobImage}). @returns `undefined` when invalid */
export function parseJobUpdate(input: unknown): (Omit<JobUpdateRequest, 'image'> & { jobId: string; image?: string }) | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const { jobId, done, total, message, image } = input as Partial<JobUpdateInput>;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(jobId)) return undefined;
  if ((done !== undefined && !count(done)) || (total !== undefined && (!count(total) || total === 0)) || (message !== undefined && typeof message !== 'string') || (image !== undefined && (typeof image !== 'string' || !image.trim()))) return undefined;
  const m = typeof message === 'string' ? message.replace(/\r\n?/g, '\n').split('\n').map(line => jobLine(line, JOB_LIMITS.maxMessageCharacters)).filter(Boolean).slice(-JOB_LIMITS.maxLines).join('\n') : '';
  return { jobId, ...(done !== undefined ? { done } : {}), ...(total !== undefined ? { total } : {}), ...(m ? { message: m } : {}), ...(typeof image === 'string' ? { image: image.trim() } : {}) };
}

/** `job_end` arguments, cleaned. @returns `undefined` when invalid */
export function parseJobEnd(input: unknown): (JobEndRequest & { jobId: string }) | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const { jobId, result, status } = input as Partial<JobEndInput>;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(jobId) || (result !== undefined && typeof result !== 'string') || (status !== undefined && !['done', 'failed', 'cancelled'].includes(status))) return undefined;
  const r = typeof result === 'string' ? jobLine(result, JOB_LIMITS.maxResultCharacters) : '';
  return { jobId, status: status ?? 'done', ...(r ? { result: r } : {}) };
}

/** The media type of image bytes, by their content (never by name). */
export function sniffJobImage(bytes: Uint8Array): JobImageType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('utf8').replace(/^\uFEFF/, '').replace(/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*/i, '');
  if (/^<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return undefined;
}

/** Is `path` inside `root` (or `root` itself)? Both real paths. */
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`)); };

/**
 * Read a job image the agent named: a data URL (`data:image/png;base64,...`),
 * or a file path in the sandbox's terms (`/workspace/...`, `/project/...`, or
 * relative to the conversation folder). The real path must stay inside
 * the workspace or the project (symlinks resolved; the last component is
 * never followed), at most 5 MB, and a PNG, JPEG, WebP or SVG by content.
 * @throws {@link JobError} (`image_not_found`, `image_outside`, `image_too_large`, `image_unsupported`)
 */
export function readJobImage(reference: string, paths?: JobPaths): JobImage {
  const data = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i.exec(reference);
  if (reference.startsWith('data:')) {
    if (!data) throw new JobError('image_unsupported');
    if (data[2]!.length > Math.ceil(JOB_LIMITS.maxDataUrlBytes / 3) * 4 + 8) throw new JobError('image_too_large');
    const bytes = new Uint8Array(Buffer.from(data[2]!, 'base64'));
    const mediaType = sniffJobImage(bytes);
    if (!mediaType) throw new JobError('image_unsupported');
    return { bytes, mediaType };
  }
  if (!paths) throw new JobError('image_outside');
  const roots = [paths.workspace, ...(paths.project ? [paths.project] : [])];
  let target: string;
  if (reference === '/workspace' || reference.startsWith('/workspace/')) target = join(paths.workspace, reference.slice('/workspace'.length));
  else if (paths.project && (reference === '/project' || reference.startsWith('/project/'))) target = join(paths.project, reference.slice('/project'.length));
  else if (isAbsolute(reference) || /^[a-z]+:/i.test(reference)) throw new JobError('image_outside');
  else target = resolve(paths.folder, reference);
  // The parent folder resolved (symlinks included) must stay inside a root; the file itself is opened without following a link.
  let real: string;
  try { real = join(realpathSync(resolve(target, '..')), target.split(sep).pop()!); } catch { throw new JobError('image_not_found'); }
  const realRoots = roots.flatMap(root => { try { return [realpathSync(root)]; } catch { return []; } });
  if (!realRoots.some(root => inside(root, real))) throw new JobError('image_outside');
  let fd: number;
  try { fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) { throw new JobError((error as NodeJS.ErrnoException).code === 'ELOOP' ? 'image_outside' : 'image_not_found'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new JobError('image_not_found');
    if (stat.size > JOB_LIMITS.maxImageBytes) throw new JobError('image_too_large');
    const bytes = new Uint8Array(stat.size);
    let read = 0;
    while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, read); if (n <= 0) break; read += n; }
    const image = bytes.subarray(0, read);
    const mediaType = sniffJobImage(image);
    if (!mediaType) throw new JobError('image_unsupported');
    return { bytes: image, mediaType };
  } finally { closeSync(fd); }
}

/** Does the agent report its own job in this turn's conversation? */
export const agentJobActive = (bound: JobContext) => { try { return bound.desk.agentJobActive?.(bound.conversationId) ?? false; } catch { return false; } };

const contextOf = (context: Readonly<Record<string, unknown>> | undefined) => context?.[JOBS_CONTEXT] as JobContext | undefined;
type ToolOptions = { toolCallId: string; context?: Readonly<Record<string, unknown>> };

export const jobStartTool: Tool<JobStartInput, JobOutput> = tool({
  description: 'Show a job card in the conversation for work that takes a while (longer than ~30 s, or many steps: games, benchmarks, training, builds, long loops). '
    + 'Give the goal in one line, and optionally the total number of steps and their unit (e.g. 20 "games"). Returns { jobId }; then call job_update as you progress and job_end when finished. The job may continue across turns.',
  inputSchema: jsonSchema<JobStartInput>({
    type: 'object',
    properties: {
      goal: { type: 'string', minLength: 1, maxLength: JOB_LIMITS.maxGoalCharacters, description: 'What this job does, in one line (e.g. "Play 20 games against the baseline").' },
      total: { type: 'number', exclusiveMinimum: 0, description: 'How many steps in all, when known (drives the progress bar).' },
      unit: { type: 'string', maxLength: JOB_LIMITS.maxUnitCharacters, description: 'What a step is, plural (e.g. "games", "epochs", "files").' },
    },
    required: ['goal'], additionalProperties: false,
  }),
  execute: async (input: JobStartInput, options: ToolOptions): Promise<JobOutput> => {
    const request = parseJobStart(input);
    if (!request) return failure('invalid_input');
    const bound = contextOf(options.context);
    if (!bound) return failure('jobs_unavailable');
    try { return { jobId: (await bound.desk.start(request, { conversationId: bound.conversationId, toolCallId: options.toolCallId })).id }; } catch (error) { return failure(errorCode(error)); }
  },
});

export const jobUpdateTool: Tool<JobUpdateInput, JobOutput> = tool({
  description: 'Update a job card: progress (done, and total if it changed), the latest log line (message), and/or a live image (image: a PNG/JPEG/WebP/SVG file path such as /workspace/... or a path relative to your working folder, re-read on every update, at most 5 MB; or a small data URL). '
    + 'Call it after each step or every few seconds. Returns { ok: true }.',
  inputSchema: jsonSchema<JobUpdateInput>({
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'From job_start.' },
      done: { type: 'number', minimum: 0, description: 'Steps done so far.' },
      total: { type: 'number', exclusiveMinimum: 0, description: 'New total, if it changed.' },
      message: { type: 'string', description: 'The latest log line (e.g. "game 9: won in 31 moves").' },
      image: { type: 'string', description: 'A chart, board or screenshot to show: file path or data URL.' },
    },
    required: ['jobId'], additionalProperties: false,
  }),
  execute: async (input: JobUpdateInput, options: ToolOptions): Promise<JobOutput> => {
    const request = parseJobUpdate(input);
    if (!request) return failure('invalid_input');
    const bound = contextOf(options.context);
    if (!bound) return failure('jobs_unavailable');
    try {
      const { jobId, image, ...rest } = request;
      const turn = { conversationId: bound.conversationId, toolCallId: options.toolCallId };
      // Without a new image, the last file is read again (it may have changed); a file that went away keeps the previous picture.
      const ref = image ?? bound.desk.imageRef?.(jobId, turn);
      let read: JobImage | undefined;
      if (image !== undefined) read = readJobImage(image, bound.paths?.());
      else if (ref) { try { read = readJobImage(ref, bound.paths?.()); } catch { /* keep the previous picture */ } }
      await bound.desk.update(jobId, { ...rest, ...(read ? { image: read, ...(ref && !ref.startsWith('data:') ? { imageRef: ref } : {}) } : {}) }, turn);
      return { ok: true };
    } catch (error) { return failure(errorCode(error)); }
  },
});

export const jobEndTool: Tool<JobEndInput, JobOutput> = tool({
  description: 'End a job: status "done" (default), "failed" or "cancelled", with a one-line result (e.g. "Won 14 of 20"). Returns { ok: true }.',
  inputSchema: jsonSchema<JobEndInput>({
    type: 'object',
    properties: {
      jobId: { type: 'string' },
      result: { type: 'string', maxLength: JOB_LIMITS.maxResultCharacters, description: 'The outcome, in one line.' },
      status: { type: 'string', enum: ['done', 'failed', 'cancelled'] },
    },
    required: ['jobId'], additionalProperties: false,
  }),
  execute: async (input: JobEndInput, options: ToolOptions): Promise<JobOutput> => {
    const request = parseJobEnd(input);
    if (!request) return failure('invalid_input');
    const bound = contextOf(options.context);
    if (!bound) return failure('jobs_unavailable');
    try {
      const { jobId, ...rest } = request;
      await bound.desk.end(jobId, rest, { conversationId: bound.conversationId, toolCallId: options.toolCallId });
      return { ok: true };
    } catch (error) { return failure(errorCode(error)); }
  },
});

/** The job tools, to spread into a definition's `tools`. */
export const jobTools: { readonly job_start: typeof jobStartTool; readonly job_update: typeof jobUpdateTool; readonly job_end: typeof jobEndTool } = Object.freeze({ [JOB_START_TOOL]: jobStartTool, [JOB_UPDATE_TOOL]: jobUpdateTool, [JOB_END_TOOL]: jobEndTool });
/** Default permissions: jobs only show progress, so all run without approval. */
export const JOB_TOOL_PERMISSIONS: Readonly<Record<JobToolName, ToolPermission>> = Object.freeze({ job_start: 'allow', job_update: 'allow', job_end: 'allow' });
/** Does the definition include `job_start` (allowed)? */
export const jobsEnabled = (definition: { tools: Record<string, unknown>; permissions: Readonly<Record<string, ToolPermission>> }) =>
  Object.hasOwn(definition.tools, JOB_START_TOOL) && definition.permissions[JOB_START_TOOL] === 'allow';

/** What agents with the job tools are told. */
export const JOBS_NOTE = 'Jobs: for any work longer than about 30 seconds or with many steps (games, benchmarks, training, builds, long loops), call job_start first with the goal (and the total, when known), so people see a live card with a progress bar. Call job_update regularly (after each step) with done and a short log line, and add an image (a chart or board you write as a PNG or SVG file) when it helps. Call job_end with a one-line result when finished, or with status "failed". A job may continue in later turns.';
