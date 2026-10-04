import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, join, relative, isAbsolute, sep } from 'node:path';
import { detectFileType } from 'ai-sdk-letta';
import { RuntimeFault } from './runtime.js';

/**
 * Read-only view of an agent's project folder (the one mounted at `/project`
 * in its sandbox), for the Resources panel: one directory at a time, a file's
 * bytes for preview and download. Nothing here writes to the folder or its
 * repository; git runs only read-only commands, without optional locks (so
 * not even the index is refreshed on disk), hooks or fsmonitor.
 *
 * Hidden: `.git`, `node_modules`, and what the project's `.gitignore` ignores
 * (asked of git itself when the folder is a repository; files git tracks stay
 * visible). Outside a repository, {@link PROJECT_DEFAULT_IGNORES} are hidden.
 *
 * Every path is resolved inside the folder's real path; anything that
 * resolves outside it (a `..`, or a symlink pointing elsewhere) is refused
 * with `project_outside` (403).
 */
export class ProjectFolder {
  /** The name shown (the last segment of the path as given: `blog`). */
  readonly name: string;
  private statusCache?: { at: number; value: Promise<GitStatus | undefined> };
  constructor(readonly path: string, private readonly options: { gitTimeoutMs?: number } = {}) {
    this.name = basename(path) || path;
  }

  /** The folder's real path; `project_unavailable` (404) if it is gone or not a folder. */
  private root(): string {
    let real: string;
    try { real = realpathSync(this.path); } catch { throw new RuntimeFault('project_unavailable', 404); }
    try { if (!statSync(real).isDirectory()) throw new Error('not a folder'); } catch { throw new RuntimeFault('project_unavailable', 404); }
    return real;
  }
  /** Whether git manages the folder (a `.git` folder at its top). */
  private isRepository(root: string) { try { return lstatSync(join(root, '.git')).isDirectory(); } catch { return false; } }

