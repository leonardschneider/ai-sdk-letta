import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { FILE_LIMITS, FileInputError, decodeText, detectFileType, metadataOf, numberedName, prepareFile, sanitizeFileName, type FileLimits, type PreparedFile, type StoredFile } from './attachments.js';
import { sanitizeRepository } from './sandbox.js';

/**
 * Resources: every file of an agent, in one git-backed folder.
 *
 * Layout under `<stateDir>/resources/<agentId>/` (all private, 0700):
 * - `files/` the work tree: one folder per conversation, plus any folders the
 *   user creates. The sandbox mounts it at `/workspace`.
 * - `git/` the repository (a separate git directory, never mounted, so
 *   commands in the sandbox cannot rewrite history). No remote.
 * - `cache/` text extracted from PDFs and file metadata, by content hash.
 * - `state.json` which folder belongs to which conversation, and where each
 *   attached file is now (so links in old messages keep working).
 *
 * Every user operation is one commit; changes made by the agent are committed
 * at the end of each turn. Git runs with a fixed identity, without global or
 * system configuration, under one lock per agent.
 */

/** Bounds for the resources of one agent. */
export const RESOURCE_LIMITS = Object.freeze({
  /** Largest file uploaded through the resources API. */
  maxFileBytes: FILE_LIMITS.maxFileBytes,
  /** Most entries walked when listing or committing (hidden and ignored entries excluded). */
  maxEntries: 20_000,
  /** Deepest folder nesting accepted in a path. */
  maxDepth: 24,
  /** Longest path, in characters. */
  maxPathChars: 1024,
  /** Files larger than this stay on disk but are not versioned. */
  maxVersionedBytes: 100 * 1024 * 1024,
  /** Most files listed by `list_files` in one result. */
  maxListed: 200,
});

/**
 * What the resources repository never versions (gitignore syntax). Kept in
 * the repository's `info/exclude`, which commands in the sandbox cannot
 * change; `.gitignore` files in folders apply too. All of these are hidden
 * in the UI as well (they start with a dot), except `node_modules`.
 */
export const RESOURCES_GITIGNORE = `# Managed by ai-sdk-letta. Python environment, sandbox home and caches are not versioned.
.venv/
.home/
__pycache__/
*.pyc
.ipynb_checkpoints/
.pytest_cache/
.mypy_cache/
.cache/
node_modules/
.DS_Store
`;

const AGENT_ID = /^agent-[a-zA-Z0-9-]{1,100}$/;
const CONVERSATION_ID = /^(?:default|(?:conv-|local-conv-)[a-zA-Z0-9-]{1,100})$/;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A file or folder in the resources tree. */
export interface ResourceNode {
  name: string;
  /** Path from the resources root, with `/` separators and no leading slash. */
  path: string;
  type: 'file' | 'folder';
  /** Files: size in bytes. */
  bytes?: number;
  /** Last modification (ISO 8601). */
  modifiedAt: string;
  /** Folders that belong to a conversation. */
  conversationId?: string;
  /** Folders: their entries, folders first, by name. */
  children?: ResourceNode[];
}
/** The listing returned by {@link ResourceStore.tree}. */
export interface ResourceTree { children: ResourceNode[]; truncated: boolean; version: string }
/** A file described by content (like an attachment), with its path from the root. */
export interface ResourceFile extends StoredFile { path: string }
/** One commit in the resources history. */
export interface ResourceCommit { commit: string; message: string; date: string }

/** `provisional` was written by an earlier version; it is ignored. */
type FolderEntry = { path: string; ino?: number; provisional?: boolean };
type LedgerEntry = { conversationId: string; name: string; path: string; sha256: string; bytes: number };
type State = { version: 1; folders: Record<string, FolderEntry>; attachments: LedgerEntry[]; migrated: string[] };

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const lineCount = (text: string) => text ? text.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0) : 0;
const invalid = (message = 'Invalid path') => new FileInputError('file_name_invalid', message);
const notFound = (path: string) => new FileInputError('file_not_found', `No file or folder "${path}"`);

