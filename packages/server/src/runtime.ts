import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UIMessage, UserContent } from 'ai';
import {
  AttachmentStore, FILE_LIMITS, FileInputError, IMAGE_PLACEHOLDER, IMAGE_REFERENCE_PROVIDER, ImageInputError, MAX_INPUT_CHARACTERS, ResourceStore, UploadStaging, attachmentNote, sanitizeFileName, titleFromFolderName, validateImages, validateResponse,
  type DecodedImage, type InteractionRequest, type InteractionResponse, type LettaAgent, type ResourceTree, type StagedFile, type StoredFile,
} from 'ai-sdk-letta';

/** One NDJSON event of a run. The application, never the HTTP consumer, owns tools. */
export type RuntimeEvent = { sequence: number; type: string; data: Record<string, unknown> };
/**
 * A conversation's override of a display setting: `'inherit'` uses the
 * agent's setting (the definition's `ui`), `'on'`/`'off'` override it.
 */
export type DisplayOverride = 'inherit' | 'on' | 'off';
const DISPLAY_OVERRIDES: readonly DisplayOverride[] = ['inherit', 'on', 'off'];
// createdAt/lastActivityAt/latex are optional: threads recorded before they existed stay valid (latex: inherit).
type Thread = { id: string; owner: string; conversationId?: string; agentId?: string; title: string; archived: boolean; state: 'creating' | 'ready'; createdAt?: string; lastActivityAt?: string; latex?: Exclude<DisplayOverride, 'inherit'>; createdBy?: RunAuthor };
/** Metadata of an image sent with a run. The bytes live only in Letta history, never in runtime state. */
export type RunImage = { mediaType: string; bytes: number; sha256: string };
/**
 * Who wrote a turn, in a shared (team) runtime. `id` is the stable user ID;
 * `name` the display name at the time; `login` the identity provider login.
 */
export type RunAuthor = { id: string; login: string; name: string; avatar?: string };
/**
 * A single user turn and the events observed while it ran. In a shared runtime
 * a run may first wait in its conversation's queue (`queued`); `author` names
 * who wrote it.
 */
export type Run = { id: string; threadId: string; input: string; images?: RunImage[]; files?: RunFile[]; uploads?: string[]; parentRunId: string | null; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; events: RuntimeEvent[]; startedAt?: string; queuedAt?: string; author?: RunAuthor; notSent?: boolean };
/** Metadata of a file sent with a run (as stored in the conversation's folder). */
export type RunFile = Pick<StoredFile, 'name' | 'kind' | 'mediaType' | 'label' | 'bytes' | 'sha256' | 'pages' | 'lines'>;
/**
 * Input of `POST /v1/runs`. `images` carry base64 data (no data: prefix) and
 * are validated against `IMAGE_LIMITS`. `files` are upload IDs returned by
 * `POST /v1/uploads` (at most `FILE_LIMITS.maxFilesPerMessage`).
 */
export type RunInput = { id: string; threadId: string; text: string; parentRunId: string | null; images?: { mediaType: string; data: string; name?: string }[]; files?: string[] };
/**
 * Options of a shared (team) runtime. Without them the runtime is the
 * single-owner, one-turn-at-a-time service it always was.
 *
 * - `queue`: a turn sent while another of the same conversation runs waits in
 *   that conversation's queue (visible to everyone) instead of being refused;
 *   `parentRunId` is not required then. Up to {@link MAX_QUEUED} per conversation.
 * - `parallel`: conversations run turns at the same time, each in its own
 *   session (needs a host whose `parallel` is true).
 */
export type RuntimeOptions = { deadlineMs?: number; humanWaitMs?: number; queue?: boolean; parallel?: boolean };
/** Most turns waiting in one conversation's queue. */
export const MAX_QUEUED = 10;
type State = { version: 1; threads: Thread[]; runs: Run[] };
/** One conversation's session and its single running turn (one lane per runtime unless parallel). */
type Lane = { key: string; locked: boolean; usedAt?: number; current?: RuntimeSession; active?: { run: Run; control: AbortController }; pending?: { runId: string; request: InteractionRequest; resolve(value: InteractionResponse): void }; draining?: boolean };
/** An opened agent conversation as seen by the runtime. */
export interface RuntimeSession {
  agentId: string;
  conversationId: string;
  history: UIMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: Pick<LettaAgent<any>, 'stream' | 'interactions' | 'transcript'> & { attachments?: AttachmentStore };
  /** Reload display history from the backend without reopening (parallel hosts). */
  reload?(): Promise<UIMessage[]>;
  /** Close only this conversation's session (parallel hosts). */
  close?(): Promise<void>;
}
/** Opens and closes the single agent session the runtime drives. */
export interface RuntimeHost {
  /**
   * Open a conversation. A single-session host closes the previous one first;
   * a `parallel` host keeps several open (each with its own `close`).
   */
  open(options: { conversationId: string } | { newTitle: string }): Promise<RuntimeSession>;
  /** Close every session (and, for a parallel host, release the agent). */
  close(): Promise<void>;
  /** Sessions of different conversations may be open and run turns at the same time. */
  parallel?: boolean;
  /**
   * Root of the agents' resources (`<stateDir>/resources`), when the agent
   * accepts files (its definition includes the file tools). Without it,
   * uploads, file lists and the resources API are refused with `files_unavailable`.
   */
  attachmentsRoot?: string;
  /**
   * Prepare the resources before any conversation is opened: create them and
   * migrate files of earlier versions (`titles` names the folders, by conversation ID).
   */
  resources?(agentId: string, titles: Record<string, string>): Promise<ResourceStore>;
}
/** A client-visible failure with a fixed code and HTTP status. */
export class RuntimeFault extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Only app-defined, fixed failure codes (e.g. user_denied) are surfaced; never free-form error text. */
const failureReasons = new Set(['user_denied', 'approval_cancelled', 'tool_denied', 'tool_cancelled', 'tool_timeout', 'tool_failed', 'invalid_arguments', 'interaction_unavailable', 'permission_denied', 'duplicate_or_limit', 'tool_output_limit']);
/** HTTP status for a refused file. */
const fileStatus = (code: string) => code === 'file_too_large' ? 413 : code === 'file_not_found' ? 404 : ['conversation_files_full', 'files_too_many', 'file_exists', 'resources_full'].includes(code) ? 409 : code === 'resources_busy' ? 503 : 400;
/** A FileInputError as a fixed-code RuntimeFault; anything else unchanged. */
export const fileFault = (error: unknown) => error instanceof FileInputError ? new RuntimeFault(error.code, fileStatus(error.code)) : error;
/** Public metadata of a stored file (what list and upload return). */
export const fileSummary = (file: StoredFile | StagedFile) => ({ ...('id' in file ? { id: file.id } : {}), name: file.name, kind: file.kind, mediaType: file.mediaType, label: file.label, bytes: file.bytes,
  ...(file.pages !== undefined ? { pages: file.pages } : {}), ...(file.lines !== undefined ? { lines: file.lines } : {}), createdAt: file.createdAt });