  /**
   * One directory (`path` from the project's top, `''` for the top): its
   * visible entries, folders first, `limit` of them from `offset`. Each has
   * its git status when the folder is a repository (`status`: a file's own,
   * `'changed'` for a folder holding changes). A symlink that points outside
   * the project is listed with `link: 'outside'` and nothing about its target.
   */
  async list(path: unknown, offset = 0, limit: number = PROJECT_LIMITS.pageSize): Promise<ProjectListing> {
    const parts = projectPath(path, true);
    const root = this.root();
    const git = this.isRepository(root);
    const directory = this.inside(root, parts);
    let info;
    try { info = statSync(directory); } catch { throw new RuntimeFault('file_not_found', 404); }
    if (!info.isDirectory()) throw new RuntimeFault('file_not_found', 404);
    if (parts.length && await this.hiddenAt(root, git, parts, directory)) throw new RuntimeFault('file_not_found', 404);
    let dirents: Dirent[];
    try { dirents = readdirSync(directory, { withFileTypes: true }); } catch { throw new RuntimeFault('file_not_found', 404); }
    const prefix = parts.length ? `${parts.join('/')}/` : '';
    let names = dirents.filter(d => !ALWAYS_HIDDEN.has(d.name) && (git || !PROJECT_DEFAULT_IGNORES.includes(d.name)));
    const truncated = names.length > PROJECT_LIMITS.maxScanned;
    if (truncated) names = names.sort((a, b) => a.name.localeCompare(b.name)).slice(0, PROJECT_LIMITS.maxScanned);
    // Git status is a hint: a listing never waits long for it.
    const [ignored, status] = git ? await Promise.all([this.ignored(root, names.map(d => ({ path: `${prefix}${d.name}`, folder: d.isDirectory() }))), Promise.race([this.status(root), delay(PROJECT_LIMITS.statusWaitMs)])]) : [new Set<string>(), undefined];
    type Row = { dirent: Dirent; folder: boolean; outside?: boolean };
    const rows: Row[] = [];
    for (const dirent of names) {
      if (ignored.has(`${prefix}${dirent.name}`)) continue;
      if (dirent.isSymbolicLink()) {
        // Only a link that stays inside the project is followed (for its type).
        let target: string | undefined;
        try { target = realpathSync(join(directory, dirent.name)); } catch { target = undefined; }
        if (!target || !within(target, root)) { rows.push({ dirent, folder: false, outside: true }); continue; }
        // A link to a hidden place (`.git`, `node_modules`) is hidden too.
        if (relative(root, target).split(sep).some(part => ALWAYS_HIDDEN.has(part))) continue;
        let folder = false;
        try { folder = statSync(target).isDirectory(); } catch { continue; }
        rows.push({ dirent, folder });
      } else if (dirent.isDirectory() || dirent.isFile()) rows.push({ dirent, folder: dirent.isDirectory() });
    }
    rows.sort((a, b) => Number(b.folder) - Number(a.folder) || a.dirent.name.localeCompare(b.dirent.name, undefined, { numeric: true, sensitivity: 'base' }));
    const start = Math.max(0, Math.floor(offset) || 0);
    const count = Math.min(PROJECT_LIMITS.maxPageSize, Math.max(1, Math.floor(limit) || PROJECT_LIMITS.pageSize));
    const page = rows.slice(start, start + count);
    const entries: ProjectEntry[] = page.map(({ dirent, folder, outside }) => {
      const entryPath = `${prefix}${dirent.name}`;
      if (outside) return { name: dirent.name, path: entryPath, type: 'file', link: 'outside' };
      let stats;
      try { stats = statSync(join(directory, dirent.name)); } catch { stats = undefined; }
      const state = status?.of(entryPath, folder);
      return { name: dirent.name, path: entryPath, type: folder ? 'folder' : 'file', ...(!folder && stats ? { bytes: stats.size } : {}), ...(stats ? { modifiedAt: stats.mtime.toISOString() } : {}),
        ...(dirent.isSymbolicLink() ? { link: 'inside' as const } : {}), ...(state ? { status: state } : {}) };
    });
    return { name: this.name, git, path: parts.join('/'), entries, offset: start, total: rows.length, more: start + page.length < rows.length, ...(truncated ? { truncated: true } : {}), ...(status && !parts.length ? { changes: status.count } : {}) };
  }

