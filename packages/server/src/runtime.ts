import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UIMessage, UserContent } from 'ai';
import {
  AttachmentStore, FILE_LIMITS, FileInputError, IMAGE_PLACEHOLDER, IMAGE_REFERENCE_PROVIDER, ImageInputError, MAX_INPUT_CHARACTERS, ResourceStore, UploadStaging, attachmentNote, validateImages, validateResponse,
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
type Thread = { id: string; owner: string; conversationId?: string; agentId?: string; title: string; archived: boolean; state: 'creating' | 'ready'; createdAt?: string; lastActivityAt?: string; latex?: Exclude<DisplayOverride, 'inherit'> };
/** Metadata of an image sent with a run. The bytes live only in Letta history, never in runtime state. */
export type RunImage = { mediaType: string; bytes: number; sha256: string };
/** A single user turn and the events observed while it ran. */
export type Run = { id: string; threadId: string; input: string; images?: RunImage[]; files?: RunFile[]; uploads?: string[]; parentRunId: string | null; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; events: RuntimeEvent[]; startedAt?: string };
/** Metadata of a file sent with a run (as stored in the conversation's folder). */
export type RunFile = Pick<StoredFile, 'name' | 'kind' | 'mediaType' | 'label' | 'bytes' | 'sha256' | 'pages' | 'lines'>;
/**
 * Input of `POST /v1/runs`. `images` carry base64 data (no data: prefix) and
 * are validated against `IMAGE_LIMITS`. `files` are upload IDs returned by
 * `POST /v1/uploads` (at most `FILE_LIMITS.maxFilesPerMessage`).
 */
export type RunInput = { id: string; threadId: string; text: string; parentRunId: string | null; images?: { mediaType: string; data: string; name?: string }[]; files?: string[] };
type State = { version: 1; threads: Thread[]; runs: Run[] };
/** An opened agent conversation as seen by the runtime. */
export interface RuntimeSession {
  agentId: string;
  conversationId: string;
  history: UIMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: Pick<LettaAgent<any>, 'stream' | 'interactions' | 'transcript'> & { attachments?: AttachmentStore };
}
/** Opens and closes the single agent session the runtime drives. */
export interface RuntimeHost {
  open(options: { conversationId: string } | { newTitle: string }): Promise<RuntimeSession>;
  close(): Promise<void>;
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
  const metadata = run.startedAt ? { metadata: { createdAt: run.startedAt } } : {};
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
 * Single-owner, single-turn thread service over one agent.
 *
 * Runs are recorded durably before delivery; a run that was in flight when the
 * process stopped is marked `interrupted` and blocks further turns on that
 * thread (uncertain delivery is never replayed). Human answers are validated
 * and accepted exactly once.
 */
export class ThreadRuntime {
  private state: State;
  private locked = false;
  private current?: RuntimeSession;
  private active?: { run: Run; control: AbortController };
  private pending?: { runId: string; request: InteractionRequest; resolve(value: InteractionResponse): void };
  private listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  /** Validated uploads waiting to be sent, next to this runtime's state (`<dir>/uploads/.staging`). */
  readonly uploads?: UploadStaging;
  constructor(private readonly host: RuntimeHost, private readonly filename: string, private readonly owner: string, private readonly deadlineMs = 180_000, private readonly humanWaitMs = 4 * 60_000) {
    if (host.attachmentsRoot) this.uploads = new UploadStaging(join(dirname(filename), 'uploads'));
    this.state = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) as State : { version: 1, threads: [], runs: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.threads) || !Array.isArray(this.state.runs)) throw new Error('Invalid runtime state');
    for (const thread of this.state.threads) thread.archived ??= false;
    for (const run of this.state.runs) if (run.status === 'running') {
      run.status = 'interrupted';
      run.events.push({ sequence: run.events.length + 1, type: 'failed', data: { code: 'delivery_uncertain' } });
    }
    this.save();
  }
  private save() {
    // A leftover temporary file is an uncertain write, not permission to overwrite it.
    const fd = openSync(`${this.filename}.tmp`, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${this.filename}.tmp`, this.filename);
    const directory = openSync(dirname(this.filename), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
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
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.locked || this.active) throw new RuntimeFault('runtime_busy');
    this.locked = true;
    try { return await fn(); } finally { this.locked = false; }
  }
  private async open(thread: Thread) {
    if (this.current && this.current.conversationId === thread.conversationId) return this.current;
    await this.host.close(); this.current = undefined;
    const session = await this.host.open(thread.conversationId ? { conversationId: thread.conversationId } : { newTitle: thread.title });
    const identity = this.state.threads.find(t => t.agentId)?.agentId;
    if (identity && session.agentId !== identity) { await this.host.close(); throw new RuntimeFault('identity_mismatch'); }
    this.current = session;
    return session;
  }
  /** Display metadata only; timestamps are omitted for legacy threads that never recorded them. */
  private summary({ id, title, state, archived, createdAt, lastActivityAt, latex }: Thread) {
    return { id, title, state, archived, ...(createdAt ? { createdAt } : {}), ...(lastActivityAt ? { lastActivityAt } : {}), latex: latex ?? 'inherit' as DisplayOverride };
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
    // locked covers session opening before start() has installed its active run.
    if (patch.archived === true && (this.locked || this.active?.run.threadId === id)) throw new RuntimeFault('runtime_busy');
    const retitled = thread.title !== title;
    thread.title = title;
    if (typeof patch.archived === 'boolean') thread.archived = patch.archived;
    if (patch.latex === 'inherit') delete thread.latex; else if (patch.latex === 'on' || patch.latex === 'off') thread.latex = patch.latex;
    this.save();
    // The conversation's folder follows its title (after the running turn, if any). A failure never fails the rename.
    if (retitled && this.host.attachmentsRoot && thread.agentId && thread.conversationId) {
      const conversationId = thread.conversationId;
      const store = this.resourcesOf(thread.agentId);
      this.renaming = this.renaming.then(() => store.retitle(conversationId, title)).then(() => {}, () => {});
    }
    return this.summary(thread);
  }
  private renaming: Promise<void> = Promise.resolve();
  /** Resolves when folder renames requested by {@link updateMetadata} are done (or deferred to the end of a turn). */
  folderRenamed(): Promise<void> { return this.renaming; }
  async create(owner: string, id: string, title: string) {
    this.authorize(owner);
    if (!uuid.test(id) || typeof title !== 'string' || !title.trim() || title.length > 120) throw new RuntimeFault('invalid_input', 400);
    const previous = this.state.threads.find(t => t.id === id);
    if (previous) {
      if (previous.owner !== owner || previous.title !== title) throw new RuntimeFault('id_conflict');
      this.thread(owner, id); return { id, title };
    }
    if (this.state.threads.length >= 200) throw new RuntimeFault('capacity_reached');
    return this.exclusive(async () => {
      const now = new Date().toISOString();
      const thread: Thread = { id, owner, title, archived: false, state: 'creating', createdAt: now, lastActivityAt: now };
      this.state.threads.push(thread); this.save();
      const session = await this.open(thread);
      thread.agentId = session.agentId; thread.conversationId = session.conversationId; thread.state = 'ready'; this.save();
      if (this.host.attachmentsRoot) { try { this.resourcesOf(session.agentId).adopt(session.conversationId, title); } catch { /* created on first use */ } }
      return { id, title };
    });
  }
  async history(owner: string, id: string) {
    const thread = this.thread(owner, id);
    return this.exclusive(async () => {
      // Refresh through backend history, not a display transcript replay into the agent.
      await this.host.close(); this.current = undefined;
      const session = await this.open(thread);
      return { messages: session.history.filter(m => m.id !== 'session-status'), lastRunId: this.state.runs.filter(r => r.threadId === id).at(-1)?.id ?? null };
    });
  }
  async view(owner: string, id: string) {
    this.thread(owner, id);
    const latest = this.state.runs.filter(r => r.threadId === id).at(-1);
    if (this.active?.run.threadId === id && this.current) return {
      messages: this.current.history.filter(m => m.id !== 'session-status'),
      lastRunId: latest?.id ?? null,
      live: { id: this.active.run.id, input: this.active.run.input, ...(this.active.run.images?.length ? { images: this.active.run.images.length } : {}), ...(this.active.run.files?.length ? { files: this.active.run.files.map(({ name, label, bytes, pages, lines, kind }) => ({ name, label, bytes, kind, ...(pages !== undefined ? { pages } : {}), ...(lines !== undefined ? { lines } : {}) })) } : {}) },
      status: 'running',
    };
    if (latest && !['running', 'completed'].includes(latest.status)) return {
      messages: this.state.runs.filter(r => r.threadId === id).flatMap(displayRun),
      lastRunId: latest.id, live: null, status: latest.status, source: 'transport-observations',
    };
    return { ...await this.history(owner, id), live: null, status: latest?.status ?? null, source: 'backend-history' };
  }
  private emit(run: Run, type: string, data: Record<string, unknown>) {
    const event = { sequence: run.events.length + 1, type, data };
    run.events.push(event); this.save();
    for (const listener of this.listeners.get(run.id) ?? []) listener(event);
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
  /** Rename or move. One commit. */
  resourceMove(owner: string, input: unknown) {
    const { from, to } = (input ?? {}) as { from?: unknown; to?: unknown };
    if (typeof from !== 'string' || typeof to !== 'string') throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, store => store.move(from, to));
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
  /**
   * Start one turn. Text, images or both; images are validated (type by
   * content, size, count, total) and fail with a fixed `image_*` code.
   * Only image metadata (type, size, SHA-256) is recorded in runtime state.
   */
  async start(owner: string, input: RunInput) {
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
      if (previous.threadId !== input.threadId || previous.input !== input.text || !sameImages(previous.images, imageMetadata) || !sameUploads(previous.uploads, uploadIds) || previous.parentRunId !== input.parentRunId) throw new RuntimeFault('id_conflict');
      return { id: previous.id, status: previous.status };
    }
    if (thread.archived) throw new RuntimeFault('thread_archived');
    const latest = this.state.runs.filter(r => r.threadId === thread.id).at(-1);
    if (input.parentRunId !== (latest?.id ?? null)) throw new RuntimeFault('history_conflict');
    if (latest && latest.status !== 'completed') throw new RuntimeFault('delivery_uncertain');
    if (this.state.runs.length >= 200) throw new RuntimeFault('capacity_reached');
    // Re-validate staged uploads (exist, unchanged, within the per-message count) before opening anything.
    let staged: ReturnType<UploadStaging['load']> = [];
    try { staged = uploadIds.length ? this.uploads!.load(uploadIds) : []; } catch (error) { throw fileFault(error); }
    return this.exclusive(async () => {
      const session = await this.open(thread);
      // Move the uploads into this conversation's folder (all or none, within its limits) before recording the run.
      let files: StoredFile[] = [];
      if (staged.length) {
        if (!session.agent.attachments) throw new RuntimeFault('files_unavailable', 400);
        try { files = await session.agent.attachments.store(staged.map(upload => upload.prepared)); } catch (error) { throw fileFault(error); }
        this.uploads!.discard(uploadIds);
      }
      const fileMetadata: RunFile[] = files.map(({ name, kind, mediaType, label, bytes, sha256, pages, lines }) => ({ name, kind, mediaType, label, bytes, sha256, ...(pages !== undefined ? { pages } : {}), ...(lines !== undefined ? { lines } : {}) }));
      const startedAt = new Date().toISOString();
      const run: Run = { id: input.id, threadId: input.threadId, input: input.text, ...(imageMetadata.length ? { images: imageMetadata } : {}), ...(fileMetadata.length ? { files: fileMetadata, uploads: uploadIds } : {}), parentRunId: input.parentRunId, status: 'running', events: [], startedAt };
      thread.lastActivityAt = startedAt;
      this.state.runs.push(run); this.save();
      const control = new AbortController(); this.active = { run, control };
      // Exactly the new turn: text (if any), the images, then the stored files by reference, in the order given.
      const content: UserContent = images.length || files.length
        ? [...(input.text.trim() ? [{ type: 'text' as const, text: input.text }] : []),
          // With attachments, images are also saved to the folder under their (sanitized) name.
          ...images.map((image, index) => {
            const name = input.images?.[index]?.name;
            return typeof name === 'string' && name.trim() && name.length <= 1024 && session.agent.attachments
              ? { type: 'file' as const, data: image.base64, mediaType: image.mediaType, filename: name }
              : { type: 'image' as const, image: image.base64, mediaType: image.mediaType };
          }),
          ...files.map(file => ({ type: 'file' as const, mediaType: file.mediaType, filename: file.name, data: { type: 'reference' as const, reference: { [IMAGE_REFERENCE_PROVIDER]: file.sha256 } } }))]
        : input.text;
      void this.drive(session, run, control, content);
      return { id: run.id, status: run.status };
    });
  }
  private async drive(session: RuntimeSession, run: Run, control: AbortController, content: UserContent) {
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
          if (this.pending?.request.id === request.id) {
            this.pending = undefined;
            this.emit(run, 'interaction_ended', { id: request.id, code: timedOut ? 'timed_out' : 'cancelled' });
            resume();
          }
          reject(new RuntimeFault('interaction_cancelled'));
        };
        signal.addEventListener('abort', abort, { once: true });
        this.pending = { runId: run.id, request, resolve: value => {
          signal.removeEventListener('abort', abort);
          if (this.pending?.request.id === request.id) this.pending = undefined;
          resume(); resolve(value);
        } };
        if (signal.aborted) { abort(); return; }
        this.emit(run, 'interaction', request);
      }));
      this.emit(run, 'started', { threadId: run.threadId });
      const result = await session.agent.stream(typeof content === 'string'
        ? { prompt: content, abortSignal: control.signal }
        : { messages: [...session.agent.transcript, { role: 'user', content }], abortSignal: control.signal });
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') this.emit(run, 'text', { text: part.text });
        else if (part.type === 'tool-call') this.emit(run, 'tool_started', { toolCallId: part.toolCallId, name: part.toolName, input: part.input, execution: 'external' });
        else if (part.type === 'tool-result') this.emit(run, 'tool_completed', { toolCallId: part.toolCallId, name: part.toolName, output: part.output, execution: 'external' });
        else if (part.type === 'tool-error') this.emit(run, 'tool_failed', { toolCallId: part.toolCallId, name: part.toolName, code: 'tool_failed', ...toolFailureReason(part.error), execution: 'external' });
        else if (part.type === 'error' || part.type === 'abort') throw new RuntimeFault('runtime_failed');
      }
      if (this.pending?.runId === run.id) throw new RuntimeFault('interaction_incomplete');
      if (control.signal.aborted || await result.finishReason !== 'stop') throw new RuntimeFault('runtime_failed');
      run.status = 'completed'; this.emit(run, 'completed', {});
    } catch (error) {
      run.status = control.signal.aborted ? 'cancelled' : 'failed';
      const code = timedOut ? 'timed_out' : run.status === 'cancelled' ? 'cancelled' : error instanceof RuntimeFault && error.message === 'interaction_incomplete' ? 'interaction_incomplete' : 'runtime_failed';
      if (this.pending?.runId === run.id) this.emit(run, 'interaction_ended', { id: this.pending.request.id, code });
      this.emit(run, 'failed', { code });
    } finally {
      // Keep the pre-run display snapshot current for browser reconnects without
      // closing a running SDK session or replaying any transcript into the agent.
      session.history = [...session.history, ...displayRun(run)];
      this.pending = undefined; disconnect(); clearTimeout(timer); clearTimeout(hardTimer); this.active = undefined;
    }
  }
  events(owner: string, id: string, after: number) {
    const run = this.run(owner, id);
    if (!Number.isSafeInteger(after) || after < 0 || after > run.events.length) throw new RuntimeFault('invalid_cursor', 400);
    return { events: run.events.slice(after), status: run.status };
  }
  subscribe(id: string, listener: (event: RuntimeEvent) => void) {
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  answer(owner: string, runId: string, response: InteractionResponse) {
    const run = this.run(owner, runId);
    const pending = this.pending;
    if (!pending || pending.runId !== runId || run.status !== 'running') throw new RuntimeFault('stale_interaction');
    let value: InteractionResponse;
    try { value = validateResponse(pending.request, response); } catch { throw new RuntimeFault('invalid_response', 400); }
    this.emit(run, 'interaction_resolved', { id: value.id }); pending.resolve(value);
  }
  cancel(owner: string, id: string) {
    this.run(owner, id);
    if (this.active?.run.id === id) this.active.control.abort();
  }
  async close() { this.active?.control.abort(); await this.host.close(); }
}