export function toolFailureReason(error: unknown): { reason?: string } {
  let value = error;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  const reason = value && typeof value === 'object' && !Array.isArray(value) ? (value as { error?: unknown }).error : undefined;
  return typeof reason === 'string' && failureReasons.has(reason) ? { reason } : {};
}

/** Transport observations for reconnects/failed-turn inspection only, never agent input. */
export function displayRun(run: Run): UIMessage[] {
  const parts: UIMessage['parts'] = [];
  for (const event of run.events) {
    const data = event.data;
    if (event.type === 'text') {
      const last = parts.at(-1);
      if (last?.type === 'text') last.text += String(data.text);
      else parts.push({ type: 'text', text: String(data.text) });
    } else if (event.type === 'tool_started') parts.push({ type: 'dynamic-tool', toolName: String(data.name), toolCallId: String(data.toolCallId), state: 'input-available', input: data.input });
    else if (event.type === 'tool_completed' || event.type === 'tool_failed') {
      const index = parts.findIndex(p => p.type === 'dynamic-tool' && p.toolCallId === data.toolCallId);
      const part = parts[index];
      if (part?.type === 'dynamic-tool' && part.state === 'input-available') parts[index] = event.type === 'tool_completed'
        ? { ...part, state: 'output-available', output: data.output }
        : { ...part, state: 'output-error', errorText: typeof data.reason === 'string' ? JSON.stringify({ error: data.reason }) : String(data.code) };
    }
  }
  if (run.status !== 'completed' && run.status !== 'running') for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === 'dynamic-tool' && part.state === 'input-available') parts[i] = { ...part, state: 'output-error', errorText: `Turn ${run.status}; execution not confirmed.` };
  }
  const metadata = run.startedAt || run.author ? { metadata: { ...(run.startedAt ? { createdAt: run.startedAt } : {}), ...(run.author ? { author: run.author } : {}) } } : {};
  // Runtime state never stores image bytes; failed/reconnecting runs show a placeholder.
  // Files are shown by the same "Attached: ..." note the agent received.
  const note = run.files?.length ? attachmentNote(run.files) : '';
  const text = note ? `${run.input.trimEnd()}${run.input.trim() ? '\n\n' : ''}${note}` : run.input;
  const user: UIMessage['parts'] = [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...(run.images ?? []).map(() => ({ type: 'text' as const, text: IMAGE_PLACEHOLDER }))];
  return [{ id: `${run.id}-user`, role: 'user', parts: user, ...metadata }, { id: `${run.id}-assistant`, role: 'assistant', parts }];
}

const sameImages = (a: RunImage[] = [], b: RunImage[] = []) => a.length === b.length && a.every((image, index) => image.sha256 === b[index]!.sha256);
const sameUploads = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Thread service over one agent.
 *
 * By default single-owner and single-turn: one session, one turn at a time.
 * With {@link RuntimeOptions} it serves a shared agent: conversations run in
 * parallel (each in its own session) and turns of one conversation wait in a
 * visible queue.
 *
 * Runs are recorded durably before delivery; a run that was in flight when the
 * process stopped is marked `interrupted` and blocks further turns on that
 * thread (uncertain delivery is never replayed). Human answers are validated
 * and accepted exactly once.
 */