  /**
   * A file's bytes (at most `limit`), its name and its type by content
   * (`other` when it is not text, a PDF or a supported image). The same rules
   * as the listing: a hidden or ignored path is not found, a path that
   * resolves outside the project is refused.
   */
  async read(path: unknown, limit: number): Promise<{ name: string; kind: 'text' | 'pdf' | 'image' | 'other'; mediaType: string; bytes: Buffer }> {
    const parts = projectPath(path, false);
    const root = this.root();
    const file = this.inside(root, parts);
    if (await this.hiddenAt(root, this.isRepository(root), parts, file)) throw new RuntimeFault('file_not_found', 404);
    let fd: number;
    // The resolved path has no links left; one appearing now is refused.
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; throw code === 'ELOOP' ? new RuntimeFault('project_outside', 403) : new RuntimeFault('file_not_found', 404); }
    let bytes: Buffer;
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw new RuntimeFault('file_not_found', 404);
      if (info.size > limit) throw new RuntimeFault('file_too_large', 413);
      bytes = readFileSync(fd);
    } finally { closeSync(fd); }
    const name = parts.at(-1)!;
    let kind: 'text' | 'pdf' | 'image' | 'other' = 'other';
    let mediaType = 'application/octet-stream';
    try { const type = detectFileType(bytes, name); kind = type.kind; mediaType = type.mediaType; } catch { /* not a supported type: downloads only */ }
    return { name, kind, mediaType, bytes };
  }

  /**
   * The real path of `parts` under `root`, which must stay inside it.
   * @throws `file_not_found` (404) or `project_outside` (403)
   */
  private inside(root: string, parts: readonly string[]): string {
    if (!parts.length) return root;
    let real: string;
    try { real = realpathSync(join(root, ...parts)); } catch {
      // A dangling link, or a missing file: tell them apart only when the parent resolves inside.
      throw new RuntimeFault('file_not_found', 404);
    }
    if (!within(real, root)) throw new RuntimeFault('project_outside', 403);
    return real;
  }

  /** Is a path hidden, by the path asked for or by where it really is (a link inside the project to `.git` is hidden too)? */
  private async hiddenAt(root: string, git: boolean, parts: readonly string[], real: string): Promise<boolean> {
    const logical = parts.join('/');
    const actual = relative(root, real).split(sep).join('/');
    return await this.hidden(root, git, logical) || (actual !== logical && actual !== '' && await this.hidden(root, git, actual));
  }
  /** Is `path` hidden: under `.git` or `node_modules`, a default ignore outside a repository, or ignored by git (and not tracked)? */
  private async hidden(root: string, git: boolean, path: string): Promise<boolean> {
    const parts = path.split('/');
    if (parts.some(part => ALWAYS_HIDDEN.has(part))) return true;
    if (!git) return parts.some(part => PROJECT_DEFAULT_IGNORES.includes(part));
    // Each ancestor too: a file under an ignored folder is ignored unless git tracks it.
    const candidates = parts.map((_, i) => ({ path: parts.slice(0, i + 1).join('/'), folder: i < parts.length - 1 }));
    const ignored = await this.ignored(root, candidates);
    return ignored.size > 0;
  }

  /**
   * Which of `paths` git ignores. A folder git ignores is still shown when it
   * holds tracked files (git's own check reports such a folder as ignored).
   */
  private async ignored(root: string, paths: readonly { path: string; folder: boolean }[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    let out: string;
    // Exit status 1 means "none ignored".
    try { out = await this.git(root, ['check-ignore', '--stdin', '-z'], paths.map(p => `${p.path}\0`).join('')); }
    catch (error) {
      if ((error as { code?: unknown }).code === 1) return new Set();
      // Git unavailable or refusing the repository: the default list applies.
      return new Set(paths.filter(p => p.path.split('/').some(part => PROJECT_DEFAULT_IGNORES.includes(part))).map(p => p.path));
    }
    const ignored = new Set(out.split('\0').filter(Boolean));
    const folders = paths.filter(p => p.folder && ignored.has(p.path)).map(p => p.path);
    if (folders.length) {
      try {
        const tracked = (await this.git(root, ['ls-files', '-z', '--', ...folders.map(f => `:(literal)${f}/`)])).split('\0').filter(Boolean);
        for (const folder of folders) if (tracked.some(file => file.startsWith(`${folder}/`))) ignored.delete(folder);
      } catch { /* keep them hidden */ }
    }
    return ignored;
  }

  /** `git status` of the repository, briefly cached (several folders are listed at once). Undefined when git fails or is slow. */
  private status(root: string): Promise<GitStatus | undefined> {
    const now = Date.now();
    if (this.statusCache && now - this.statusCache.at < PROJECT_LIMITS.statusCacheMs) return this.statusCache.value;
    const value = this.git(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=normal', '--ignore-submodules=all'])
      .then(out => parseStatus(out), () => undefined);
    this.statusCache = { at: now, value };
    return value;
  }

  /** Run a read-only git command in the project: no optional locks, hooks, fsmonitor, global or system config, or prompts. */
  private git(root: string, args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-C', root, ...args], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: this.options.gitTimeoutMs ?? PROJECT_LIMITS.gitTimeoutMs,
      }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
      child.stdin?.on('error', () => { /* git exited early */ });
      child.stdin?.end(input ?? '');
    });
  }
}