function syncDirectory(path: string) { try { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* best effort */ } }
/** Create a private directory (0700); refuse a symlink or a non-directory. */
function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid('Unsafe resources directory');
  if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700);
}
/** Write a new file atomically (temporary file, fsync, no-clobber link). Throws EEXIST if `path` exists. */
function writeNew(directory: string, path: string, data: Uint8Array | string, mode = 0o600) {
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
}
/** Replace a private file atomically. */
function writeReplace(path: string, data: string) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
/** Read a regular, singly-linked file without following symlinks. */
export function readRegularFile(path: string, limit = Number.MAX_SAFE_INTEGER): Buffer {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new FileInputError('file_not_found', 'No such file');
    if (code === 'ELOOP' || code === 'EMLINK') throw invalid('Refusing to follow a link');
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw invalid('Not a regular file');
    if (info.size > limit) throw new FileInputError('file_too_large', 'File too large');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/**
 * Split a path from the resources root into its names. Leading and trailing
 * slashes are ignored. Every name must be visible (no leading dot), without
 * control characters or separators; `.` and `..` are refused.
 * @throws {FileInputError} `file_name_invalid`
 */
export function splitResourcePath(path: unknown, options: { allowRoot?: boolean } = {}): string[] {
  if (typeof path !== 'string' || path.length > RESOURCE_LIMITS.maxPathChars) throw invalid();
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) { if (options.allowRoot) return []; throw invalid('A path is required'); }
  const parts = trimmed.split('/');
  if (parts.length > RESOURCE_LIMITS.maxDepth) throw invalid('Path is too deep');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.startsWith('.') || /[\0-\x1f\x7f\\]/.test(part) || Buffer.byteLength(part) > 255) throw invalid(`Invalid path "${path}"`);
  }
  return parts;
}
/** A path joined from names (see {@link splitResourcePath}). */
export const joinResourcePath = (...parts: string[]) => parts.filter(Boolean).join('/');
const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const within = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** A folder name from a conversation title: a plain name, at most 60 characters. */
export function folderNameFromTitle(title: string | undefined, fallback: string): string {
  // Punctuation that file systems dislike becomes readable separators rather than underscores.
  const plain = (title ?? '').replace(/\s*[/\\|]\s*/g, ' - ').replace(/\s*:\s*/g, ' - ').replace(/[?*"<>]/g, '').replace(/…+$/u, '');
  const name = sanitizeFileName(plain, fallback);
  const short = [...name].length > 60 ? `${[...name].slice(0, 59).join('').trim()}…` : name;
  return short || fallback;
}
/** Names the resources UI and listings leave out: hidden (dot) entries, caches, odd names. */
const hiddenName = (name: string) => name.startsWith('.') || name === '__pycache__' || name === 'node_modules' || /[\0-\x1f\x7f\\]/.test(name);

/* ------------------------------------------------------------------ */
/* Lock                                                                */
/* ------------------------------------------------------------------ */

const queues = new Map<string, Promise<unknown>>();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

/**
 * Run `task` alone for this resources folder: one at a time in this process
 * (a queue), and across processes (an exclusive lock file; a lock left by a
 * process that no longer runs is taken over).
 */
async function exclusive<T>(directory: string, task: () => Promise<T>, waitMs = 20_000): Promise<T> {
  const previous = queues.get(directory) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>(resolve => { done = resolve; });
  const tail = previous.then(() => mine);
  queues.set(directory, tail);
  await previous.catch(() => {});
  const file = join(directory, 'resources.lock');
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try { const fd = openSync(file, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let pid = NaN;
        try { pid = Number(readFileSync(file, 'utf8')); } catch { /* raced */ }
        if (Number.isInteger(pid) && pid > 0 && !alive(pid)) { try { unlinkSync(file); } catch { /* raced */ } continue; }
        if (Date.now() > deadline) throw new FileInputError('resources_busy', 'The resources are busy; try again');
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    try { return await task(); }
    finally { try { unlinkSync(file); } catch { /* already gone */ } }
  } finally {
    done();
    if (queues.get(directory) === tail) queues.delete(directory);
  }
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

const stores = new Map<string, ResourceStore>();

/** The git-backed resources of one agent. Get one with {@link ResourceStore.open}. */
export class ResourceStore {
  /** `<root>/<agentId>` */
  readonly directory: string;
  /** The work tree (mounted at `/workspace` in the sandbox). */
  readonly files: string;
  /** The git directory (outside the work tree). */
  readonly gitDir: string;
  private readonly cache: string;
  private readonly stateFile: string;
  private ready?: Promise<void>;
  private readonly described = new Map<string, Omit<StoredFile, 'name'>>();
  /** Commits made by this process (all stores of the folder share it); a UI can poll it to refresh. */
  get commits(): number { return this.committed; }
  private committed = 0;
  private readonly listeners = new Set<(commit: string) => void>();
  /** Call `listener` after each commit. Returns a function that removes it. */
  subscribe(listener: (commit: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  private constructor(readonly root: string, readonly agentId: string, readonly limits: Readonly<FileLimits>) {
    this.directory = join(root, agentId);
    this.files = join(this.directory, 'files');
    this.gitDir = join(this.directory, 'git');
    this.cache = join(this.directory, 'cache');
    this.stateFile = join(this.directory, 'state.json');
  }

  /** The store for an agent (one instance per folder in this process). */
  static open(root: string, agentId: string, limits: Readonly<FileLimits> = FILE_LIMITS): ResourceStore {
    if (!isAbsolute(root)) throw invalid('Resources root must be absolute');
    if (!AGENT_ID.test(agentId)) throw invalid('Invalid agent ID for resources');
    const key = join(resolve(root), agentId);
    let store = stores.get(key);
    if (!store) { store = new ResourceStore(resolve(root), agentId, limits); stores.set(key, store); }
    store.prepare();
    return store;
  }

  /** Create the folders (0700), verify them and return the work tree's real path (to mount at `/workspace`). */
  workTree(): string { return this.prepare(); }
  private prepare(): string {
    privateDirectory(this.root);
    privateDirectory(this.directory);
    privateDirectory(this.files);
    privateDirectory(this.cache);
    const real = realpathSync(this.files);
    if (real !== join(realpathSync(this.root), this.agentId, 'files')) throw invalid('Unsafe resources directory');
    return real;
  }

  /** Set up the git repository (once) and commit what is already there. */
  init(): Promise<void> {
    return this.ready ??= exclusive(this.directory, async () => {
      if (!existsSync(join(this.gitDir, 'HEAD'))) {
        privateDirectory(this.gitDir);
        // A bare-style repository next to the work tree: no absolute work-tree path is recorded.
        await this.git(['init', '--bare', '--template=', '-q'], undefined, false, { GIT_WORK_TREE: undefined });
        await this.git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
        for (const [key, value] of [['core.bare', 'false'], ['core.logAllRefUpdates', 'true'], ['core.quotePath', 'false'], ['core.symlinks', 'false'], ['commit.gpgSign', 'false'], ['gc.auto', '0']]) await this.git(['config', key, value]);
      }
      privateDirectory(join(this.gitDir, 'info'));
      const exclude = join(this.gitDir, 'info', 'exclude');
      if (!existsSync(exclude) || readFileSync(exclude, 'utf8') !== RESOURCES_GITIGNORE) writeReplace(exclude, RESOURCES_GITIGNORE);
      await this.commitLocked(await this.head() ? 'Changes made while the app was closed' : 'Initialize resources');
    }).catch(error => { this.ready = undefined; throw error; });
  }

  /* ---------------- git ---------------- */

  private get env(): NodeJS.ProcessEnv {
    const who = { name: 'ai-sdk-letta', email: 'resources@ai-sdk-letta.invalid' };
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.directory, LANG: 'C', LC_ALL: 'C',
      GIT_DIR: this.gitDir, GIT_WORK_TREE: this.files, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    };
  }
  /** Run git on this repository. Exit code 1 is accepted when `ok1` is set (for example, check-ignore with no match). */
  private git(args: string[], input?: string | Buffer, ok1 = false, extra: NodeJS.ProcessEnv = {}): Promise<Buffer> {
    const env = { ...this.env, ...extra };
    for (const key of Object.keys(extra)) if (extra[key] === undefined) delete env[key];
    return new Promise((done, fail) => {
      const child = execFile('git', args, { env, cwd: this.files, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (error && !(ok1 && code === 1)) fail(new Error(`git ${args[0]} failed: ${String(stderr).trim().slice(0, 300) || (error as Error).message}`));
        else done(stdout);
      });
      // git may exit before reading its input (on an error); the exit code reports that, not the pipe.
      child.stdin?.on('error', () => {});
      child.stdin?.end(input ?? '');
    });
  }
  private async head(): Promise<string | undefined> {
    const out = (await this.git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], undefined, true)).toString().trim();
    return COMMIT.test(out) ? out : undefined;
  }

  /** Paths (from the root) of entries git ignores, among `paths` (folders end with `/`). */
  private async ignored(paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    // check-ignore reads paths, not pathspecs; it refuses the literal-pathspec setting.
    const out = await this.git(['check-ignore', '--no-index', '-z', '--stdin'], Buffer.from(`${paths.join('\0')}\0`), true, { GIT_LITERAL_PATHSPECS: undefined });
    return new Set(out.toString().split('\0').filter(Boolean));
  }
  /** Files to version under `start` (a folder or a file): no `.git` folders, links or ignored entries. */
  private async walk(start: string): Promise<string[]> {
    const files: string[] = [];
    let info: Stats;
    try { info = lstatSync(start ? join(this.files, start) : this.files); } catch (error) { if (missing(error)) return files; throw error; }
    if (info.isFile()) return (await this.ignored([start])).has(start) ? [] : [start];
    if (!info.isDirectory()) return files;
    let frontier = [start];
    let seen = 0;
    while (frontier.length) {
      const candidates: { path: string; folder: boolean }[] = [];
      for (const folder of frontier) {
        let entries;
        try { entries = readdirSync(folder ? join(this.files, folder) : this.files, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (entry.name === '.git') { sanitizeRepository(join(this.files, folder, '.git')); continue; }
          if (entry.name.startsWith('.tmp-')) continue;
          const path = folder ? `${folder}/${entry.name}` : entry.name;
          if (entry.isDirectory()) candidates.push({ path, folder: true });
          else if (entry.isFile()) { try { if (lstatSync(join(this.files, path)).size <= RESOURCE_LIMITS.maxVersionedBytes) candidates.push({ path, folder: false }); } catch { /* raced */ } }
          if (++seen > RESOURCE_LIMITS.maxEntries * 2) throw new FileInputError('resources_full', `The resources hold more than ${RESOURCE_LIMITS.maxEntries.toLocaleString('en-US')} entries`);
        }
      }
      const skip = await this.ignored(candidates.map(c => c.folder ? `${c.path}/` : c.path));
      frontier = [];
      for (const c of candidates) {
        if (skip.has(c.folder ? `${c.path}/` : c.path) || skip.has(c.path)) continue;
        if (c.folder) frontier.push(c.path); else files.push(c.path);
      }
      if (files.length > RESOURCE_LIMITS.maxEntries) throw new FileInputError('resources_full', `The resources hold more than ${RESOURCE_LIMITS.maxEntries.toLocaleString('en-US')} files`);
    }
    return files;
  }
  /** Bring the index in line with the work tree, for everything or only under `scope`. */
  private async stage(scope?: readonly string[]) {
    const roots = scope ? [...new Set(scope)] : [''];
    const present = new Set<string>();
    for (const root of roots) for (const file of await this.walk(root)) present.add(file);
    const listed = (await this.git(['ls-files', '-z', ...(scope ? ['--', ...roots] : [])])).toString().split('\0').filter(Boolean);
    const removed = listed.filter(path => !present.has(path));
    if (removed.length) await this.git(['update-index', '--force-remove', '-z', '--stdin'], Buffer.from(`${removed.join('\0')}\0`));
    if (present.size) await this.git(['update-index', '--add', '--replace', '-z', '--stdin'], Buffer.from(`${[...present].join('\0')}\0`));
  }
  /** Commit staged changes (everything, or only `scope`). Returns the new commit, or `undefined` if nothing changed. Caller holds the lock. */
  private async commitLocked(message: string, scope?: readonly string[]): Promise<string | undefined> {
    const head = await this.head();
    try {
      await this.stage(scope);
      const tree = (await this.git(['write-tree'])).toString().trim();
      const before = head ? (await this.git(['rev-parse', `${head}^{tree}`])).toString().trim() : EMPTY_TREE;
      if (tree === before && head) return undefined;
      const commit = (await this.git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], `${message}\n`)).toString().trim();
      await this.git(['update-ref', '-m', message.slice(0, 200), 'HEAD', commit, head ?? '']);
      this.committed++;
      for (const listener of this.listeners) { try { listener(commit); } catch { /* observer */ } }
      return commit;
    } catch (error) {
      // Never leave a half-staged index: it would leak into the next commit.
      await this.git(head ? ['read-tree', head] : ['read-tree', '--empty']).catch(() => {});
      throw error;
    }
  }
  /** Run a change and commit it as one commit (under the lock). */
  private async change<T extends object>(message: string | ((value: T) => string), scope: (value: T) => string[], task: () => T | Promise<T>): Promise<T & { commit?: string }> {
    await this.init();
    return exclusive(this.directory, async () => {
      const value = await task();
      const commit = await this.commitLocked(typeof message === 'function' ? message(value) : message, scope(value));
      return { ...value, ...(commit ? { commit } : {}) };
    });
  }

  /** Commit everything that changed (for example, by the agent during a turn), as one commit. */
  async commitAll(message: string): Promise<string | undefined> {
    await this.init();
    return exclusive(this.directory, () => this.commitLocked(message));
  }
  /** Commit the agent's changes at the end of a turn: "Agent changes in <folder>". */
  commitAgentChanges(conversationId?: string): Promise<string | undefined> {
    const folder = conversationId ? this.state().folders[conversationId]?.path : undefined;
    return this.commitAll(folder ? `Agent changes in ${folder}` : 'Agent changes');
  }
  /** The newest commits first. */
  async log(limit = 50): Promise<ResourceCommit[]> {
    await this.init();
    const out = (await this.git(['log', `-n${Math.max(1, Math.min(limit, 1000))}`, '--format=%H%x00%s%x00%cI%x00'], undefined, true)).toString();
    const fields = out.split('\0').map(s => s.replace(/^\n/, ''));
    const commits: ResourceCommit[] = [];
    for (let i = 0; i + 2 < fields.length; i += 3) if (COMMIT.test(fields[i]!)) commits.push({ commit: fields[i]!, message: fields[i + 1]!, date: fields[i + 2]! });
    return commits;
  }
  /** Paths changed by a commit (for tests and diagnostics). */
  async changed(commit: string): Promise<string[]> {
    if (!COMMIT.test(commit)) throw invalid('Invalid commit');
    return (await this.git(['show', '--format=', '--name-only', '-z', '--no-renames', commit])).toString().split('\0').filter(Boolean);
  }

  /* ---------------- state ---------------- */

  private state(): State {
    try {
      const value = JSON.parse(readRegularFile(this.stateFile, 16 * 1024 * 1024).toString('utf8')) as State;
      if (value.version === 1 && value.folders && Array.isArray(value.attachments)) return { ...value, migrated: value.migrated ?? [] };
    } catch (error) { if (!(error instanceof FileInputError && error.code === 'file_not_found') && !(error instanceof SyntaxError)) throw error; }
    return { version: 1, folders: {}, attachments: [], migrated: [] };
  }
  private save(state: State) { writeReplace(this.stateFile, JSON.stringify(state)); }

  /* ---------------- paths ---------------- */

  /**
   * The absolute path of `path` (from the root), checked: every name is
   * plain and visible, and no part of it is a symlink.
   * @throws {FileInputError} `file_name_invalid` or `file_not_found`
   */
  resolve(path: string, options: { mustExist?: boolean } = {}): string {
    const parts = splitResourcePath(path, { allowRoot: true });
    let current = this.prepare();
    for (const [index, part] of parts.entries()) {
      const next = join(current, part);
      let info: Stats;
      try { info = lstatSync(next); }
      catch (error) {
        if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
        if (options.mustExist === false && index === parts.length - 1) return next;
        throw notFound(path);
      }
      if (info.isSymbolicLink()) throw invalid('Links are not followed');
      if (index < parts.length - 1 && !info.isDirectory()) throw notFound(path);
      current = next;
    }
    return current;
  }
  /** Path of a host file inside the sandbox. */
  containerPath(path: string): string { return posix.join('/workspace', ...splitResourcePath(path, { allowRoot: true })); }
  private exists(path: string) { try { lstatSync(join(this.files, path)); return true; } catch (error) { if (missing(error)) return false; throw error; } }
  private freeName(folder: string, name: string): string {
    for (let n = 1; n <= 200; n++) {
      const candidate = n === 1 ? name : numberedName(name, n);
      if (!this.existsCaseless(folder, candidate)) return candidate;
    }
    throw new FileInputError('file_exists', 'Too many files with this name');
  }
  /** Does `folder` hold an entry named `name` (ignoring case and Unicode normalization, as macOS does)? */
  private existsCaseless(folder: string, name: string, except?: string): boolean {
    const want = name.normalize('NFC').toLowerCase();
    let entries: string[];
    try { entries = readdirSync(folder ? this.resolve(folder) : this.prepare()); } catch { return false; }
    return entries.some(entry => entry !== except && entry.normalize('NFC').toLowerCase() === want);
  }

  /* ---------------- conversation folders ---------------- */

  /** The folder of a conversation, if it has one (path from the root). Follows a folder the agent renamed. */
  folderOf(conversationId: string): string | undefined {
    const state = this.state();
    const entry = state.folders[conversationId];
    if (!entry) return undefined;
    try {
      const info = lstatSync(join(this.files, entry.path));
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (entry.ino !== info.ino) { entry.ino = info.ino; this.save(state); }
        return entry.path;
      }
    } catch (error) { if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error; }
    // Moved outside the app (e.g. `mv` in the sandbox): find the same folder by inode, two levels deep.
    if (entry.ino !== undefined) {
      const found = this.findFolder(entry.ino);
      if (found) { entry.path = found; this.save(state); return found; }
    }
    return entry.path;
  }
  private findFolder(ino: number): string | undefined {
    const level = (folder: string) => { try { return readdirSync(folder ? join(this.files, folder) : this.files, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => folder ? `${folder}/${e.name}` : e.name); } catch { return []; } };
    for (const path of [...level(''), ...level('').flatMap(level)]) { try { if (lstatSync(join(this.files, path)).ino === ino) return path; } catch { /* raced */ } }
    return undefined;
  }

  /**
   * The folder of a conversation, created if needed (path from the root).
   * A new folder is named after `title` (made unique); when the conversation
   * is renamed, the folder follows (see {@link retitle}).
   */
  ensureFolder(conversationId: string, title?: string): string {
    if (!CONVERSATION_ID.test(conversationId)) throw invalid('Invalid conversation ID');
    const state = this.state();
    const known = state.folders[conversationId];
    if (known) {
      const path = this.folderOf(conversationId)!;
      const absolute = join(this.files, path);
      if (!existsSync(absolute)) {
        // Deleted by the user: recreate it, empty, where it was (or at the top if its parent is gone too).
        const parent = parentOf(path);
        const target = parent && existsSync(join(this.files, parent)) ? path : this.freeName('', baseName(path));
        mkdirSync(join(this.files, target), { mode: 0o700 });
        const fresh = this.state();
        fresh.folders[conversationId] = { ...fresh.folders[conversationId]!, path: target, ino: lstatSync(join(this.files, target)).ino };
        this.save(fresh);
        return target;
      }
      return path;
    }
    const tail = conversationId.replace(/^(?:local-)?conv-/, '');
    const fallback = conversationId === 'default' ? 'Default conversation' : `Conversation ${tail.length > 8 ? tail.slice(-8) : tail}`;
    const name = this.freeName('', folderNameFromTitle(title, fallback));
    mkdirSync(join(this.files, name), { mode: 0o700 });
    state.folders[conversationId] = { path: name, ino: lstatSync(join(this.files, name)).ino };
    this.save(state);
    return name;
  }
  /** Give a conversation a folder if it never had one (a folder the user deleted stays deleted). Returns its path. */
  adopt(conversationId: string, title?: string): string {
    return this.state().folders[conversationId] ? this.folderOf(conversationId)! : this.ensureFolder(conversationId, title);
  }
  /** Conversation folders: `{ conversationId, path }`. */
  conversations(): { conversationId: string; path: string }[] {
    return Object.keys(this.state().folders).map(conversationId => ({ conversationId, path: this.folderOf(conversationId)! }));
  }
  /**
   * A conversation was renamed: its folder takes the new title (made a valid
   * name, unique in its parent), wherever the folder is now, also if the user
   * renamed or moved it. One commit, "Rename folder <old> → <new>". While a
   * turn of that conversation runs, the rename waits until the turn ended
   * (after its end-of-turn commit), so running commands keep their working
   * directory; only the newest title is applied. A conversation whose folder
   * no longer exists keeps none (nothing is created).
   * @returns the new path, `'deferred'`, or `undefined` when nothing changed
   */
  async retitle(conversationId: string, title: string): Promise<string | 'deferred' | undefined> {
    if (!this.state().folders[conversationId]) return undefined;
    if (this.running.has(conversationId)) { this.pendingTitles.set(conversationId, title); return 'deferred'; }
    this.pendingTitles.delete(conversationId);
    const from = this.folderOf(conversationId)!;
    try { if (!lstatSync(join(this.files, from)).isDirectory()) return undefined; } catch { return undefined; }
    const parent = parentOf(from);
    const name = this.freeNameExcept(parent, folderNameFromTitle(title, baseName(from)), baseName(from));
    const to = joinResourcePath(parent, name);
    if (to === from) return undefined;
    return (await this.move(from, to, `Rename folder ${from} → ${name}`)).path;
  }
  /** Conversations with a turn running (their folder renames wait), and the titles to apply when they end. */
  private readonly running = new Map<string, number>();
  private readonly pendingTitles = new Map<string, string>();
  /** A turn of `conversationId` started: renames of its folder wait until {@link endTurn}. */
  beginTurn(conversationId: string) { this.running.set(conversationId, (this.running.get(conversationId) ?? 0) + 1); }
  /** Is a turn of this conversation running? */
  turnRunning(conversationId: string) { return this.running.has(conversationId); }
  /**
   * A turn ended: commit what the agent changed ("Agent changes in <folder>"),
   * then apply a folder rename that waited for the turn.
   */
  async endTurn(conversationId: string): Promise<void> {
    try { await this.commitAgentChanges(conversationId); }
    finally {
      const left = (this.running.get(conversationId) ?? 1) - 1;
      if (left > 0) this.running.set(conversationId, left); else this.running.delete(conversationId);
      const title = left > 0 ? undefined : this.pendingTitles.get(conversationId);
      if (title !== undefined) await this.retitle(conversationId, title).catch(() => undefined);
    }
  }
  private freeNameExcept(folder: string, name: string, except: string) {
    for (let n = 1; n <= 200; n++) { const candidate = n === 1 ? name : numberedName(name, n); if (!this.existsCaseless(folder, candidate, except)) return candidate; }
    throw new FileInputError('file_exists', 'Too many folders with this name');
  }

  /* ---------------- listing ---------------- */

  /** The tree of visible files and folders (hidden entries and links are left out), at most `maxEntries` entries. */
  tree(maxEntries = 5000): ResourceTree {
    this.prepare();
    const owners = new Map(this.conversations().map(c => [c.path, c.conversationId]));
    let count = 0;
    let truncated = false;
    const walk = (folder: string, depth: number): ResourceNode[] => {
      let entries;
      try { entries = readdirSync(folder ? join(this.files, folder) : this.files, { withFileTypes: true }); } catch { return []; }
      const nodes: ResourceNode[] = [];
      for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))) {
        if (hiddenName(entry.name) || !(entry.isFile() || entry.isDirectory())) continue;
        if (count >= maxEntries) { truncated = true; break; }
        count++;
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        let info: Stats;
        try { info = lstatSync(join(this.files, path)); } catch { continue; }
        if (entry.isDirectory()) {
          const owner = owners.get(path);
          nodes.push({ name: entry.name, path, type: 'folder', modifiedAt: info.mtime.toISOString(), ...(owner ? { conversationId: owner } : {}), children: depth < RESOURCE_LIMITS.maxDepth ? walk(path, depth + 1) : [] });
        } else nodes.push({ name: entry.name, path, type: 'file', bytes: info.size, modifiedAt: info.mtime.toISOString() });
      }
      return nodes;
    };
    const children = walk('', 0);
    const version = createHash('sha256').update(JSON.stringify(children)).digest('hex').slice(0, 20);
    return { children, truncated, version };
  }

  /**
   * Describe a file by content: type, label, size, SHA-256 and line count
   * (PDF page counts once its text was read). Results are cached.
   * @throws {FileInputError} `file_unsupported_type` for files that are not text, PDF or a supported image
   */
  describe(path: string): ResourceFile {
    const clean = splitResourcePath(path).join('/');
    const absolute = this.resolve(clean);
    const info = lstatSync(absolute);
    if (!info.isFile()) throw new FileInputError('file_not_found', `"${clean}" is a folder`);
    const name = baseName(clean);
    const key = `${absolute}\0${info.size}\0${info.mtimeMs}\0${info.ino}`;
    let meta = this.described.get(key);
    if (!meta) {
      if (info.size > this.limits.maxFileBytes) throw new FileInputError('file_too_large', `${name} is larger than ${Math.round(this.limits.maxFileBytes / 1024 / 1024)} MB`);
      const bytes = readRegularFile(absolute, this.limits.maxFileBytes);
      const type = detectFileType(bytes, name);
      const hash = sha256(bytes);
      const pages = type.kind === 'pdf' ? this.cachedPages(hash)?.length : undefined;
      meta = { ...type, bytes: bytes.byteLength, sha256: hash, ...(type.kind === 'text' ? { lines: lineCount(decodeText(bytes)) } : {}), ...(pages !== undefined ? { pages } : {}), createdAt: new Date(info.birthtimeMs || info.mtimeMs).toISOString() };
      if (this.described.size > 5000) this.described.clear();
      this.described.set(key, meta);
    }
    return { ...meta, name, path: clean };
  }
  /** The bytes of a file (not following links), at most `limit` bytes. */
  read(path: string, limit = this.limits.maxFileBytes): Buffer { return readRegularFile(this.resolve(path), limit); }

  /** Text of a PDF's pages, cached by content hash. */
  cachedPages(hash: string): string[] | undefined {
    if (!SHA.test(hash)) return undefined;
    try {
      const pages = JSON.parse(readRegularFile(join(this.cache, `${hash}.text.json`)).toString('utf8')) as unknown;
      return Array.isArray(pages) && pages.every(p => typeof p === 'string') ? pages : undefined;
    } catch { return undefined; }
  }
  /** Remember a PDF's page text (and page count) by content hash. */
  cachePages(hash: string, pages: string[]) {
    if (!SHA.test(hash)) return;
    this.prepare();
    writeReplace(join(this.cache, `${hash}.text.json`), JSON.stringify(pages));
    for (const [key, meta] of this.described) if (meta.sha256 === hash) this.described.set(key, { ...meta, pages: pages.length });
  }

  /* ---------------- user operations (one commit each) ---------------- */

  /**
   * Add a file to a folder under a free name ("report (2).pdf" on collision).
   * Any type is accepted, up to {@link RESOURCE_LIMITS.maxFileBytes}.
   */
  upload(folder: string, name: string, bytes: Uint8Array, message?: string): Promise<{ path: string; commit?: string }> {
    if (bytes.byteLength > RESOURCE_LIMITS.maxFileBytes) return Promise.reject(new FileInputError('file_too_large', `Each file can be up to ${Math.round(RESOURCE_LIMITS.maxFileBytes / 1024 / 1024)} MB`));
    const safe = sanitizeFileName(name);
    return this.change(value => message ?? `Upload ${value.path}`, value => [value.path], () => {
      const directory = this.resolve(folder);
      if (!lstatSync(directory).isDirectory()) throw notFound(folder);
      const parts = splitResourcePath(folder, { allowRoot: true });
      for (let n = 1; n <= 200; n++) {
        const candidate = n === 1 ? safe : numberedName(safe, n);
        if (this.existsCaseless(parts.join('/'), candidate)) continue;
        try { writeNew(directory, join(directory, candidate), bytes); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
        syncDirectory(directory);
        return { path: joinResourcePath(...parts, candidate) };
      }
      throw new FileInputError('file_exists', 'Too many files with this name');
    });
  }
  /** Create a folder (with a `.gitkeep`, so the empty folder is versioned too). */
  createFolder(parent: string, name: string): Promise<{ path: string; commit?: string }> {
    const safe = sanitizeFileName(name, 'New folder');
    return this.change(value => `Create folder ${value.path}`, value => [value.path], () => {
      const parts = splitResourcePath(parent, { allowRoot: true });
      const directory = this.resolve(parent);
      if (!lstatSync(directory).isDirectory()) throw notFound(parent);
      if (this.existsCaseless(parts.join('/'), safe)) throw new FileInputError('file_exists', `"${safe}" already exists here`);
      const path = joinResourcePath(...parts, safe);
      mkdirSync(join(directory, safe), { mode: 0o700 });
      writeFileSync(join(directory, safe, '.gitkeep'), '', { mode: 0o600 });
      return { path };
    });
  }
  /**
   * Rename or move a file or folder to `to` (its full new path; the parent
   * must exist). Conversation folders and attachment links follow it.
   */
  move(from: string, to: string, message?: string): Promise<{ path: string; from: string; commit?: string }> {
    return this.change(value => message ?? (parentOf(value.from) === parentOf(value.path) ? `Rename ${value.from} to ${baseName(value.path)}` : `Move ${value.from} to ${parentOf(value.path) || 'the top level'}`),
      value => [value.from, value.path], () => {
        const source = splitResourcePath(from).join('/');
        const target = splitResourcePath(to).map((part, index, all) => index === all.length - 1 ? sanitizeFileName(part) : part).join('/');
        if (source === target) throw new FileInputError('file_exists', 'Nothing to change');
        if (within(target, source)) throw invalid('A folder cannot be moved into itself');
        const sourcePath = this.resolve(source);
        const targetParent = this.resolve(parentOf(target));
        if (!lstatSync(targetParent).isDirectory()) throw notFound(parentOf(target));
        // Case-only renames are allowed; anything else already there is not replaced.
        const sameEntry = parentOf(source) === parentOf(target) && baseName(source).normalize('NFC').toLowerCase() === baseName(target).normalize('NFC').toLowerCase();
        if (this.existsCaseless(parentOf(target), baseName(target), sameEntry ? baseName(source) : undefined)) throw new FileInputError('file_exists', `"${baseName(target)}" already exists there`);
        renameSync(sourcePath, join(targetParent, baseName(target)));
        syncDirectory(targetParent);
        const state = this.state();
        for (const entry of Object.values(state.folders)) if (within(entry.path, source)) entry.path = target + entry.path.slice(source.length);
        for (const entry of state.attachments) if (within(entry.path, source)) entry.path = target + entry.path.slice(source.length);
        this.save(state);
        this.described.clear();
        return { path: target, from: source };
      });
  }
  /** Delete a file or folder. It stays in the history; {@link restore} brings it back. */
  delete(path: string): Promise<{ path: string; commit?: string }> {
    return this.change(value => `Delete ${value.path}`, value => [value.path], () => {
      const clean = splitResourcePath(path).join('/');
      rmSync(this.resolve(clean), { recursive: true, force: true });
      syncDirectory(join(this.files, parentOf(clean)));
      return { path: clean };
    });
  }
  /** Bring back `path` as it was before `commit` (typically the commit that deleted it). */
  async restore(path: string, commit: string): Promise<{ path: string; commit?: string }> {
    if (!COMMIT.test(commit)) throw invalid('Invalid commit');
    const clean = splitResourcePath(path).join('/');
    await this.init();
    return exclusive(this.directory, async () => {
      if (this.exists(clean)) throw new FileInputError('file_exists', `"${clean}" already exists`);
      const listing = (await this.git(['ls-tree', '-r', '-z', `${commit}^`, '--', clean]).catch(() => Buffer.alloc(0))).toString().split('\0').filter(Boolean);
      const blobs = listing.map(line => /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/s.exec(line)).filter((m): m is RegExpExecArray => !!m && within(m[3]!, clean));
      if (!blobs.length) throw notFound(clean);
      for (const [, mode, blob, file] of blobs) {
        // Every folder on the way must be a plain folder inside the root (created if missing).
        let current = this.prepare();
        for (const part of file!.split('/').slice(0, -1)) {
          current = join(current, part);
          try { const info = lstatSync(current); if (!info.isDirectory() || info.isSymbolicLink()) throw invalid('Cannot restore over a file or link'); }
          catch (error) { if (!missing(error)) throw error; mkdirSync(current, { mode: 0o700 }); }
        }
        const bytes = await this.git(['cat-file', 'blob', blob!]);
        try { writeNew(current, join(this.files, file!), bytes, mode === '100755' ? 0o700 : 0o600); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const done = await this.commitLocked(`Restore ${clean}`, [clean]);
      return { path: clean, ...(done ? { commit: done } : {}) };
    });
  }

  /* ---------------- attachments ---------------- */

  /** Remember where a conversation's attached files are, so links in its messages find them after moves. */
  recordAttachments(conversationId: string, files: readonly { name: string; path: string; sha256: string; bytes: number }[]) {
    if (!files.length) return;
    const state = this.state();
    for (const file of files) {
      state.attachments = state.attachments.filter(e => !(e.conversationId === conversationId && e.name === file.name));
      state.attachments.push({ conversationId, ...file });
    }
    if (state.attachments.length > 50_000) state.attachments = state.attachments.slice(-50_000);
    this.save(state);
  }
  /**
   * Where a file attached to a conversation is now: where it was moved by
   * the user, else in the conversation's folder under its name, else any file
   * with the same content (moved outside the app).
   */
  locateAttachment(conversationId: string, name: string): string | undefined {
    const isFile = (path: string) => { try { return lstatSync(this.resolve(path)).isFile(); } catch { return false; } };
    const entry = this.state().attachments.find(e => e.conversationId === conversationId && e.name === name);
    if (entry && isFile(entry.path)) return entry.path;
    const folder = this.folderOf(conversationId);
    if (folder) { try { const path = joinResourcePath(folder, ...splitResourcePath(name)); if (isFile(path)) return path; } catch { /* not a plain name */ } }
    if (!entry) return undefined;
    // Same content elsewhere: compare sizes first, then hashes, within the visible tree.
    const stack: ResourceNode[] = [...this.tree(20_000).children];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === 'folder') { stack.push(...node.children ?? []); continue; }
      if (node.bytes !== entry.bytes) continue;
      try { if (sha256(this.read(node.path)) === entry.sha256) return node.path; } catch { /* unreadable */ }
    }
    return undefined;
  }

  /* ---------------- migration ---------------- */

  /** Conversations with files in the earlier layout (`<attachments>/<agentId>/<conversationId>/`) that are not moved yet. */
  pendingMigration(legacyRoot: string): string[] {
    const directory = join(legacyRoot, this.agentId);
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return []; }
    return entries.filter(e => e.isDirectory() && CONVERSATION_ID.test(e.name)).map(e => e.name);
  }
  /**
   * Move files from the earlier layout (one folder per conversation ID under
   * `<attachments>/<agentId>/`) into conversation folders named after their
   * titles, then commit them once. Idempotent and resumable: a conversation
   * whose move was interrupted continues where it stopped. Sidecars and the
   * old Python environment are kept aside in `<attachments>/<agentId>/.migrated/`.
   */
  async migrate(legacyRoot: string, titleOf: (conversationId: string) => string | undefined = () => undefined): Promise<number> {
    const pending = this.pendingMigration(legacyRoot);
    if (!pending.length) return 0;
    await this.init();
    return exclusive(this.directory, async () => {
      const legacy = join(legacyRoot, this.agentId);
      let moved = 0;
      for (const conversationId of this.pendingMigration(legacyRoot)) {
        const source = join(legacy, conversationId);
        const info = lstatSync(source);
        if (info.isSymbolicLink() || !info.isDirectory()) continue;
        const folder = this.ensureFolder(conversationId, titleOf(conversationId));
        const target = this.resolve(folder);
        const metas = new Map<string, StoredFile>();
        try { for (const name of readdirSync(join(source, '.meta'))) { try { const meta = JSON.parse(readFileSync(join(source, '.meta', name), 'utf8')) as StoredFile; if (meta?.name && SHA.test(meta.sha256)) metas.set(meta.name, meta); } catch { /* skip */ } } } catch { /* none */ }
        // PDF text cache, by content hash.
        try {
          for (const name of readdirSync(join(source, '.text'))) {
            const hash = name.replace(/\.json$/, '');
            if (!SHA.test(hash) || this.cachedPages(hash)) continue;
            try { const pages = JSON.parse(readFileSync(join(source, '.text', name), 'utf8')) as string[]; if (Array.isArray(pages)) this.cachePages(hash, pages); } catch { /* skip */ }
          }
        } catch { /* none */ }
        const ledger: { name: string; path: string; sha256: string; bytes: number }[] = [];
        for (const entry of readdirSync(source, { withFileTypes: true })) {
          if (['.meta', '.text', '.venv', '.home'].includes(entry.name) || entry.name.startsWith('.tmp-') || entry.isSymbolicLink()) continue;
          let name = entry.name;
          if (existsSync(join(target, name))) name = this.freeName(folder, name);
          renameSync(join(source, entry.name), join(target, name));
          const meta = metas.get(entry.name);
          if (meta && entry.isFile()) {
            ledger.push({ name: entry.name, path: joinResourcePath(folder, name), sha256: meta.sha256, bytes: meta.bytes });
            const time = Date.parse(meta.createdAt);
            if (Number.isFinite(time)) { try { utimesSync(join(target, name), new Date(), new Date(time)); } catch { /* keep */ } }
          }
          moved++;
        }
        this.recordAttachments(conversationId, ledger);
        privateDirectory(join(legacy, '.migrated'));
        renameSync(source, join(legacy, '.migrated', `${conversationId}-${Date.now()}`));
        const state = this.state();
        state.migrated = [...new Set([...state.migrated, conversationId])];
        this.save(state);
      }
      await this.commitLocked('Import attachments from earlier versions');
      return moved;
    });
  }
}