export class ThreadRuntime {
  private state: State;
  private lanes = new Map<string, Lane>();
  private listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  /** Validated uploads waiting to be sent, next to this runtime's state (`<dir>/uploads/.staging`). */
  readonly uploads?: UploadStaging;
  private readonly deadlineMs: number;
  private readonly humanWaitMs: number;
  /** Turns of one conversation queue instead of being refused (shared runtimes). */
  readonly queueing: boolean;
  /** Conversations run turns at the same time, each in its own session. */
  readonly parallel: boolean;
  private changes = 0;
  private waiting = new Set<() => void>();
  constructor(host: RuntimeHost, filename: string, owner: string, deadlineMs?: number, humanWaitMs?: number);
  constructor(host: RuntimeHost, filename: string, owner: string, options: RuntimeOptions);
  constructor(private readonly host: RuntimeHost, private readonly filename: string, private readonly owner: string, deadlineOrOptions?: number | RuntimeOptions, humanWaitMs?: number) {
    const options: RuntimeOptions = typeof deadlineOrOptions === 'object' ? deadlineOrOptions : { deadlineMs: deadlineOrOptions, humanWaitMs };
    this.deadlineMs = options.deadlineMs ?? 180_000;
    this.humanWaitMs = options.humanWaitMs ?? 4 * 60_000;
    this.queueing = !!options.queue;
    this.parallel = !!options.parallel;
    if (this.parallel && !host.parallel) throw new Error('A parallel runtime needs a parallel host');
    if (host.attachmentsRoot) this.uploads = new UploadStaging(join(dirname(filename), 'uploads'));
    this.state = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) as State : { version: 1, threads: [], runs: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.threads) || !Array.isArray(this.state.runs)) throw new Error('Invalid runtime state');
    for (const thread of this.state.threads) thread.archived ??= false;
    for (const run of this.state.runs) if (run.status === 'running') {
      run.status = 'interrupted';
      run.events.push({ sequence: (run.events.at(-1)?.sequence ?? 0) + 1, type: 'failed', data: { code: 'delivery_uncertain' } });
    } else if (run.status === 'queued') {
      // Never sent: a queued turn does not survive a restart, and nothing was delivered.
      run.status = 'cancelled'; run.notSent = true;
      run.events.push({ sequence: (run.events.at(-1)?.sequence ?? 0) + 1, type: 'failed', data: { code: 'not_sent' } });
    }
    this.save();
  }
  private saveTimer?: ReturnType<typeof setTimeout>;
  private save() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    // A leftover temporary file is an uncertain write, not permission to overwrite it.
    const fd = openSync(`${this.filename}.tmp`, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${this.filename}.tmp`, this.filename);
    const directory = openSync(dirname(this.filename), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  /** Streamed text is display-only: batch its writes (every other event, and the end of a run, writes at once). */
  private saveSoon() { this.saveTimer ??= setTimeout(() => { this.saveTimer = undefined; try { this.save(); } catch { /* the next event retries */ } }, 250); }
  /** Something visible changed (a thread or a run): wake {@link waitForChange}. */
  private changed() {
    this.changes++;
    const waiting = [...this.waiting]; this.waiting.clear();
    for (const wake of waiting) wake();
  }
  /**
   * A counter that increases whenever threads or runs change (created, renamed,
   * archived, a run queued, started or ended). Pass the last value back to
   * {@link waitForChange} to wait for the next change.
   */
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
  private authorize(owner: string) { if (owner !== this.owner) throw new RuntimeFault('forbidden', 403); }
  private thread(owner: string, id: string) {
    this.authorize(owner);
    const thread = this.state.threads.find(t => t.id === id && t.owner === owner);
    if (!thread) throw new RuntimeFault('not_found', 404);
    if (thread.state !== 'ready') throw new RuntimeFault('creation_uncertain');
    return thread;
  }
  private run(owner: string, id: string) {
    this.authorize(owner);
    const run = this.state.runs.find(r => r.id === id);
    if (!run) throw new RuntimeFault('not_found', 404);
    this.thread(owner, run.threadId);
    return run;
  }
  /** The lane of a thread: its own in a parallel runtime, the single shared one otherwise. */
  private lane(threadId: string): Lane {
    const key = this.parallel ? threadId : '';
    let lane = this.lanes.get(key);
    if (!lane) { lane = { key, locked: false }; this.lanes.set(key, lane); }
    return lane;
  }
  private laneOfRun(runId: string) { return [...this.lanes.values()].find(lane => lane.active?.run.id === runId); }
  private async exclusive<T>(lane: Lane, fn: () => Promise<T>) {
    if (lane.locked || lane.active) throw new RuntimeFault('runtime_busy');
    lane.locked = true;
    try { return await fn(); } finally { lane.locked = false; }
  }
  private async open(lane: Lane, thread: Thread) {
    if (lane.current && lane.current.conversationId === thread.conversationId) return lane.current;
    await this.closeLane(lane);
    const session = await this.host.open(thread.conversationId ? { conversationId: thread.conversationId } : { newTitle: thread.title });
    const identity = this.state.threads.find(t => t.agentId)?.agentId;
    if (identity && session.agentId !== identity) { await (session.close?.() ?? this.host.close()); throw new RuntimeFault('identity_mismatch'); }
    lane.current = session;
    return session;
  }
  private async closeLane(lane: Lane) {
    const current = lane.current; lane.current = undefined;
    if (this.parallel) await current?.close?.();
    else await this.host.close();
  }
  /** Display metadata only; timestamps are omitted for legacy threads that never recorded them. */
  private summary(thread: Thread) {
    const { id, title, state, archived, createdAt, lastActivityAt, latex } = thread;
    const base = { id, title, state, archived, ...(createdAt ? { createdAt } : {}), ...(lastActivityAt ? { lastActivityAt } : {}), latex: latex ?? 'inherit' as DisplayOverride };
    if (!this.queueing) return base;
    // Shared runtimes also show who started a conversation and whether a turn is running or waiting.
    const runs = this.state.runs.filter(r => r.threadId === id);
    const running = runs.find(r => r.status === 'running');
    const queued = runs.filter(r => r.status === 'queued').length;
    return { ...base, ...(thread.createdBy ? { createdBy: thread.createdBy } : {}), ...(running ? { running: running.id } : {}), ...(queued ? { queued } : {}) };
  }
  list(owner: string) {
    this.authorize(owner);
    return this.state.threads.filter(t => t.owner === owner).map(t => this.summary(t));
  }
  /**
   * Local display metadata only: never opens a session or edits backend history.
   * Fields: `title` (1–120 characters), `archived` (boolean), and `latex`
   * (`'inherit' | 'on' | 'off'`: whether the browser app renders LaTeX in this
   * conversation; `'inherit'` follows the agent's `ui.latex`).
   */
  updateMetadata(owner: string, id: string, input: unknown) {
    const thread = this.thread(owner, id);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeFault('invalid_input', 400);
    const fields = Object.keys(input);
    if (!fields.length || fields.some(key => key !== 'title' && key !== 'archived' && key !== 'latex')) throw new RuntimeFault('invalid_input', 400);
    const patch = input as { title?: unknown; archived?: unknown; latex?: unknown };
    if (fields.includes('latex') && !DISPLAY_OVERRIDES.includes(patch.latex as DisplayOverride)) throw new RuntimeFault('invalid_input', 400);
    let title = thread.title;
    if (fields.includes('title')) {
      // Reject terminal controls and invisible formatting/bidi controls before trimming.
      if (typeof patch.title !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(patch.title)) throw new RuntimeFault('invalid_input', 400);
      title = patch.title.trim();
      if (!title || title.length > 120) throw new RuntimeFault('invalid_input', 400);
    }
    if (fields.includes('archived') && typeof patch.archived !== 'boolean') throw new RuntimeFault('invalid_input', 400);
    // locked covers session opening before start() has installed its active run; queued turns would run in an archived conversation.
    const lane = this.lane(id);
    if (patch.archived === true && (lane.locked || lane.active?.run.threadId === id || this.state.runs.some(r => r.threadId === id && r.status === 'queued'))) throw new RuntimeFault('runtime_busy');
    const retitled = thread.title !== title;
    thread.title = title;
    if (typeof patch.archived === 'boolean') thread.archived = patch.archived;
    if (patch.latex === 'inherit') delete thread.latex; else if (patch.latex === 'on' || patch.latex === 'off') thread.latex = patch.latex;
    this.save(); this.changed();
    // The conversation's folder follows its title (after the running turn, if any). A failure never fails the rename.
    if (retitled && this.host.attachmentsRoot && thread.agentId && thread.conversationId) {
      const conversationId = thread.conversationId;
      const store = this.resourcesOf(thread.agentId);
      // The title when the rename runs: a folder renamed in the panel meanwhile already set it (and is not renamed back).
      this.renaming = this.renaming.then(() => store.retitle(conversationId, thread.title)).then(() => {}, () => {});
    }
    return this.summary(thread);
  }
  private renaming: Promise<void> = Promise.resolve();
  /** Resolves when folder renames requested by {@link updateMetadata} are done (or deferred to the end of a turn). */
  folderRenamed(): Promise<void> { return this.renaming; }
  /** Create a thread (and its Letta conversation). In a shared runtime, `author` records who started it. */
  async create(owner: string, id: string, title: string, author?: RunAuthor) {
    this.authorize(owner);
    if (!uuid.test(id) || typeof title !== 'string' || !title.trim() || title.length > 120) throw new RuntimeFault('invalid_input', 400);
    const previous = this.state.threads.find(t => t.id === id);
    if (previous) {
      if (previous.owner !== owner || previous.title !== title) throw new RuntimeFault('id_conflict');
      this.thread(owner, id); return { id, title };
    }
    if (this.state.threads.length >= 200) throw new RuntimeFault('capacity_reached');
    const lane = this.lane(id);
    return this.exclusive(lane, async () => {
      const now = new Date().toISOString();
      const thread: Thread = { id, owner, title, archived: false, state: 'creating', createdAt: now, lastActivityAt: now, ...(author ? { createdBy: author } : {}) };
      this.state.threads.push(thread); this.save();
      const session = await this.openIn(lane, thread);
      thread.agentId = session.agentId; thread.conversationId = session.conversationId; thread.state = 'ready'; this.save(); this.changed();
      if (this.host.attachmentsRoot) { try { this.resourcesOf(session.agentId).adopt(session.conversationId, title); } catch { /* created on first use */ } }
      return { id, title };
    });
  }
  /** Turns that reached (or may have reached) the agent: not waiting, not withdrawn before sending. */
  private delivered(threadId: string) { return this.state.runs.filter(r => r.threadId === threadId && r.status !== 'queued' && !r.notSent); }
  /** In a shared runtime, user turns in display history carry their author (matched by the OTID they were sent with). */
  private annotate(threadId: string, messages: UIMessage[]): UIMessage[] {
    if (!this.queueing) return messages;
    const authors = new Map(this.state.runs.filter(r => r.threadId === threadId && r.author).map(r => [r.id, r.author!]));
    return messages.map(message => {
      const otid = (message.metadata as { otid?: unknown } | undefined)?.otid;
      const author = message.role === 'user' && typeof otid === 'string' ? authors.get(otid) : undefined;
      return author ? { ...message, metadata: { ...(message.metadata as object), author } } : message;
    });
  }
  async history(owner: string, id: string) {
    const thread = this.thread(owner, id);
    const lane = this.lane(id);
    // Several people may open the same idle conversation at once: wait briefly for another reader rather than refusing.
    for (let i = 0; this.parallel && lane.locked && !lane.active && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100));
    return this.exclusive(lane, async () => {
      let session: RuntimeSession;
      const current = lane.current;
      if (this.parallel && current?.reload && current.conversationId === thread.conversationId) {
        // Shared sessions stay open: reload backend history instead of reopening.
        session = current; session.history = await current.reload();
      } else {
        // Refresh through backend history, not a display transcript replay into the agent.
        await this.closeLane(lane);
        session = await this.openIn(lane, thread);
      }
      const lastRunId = this.delivered(id).at(-1)?.id ?? null;
      return { messages: this.annotate(id, session.history.filter(m => m.id !== 'session-status')), lastRunId };
    });
  }
  /** Turns waiting in a thread's queue, oldest first (shared runtimes). */
  private queueOf(threadId: string) {
    return this.state.runs.filter(r => r.threadId === threadId && r.status === 'queued').map(r => ({ id: r.id, input: r.input, ...(r.author ? { author: r.author } : {}),
      ...(r.images?.length ? { images: r.images.length } : {}), ...(r.uploads?.length ? { files: r.uploads.length } : {}), ...(r.queuedAt ? { queuedAt: r.queuedAt } : {}) }));
  }
  async view(owner: string, id: string): Promise<Awaited<ReturnType<ThreadRuntime['viewOnce']>>> {
    // A queued turn may start between the checks below and reading history: then show it live instead.
    for (let attempt = 0; ; attempt++) {
      try { return await this.viewOnce(owner, id); }
      catch (error) { if (!this.parallel || attempt >= 3 || !(error instanceof RuntimeFault) || error.code !== 'runtime_busy') throw error; }
    }
  }
  private async viewOnce(owner: string, id: string) {
    this.thread(owner, id);
    const lane = this.lane(id);
    const latest = this.delivered(id).at(-1);
    const queue = this.queueing ? { queue: this.queueOf(id) } : {};
    const active = lane.active?.run.threadId === id ? lane.active.run : undefined;
    if (active && lane.current) return {
      messages: this.annotate(id, lane.current.history.filter(m => m.id !== 'session-status')),
      lastRunId: latest?.id ?? null,
      live: { id: active.id, input: active.input, ...(active.author ? { author: active.author } : {}), ...(active.startedAt && this.queueing ? { startedAt: active.startedAt } : {}), ...(active.images?.length ? { images: active.images.length } : {}), ...(active.files?.length ? { files: active.files.map(({ name, label, bytes, pages, lines, kind }) => ({ name, label, bytes, kind, ...(pages !== undefined ? { pages } : {}), ...(lines !== undefined ? { lines } : {}) })) } : {}) },
      status: 'running', ...queue,
    };
    if (latest && !['running', 'completed'].includes(latest.status)) return {
      messages: this.delivered(id).flatMap(displayRun),
      lastRunId: latest.id, live: null, status: latest.status, source: 'transport-observations', ...queue,
    };
    return { ...await this.history(owner, id), live: null, status: latest?.status ?? null, source: 'backend-history', ...queue };
  }
  private emit(run: Run, type: string, data: Record<string, unknown>) {
    // Sequence numbers continue from the last event (compacted runs have fewer events than their last number).
    const event = { sequence: (run.events.at(-1)?.sequence ?? 0) + 1, type, data };
    run.events.push(event);
    // Streamed text is display-only; in a shared runtime its writes are batched.
    if (this.queueing && type === 'text') this.saveSoon(); else this.save();
    for (const listener of this.listeners.get(run.id) ?? []) listener(event);
    if (type !== 'text') this.changed();
  }
  /** The thread's view of the resources (no session is opened). */
  private store(owner: string, id: string) {
    const thread = this.thread(owner, id);
    if (!thread.agentId || !thread.conversationId) throw new RuntimeFault('not_found', 404);
    return new AttachmentStore(this.resourcesOf(thread.agentId), thread.conversationId, { title: thread.title });
  }
  /** Files in a thread's conversation folder, by name. Archived threads keep their files. */
  files(owner: string, id: string) {
    try { return this.store(owner, id).list().filter(file => !file.name.includes('/')).map(fileSummary); } catch (error) { throw fileFault(error); }
  }
  /**
   * A file attached to a thread's conversation, by the name it was attached
   * under: found where it is now, even after the user moved or renamed it.
   */
  file(owner: string, id: string, name: string) {
    try {
      const store = this.store(owner, id);
      const path = store.resources.locateAttachment(store.conversationId, name);
      if (!path) throw new FileInputError('file_not_found', 'No such file');
      const file = store.resources.describe(path);
      return { file: { ...file, name: file.path.split('/').pop()! }, bytes: store.resources.read(path) };
    } catch (error) { throw fileFault(error); }
  }

  /* ---------------- resources ---------------- */

  /** The agent's resources (one agent per runtime). */
  private resourcesOf(agentId?: string): ResourceStore {
    if (!this.host.attachmentsRoot) throw new RuntimeFault('files_unavailable', 404);
    const id = agentId ?? this.state.threads.find(t => t.agentId)?.agentId;
    if (!id) throw new RuntimeFault('resources_empty', 404);
    return ResourceStore.open(this.host.attachmentsRoot, id);
  }
  private prepared?: Promise<ResourceStore>;
  private async resources(owner: string): Promise<ResourceStore> {
    this.authorize(owner);
    const store = this.resourcesOf();
    this.prepared ??= (async () => {
      const titles = Object.fromEntries(this.state.threads.filter(t => t.conversationId).map(t => [t.conversationId!, t.title]));
      if (this.host.resources) await this.host.resources(store.agentId, titles); else await store.init();
      // Every ready thread has a folder (named after its title), except ones the user deleted.
      for (const thread of this.state.threads) if (thread.state === 'ready' && thread.agentId === store.agentId && thread.conversationId) store.adopt(thread.conversationId, thread.title);
      return store;
    })().catch(error => { this.prepared = undefined; throw error; });
    return this.prepared;
  }
  /** Run a resources operation, with fixed error codes. */
  private async withResources<T>(owner: string, task: (store: ResourceStore) => T | Promise<T>): Promise<T> {
    try { return await task(await this.resources(owner)); } catch (error) { throw fileFault(error); }
  }
  /**
   * The resources tree: one folder per conversation (with its thread ID when
   * this runtime knows it) and the user's own folders. `version` changes with
   * the content; pass it back as `since` to get `{ unchanged: true }` cheaply.
   */
  async resourceTree(owner: string): Promise<ResourceTree & { threads: Record<string, string>; changes: number }> {
    this.authorize(owner);
    // Before the first conversation there is no agent yet, so nothing to list (not an error).
    if (this.host.attachmentsRoot && !this.state.threads.some(t => t.agentId)) return { children: [], truncated: false, version: 'empty', threads: {}, changes: 0 };
    return this.withResources(owner, store => {
      const tree = store.tree();
      const threads: Record<string, string> = {};
      for (const { conversationId, path } of store.conversations()) {
        const thread = this.state.threads.find(t => t.owner === owner && t.conversationId === conversationId);
        if (thread) threads[path] = thread.id;
      }
      return { ...tree, threads, changes: store.commits };
    });
  }
  /** Add a file to a folder (any type, up to the per-file limit). One commit. */
  resourceUpload(owner: string, folder: unknown, name: unknown, bytes: Uint8Array) {
    if (typeof folder !== 'string' || typeof name !== 'string' || !name.trim() || name.length > 1024) throw new RuntimeFault('file_name_invalid', 400);
    return this.withResources(owner, store => store.upload(folder, name, bytes));
  }
  /** Create a folder. One commit. */
  resourceFolder(owner: string, input: unknown) {
    const { parent, name } = (input ?? {}) as { parent?: unknown; name?: unknown };
    if (typeof parent !== 'string' || typeof name !== 'string' || !name.trim() || name.length > 255) throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, store => store.createFolder(parent, name));
  }
  /**
   * Rename or move. One commit. Renaming a conversation's own folder renames
   * the conversation too, to the name as typed (see {@link titleFromFolderName});
   * the result then has the updated `thread`, as listed. A move that keeps
   * the name does not.
   */
  resourceMove(owner: string, input: unknown) {
    const { from, to } = (input ?? {}) as { from?: unknown; to?: unknown };
    if (typeof from !== 'string' || typeof to !== 'string') throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, async (store): Promise<{ path: string; from: string; commit?: string; thread?: ReturnType<ThreadRuntime['summary']> }> => {
      const moved = await store.move(from, to);
      const name = moved.path.slice(moved.path.lastIndexOf('/') + 1);
      if (name === moved.from.slice(moved.from.lastIndexOf('/') + 1)) return moved;
      const conversationId = store.conversations().find(c => c.path === moved.path)?.conversationId;
      const thread = conversationId && this.state.threads.find(t => t.owner === owner && t.agentId === store.agentId && t.conversationId === conversationId);
      if (!thread) return moved;
      // The name as the user typed it, when the folder only got a file-system-safe spelling of it ("Porto: day trips" → "Porto_ day trips").
      const typed = to.split('/').filter(Boolean).pop()?.trim() ?? '';
      const written = typed && sanitizeFileName(typed) === name && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(typed) ? typed : name;
      // Metadata only: the folder already has its name, so this never renames it again (no title ↔ folder loop).
      const title = titleFromFolderName(thread.title, written);
      if (title !== thread.title) { thread.title = title; this.save(); }
      return { ...moved, thread: this.summary(thread) };
    });
  }
  /** Delete (kept in the history; see {@link resourceRestore}). One commit. */
  resourceDelete(owner: string, input: unknown) {
    const { path } = (input ?? {}) as { path?: unknown };
    if (typeof path !== 'string') throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, store => store.delete(path));
  }
  /** Undo a delete: bring `path` back as it was before `commit`. One commit. */
  resourceRestore(owner: string, input: unknown) {
    const { path, commit } = (input ?? {}) as { path?: unknown; commit?: unknown };
    if (typeof path !== 'string' || typeof commit !== 'string') throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, store => store.restore(path, commit));
  }
  /** The newest commits of the resources. */
  resourceHistory(owner: string, limit = 50) { return this.withResources(owner, store => store.log(limit)); }
  /** One resource's bytes and description (type by content when it is text, PDF or an image). */
  resourceFile(owner: string, path: unknown, limit: number) {
    if (typeof path !== 'string') throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, store => {
      const bytes = store.read(path, limit);
      let kind: 'text' | 'pdf' | 'image' | 'other' = 'other';
      let mediaType = 'application/octet-stream';
      try { const file = store.describe(path); kind = file.kind; mediaType = file.mediaType; } catch { /* not a supported type: downloads only */ }
      return { name: path.split('/').filter(Boolean).pop()!, kind, mediaType, bytes };
    });
  }
  /**
   * Validate an upload (type by content, size, PDF text) and stage it until a
   * run sends it. Not tied to a thread yet: a new chat uploads before it exists.
   */
  async upload(owner: string, name: unknown, bytes: Uint8Array, signal?: AbortSignal) {
    this.authorize(owner);
    if (!this.uploads) throw new RuntimeFault('files_unavailable', 404);
    if (typeof name !== 'string' || !name.trim() || name.length > 1024) throw new RuntimeFault('file_name_invalid', 400);
    // Each upload may parse a PDF in a worker; bound how many run at once.
    if (this.uploading >= ThreadRuntime.MAX_CONCURRENT_UPLOADS) throw new RuntimeFault('uploads_busy', 429);
    this.uploading++;
    try { return fileSummary(await this.uploads.stage(name, bytes, { signal })); } catch (error) { throw fileFault(error); }
    finally { this.uploading--; }
  }
  /** Uploads validated at the same time; more are refused with `uploads_busy` (429). */
  static readonly MAX_CONCURRENT_UPLOADS = 3;
  private uploading = 0;
  /** The thread's lane, opening its session (and closing idle sessions beyond the limit in a parallel runtime). */
  private async openIn(lane: Lane, thread: Thread) {
    lane.usedAt = Date.now();
    const session = await this.open(lane, thread);
    if (this.parallel) void this.evict();
    return session;
  }
  /** Idle sessions kept open in a parallel runtime (least recently used are closed first). */
  static readonly MAX_IDLE_SESSIONS = 4;
  /** Turns running at the same time in a parallel runtime; more wait in their conversation's queue. */
  static readonly MAX_PARALLEL_TURNS = 4;
  private async evict() {
    const idle = [...this.lanes.values()].filter(lane => lane.current && !lane.locked && !lane.active).sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0));
    for (const lane of idle.slice(ThreadRuntime.MAX_IDLE_SESSIONS)) {
      if (lane.locked || lane.active || !lane.current) continue;
      lane.locked = true;
      try { await this.closeLane(lane); } catch { /* closed anyway */ } finally { lane.locked = false; }
    }
    if (this.queueing) this.pump();
  }
  /** In-memory payload of queued runs (image bytes are never written to runtime state). */
  private queued = new Map<string, { images: DecodedImage[]; names: (string | undefined)[]; uploads: string[] }>();
  /**
   * Start one turn. Text, images or both; images are validated (type by
   * content, size, count, total) and fail with a fixed `image_*` code.
   * Only image metadata (type, size, SHA-256) is recorded in runtime state.
   *
   * In a shared runtime, `author` records who wrote it (shown in history and
   * told to the agent), and a turn sent while another of its conversation is
   * running or waiting is queued (status `queued`) instead of refused.
   */
  async start(owner: string, input: RunInput, author?: RunAuthor) {
    this.authorize(owner);
    if (!input || typeof input !== 'object' || !uuid.test(input.id) || typeof input.text !== 'string' || input.text.length > MAX_INPUT_CHARACTERS || (input.parentRunId !== null && !uuid.test(input.parentRunId)) || (input.images !== undefined && !Array.isArray(input.images))
      || (input.files !== undefined && (!Array.isArray(input.files) || input.files.some(id => typeof id !== 'string' || !uuid.test(id))))) throw new RuntimeFault('invalid_input', 400);
    let images: DecodedImage[] = [];
    try { images = validateImages(input.images ?? []); }
    catch (error) { throw error instanceof ImageInputError ? new RuntimeFault(error.code, error.code === 'image_too_large' || error.code === 'images_too_large' ? 413 : 400) : error; }
    const uploadIds = input.files ?? [];
    if (uploadIds.length && !this.uploads) throw new RuntimeFault('files_unavailable', 400);
    if (uploadIds.length > FILE_LIMITS.maxFilesPerMessage) throw new RuntimeFault('files_too_many', 400);
    if (!input.text.trim() && !images.length && !uploadIds.length) throw new RuntimeFault('invalid_input', 400);
    const imageMetadata: RunImage[] = images.map(({ mediaType, bytes, sha256 }) => ({ mediaType, bytes, sha256 }));
    const thread = this.thread(owner, input.threadId);
    const previous = this.state.runs.find(r => r.id === input.id);
    if (previous) {
      if (previous.threadId !== input.threadId || previous.input !== input.text || !sameImages(previous.images, imageMetadata) || !sameUploads(previous.uploads, uploadIds) || (!this.queueing && previous.parentRunId !== input.parentRunId) || previous.author?.id !== author?.id) throw new RuntimeFault('id_conflict');
      return { id: previous.id, status: previous.status };
    }
    if (thread.archived) throw new RuntimeFault('thread_archived');
    if (this.queueing) return this.enqueue(thread, input, images, imageMetadata, uploadIds, author);
    const latest = this.delivered(thread.id).at(-1);
    if (input.parentRunId !== (latest?.id ?? null)) throw new RuntimeFault('history_conflict');
    if (latest && latest.status !== 'completed') throw new RuntimeFault('delivery_uncertain');
    if (this.state.runs.length >= 200) throw new RuntimeFault('capacity_reached');
    // Re-validate staged uploads (exist, unchanged, within the per-message count) before opening anything.
    let staged: ReturnType<UploadStaging['load']> = [];
    try { staged = uploadIds.length ? this.uploads!.load(uploadIds) : []; } catch (error) { throw fileFault(error); }
    const lane = this.lane(thread.id);
    return this.exclusive(lane, async () => {
      const run = await this.launch(lane, thread, { id: input.id, threadId: input.threadId, input: input.text, parentRunId: input.parentRunId, status: 'running', events: [] }, images, input.images?.map(image => image?.name), staged, uploadIds, imageMetadata);
      return { id: run.id, status: run.status };
    });
  }
  /** Most runs a shared runtime keeps (a single-owner runtime keeps 200). */
  static readonly MAX_SHARED_RUNS = 2000;
  private enqueue(thread: Thread, input: RunInput, images: DecodedImage[], imageMetadata: RunImage[], uploadIds: string[], author?: RunAuthor) {
    const latest = this.delivered(thread.id).at(-1);
    // A conversation whose last turn did not finish stays read-only; queued turns behind it are never sent.
    if (latest && latest.status !== 'completed' && latest.status !== 'running') throw new RuntimeFault('delivery_uncertain');
    if (this.state.runs.filter(r => r.threadId === thread.id && r.status === 'queued').length >= MAX_QUEUED) throw new RuntimeFault('queue_full', 429);
    if (this.state.runs.length >= ThreadRuntime.MAX_SHARED_RUNS) throw new RuntimeFault('capacity_reached');
    // Uploads are checked now (exist, unchanged) and stored when the turn is sent.
    try { if (uploadIds.length) this.uploads!.load(uploadIds); } catch (error) { throw fileFault(error); }
    const queuedAt = new Date().toISOString();
    const run: Run = { id: input.id, threadId: thread.id, input: input.text, ...(imageMetadata.length ? { images: imageMetadata } : {}), ...(uploadIds.length ? { uploads: uploadIds } : {}),
      parentRunId: input.parentRunId, status: 'queued', events: [], queuedAt, ...(author ? { author } : {}) };
    this.queued.set(run.id, { images, names: input.images?.map(image => image?.name) ?? [], uploads: uploadIds });
    thread.lastActivityAt = queuedAt;
    this.state.runs.push(run); this.save(); this.changed();
    this.pump();
    return { id: run.id, status: run.status };
  }
  private pumping = false;
  /** Send the oldest queued turn of every conversation whose lane is free. */
  private pump() {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      const running = () => [...this.lanes.values()].filter(lane => lane.active || lane.locked).length;
      for (const run of this.state.runs.filter(r => r.status === 'queued')) {
        const lane = this.lane(run.threadId);
        if (lane.locked || lane.active || this.state.runs.some(r => r.threadId === run.threadId && r.status === 'running')) continue;
        if (this.state.runs.find(r => r.threadId === run.threadId && r.status === 'queued') !== run) continue;
        if (this.parallel && running() >= ThreadRuntime.MAX_PARALLEL_TURNS) break;
        void this.dispatch(lane, run);
      }
    } finally { this.pumping = false; }
  }
  /** Withdraw a queued run that was never sent. */
  private withdraw(run: Run, code: string) {
    this.queued.delete(run.id);
    run.status = 'cancelled'; run.notSent = true;
    this.emit(run, 'failed', { code });
  }
  private async dispatch(lane: Lane, run: Run) {
    lane.locked = true;
    let launched = false;
    try {
      const thread = this.state.threads.find(t => t.id === run.threadId);
      const latest = this.delivered(run.threadId).at(-1);
      const payload = this.queued.get(run.id);
      if (!thread || thread.state !== 'ready' || thread.archived || !payload || (latest && latest.status !== 'completed')) { this.withdraw(run, 'not_sent'); return; }
      let staged: ReturnType<UploadStaging['load']> = [];
      try { staged = payload.uploads.length ? this.uploads!.load(payload.uploads) : []; }
      catch (error) { const fault = fileFault(error); this.withdraw(run, fault instanceof RuntimeFault ? fault.code : 'not_sent'); return; }
      run.parentRunId = latest?.id ?? null;
      this.queued.delete(run.id);
      await this.launch(lane, thread, run, payload.images, payload.names, staged, payload.uploads, run.images ?? []);
      launched = true;
    } catch (error) {
      if (!launched && run.status === 'queued') this.withdraw(run, error instanceof RuntimeFault ? error.code : 'not_sent');
    } finally { lane.locked = false; if (!launched) this.pump(); }
  }
  /**
   * Open the session, store the uploads, record the run as running, and drive it.
   * `run` is new (single-owner) or the queued record (shared).
   */
  private async launch(lane: Lane, thread: Thread, run: Run, images: DecodedImage[], names: (string | undefined)[] | undefined, staged: ReturnType<UploadStaging['load']>, uploadIds: string[], imageMetadata: RunImage[]) {
    const session = await this.openIn(lane, thread);
    // Move the uploads into this conversation's folder (all or none, within its limits) before recording the run.
    let files: StoredFile[] = [];
    if (staged.length) {
      if (!session.agent.attachments) throw new RuntimeFault('files_unavailable', 400);
      try { files = await session.agent.attachments.store(staged.map(upload => upload.prepared)); } catch (error) { throw fileFault(error); }
      this.uploads!.discard(uploadIds);
    }
    const fileMetadata: RunFile[] = files.map(({ name, kind, mediaType, label, bytes, sha256, pages, lines }) => ({ name, kind, mediaType, label, bytes, sha256, ...(pages !== undefined ? { pages } : {}), ...(lines !== undefined ? { lines } : {}) }));
    const startedAt = new Date().toISOString();
    Object.assign(run, { ...(imageMetadata.length ? { images: imageMetadata } : {}), ...(fileMetadata.length ? { files: fileMetadata, uploads: uploadIds } : {}), status: 'running', startedAt });
    thread.lastActivityAt = startedAt;
    if (!this.state.runs.includes(run)) this.state.runs.push(run);
    this.save();
    const control = new AbortController(); lane.active = { run, control };
    this.changed();
    const text = run.input;
    // Exactly the new turn: text (if any), the images, then the stored files by reference, in the order given.
    const content: UserContent = images.length || files.length
      ? [...(text.trim() ? [{ type: 'text' as const, text }] : []),
        // With attachments, images are also saved to the folder under their (sanitized) name.
        ...images.map((image, index) => {
          const name = names?.[index];
          return typeof name === 'string' && name.trim() && name.length <= 1024 && session.agent.attachments
            ? { type: 'file' as const, data: image.base64, mediaType: image.mediaType, filename: name }
            : { type: 'image' as const, image: image.base64, mediaType: image.mediaType };
        }),
        ...files.map(file => ({ type: 'file' as const, mediaType: file.mediaType, filename: file.name, data: { type: 'reference' as const, reference: { [IMAGE_REFERENCE_PROVIDER]: file.sha256 } } }))]
      : text;
    void this.drive(lane, session, run, control, content);
    return run;
  }
  private async drive(lane: Lane, session: RuntimeSession, run: Run, control: AbortController, content: UserContent) {
    let timedOut = false;
    const expire = () => { timedOut = true; control.abort(); };
    let remaining = this.deadlineMs;
    // The installed harness caps external tools at five minutes. Finish human
    // waits explicitly before that limit, rather than accepting a detached result.
    let remainingWait = this.humanWaitMs;
    let resumedAt = Date.now();
    let timer = setTimeout(expire, remaining);
    // Human reading time does not consume inference time, but the whole turn
    // remains bounded even if the browser is abandoned or prompts repeat.
    const hardTimer = setTimeout(expire, this.deadlineMs + this.humanWaitMs);
    let disconnect = () => {};
    try {
      disconnect = session.agent.interactions.connect((request, signal) => new Promise((resolve, reject) => {
        clearTimeout(timer);
        remaining = Math.max(1, remaining - (Date.now() - resumedAt));
        const waitingAt = Date.now();
        timer = setTimeout(expire, Math.max(1, remainingWait));
        const resume = () => {
          clearTimeout(timer); remainingWait -= Date.now() - waitingAt;
          resumedAt = Date.now(); timer = setTimeout(expire, remaining);
        };
        const abort = () => {
          if (lane.pending?.request.id === request.id) {
            lane.pending = undefined;
            this.emit(run, 'interaction_ended', { id: request.id, code: timedOut ? 'timed_out' : 'cancelled' });
            resume();
          }
          reject(new RuntimeFault('interaction_cancelled'));
        };
        signal.addEventListener('abort', abort, { once: true });
        lane.pending = { runId: run.id, request, resolve: value => {
          signal.removeEventListener('abort', abort);
          if (lane.pending?.request.id === request.id) lane.pending = undefined;
          resume(); resolve(value);
        } };
        if (signal.aborted) { abort(); return; }
        this.emit(run, 'interaction', request);
      }));
      this.emit(run, 'started', { threadId: run.threadId });
      // Shared runtimes tag the turn with its run ID (to show its author in history) and tell the agent who is speaking.
      const shared = this.queueing ? { otid: run.id, ...(run.author ? { speaker: { name: run.author.name, login: run.author.login } } : {}) } : {};
      const result = await session.agent.stream(typeof content === 'string'
        ? { prompt: content, abortSignal: control.signal, ...shared }
        : { messages: [...session.agent.transcript, { role: 'user', content }], abortSignal: control.signal, ...shared });
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') this.emit(run, 'text', { text: part.text });
        else if (part.type === 'tool-call') this.emit(run, 'tool_started', { toolCallId: part.toolCallId, name: part.toolName, input: part.input, execution: 'external' });
        else if (part.type === 'tool-result') this.emit(run, 'tool_completed', { toolCallId: part.toolCallId, name: part.toolName, output: part.output, execution: 'external' });
        else if (part.type === 'tool-error') this.emit(run, 'tool_failed', { toolCallId: part.toolCallId, name: part.toolName, code: 'tool_failed', ...toolFailureReason(part.error), execution: 'external' });
        else if (part.type === 'error' || part.type === 'abort') throw new RuntimeFault('runtime_failed');
      }
      if (lane.pending?.runId === run.id) throw new RuntimeFault('interaction_incomplete');
      if (control.signal.aborted || await result.finishReason !== 'stop') throw new RuntimeFault('runtime_failed');
      run.status = 'completed'; this.compact(run); this.emit(run, 'completed', {});
    } catch (error) {
      run.status = control.signal.aborted ? 'cancelled' : 'failed';
      const code = timedOut ? 'timed_out' : run.status === 'cancelled' ? 'cancelled' : error instanceof RuntimeFault && error.message === 'interaction_incomplete' ? 'interaction_incomplete' : 'runtime_failed';
      if (lane.pending?.runId === run.id) this.emit(run, 'interaction_ended', { id: lane.pending.request.id, code });
      this.emit(run, 'failed', { code });
    } finally {
      // Keep the pre-run display snapshot current for browser reconnects without
      // closing a running SDK session or replaying any transcript into the agent.
      session.history = [...session.history, ...displayRun(run)];
      lane.pending = undefined; disconnect(); clearTimeout(timer); clearTimeout(hardTimer); lane.active = undefined; lane.usedAt = Date.now();
      this.changed();
      // The next queued turn of this conversation (or another waiting for a free slot).
      if (this.queueing) {
        // A failed turn leaves the conversation read-only: what waited behind it is never sent.
        if (run.status !== 'completed') for (const next of this.state.runs.filter(r => r.threadId === run.threadId && r.status === 'queued')) this.withdraw(next, 'not_sent');
        this.pump();
      }
    }
  }
  /** Shared runtimes keep completed runs small: consecutive text events become one (sequence numbers are kept). */
  private compact(run: Run) {
    if (!this.queueing) return;
    const events: RuntimeEvent[] = [];
    for (const event of run.events) {
      const last = events.at(-1);
      if (event.type === 'text' && last?.type === 'text') events[events.length - 1] = { sequence: event.sequence, type: 'text', data: { text: String(last.data.text) + String(event.data.text) } };
      else events.push(event);
    }
    run.events = events;
  }
  events(owner: string, id: string, after: number) {
    const run = this.run(owner, id);
    // Sequence numbers survive compaction: events are selected by sequence, not by index.
    const last = run.events.at(-1)?.sequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0 || after > last) throw new RuntimeFault('invalid_cursor', 400);
    return { events: run.events.filter(event => event.sequence > after), status: run.status };
  }
  subscribe(id: string, listener: (event: RuntimeEvent) => void) {
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  /** Who wrote a run and its state, for authorization by a shared server. */
  runInfo(owner: string, id: string): { threadId: string; status: Run['status']; author?: RunAuthor } {
    const run = this.run(owner, id);
    return { threadId: run.threadId, status: run.status, ...(run.author ? { author: run.author } : {}) };
  }
  answer(owner: string, runId: string, response: InteractionResponse) {
    const run = this.run(owner, runId);
    const pending = this.lane(run.threadId).pending;
    if (!pending || pending.runId !== runId || run.status !== 'running') throw new RuntimeFault('stale_interaction');
    let value: InteractionResponse;
    try { value = validateResponse(pending.request, response); } catch { throw new RuntimeFault('invalid_response', 400); }
    this.emit(run, 'interaction_resolved', { id: value.id }); pending.resolve(value);
  }
  cancel(owner: string, id: string) {
    const run = this.run(owner, id);
    if (run.status === 'queued') { this.withdraw(run, 'cancelled'); this.pump(); return; }
    const lane = this.laneOfRun(id);
    if (lane?.active?.run.id === id) lane.active.control.abort();
  }
  private closing = false;
  async close() {
    this.closing = true;
    for (const lane of this.lanes.values()) lane.active?.control.abort();
    if (this.saveTimer) { try { this.save(); } catch { /* best effort */ } }
    await Promise.allSettled([...this.lanes.values()].map(lane => this.parallel ? this.closeLane(lane) : Promise.resolve()));
    await this.host.close();
  }
}