/** One entry of a project listing. */
export type ProjectEntry = {
  name: string; path: string; type: 'file' | 'folder'; bytes?: number; modifiedAt?: string;
  /** A symlink: `inside` (followed) or `outside` the project (never followed or described). */
  link?: 'inside' | 'outside';
  /** Git status: a file's own; `changed` for a folder holding changes. */
  status?: ProjectStatus;
};
export type ProjectStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'changed';
/** `GET /v1/project/list`: one page of one directory. `changes`: how many paths git reports changed (top level only). */
export type ProjectListing = { name: string; git: boolean; path: string; entries: ProjectEntry[]; offset: number; total: number; more: boolean; truncated?: boolean; changes?: number };

export const PROJECT_LIMITS = Object.freeze({
  /** Entries per page of a directory. */
  pageSize: 200,
  /** Most entries one request may ask for. */
  maxPageSize: 1000,
  /** Most entries of one directory considered (the rest are not listed). */
  maxScanned: 20_000,
  /** Longest path accepted, in characters. */
  maxPathChars: 4096,
  /** Deepest path accepted. */
  maxDepth: 64,
  /** Git commands give up after this long (status is then left out). */
  gitTimeoutMs: 10_000,
  /** How long a listing waits for git status before answering without it (it is used once ready). */
  statusWaitMs: 1500,
  /** How long one `git status` answers listings. */
  statusCacheMs: 1500,
});
/** Never shown, read or listed, git or not. */
const ALWAYS_HIDDEN = new Set(['.git', 'node_modules']);
/** Hidden in a folder that is not a git repository (one that is uses its `.gitignore`). */
export const PROJECT_DEFAULT_IGNORES: readonly string[] = Object.freeze(['.DS_Store', 'Thumbs.db', '__pycache__', '.venv', 'venv', '.cache', '.next', '.turbo', '.parcel-cache', 'dist', 'build', 'target', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', 'coverage']);

/**
 * Split a project path (from its top, `/`-separated) into names. Every name
 * must be non-empty, not `.` or `..`, and free of NUL and control characters.
 * @throws `file_name_invalid` (400)
 */
export function projectPath(path: unknown, allowRoot: boolean): string[] {
  if (typeof path !== 'string' || path.length > PROJECT_LIMITS.maxPathChars) throw new RuntimeFault('file_name_invalid', 400);
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) { if (allowRoot) return []; throw new RuntimeFault('file_name_invalid', 400); }
  const parts = trimmed.split('/');
  if (parts.length > PROJECT_LIMITS.maxDepth) throw new RuntimeFault('file_name_invalid', 400);
  for (const part of parts) if (!part || part === '.' || part === '..' || /[\0-\x1f\x7f\\]/.test(part)) throw new RuntimeFault('file_name_invalid', 400);
  return parts;
}
const delay = (ms: number) => new Promise<undefined>(resolve => { const timer = setTimeout(() => resolve(undefined), ms); timer.unref?.(); });
const within = (child: string, parent: string) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };

type GitStatus = { count: number; of(path: string, folder: boolean): ProjectStatus | undefined };
/** Parse `git status --porcelain=v1 -z --no-renames`. */
export function parseStatus(out: string): GitStatus {
  const files = new Map<string, ProjectStatus>();
  const untrackedFolders: string[] = [];
  for (const record of out.split('\0')) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code === '??') { if (path.endsWith('/')) untrackedFolders.push(path.slice(0, -1)); else files.set(path, 'untracked'); continue; }
    if (code === '!!') continue;
    files.set(path, code.includes('D') ? 'deleted' : code[0] === 'A' ? 'added' : 'modified');
  }
  const folders = new Set<string>();
  for (const path of [...files.keys(), ...untrackedFolders]) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/')); }
  return {
    count: files.size + untrackedFolders.length,
    of(path, folder) {
      // Everything in a new (untracked) folder is untracked.
      if (untrackedFolders.some(f => path === f || path.startsWith(`${f}/`))) return 'untracked';
      return folder ? (folders.has(path) ? 'changed' : undefined) : files.get(path);
    },
  };
}