/* ------------------------------------------------------------------ */
/* One conversation's view                                             */
/* ------------------------------------------------------------------ */

/**
 * The files of one conversation: its folder in the agent's
 * {@link ResourceStore}, where attachments are stored and where the file
 * tools look first.
 *
 * A name resolves inside the conversation's folder (`report.pdf`,
 * `data/raw.csv`), or from the resources root when it starts with `/`
 * (`/Trip planning/itinerary.md`; `/workspace/...` as the sandbox shows it
 * works too). Names never leave the root: `..`, hidden names and symlinks
 * are refused, and hard-linked files are not read.
 */
export class AttachmentStore {
  readonly resources: ResourceStore;
  readonly agentId: string;
  readonly conversationId: string;
  readonly limits: Readonly<FileLimits>;
  private readonly title?: string;

  /**
   * @param resources the agent's resources, or the resources root folder (then `agentId` follows).
   */
  constructor(resources: ResourceStore, conversationId: string, options?: { title?: string });
  constructor(root: string, agentId: string, conversationId: string, limits?: Readonly<FileLimits>);
  constructor(first: ResourceStore | string, second: string, third?: string | { title?: string }, fourth?: Readonly<FileLimits>) {
    if (typeof first === 'string') {
      if (!CONVERSATION_ID.test(String(third))) throw invalid('Invalid conversation ID for attachments');
      this.resources = ResourceStore.open(first, second, fourth ?? FILE_LIMITS);
      this.conversationId = third as string;
    } else {
      if (!CONVERSATION_ID.test(second)) throw invalid('Invalid conversation ID for attachments');
      this.resources = first;
      this.conversationId = second;
      this.title = (third as { title?: string } | undefined)?.title;
    }
    this.agentId = this.resources.agentId;
    this.limits = fourth ?? this.resources.limits;
  }

  /** The conversation's folder, from the resources root (created if needed). */
  get path(): string { return this.resources.ensureFolder(this.conversationId, this.title); }
  /** The conversation's folder on disk (created if needed). */
  get directory(): string { return this.resources.resolve(this.path); }
  /** Same as {@link directory}. */
  folder(): string { return this.directory; }

  /**
   * The path from the resources root of a name given by the model or the user.
   * @throws {FileInputError} `file_name_invalid`
   */
  resolvePath(name: unknown): string {
    if (typeof name !== 'string' || !name.trim()) throw invalid('Use a file name as list_files shows it');
    let value = name.trim();
    if (value === '/workspace' || value.startsWith('/workspace/')) value = value.slice('/workspace'.length) || '/';
    return value.startsWith('/') ? splitResourcePath(value, { allowRoot: true }).join('/') : joinResourcePath(this.path, ...splitResourcePath(value));
  }
  /** How to name a path for the model: relative inside this conversation's folder, else from the root with a leading `/`. */
  display(path: string, fromRoot = false): string {
    const folder = this.path;
    return !fromRoot && within(path, folder) && path !== folder ? path.slice(folder.length + 1) : `/${path}`;
  }

  /** Readable files (text, PDF, images) under `folder` (default: this conversation's), named by {@link display}, by path. */
  list(folder?: string): StoredFile[] { return this.scan(folder).files; }
  /** Readable files plus the names of other files under a folder. */
  scan(folder?: string): { files: (StoredFile & { path: string })[]; others: string[]; truncated: boolean } {
    const base = folder === undefined ? this.path : this.resolvePath(folder);
    const fromRoot = base !== this.path;
    const files: (StoredFile & { path: string })[] = [];
    const others: string[] = [];
    let truncated = false;
    const stack = [base];
    let seen = 0;
    while (stack.length) {
      const current = stack.shift()!;
      let entries;
      try { entries = readdirSync(this.resources.resolve(current), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
        if (hiddenName(entry.name)) continue;
        const path = current ? `${current}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { stack.push(path); continue; }
        if (!entry.isFile()) continue;
        if (++seen > RESOURCE_LIMITS.maxEntries) { truncated = true; stack.length = 0; break; }
        try { files.push({ ...this.resources.describe(path), name: this.display(path, fromRoot) }); }
        catch { others.push(this.display(path, fromRoot)); }
      }
    }
    return { files, others, truncated };
  }
  /** Metadata of one file. @throws {FileInputError} `file_not_found` or `file_name_invalid` */
  get(name: unknown): StoredFile & { path: string } {
    const path = this.resolvePath(name);
    let file: ResourceFile;
    try { file = this.resources.describe(path); }
    catch (error) {
      if (error instanceof FileInputError && error.code === 'file_not_found') throw new FileInputError('file_not_found', `No file named "${String(name)}"`);
      throw error;
    }
    return { ...file, name: this.display(path) };
  }
  /** The bytes of one file. */
  read(name: unknown): { file: StoredFile & { path: string }; bytes: Buffer } {
    const file = this.get(name);
    return { file, bytes: this.resources.read(file.path) };
  }
  /**
   * Readable content: the text of a text file, or one string per PDF page
   * (empty for pages without a text layer). PDF text is cached by content hash.
   * @throws {FileInputError}
   */
  async content(name: unknown, signal?: AbortSignal): Promise<{ file: StoredFile; text: string } | { file: StoredFile; pages: string[] }> {
    const { file, bytes } = this.read(name);
    if (file.kind === 'text') return { file, text: decodeText(bytes) };
    if (file.kind !== 'pdf') throw new FileInputError('file_unsupported_type', `${file.name} is an image; it has no text to read`);
    const cached = this.resources.cachedPages(file.sha256);
    if (cached) return { file: { ...file, pages: cached.length }, pages: cached };
    const prepared = await prepareFile(baseName(file.path), bytes, { signal, limits: this.limits });
    this.resources.cachePages(file.sha256, prepared.pages ?? []);
    return { file: { ...file, pages: prepared.pages?.length ?? 0 }, pages: prepared.pages ?? [] };
  }

  private budget(adding: readonly { bytes: number }[], existing: readonly StoredFile[]) {
    if (existing.length + adding.length > this.limits.maxConversationFiles) throw new FileInputError('conversation_files_full', `A conversation can keep up to ${this.limits.maxConversationFiles} files`);
    const total = existing.reduce((sum, f) => sum + f.bytes, 0) + adding.reduce((sum, f) => sum + f.bytes, 0);
    if (total > this.limits.maxConversationBytes) throw new FileInputError('conversation_files_full', `A conversation's files can total up to ${Math.round(this.limits.maxConversationBytes / 1024 / 1024)} MB`);
  }
  /** Top-level files of the folder, the attachment budget's scope. */
  private attached(): StoredFile[] { return this.list().filter(f => !f.name.includes('/')); }

  /**
   * Store validated files in the conversation's folder (as one commit): all
   * are checked against the conversation's limits first. An identical file
   * already there under the same name (or a numbered variant) is reused.
   * @throws {FileInputError}
   */
  async store(files: readonly PreparedFile[]): Promise<StoredFile[]> {
    if (!files.length) return [];
    await this.resources.init();
    const existing = this.attached();
    const same = (p: PreparedFile, list: readonly StoredFile[]) => list.find(f => f.sha256 === p.sha256 && (f.name === p.name || Array.from({ length: 98 }, (_, i) => numberedName(p.name, i + 2)).includes(f.name)));
    this.budget(files.filter(p => !same(p, existing)).map(p => ({ bytes: p.bytes.byteLength })), existing);
    const stored: StoredFile[] = [];
    const ledger: { name: string; path: string; sha256: string; bytes: number }[] = [];
    for (const p of files) {
      const reuse = same(p, [...existing, ...stored]);
      if (reuse) { stored.push(reuse); ledger.push({ name: reuse.name, path: joinResourcePath(this.path, reuse.name), sha256: reuse.sha256, bytes: reuse.bytes }); continue; }
      const { path } = await this.resources.upload(this.path, p.name, p.bytes, `Attach ${p.name} in ${this.path}`);
      if (p.pages) this.resources.cachePages(p.sha256, p.pages);
      const file: StoredFile = { ...metadataOf(p, baseName(path)) };
      stored.push(file);
      ledger.push({ name: file.name, path, sha256: p.sha256, bytes: file.bytes });
    }
    this.resources.recordAttachments(this.conversationId, ledger);
    return stored;
  }
  /** Validate and store files (see {@link prepareFile} and {@link store}). */
  async save(files: readonly { name: string; bytes: Uint8Array }[], options: { signal?: AbortSignal } = {}): Promise<StoredFile[]> {
    const prepared: PreparedFile[] = [];
    for (const file of files) prepared.push(await prepareFile(file.name, file.bytes, { ...options, limits: this.limits }));
    return this.store(prepared);
  }
}
