import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { tool, jsonSchema, type Experimental_SandboxSession, type Tool } from 'ai';
import type { ToolPermission } from './definition.js';
import { COMMAND_PROGRESS, commandJob, type CommandJob, type CommandOutputChunk } from './command-progress.js';
import { BACKGROUND_LIMITS, BACKGROUND_MARK, BackgroundCommands, backgroundScript, type BackgroundRecord } from './background.js';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Names of the built-in sandbox tools. */
export const SANDBOX_TOOL_NAMES = ['run_command', 'run_command_online', 'command_status', 'command_output', 'command_stop'] as const;
export type SandboxToolName = typeof SANDBOX_TOOL_NAMES[number];

/**
 * Key under which the tool bridge passes the conversation's
 * {@link SandboxManager} to tools (`options.context[SANDBOX_CONTEXT]`).
 * Like the attachment folder, it is bound by the runtime, never by the model.
 */
export const SANDBOX_CONTEXT = 'ai-sdk-letta.sandbox';

/** Where things are inside the sandbox. */
export const SANDBOX_PATHS = Object.freeze({
  /** All of the agent's resources (one folder per conversation), read-write. Commands start in the conversation's folder. */
  workspace: '/workspace',
  /** The optional project folder. */
  project: '/project',
  /** Python virtual environment, shared by all conversations: packages installed with pip persist here (not versioned). */
  venv: '/workspace/.venv',
  /** `HOME` for commands (caches, shell history), also in the workspace. */
  home: '/workspace/.home',
});

/** Bounds for commands and what they return to the model. */
export const SANDBOX_LIMITS = Object.freeze({
  /** Most characters of stdout and stderr combined in one result (head and tail are kept). */
  maxOutputChars: 14_000,
  /** Bytes read from the start and from the end of each stream inside the sandbox. */
  captureBytes: 32 * 1024,
  /** Longest command. */
  maxCommandChars: 8_000,
  /** Default and largest per-command timeout (the Letta harness ends an application tool call after 5 minutes; the rest is left to start the sandbox and report). Configurable per agent: `sandbox.timeoutMs`. */
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 240_000,
  /** Default idle time before the conversation's sandbox is stopped. */
  defaultIdleMs: 10 * 60_000,
});

/**
 * Pinned base image plus a one-time setup step. The image is built once per
 * machine and cached under a tag derived from this text. `procps` provides
 * `ps`; everything else is what the tool description promises.
 */
export const SANDBOX_DOCKERFILE = `FROM docker.io/library/python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git ripgrep jq poppler-utils curl ca-certificates procps \\
 && rm -rf /var/lib/apt/lists/*
`;
/** Tag of the default image (changes when {@link SANDBOX_DOCKERFILE} changes). */
export const SANDBOX_IMAGE = `ai-sdk-letta-sandbox:${createHash('sha256').update(SANDBOX_DOCKERFILE).digest('hex').slice(0, 12)}`;
/**
 * The opt-in web development image: {@link SANDBOX_DOCKERFILE} plus Node 22
 * (pinned by digest), Debian's Chromium, fonts and chrome-devtools-mcp
 * (pinned), with its usage statistics and update checks off. About 400 MB
 * compressed, 1.5 GB on disk.
 * Agents with the web development tools use it by default (see `webDevTools`).
 */
export const WEBDEV_DOCKERFILE = `FROM docker.io/library/node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS node
FROM docker.io/library/python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git ripgrep jq poppler-utils curl ca-certificates procps \\
    chromium fonts-liberation fonts-noto-color-emoji \\
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \\
 && npm install -g --no-fund --no-audit --no-update-notifier chrome-devtools-mcp@1.10.1 && npm cache clean --force
ENV CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1 CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 NPM_CONFIG_UPDATE_NOTIFIER=false
`;
/** Tag of the web development image (changes when {@link WEBDEV_DOCKERFILE} changes). */
export const WEBDEV_IMAGE = `ai-sdk-letta-webdev:${createHash('sha256').update(WEBDEV_DOCKERFILE).digest('hex').slice(0, 12)}`;
/**
 * The slim runtime of MCP App servers (see `mcpApps`): Python 3.12 and Node
 * 22 (both pinned by digest), nothing else (no Chromium, no compilers). Built
 * from the same base images as the sandbox, without a package manager step.
 */
export const MCP_APPS_DOCKERFILE = `FROM docker.io/library/node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS node
FROM docker.io/library/python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1 HOME=/tmp
`;
/** Tag of the MCP App runtime image (changes when {@link MCP_APPS_DOCKERFILE} changes). */
export const MCP_APPS_IMAGE = `ai-sdk-letta-mcp-apps:${createHash('sha256').update(MCP_APPS_DOCKERFILE).digest('hex').slice(0, 12)}`;
/** Images this package builds itself (instead of pulling), by tag. */
const BUILT_IMAGES: Readonly<Record<string, string>> = { [SANDBOX_IMAGE]: SANDBOX_DOCKERFILE, [WEBDEV_IMAGE]: WEBDEV_DOCKERFILE, [MCP_APPS_IMAGE]: MCP_APPS_DOCKERFILE };
/** Label on every container this package creates; stale ones are removed at startup. */
export const SANDBOX_LABEL = 'ai-sdk-letta.sandbox';

/** A host folder to mount into the sandbox. */
export interface SandboxMount { hostPath: string; containerPath: string; readOnly?: boolean }

/** What a custom provider is asked to create. */
export interface SandboxRequest {
  /** True only for the short-lived sandbox of an approved `run_command_online` call. */
  network: boolean;
  /** Folders to mount, in order (nested read-only mounts come after their parent). */
  mounts: readonly SandboxMount[];
  /** Labels to put on the container, if the provider supports them. */
  labels: Readonly<Record<string, string>>;
  /** Image to use, when the provider runs images. */
  image: string;
  signal?: AbortSignal;
}
/** A created sandbox: the AI SDK session plus a way to stop it. */
export interface SandboxHandle { session: Experimental_SandboxSession; stop(): Promise<void> }
/** Creates sandboxes for a custom provider. It must honour `network: false` (no network at all). */
export type SandboxFactory = (request: SandboxRequest) => Promise<SandboxHandle>;
/** Built-in providers (optional peer dependencies). */
export type SandboxProviderName = 'apple-container' | 'docker';

/** `sandbox` option of a definition. */
export interface SandboxConfig {
  /**
   * `'apple-container'` (`@lgrammel/apple-container-sandbox`, macOS 26 on
   * Apple silicon), `'docker'` (`ai-sdk-sandbox-docker`), or a factory that
   * returns any AI SDK `Experimental_SandboxSession`.
   */
  provider: SandboxProviderName | SandboxFactory;
  /**
   * An optional host folder mounted at `/project`. It is refused if it holds
   * credentials (see {@link checkProjectFolder}). Commands can change it,
   * except `.git/hooks`, and `.git/config` is restored if a command changes it.
   */
  project?: string | { path: string; readOnly?: boolean };
  /** Image for the built-in providers. @default {@link SANDBOX_IMAGE}, built from {@link SANDBOX_DOCKERFILE} */
  image?: string;
  /**
   * Per-command timeout: a command still running then is stopped (with what
   * it started) and the agent gets its output so far. Raise it for long
   * builds (a full static site build, a test suite). At most 240000: the
   * Letta harness ends any application tool call after 5 minutes, and the
   * sandbox may need time to start. Longer work belongs in several
   * commands. @default 120000
   */
  timeoutMs?: number;
  /** Stop the conversation's sandbox after this long without commands (never while a background command runs). @default 600000 */
  idleTimeoutMs?: number;
  /** Wall-clock limit of one background command (`run_command` with `background: true`), at most 48 hours. @default 21600000 (6 hours) */
  backgroundTimeoutMs?: number;
  /** Identity for git commits made in the sandbox. @default { name: 'Sandbox', email: 'sandbox@localhost' } */
  git?: { name: string; email: string };
  /** Memory for the built-in providers (e.g. `'2G'`). @default '2G' */
  memory?: string;
  /** CPUs for the built-in providers. @default 2 */
  cpus?: number;
  /** Path of the `docker` or `container` CLI. @default 'docker' or 'container' */
  binary?: string;
}
/** A validated sandbox configuration. */
export interface ResolvedSandboxConfig {
  readonly provider: SandboxProviderName | SandboxFactory;
  readonly project?: { readonly path: string; readonly readOnly: boolean };
  readonly image: string;
  readonly timeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly backgroundTimeoutMs: number;
  readonly git: { readonly name: string; readonly email: string };
  readonly memory: string;
  readonly cpus: number;
  readonly binary?: string;
}

/** Machine-readable reason for {@link SandboxError}. */
export type SandboxErrorCode =
  | 'sandbox_config_invalid' // the definition's sandbox option is malformed
  | 'sandbox_unavailable' // no sandbox is configured, or the provider failed to start
  | 'project_has_credentials' // the project's git config holds credentials
  | 'project_unsafe' // the project folder is a home directory, a root, or otherwise unsuitable
  | 'command_invalid' // empty or too long
  | 'cwd_invalid' // a working directory outside the workspace
  | 'cwd_not_found'; // a working directory that does not exist

/** A sandbox failure. `code` is stable; `message` is human-readable. */
export class SandboxError extends Error {
  override readonly name = 'SandboxError';
  constructor(readonly code: SandboxErrorCode, message: string) { super(message); }
}

const PROVIDERS: readonly string[] = ['apple-container', 'docker'];
const MOUNT_UNSAFE = /[,=\n\r\0]/;

/**
 * Validate and freeze a sandbox configuration (called by `defineAgent`).
 * @throws {SandboxError} `sandbox_config_invalid`
 */
export function resolveSandboxConfig(input: SandboxConfig): ResolvedSandboxConfig {
  const bad = (message: string) => new SandboxError('sandbox_config_invalid', `sandbox: ${message}`);
  if (!input || typeof input !== 'object') throw bad('expected an object');
  if (typeof input.provider !== 'function' && !PROVIDERS.includes(input.provider)) throw bad('provider must be "apple-container", "docker" or a factory function');
  const timeoutMs = input.timeoutMs ?? SANDBOX_LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > SANDBOX_LIMITS.maxTimeoutMs) throw bad(`timeoutMs must be 1000–${SANDBOX_LIMITS.maxTimeoutMs}`);
  const idleTimeoutMs = input.idleTimeoutMs ?? SANDBOX_LIMITS.defaultIdleMs;
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > 24 * 3600_000) throw bad('idleTimeoutMs must be 1000 ms to 24 hours');
  const backgroundTimeoutMs = input.backgroundTimeoutMs ?? BACKGROUND_LIMITS.defaultLimitMs;
  if (!Number.isInteger(backgroundTimeoutMs) || backgroundTimeoutMs < 1000 || backgroundTimeoutMs > BACKGROUND_LIMITS.maxLimitMs) throw bad('backgroundTimeoutMs must be 1000 ms to 48 hours');
  const git = input.git ?? { name: 'Sandbox', email: 'sandbox@localhost' };
  const plain = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0-\x1f<>]/.test(value);
  if (!plain(git.name, 100) || !plain(git.email, 200) || !/^[^@\s]+@[^@\s]+$/.test(git.email)) throw bad('git must be { name, email } with a plain name and an email address');
  const memory = input.memory ?? '2G';
  if (!/^\d{1,6}[KMG]?$/i.test(memory)) throw bad('memory must look like "2G" or "512M"');
  const cpus = input.cpus ?? 2;
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 64) throw bad('cpus must be 1–64');
  const image = input.image ?? SANDBOX_IMAGE;
  if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(image)) throw bad('image is not a valid image reference');
  if (input.binary !== undefined && (typeof input.binary !== 'string' || !input.binary.trim())) throw bad('binary must be a path');
  let project: ResolvedSandboxConfig['project'];
  if (input.project !== undefined) {
    const spec = typeof input.project === 'string' ? { path: input.project } : input.project;
    if (!spec || typeof spec.path !== 'string' || !isAbsolute(spec.path)) throw bad('project must be an absolute path');
    if (MOUNT_UNSAFE.test(spec.path)) throw bad('project path must not contain commas, equal signs or control characters');
    project = Object.freeze({ path: resolve(spec.path), readOnly: spec.readOnly === true });
  }
  return Object.freeze({ provider: input.provider, ...(project ? { project } : {}), image, timeoutMs, idleTimeoutMs, backgroundTimeoutMs, git: Object.freeze({ name: git.name.trim(), email: git.email.trim() }), memory, cpus, ...(input.binary ? { binary: input.binary } : {}) });
}

/* ------------------------------------------------------------------ */
/* Project folder safety                                               */
/* ------------------------------------------------------------------ */

/** Minimal git-config reader: `[section "sub"]` headers and `key = value` lines, lowercased keys. */
function gitConfigEntries(text: string): { section: string; key: string; value: string }[] {
  const entries: { section: string; key: string; value: string }[] = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/.exec(line);
    if (header) {
      // "[section.sub]" is the legacy form of '[section "sub"]'.
      const [name, legacy] = header[1]!.split(/\.(.*)/s);
      section = `${name!.toLowerCase()}${header[2] !== undefined ? ` "${header[2]}"` : legacy ? ` "${legacy}"` : ''}`;
      const rest = header[3]!.trim();
      if (!rest) continue;
      const inline = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(rest);
      if (inline) entries.push({ section, key: inline[1]!.toLowerCase(), value: (inline[2] ?? 'true').replace(/^"(.*)"$/, '$1') });
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (entry) entries.push({ section, key: entry[1]!.toLowerCase(), value: (entry[2] ?? 'true').replace(/\s+[#;].*$/, '').replace(/^"(.*)"$/, '$1') });
  }
  return entries;
}

/** Does a git URL carry credentials? http(s) and similar: any user info. ssh: a password. */
function urlHasCredentials(value: string): boolean {
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(value.trim());
  if (!url) return false; // scp-like "git@host:path" names a user, never a secret
  const scheme = url[1]!.toLowerCase();
  const authority = url[2]!;
  const at = authority.lastIndexOf('@');
  if (at < 0) return false;
  const userinfo = authority.slice(0, at);
  if (scheme === 'ssh' || scheme === 'git+ssh' || scheme === 'ssh+git') return userinfo.includes(':');
  return userinfo.length > 0;
}

/**
 * Why a git config would expose credentials to the sandbox, if it does:
 * remote (or `insteadOf`) URLs with user info, any `credential` setting,
 * `http.extraHeader`, or includes that cannot be checked. Empty if none.
 */
export function gitConfigCredentials(text: string): string[] {
  const reasons: string[] = [];
  for (const { section, key, value } of gitConfigEntries(text)) {
    const name = section.split(' ')[0]!;
    if ((key === 'url' || key === 'pushurl') && urlHasCredentials(value)) reasons.push(`${section} ${key} contains credentials`);
    else if (name === 'url' && urlHasCredentials(section.slice(5, -1))) reasons.push(`${section} rewrites to a URL with credentials`);
    else if (name === 'credential') reasons.push(`a credential setting (${section} ${key})`);
    else if (name === 'http' && key === 'extraheader') reasons.push(`${section} extraHeader (often an access token)`);
    else if (name === 'include' || name === 'includeif') reasons.push(`an include (${section}), which cannot be checked`);
  }
  return [...new Set(reasons)];
}

const SAFE_CORE_KEYS = new Set(['repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'ignorecase', 'precomposeunicode', 'symlinks', 'autocrlf', 'eol']);
function serializeGitConfig(entries: { section: string; key: string; value: string }[]): string {
  const sections = new Map<string, string[]>();
  for (const { section, key, value } of entries) {
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(`\t${key} = ${/[\s;#"\\]/.test(value) ? JSON.stringify(value) : value}`);
  }
  return [...sections].map(([section, lines]) => `[${section}]\n${lines.join('\n')}\n`).join('');
}

const SECRET_ENTRIES = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.netrc', '.git-credentials', '.npmrc', '.pypirc', 'Library'];

/**
 * Check a folder before mounting it as the project: it must be a real
 * directory, not the file system root, the home directory or one of its
 * ancestors, must not look like a home directory (no `.ssh`, `.aws`, ...,
 * `.git-credentials`, `.netrc` at its top), and its `.git/config` must hold
 * no credentials ({@link gitConfigCredentials}). A `.git` file (a linked
 * worktree) is refused, because its real git directory would not be mounted.
 * @throws {SandboxError} `project_unsafe` or `project_has_credentials`
 */
export function checkProjectFolder(path: string, home = homedir()): string {
  let real: string;
  try { real = realpathSync(path); } catch { throw new SandboxError('project_unsafe', `Project folder ${path} does not exist`); }
  if (!lstatSync(real).isDirectory()) throw new SandboxError('project_unsafe', `Project ${path} is not a folder`);
  const realHome = (() => { try { return realpathSync(home); } catch { return resolve(home); } })();
  const inside = (child: string, parent: string) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  if (real === sep || inside(realHome, real)) throw new SandboxError('project_unsafe', `Refusing to mount ${path}: it is the file system root, your home folder, or contains it`);
  for (const entry of SECRET_ENTRIES) {
    if (existsSync(join(real, entry))) throw new SandboxError('project_unsafe', `Refusing to mount ${path}: it contains ${entry}, which looks like a home folder or credentials`);
  }
  const git = join(real, '.git');
  if (existsSync(git)) {
    const info = lstatSync(git);
    if (!info.isDirectory()) throw new SandboxError('project_unsafe', `Refusing to mount ${path}: .git is not a folder (linked worktrees and submodule checkouts are not supported)`);
    const config = join(git, 'config');
    if (existsSync(config)) {
      const reasons = gitConfigCredentials(readFileSync(config, 'utf8'));
      if (reasons.length) throw new SandboxError('project_has_credentials', `Refusing to mount ${path}: its .git/config has ${reasons.join('; ')}. Remove them (for example use a credential helper in your global config) and try again.`);
    }
  }
  return real;
}

/**
 * Make a repository created by a command safe for git on the host: keep only
 * plain settings in its config (no hooks path, filters, fsmonitor, aliases,
 * includes...), remove `commondir`/`config.worktree` and active hooks.
 * Returns what was changed (empty if nothing).
 */
export function sanitizeRepository(git: string): string[] {
  const notes: string[] = [];
  let info;
  try { info = lstatSync(git); } catch { return notes; }
  if (info.isSymbolicLink()) { rmSync(git, { force: true }); return ['removed a .git link']; }
  if (!info.isDirectory()) { rmSync(git, { force: true }); return ['removed a .git file']; }
  const config = join(git, 'config');
  try {
    if (lstatSync(config).isFile()) {
      const text = readFileSync(config, 'utf8');
      const safe = gitConfigEntries(text).filter(e => (e.section === 'core' && SAFE_CORE_KEYS.has(e.key)) || (/^branch "/.test(e.section) && ['remote', 'merge'].includes(e.key)) || (/^remote "/.test(e.section) && ['url', 'fetch'].includes(e.key) && !urlHasCredentials(e.value)) || (e.section === 'init' && e.key === 'defaultbranch'));
      const rebuilt = serializeGitConfig(safe);
      if (rebuilt !== text) { writeFileSync(config, rebuilt); notes.push('kept only plain settings in .git/config'); }
    } else { rmSync(config, { force: true, recursive: true }); notes.push('removed an unusual .git/config'); }
  } catch { /* no config */ }
  for (const name of ['commondir', 'config.worktree']) if (existsSync(join(git, name))) { rmSync(join(git, name), { force: true, recursive: true }); notes.push(`removed .git/${name}`); }
  const hooks = join(git, 'hooks');
  try {
    if (lstatSync(hooks).isSymbolicLink()) { rmSync(hooks, { force: true }); notes.push('removed a hooks link'); }
    else for (const entry of readdirSync(hooks)) if (!entry.endsWith('.sample')) { rmSync(join(hooks, entry), { force: true, recursive: true }); notes.push(`removed hook ${entry}`); }
  } catch { /* no hooks folder */ }
  return notes;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The exact environment of every command: nothing from the host or the image. */
export function sandboxEnvironment(config: Pick<ResolvedSandboxConfig, 'git'>): Record<string, string> {
  return {
    PATH: `${SANDBOX_PATHS.venv}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: SANDBOX_PATHS.home, LANG: 'C.UTF-8', TMPDIR: '/tmp', TERM: 'dumb',
    VIRTUAL_ENV: SANDBOX_PATHS.venv, PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONUNBUFFERED: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: config.git.name, GIT_AUTHOR_EMAIL: config.git.email, GIT_COMMITTER_NAME: config.git.name, GIT_COMMITTER_EMAIL: config.git.email,
  };
}

/**
 * Resolve a working directory given by the model: relative to `base` (the
 * conversation's folder, `/workspace` by default), or absolute under
 * `/workspace` (or `/project` when one is mounted). `..` segments are
 * refused. This keeps commands where the user expects them; the container
 * itself is the security boundary.
 * @throws {SandboxError} `cwd_invalid`
 */
export function resolveWorkingDirectory(cwd: string | undefined, project = false, base: string = SANDBOX_PATHS.workspace): string {
  if (cwd === undefined || !cwd.trim() || cwd.trim() === '.') return base;
  const value = cwd.trim();
  if (value.length > 500 || /[\0-\x1f]/.test(value) || value.split('/').includes('..')) throw new SandboxError('cwd_invalid', 'Working directory must be a path inside /workspace without ".."');
  const absolute = value.startsWith('/') ? posix.normalize(value) : posix.join(base, value);
  const roots = [SANDBOX_PATHS.workspace, ...(project ? [SANDBOX_PATHS.project] : [])];
  const clean = absolute.replace(/\/+$/, '') || '/';
  if (!roots.some(root => clean === root || clean.startsWith(`${root}/`))) throw new SandboxError('cwd_invalid', `Working directory must be inside ${roots.join(' or ')}`);
  return clean;
}

/**
 * Shell that kills every process in the sandbox except PID 1 (the sandbox's
 * keep-alive), the shell running it, and background commands (marked with
 * {@link BACKGROUND_MARK} in their environment). Commands run one at a
 * time, so this also stops anything a command left in the background, even
 * with a cleared environment or a new session. Pure shell builtins: it
 * starts no processes. (The sandbox's `sh` is dash, whose `read` takes the
 * whole NUL-separated environment as one line; the mark comes first anyway.
 * A command that sets the mark itself only outlives later commands: the
 * sandbox still stops when idle, since only recorded background commands hold it.)
 */
export const KILL_SCRIPT = `for p in /proc/[0-9]*; do [ -r "$p/status" ] || continue; n=\${p#/proc/}; [ "$n" = 1 ] && continue; [ "$n" = "$$" ] && continue; q=; while read -r k v; do if [ "$k" = PPid: ]; then q=$v; break; fi; done <"$p/status" 2>/dev/null; [ "$q" = "$$" ] && continue; l=; IFS= read -r l <"$p/environ" 2>/dev/null; case "$l" in *${BACKGROUND_MARK}*) continue;; esac; kill -9 "$n" 2>/dev/null; done; true`;

/**
 * The POSIX shell script that runs one command in the sandbox: an empty
 * environment plus {@link sandboxEnvironment}, a `timeout`, stdin closed,
 * output captured to files and only its head and tail sent back, leftover
 * processes killed ({@link KILL_SCRIPT}). Output is framed by markers that include the run ID.
 */
export function commandScript(options: { runId: string; command: string; cwd: string; env: Record<string, string>; timeoutSeconds: number; captureBytes?: number }): string {
  const { runId } = options;
  const capture = options.captureBytes ?? SANDBOX_LIMITS.captureBytes;
  const marker = `<<ai-sdk-letta:${runId}>>`;
  for (const key of Object.keys(options.env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new SandboxError('command_invalid', `Invalid environment variable name ${key}`);
  // `env -i` starts from nothing; the exports run in the cleared shell, which then execs itself for the command.
  const setup = `export ${Object.entries(options.env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')}; exec "$0" -c "$1"`;
  const stream = (file: string) => `head -c ${capture} "$D/${file}"; n=$(wc -c <"$D/${file}"); if [ "$((n))" -gt ${capture * 2} ]; then printf '\\n%s\\n' ${quote(`${marker}:cut`)}; tail -c ${capture} "$D/${file}"; elif [ "$((n))" -gt ${capture} ]; then tail -c "$((n - ${capture}))" "$D/${file}"; fi`;
  return [
    `D=/tmp/.ai-sdk-letta-${runId}; mkdir -p "$D" || exit 125; : >"$D/o"; : >"$D/e"`,
    'B=/bin/bash; [ -x "$B" ] || B=/bin/sh',
    `if cd -- ${quote(options.cwd)} 2>/dev/null; then timeout -k 3 ${options.timeoutSeconds} env -i "$B" -c ${quote(setup)} "$B" ${quote(options.command)} </dev/null >"$D/o" 2>"$D/e"; c=$?; else c=nocwd; fi`,
    KILL_SCRIPT,
    `so=$(wc -c <"$D/o"); se=$(wc -c <"$D/e")`,
    `printf '%s\\n' "${marker}:$c:$((so)):$((se))"`,
    stream('o'),
    `printf '\\n%s\\n' ${quote(`${marker}:stderr`)}`,
    stream('e'),
    'rm -rf "$D"',
  ].join('\n');
}

/** One captured stream: its start, its end when the middle was dropped in the sandbox, and its full size in bytes. */
export interface CapturedStream { head: string; tail?: string; bytes: number }
/** The outcome of one command. */
export interface CommandResult { exitCode: number; timedOut: boolean; stdout: CapturedStream; stderr: CapturedStream; durationMs: number }

/** Parse {@link commandScript} output. Returns `undefined` if it is not ours (the sandbox failed). */
export function parseCommandOutput(runId: string, stdout: string): (Omit<CommandResult, 'timedOut' | 'durationMs'> & { noCwd: boolean }) | undefined {
  const marker = `<<ai-sdk-letta:${runId}>>`;
  const header = new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(-?\\d+|nocwd):(\\d+):(\\d+)\\n`).exec(stdout);
  if (!header) return undefined;
  const body = stdout.slice(header[0].length);
  const split = body.lastIndexOf(`\n${marker}:stderr\n`);
  if (split < 0) return undefined;
  const part = (text: string, bytes: number): CapturedStream => {
    const cut = text.indexOf(`\n${marker}:cut\n`);
    return cut < 0 ? { head: text, bytes } : { head: text.slice(0, cut), tail: text.slice(cut + marker.length + 6), bytes };
  };
  return { exitCode: header[1] === 'nocwd' ? -1 : Number(header[1]), noCwd: header[1] === 'nocwd', stdout: part(body.slice(0, split), Number(header[2])), stderr: part(body.slice(split + marker.length + 9), Number(header[3])) };
}

const kb = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;

/** Fit one stream into `budget` characters, keeping about two thirds from the start and one third from the end. */
function fit(stream: CapturedStream, budget: number): { text: string; truncated: boolean } {
  const cut = stream.tail !== undefined;
  const tail = stream.tail ?? '';
  if (!cut && stream.head.length <= budget) return { text: stream.head, truncated: false };
  let start: string; let end: string;
  if (cut && stream.head.length + tail.length <= budget) { start = stream.head; end = tail; }
  else {
    const keepHead = Math.floor(budget * 2 / 3);
    const keepTail = budget - keepHead;
    start = stream.head.slice(0, keepHead);
    end = keepTail > 0 ? (cut ? tail : stream.head).slice(-keepTail) : '';
    // Prefer whole lines when that loses little.
    const lastBreak = start.lastIndexOf('\n');
    if (lastBreak >= start.length - 200 && lastBreak > 0) start = start.slice(0, lastBreak + 1);
    const firstBreak = end.indexOf('\n');
    if (firstBreak >= 0 && firstBreak < 200 && firstBreak < end.length - 1) end = end.slice(firstBreak + 1);
  }
  const omitted = Math.max(0, stream.bytes - Buffer.byteLength(start) - Buffer.byteLength(end));
  return { text: `${start}${start && !start.endsWith('\n') ? '\n' : ''}[… ${kb(omitted)} of output omitted …]\n${end}`, truncated: true };
}

/**
 * Text of a command result, as the model sees it: the exit code first, then
 * stdout, then stderr, together at most `limit` characters. A stream that is
 * too long keeps its start and end, with a notice of how much was omitted.
 */
export function formatCommandResult(result: CommandResult, limit: number = SANDBOX_LIMITS.maxOutputChars, timeoutMs?: number): string {
  const outLength = result.stdout.head.length + (result.stdout.tail?.length ?? 0);
  const errLength = result.stderr.head.length + (result.stderr.tail?.length ?? 0);
  let outBudget = outLength; let errBudget = errLength;
  if (outLength + errLength > limit) {
    errBudget = Math.min(errLength, Math.max(Math.floor(limit / 4), limit - outLength));
    outBudget = limit - errBudget;
  }
  const out = fit(result.stdout, outBudget);
  const err = fit(result.stderr, errBudget);
  const seconds = result.durationMs >= 1000 ? `${(result.durationMs / 1000).toFixed(1)} s` : `${result.durationMs} ms`;
  const status = result.timedOut ? `Exit code: ${result.exitCode} (timed out after ${Math.round((timeoutMs ?? 0) / 1000)} s; the command was stopped)` : `Exit code: ${result.exitCode} (${seconds})`;
  const parts = [status];
  if (out.text) parts.push(out.text.replace(/\n$/, ''));
  if (err.text) parts.push(`[stderr]\n${err.text.replace(/\n$/, '')}`);
  if (!out.text && !err.text) parts.push('(no output)');
  if (out.truncated || err.truncated) parts.push('[Output truncated. To see more, write it to a file and read parts with head, tail, sed -n or rg.]');
  return parts.join('\n');
}

/**
 * Run one command through any AI SDK sandbox session with the wrapper from
 * {@link commandScript}. A timeout or abort also kills what the command left
 * running in the sandbox.
 * @throws {SandboxError} `cwd_not_found` or `sandbox_unavailable`; rethrows aborts
 */
/** Live output of a running command: called with what it printed since the last call (UI only; never changes the result). */
export type CommandOutputListener = (chunk: CommandOutputChunk) => void | Promise<void>;
/** When and how often live output is read: from `delayMs` after the start, every `intervalMs`. */
export type CommandPolling = { delayMs?: number; intervalMs?: number; tailBytes?: number };

/**
 * The script that reads a running command's new output (from {@link commandScript}'s files):
 * both sizes, then at most `tailBytes` of each stream, the newest, from the given offsets.
 * Prints nothing when the command's folder is gone (it ended).
 */
export function pollScript(runId: string, offsets: { stdout: number; stderr: number }, tailBytes: number = COMMAND_PROGRESS.tailBytes): string {
  const marker = `<<ai-sdk-letta-poll:${runId}>>`;
  // Up to the size measured first (the file keeps growing), at most the newest `tailBytes` of what is new.
  const part = (file: string, size: string, from: number) => `if [ "$((${size}))" -gt ${from} ]; then tail -c +${from + 1} "$D/${file}" | head -c "$((${size} - ${from}))" | tail -c ${tailBytes}; fi`;
  return [
    `D=/tmp/.ai-sdk-letta-${runId}; [ -d "$D" ] || exit 0`,
    `so=$(wc -c <"$D/o" 2>/dev/null) || so=0; se=$(wc -c <"$D/e" 2>/dev/null) || se=0`,
    `printf '%s\\n' "${marker}:$((so)):$((se))"`,
    part('o', 'so', Math.floor(offsets.stdout)),
    `printf '\\n%s\\n' ${quote(`${marker}:stderr`)}`,
    part('e', 'se', Math.floor(offsets.stderr)),
  ].join('\n');
}

/** Parse {@link pollScript} output. `undefined`: nothing to read (the command ended, or not ours). */
export function parsePollOutput(runId: string, stdout: string): CommandOutputChunk | undefined {
  const marker = `<<ai-sdk-letta-poll:${runId}>>`;
  const header = new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):(\\d+)\\n`).exec(stdout);
  if (!header) return undefined;
  const body = stdout.slice(header[0].length);
  const split = body.lastIndexOf(`\n${marker}:stderr\n`);
  if (split < 0) return undefined;
  return { stdout: body.slice(0, split), stderr: body.slice(split + marker.length + 9), stdoutBytes: Number(header[1]), stderrBytes: Number(header[2]) };
}

/**
 * Read a running command's output every `intervalMs` from `delayMs` on, with
 * separate runs on the same session (built-in providers run each call as its
 * own `exec`, so they do not wait for the command). Returns `stop()`, which
 * waits for the last read to finish.
 */
export function pollCommandOutput(session: Experimental_SandboxSession, runId: string, onOutput: CommandOutputListener, polling: CommandPolling = {}): { stop(): Promise<void> } {
  const delayMs = polling.delayMs ?? COMMAND_PROGRESS.delayMs;
  const intervalMs = polling.intervalMs ?? COMMAND_PROGRESS.intervalMs;
  const tailBytes = polling.tailBytes ?? COMMAND_PROGRESS.tailBytes;
  const control = new AbortController();
  let stopped = false;
  let wake: (() => void) | undefined;
  const sleep = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(() => { wake = undefined; resolve(); }, ms); wake = () => { clearTimeout(timer); wake = undefined; resolve(); }; });
  const offsets = { stdout: 0, stderr: 0 };
  const loop = (async () => {
    await sleep(delayMs);
    while (!stopped) {
      const started = Date.now();
      try {
        const limit = AbortSignal.any([control.signal, AbortSignal.timeout(Math.max(5000, intervalMs * 5))]);
        const raw = await session.run({ command: pollScript(runId, offsets, tailBytes), abortSignal: limit });
        const chunk = stopped ? undefined : parsePollOutput(runId, raw.stdout);
        if (chunk) {
          offsets.stdout = Math.max(offsets.stdout, chunk.stdoutBytes); offsets.stderr = Math.max(offsets.stderr, chunk.stderrBytes);
          await onOutput(chunk);
        }
      } catch { /* a missed read; the next one catches up */ }
      if (stopped) break;
      await sleep(Math.max(0, intervalMs - (Date.now() - started)));
    }
  })();
  return { stop: async () => { stopped = true; wake?.(); control.abort(); await loop; } };
}

export async function runSandboxCommand(session: Experimental_SandboxSession, options: { command: string; cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal; captureBytes?: number; onOutput?: CommandOutputListener; polling?: CommandPolling }): Promise<CommandResult> {
  const runId = randomUUID().replace(/-/g, '');
  const started = Date.now();
  const timeoutSeconds = Math.max(1, Math.round(options.timeoutMs / 1000));
  // Host-side backstop if the sandbox itself hangs.
  const control = new AbortController();
  const backstop = setTimeout(() => control.abort(new Error('sandbox_unresponsive')), options.timeoutMs + 15_000);
  backstop.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, control.signal]) : control.signal;
  let raw: { exitCode: number; stdout: string; stderr: string };
  const poller = options.onOutput ? pollCommandOutput(session, runId, options.onOutput, options.polling) : undefined;
  try {
    try { raw = await session.run({ command: commandScript({ ...options, runId, timeoutSeconds }), abortSignal: signal }); }
    finally { await poller?.stop(); }
  } catch (error) {
    // Providers only kill their local client process; stop what runs in the sandbox.
    const cleanup = new AbortController();
    const limit = setTimeout(() => cleanup.abort(), 10_000);
    try { await session.run({ command: KILL_SCRIPT, abortSignal: cleanup.signal }); } catch { /* the sandbox is gone or stuck */ } finally { clearTimeout(limit); }
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw new SandboxError('sandbox_unavailable', control.signal.aborted ? 'The sandbox stopped responding; the command was stopped' : 'The sandbox could not run the command');
  } finally { clearTimeout(backstop); }
  const parsed = parseCommandOutput(runId, raw.stdout);
  if (!parsed) throw new SandboxError('sandbox_unavailable', `The sandbox could not run the command${raw.stderr.trim() ? `: ${raw.stderr.trim().slice(0, 300)}` : ''}`);
  if (parsed.noCwd) throw new SandboxError('cwd_not_found', `Working directory ${options.cwd} does not exist`);
  const durationMs = Date.now() - started;
  const timedOut = (parsed.exitCode === 124 || parsed.exitCode === 137) && durationMs >= timeoutSeconds * 1000 - 250;
  return { exitCode: parsed.exitCode, timedOut, stdout: parsed.stdout, stderr: parsed.stderr, durationMs };
}

/* ------------------------------------------------------------------ */
/* Container CLIs                                                      */
/* ------------------------------------------------------------------ */

/** A container CLI (internal, shared with the web development services). */
export type Cli = { kind: SandboxProviderName; binary: string };
export function cliOf(config: Pick<ResolvedSandboxConfig, 'provider' | 'binary'>): Cli | undefined {
  if (config.provider === 'docker') return { kind: 'docker', binary: config.binary ?? 'docker' };
  if (config.provider === 'apple-container') return { kind: 'apple-container', binary: config.binary ?? 'container' };
  return undefined;
}
export function exec(binary: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(done => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const images = new Map<string, Promise<void>>();
/**
 * Make sure the image exists, building the default one from
 * {@link SANDBOX_DOCKERFILE} (or the web development one from
 * {@link WEBDEV_DOCKERFILE}; once per machine, a few minutes the first time,
 * depending on the network) or pulling a custom one.
 */
export async function ensureImage(cli: Cli, image: string, log?: (line: string) => void): Promise<void> {
  const key = `${cli.kind}:${cli.binary}:${image}`;
  let pending = images.get(key);
  if (!pending) {
    pending = (async () => {
      if ((await exec(cli.binary, ['image', 'inspect', image])).code === 0) return;
      const dockerfile = BUILT_IMAGES[image];
      if (!dockerfile) {
        log?.(`Pulling sandbox image ${image}…`);
        const pulled = cli.kind === 'docker' ? await exec(cli.binary, ['pull', image], 600_000) : await exec(cli.binary, ['image', 'pull', image], 600_000);
        if (pulled.code !== 0) throw new SandboxError('sandbox_unavailable', `Could not pull ${image}: ${pulled.stderr.trim().slice(-300)}`);
        return;
      }
      log?.(image === MCP_APPS_IMAGE ? `Building the MCP App runtime image ${image} (first run only; usually under a minute)…` : `Building sandbox image ${image} (first run only; usually 1–3 minutes${image === WEBDEV_IMAGE ? ', a little more for the web development image' : ''})…`);
      const context = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-image-'));
      try {
        writeFileSync(join(context, 'Dockerfile'), dockerfile);
        const builderWasRunning = cli.kind === 'apple-container' && /running/.test((await exec(cli.binary, ['builder', 'status'])).stdout);
        const built = await exec(cli.binary, ['build', '-t', image, ...(cli.kind === 'docker' ? ['--label', `${SANDBOX_LABEL}.image=1`] : []), context], 900_000);
        if (cli.kind === 'apple-container' && !builderWasRunning) await exec(cli.binary, ['builder', 'stop'], 60_000);
        if (built.code !== 0) throw new SandboxError('sandbox_unavailable', `Could not build the sandbox image: ${built.stderr.trim().slice(-500)}`);
      } finally { rmSync(context, { recursive: true, force: true }); }
    })();
    images.set(key, pending);
    pending.catch(() => images.delete(key));
  }
  return pending;
}

/** Containers this process created and has not removed yet; removed on exit. */
const live = new Map<string, Cli>();
let exitHook = false;
export function track(cli: Cli, name: string) {
  live.set(name, cli);
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => {
      for (const [container, { kind, binary }] of live) spawnSync(binary, kind === 'docker' ? ['rm', '-f', container] : ['delete', '--force', container], { stdio: 'ignore', timeout: 10_000 });
    });
  }
}
export async function remove(cli: Cli, name: string) {
  await exec(cli.binary, cli.kind === 'docker' ? ['rm', '-f', name] : ['delete', '--force', name], 60_000);
  live.delete(name);
}

const swept = new Set<string>();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
/**
 * Remove sandbox containers left behind by a process of this host that is
 * no longer running (a crash, `kill -9`). Runs once per CLI and process.
 */
export async function sweepStaleSandboxes(config: Pick<ResolvedSandboxConfig, 'provider' | 'binary'>): Promise<string[]> {
  const cli = cliOf(config);
  if (!cli || swept.has(`${cli.kind}:${cli.binary}`)) return [];
  swept.add(`${cli.kind}:${cli.binary}`);
  const stale: string[] = [];
  const host = hostname();
  if (cli.kind === 'docker') {
    const listed = await exec(cli.binary, ['ps', '-a', '--filter', `label=${SANDBOX_LABEL}=1`, '--format', `{{.Names}}\t{{.Label "${SANDBOX_LABEL}.pid"}}\t{{.Label "${SANDBOX_LABEL}.host"}}`]);
    for (const line of listed.stdout.split('\n').filter(Boolean)) {
      const [name, pid, from] = line.split('\t');
      if (name && from === host && !alive(Number(pid))) stale.push(name);
    }
  } else {
    const listed = await exec(cli.binary, ['list', '--all', '--format', 'json']);
    try {
      for (const entry of JSON.parse(listed.stdout || '[]') as { configuration?: { id?: string; labels?: Record<string, string> } }[]) {
        const labels = entry.configuration?.labels ?? {};
        if (entry.configuration?.id && labels[SANDBOX_LABEL] === '1' && labels[`${SANDBOX_LABEL}.host`] === host && !alive(Number(labels[`${SANDBOX_LABEL}.pid`]))) stale.push(entry.configuration.id);
      }
    } catch { /* unreadable listing: nothing to sweep */ }
  }
  for (const name of stale) await remove(cli, name);
  return stale;
}

/** Shape of the provider packages, loaded only when configured (they are optional peer dependencies). */
type DockerModule = { createDockerSandbox(settings: { image?: string; workdir?: string; docker?: string; createArgs?: string[] }): { createSession(options?: { sessionId?: string; abortSignal?: AbortSignal }): Promise<{ restricted(): Experimental_SandboxSession; stop(): Promise<void> }> } };
type AppleModule = { createAppleContainerSandbox(options: { image?: string; cwd?: string; containerBinary?: string; containerArgs?: string[]; memory?: string; mounts?: { hostPath: string; containerPath: string; readOnly?: boolean }[]; name?: string }): { createSession(options?: { abortSignal?: AbortSignal }): Promise<{ restricted(): Experimental_SandboxSession; stop(): Promise<void> }> } };
const PACKAGES: Record<SandboxProviderName, string> = { docker: 'ai-sdk-sandbox-docker', 'apple-container': '@lgrammel/apple-container-sandbox' };
async function load<T>(provider: SandboxProviderName): Promise<T> {
  try { return await import(PACKAGES[provider]) as T; }
  catch { throw new SandboxError('sandbox_unavailable', `The ${provider} sandbox needs the optional package ${PACKAGES[provider]}; install it (see the ai-sdk-letta README)`); }
}

/** Create a sandbox with a built-in provider: no network unless asked, the host user's UID, no capabilities, read-only root, labelled. */
async function createBuiltin(config: ResolvedSandboxConfig, cli: Cli, request: SandboxRequest): Promise<SandboxHandle> {
  await sweepStaleSandboxes(config);
  await ensureImage(cli, request.image);
  request.signal?.throwIfAborted();
  const id = `ai-sdk-letta-${randomUUID().slice(0, 12)}`;
  const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid!()}`] : [];
  const labels = Object.entries(request.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  if (cli.kind === 'docker') {
    const { createDockerSandbox } = await load<DockerModule>('docker');
    const mounts = request.mounts.flatMap(m => ['--mount', `type=bind,src=${m.hostPath},dst=${m.containerPath}${m.readOnly ? ',readonly' : ''}`]);
    const provider = createDockerSandbox({ image: request.image, workdir: SANDBOX_PATHS.workspace, docker: cli.binary, createArgs: [
      '--network', request.network ? 'bridge' : 'none', ...user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=1g',
      '--pids-limit', '1024', '--memory', config.memory, '--cpus', String(config.cpus), ...labels, ...mounts,
    ] });
    const name = `ai-sdk-sandbox-${id}`;
    track(cli, name);
    try {
      const session = await provider.createSession({ sessionId: id, abortSignal: request.signal });
      return { session: session.restricted(), stop: async () => { await session.stop(); await remove(cli, name); } };
    } catch (error) { await remove(cli, name); throw error; }
  }
  const { createAppleContainerSandbox } = await load<AppleModule>('apple-container');
  const provider = createAppleContainerSandbox({ image: request.image, cwd: SANDBOX_PATHS.workspace, containerBinary: cli.binary, memory: config.memory, name: id, mounts: request.mounts.map(m => ({ ...m })),
    containerArgs: [...(request.network ? [] : ['--network', 'none']), ...user, '--cap-drop', 'ALL', '--read-only', '--tmpfs', '/tmp', '--cpus', String(config.cpus), ...labels] });
  track(cli, id);
  try {
    const session = await provider.createSession({ abortSignal: request.signal });
    return { session: session.restricted(), stop: async () => { await session.stop().catch(() => {}); await remove(cli, id); } };
  } catch (error) { await remove(cli, id); throw error; }
}

/**
 * Which built-in provider works on this machine, if any: Apple Container
 * when its services run (macOS on Apple silicon), else Docker when its
 * daemon answers; only if the matching optional package can be loaded.
 */
export async function detectSandboxProvider(): Promise<SandboxProviderName | undefined> {
  const importable = async (provider: SandboxProviderName) => { try { await load(provider); return true; } catch { return false; } };
  if (process.platform === 'darwin' && process.arch === 'arm64' && (await exec('container', ['system', 'status'], 10_000)).code === 0 && await importable('apple-container')) return 'apple-container';
  if ((await exec('docker', ['info', '--format', '{{.ServerVersion}}'], 10_000)).code === 0 && await importable('docker')) return 'docker';
  return undefined;
}

/**
 * Prepare a built-in provider ahead of the first command: remove stale
 * containers and build or pull the image. Optional; the first command does
 * the same. Call it at startup to show the one-time build.
 */
export async function prepareSandbox(config: SandboxConfig, log?: (line: string) => void): Promise<void> {
  const resolved = resolveSandboxConfig(config);
  const cli = cliOf(resolved);
  if (!cli) return;
  await sweepStaleSandboxes(resolved);
  await ensureImage(cli, resolved.image, log);
}

/* ------------------------------------------------------------------ */
/* Per-conversation manager                                            */
/* ------------------------------------------------------------------ */

/**
 * One conversation's sandbox: created on the first command, reused across
 * turns, stopped after `idleTimeoutMs` without commands and on `close()`.
 * Network commands get their own short-lived sandbox with network access,
 * mounting the same workspace, removed right after the command.
 *
 * `session` is a lazy AI SDK `Experimental_SandboxSession` for this
 * conversation: the runtime passes it to every tool as `experimental_sandbox`.
 */
export class SandboxManager {
  readonly config: ResolvedSandboxConfig;
  /** Lazy AI SDK session; the container starts on its first use. */
  readonly session: Experimental_SandboxSession;
  private readonly workspace: () => string;
  private readonly folder?: () => string | undefined;
  private readonly labels: Record<string, string>;
  private readonly project?: { path: string; readOnly: boolean; git: boolean; gitConfig: Buffer | null };
  private current?: Promise<SandboxHandle>;
  private busy = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly online = new Set<SandboxHandle>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Background commands of the agent, and this conversation's key in them (`<agentId>.<conversationId>`). */
  readonly background?: { commands: BackgroundCommands; owner: string; conversationId: string };
  private unwatch?: () => void;

  /**
   * @param options.workspace returns the host folder to mount at `/workspace` (created and checked by the caller).
   * @param options.folder returns the conversation's folder, relative to `/workspace`: commands start there.
   * @throws {SandboxError} if the project folder is unsafe or holds credentials
   */
  constructor(config: ResolvedSandboxConfig, options: { workspace: () => string; folder?: () => string | undefined; owner?: string; background?: { commands: BackgroundCommands; conversationId: string } }) {
    this.config = config;
    this.workspace = options.workspace;
    this.folder = options.folder;
    if (options.background && options.owner) {
      this.background = { commands: options.background.commands, owner: options.owner, conversationId: options.background.conversationId };
      // When the last background command ends, the idle timer starts again.
      this.unwatch = options.background.commands.watch(options.owner, () => { if (!this.busy && !this.closed && this.current) this.release(true); });
    }
    this.labels = { [SANDBOX_LABEL]: '1', [`${SANDBOX_LABEL}.pid`]: String(process.pid), [`${SANDBOX_LABEL}.host`]: hostname(), ...(options.owner ? { [`${SANDBOX_LABEL}.owner`]: options.owner.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) } : {}) };
    if (config.project) {
      const path = checkProjectFolder(config.project.path);
      const git = existsSync(join(path, '.git'));
      const gitConfig = join(path, '.git', 'config');
      this.project = { path, readOnly: config.project.readOnly, git, gitConfig: git && existsSync(gitConfig) ? readFileSync(gitConfig) : null };
    }
    const lazy = <K extends keyof Experimental_SandboxSession>(key: K) => ((...args: unknown[]) => this.exclusive(async () => {
      const handle = await this.acquire();
      try { return await (handle.session[key] as (...a: unknown[]) => unknown)(...args); }
      finally { this.release(); }
    })) as unknown as Experimental_SandboxSession[K];
    this.session = {
      description: `Isolated Linux sandbox without network. ${SANDBOX_PATHS.workspace} holds the agent's resources, one folder per conversation${config.project ? `, and ${SANDBOX_PATHS.project} the project folder` : ''}.`,
      readFile: lazy('readFile'), readBinaryFile: lazy('readBinaryFile'), readTextFile: lazy('readTextFile'),
      writeFile: lazy('writeFile'), writeBinaryFile: lazy('writeBinaryFile'), writeTextFile: lazy('writeTextFile'),
      spawn: lazy('spawn'), run: lazy('run'),
    };
  }

  /** One operation at a time: a finished command kills whatever is still running in the sandbox. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Labels of this conversation's containers (owner, process, host). */
  get containerLabels(): Readonly<Record<string, string>> { return this.labels; }
  /** Is the conversation's sandbox running (or starting)? */
  get running(): boolean { return this.current !== undefined; }
  /** Does a background command of this conversation run now (the sandbox then stays up)? */
  get holding(): boolean { return !!this.background?.commands.running(this.background.owner); }
  /** Does `/project` exist in this sandbox? */
  get hasProject(): boolean { return this.project !== undefined; }
  /** Default working directory of commands: the conversation's folder. */
  get workingDirectory(): string {
    const folder = this.folder?.();
    return folder ? posix.join(SANDBOX_PATHS.workspace, folder) : SANDBOX_PATHS.workspace;
  }
  /** The exact environment of commands. */
  get environment(): Record<string, string> { return sandboxEnvironment(this.config); }

  /** What the sandbox mounts: the workspace, and the project (with its `.git` and read-only hooks) when set. */
  mounts(): SandboxMount[] {
    const workspace = this.workspace();
    if (MOUNT_UNSAFE.test(workspace)) throw new SandboxError('sandbox_unavailable', 'The workspace path contains characters that cannot be mounted');
    // Only the work tree is mounted: the resources' git history and metadata live next to it, out of reach.
    const mounts: SandboxMount[] = [{ hostPath: workspace, containerPath: SANDBOX_PATHS.workspace }];
    if (this.project) {
      mounts.push({ hostPath: this.project.path, containerPath: SANDBOX_PATHS.project, readOnly: this.project.readOnly });
      if (!this.project.readOnly && this.project.git) {
        // .git is its own mount, so it cannot be swapped for another folder; its hooks are read-only.
        const git = join(this.project.path, '.git');
        const hooks = join(git, 'hooks');
        mkdirSync(hooks, { recursive: true });
        for (const dir of [git, hooks]) { const info = lstatSync(dir); if (!info.isDirectory() || info.isSymbolicLink()) throw new SandboxError('project_unsafe', 'The project\'s .git or .git/hooks is not a plain folder'); }
        mounts.push({ hostPath: git, containerPath: `${SANDBOX_PATHS.project}/.git` }, { hostPath: hooks, containerPath: `${SANDBOX_PATHS.project}/.git/hooks`, readOnly: true });
      }
    }
    return mounts;
  }

  private async create(network: boolean, signal?: AbortSignal): Promise<SandboxHandle> {
    // Fail before touching the workspace when a built-in provider's package is missing.
    const builtin = cliOf(this.config);
    if (builtin) await load(builtin.kind);
    const request: SandboxRequest = { network, mounts: this.mounts(), labels: { ...this.labels, [`${SANDBOX_LABEL}.network`]: network ? 'on' : 'off' }, image: this.config.image, signal };
    const cli = cliOf(this.config);
    let handle: SandboxHandle;
    try { handle = cli ? await createBuiltin(this.config, cli, request) : await (this.config.provider as SandboxFactory)(request); }
    catch (error) {
      if (error instanceof SandboxError || signal?.aborted) throw error;
      throw new SandboxError('sandbox_unavailable', `The sandbox could not start: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`);
    }
    // One-time setup in the workspace: a Python venv for pip, and HOME.
    try {
      await handle.session.run({ command: `mkdir -p ${SANDBOX_PATHS.home} && if command -v python3 >/dev/null 2>&1 && [ ! -x ${SANDBOX_PATHS.venv}/bin/python ]; then python3 -m venv ${SANDBOX_PATHS.venv} >/dev/null 2>&1 || true; fi`, abortSignal: signal });
    } catch (error) { await handle.stop().catch(() => {}); throw signal?.aborted ? error : new SandboxError('sandbox_unavailable', 'The sandbox could not be set up'); }
    return handle;
  }

  private async acquire(signal?: AbortSignal): Promise<SandboxHandle> {
    if (this.closed) throw new SandboxError('sandbox_unavailable', 'The sandbox is closed');
    this.busy++;
    clearTimeout(this.idle);
    try {
      // A sandbox kept for background commands after the conversation's session closed is taken back.
      if (!this.current && this.background) { const parked = this.background.commands.adopt<SandboxHandle>(this.background.owner); if (parked) this.current = parked; }
      if (!this.current) {
        const pending = this.create(false);
        this.current = pending;
        pending.catch(() => { if (this.current === pending) this.current = undefined; });
      }
      const handle = this.current;
      return await (signal ? Promise.race([handle, new Promise<never>((_, reject) => { signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); })]) : handle);
    } catch (error) { this.release(); throw error; }
  }
  private release(rearm = false) {
    if (!rearm) this.busy = Math.max(0, this.busy - 1);
    if (this.busy || this.closed || !this.current) return;
    clearTimeout(this.idle);
    // Never idle-stopped while a background command runs; its end re-arms the timer.
    if (this.holding) return;
    this.idle = setTimeout(() => { if (!this.holding) void this.stop(); }, this.config.idleTimeoutMs);
    this.idle.unref?.();
  }
  /** Stop the conversation's sandbox now (the next command starts a new one). Running background commands are stopped with it. */
  async stop(): Promise<void> {
    clearTimeout(this.idle);
    const current = this.current;
    this.current = undefined;
    if (current) await current.then(handle => handle.stop(), () => {}).catch(() => {});
  }

  /**
   * After a command: undo changes to the project's git settings, which git
   * on the host would obey (hooks paths, filters, fsmonitor, aliases...).
   * `.git/config` is restored, and `commondir` or `config.worktree` added by
   * the command are removed. Returns a note for the model when it did so.
   */
  private guard(): string | undefined {
    if (!this.project || this.project.readOnly) return undefined;
    const git = join(this.project.path, '.git');
    if (!this.project.git) { const notes = existsSync(git) ? sanitizeRepository(git) : []; return notes.length ? `[In the new repository in the project, ai-sdk-letta ${notes.join(', ')}, because git on the user's computer would obey them.]` : undefined; }
    const notes: string[] = [];
    for (const name of ['commondir', 'config.worktree']) {
      const path = join(git, name);
      if (existsSync(path)) { rmSync(path, { force: true, recursive: true }); notes.push(name); }
    }
    const path = join(git, 'config');
    const now = existsSync(path) ? readFileSync(path) : null;
    const before = this.project.gitConfig;
    if (!(before === null ? now === null : now !== null && before.equals(now))) {
      if (before === null) rmSync(path, { force: true });
      else { const temp = join(git, `.config.ai-sdk-letta-${process.pid}`); writeFileSync(temp, before, { mode: 0o644 }); renameSync(temp, path); }
      notes.push('config');
    }
    return notes.length ? `[The command changed the project's git settings (.git/${notes.join(', .git/')}); they were restored, because git on the user's computer would obey them.]` : undefined;
  }

  /**
   * Run one command in the conversation's sandbox (no network), or, with
   * `network: true`, in a new network-enabled sandbox on the same workspace
   * that is removed right after.
   */
  async run(input: { command: string; cwd?: string; network?: boolean; signal?: AbortSignal; onOutput?: CommandOutputListener; polling?: CommandPolling }): Promise<{ result: CommandResult; note?: string }> {
    const cwd = resolveWorkingDirectory(input.cwd, this.hasProject, this.workingDirectory);
    const options = { command: input.command, cwd, env: this.environment, timeoutMs: this.config.timeoutMs, signal: input.signal, ...(input.onOutput ? { onOutput: input.onOutput } : {}), ...(input.polling ? { polling: input.polling } : {}) };
    if (!input.network) return this.exclusive(async () => {
      input.signal?.throwIfAborted();
      const handle = await this.acquire(input.signal);
      try { return { result: await runSandboxCommand(handle.session, options), note: this.guard() }; }
      finally { this.release(); }
    });
    if (this.closed) throw new SandboxError('sandbox_unavailable', 'The sandbox is closed');
    const handle = await this.create(true, input.signal);
    this.online.add(handle);
    try { return { result: await runSandboxCommand(handle.session, options), note: this.guard() }; }
    finally { this.online.delete(handle); await handle.stop().catch(() => {}); }
  }

  /**
   * Start a background command: detached in the conversation's sandbox
   * (marked, so later commands' cleanup spares it), output to
   * `/workspace/.jobs/<id>/`, stopped at `limitMs` (default
   * `backgroundTimeoutMs`). Returns once it was launched.
   * @throws {SandboxError} `sandbox_unavailable` without background support, at the per-conversation limit, or when the launch fails
   */
  async runBackground(input: { command: string; cwd?: string; notify?: boolean; limitMs?: number; toolCallId?: string; job?: CommandJob; signal?: AbortSignal }): Promise<BackgroundRecord> {
    const background = this.background;
    if (!background) throw new SandboxError('sandbox_unavailable', 'Background commands are not available in this session');
    if (background.commands.runningCount(background.owner) >= BACKGROUND_LIMITS.maxRunningPerConversation) throw new SandboxError('sandbox_unavailable', `At most ${BACKGROUND_LIMITS.maxRunningPerConversation} background commands can run at once in a conversation; stop one with command_stop first`);
    const cwd = resolveWorkingDirectory(input.cwd, this.hasProject, this.workingDirectory);
    const id = `bg-${randomUUID().slice(0, 8)}`;
    const limitMs = Math.min(input.limitMs ?? this.config.backgroundTimeoutMs, BACKGROUND_LIMITS.maxLimitMs);
    const script = backgroundScript({ id, command: input.command, cwd, env: this.environment, limitSeconds: Math.round(limitMs / 1000) });
    return this.exclusive(async () => {
      input.signal?.throwIfAborted();
      const handle = await this.acquire(input.signal);
      try {
        let raw: { exitCode: number; stdout: string; stderr: string };
        try { raw = await handle.session.run({ command: script, abortSignal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(30_000)]) }); }
        catch (error) { if (input.signal?.aborted) throw error; throw new SandboxError('sandbox_unavailable', 'The sandbox could not start the command'); }
        if (!raw.stdout.includes(`<<ai-sdk-letta-bg:${id}>>:started`)) throw new SandboxError('sandbox_unavailable', `The sandbox could not start the command${raw.stderr.trim() ? `: ${raw.stderr.trim().slice(0, 300)}` : ''}`);
        // The card shows from the start (and keeps updating after the turn).
        if (input.job) { try { await input.job.output({ stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0 }); } catch { /* the card is only a view */ } }
        return background.commands.add({ id, owner: background.owner, conversationId: background.conversationId, command: input.command, cwd, dir: join(this.workspace(), '.jobs', id), limitMs, notify: input.notify !== false, ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}) }, input.job);
      } finally { this.release(); }
    });
  }

  /** Stop every sandbox of this conversation. Idempotent. A sandbox running background commands is kept (by the agent's background commands) until they end. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idle);
    this.unwatch?.();
    const current = this.current;
    if (current && this.background && this.holding) { this.current = undefined; this.background.commands.park(this.background.owner, current); }
    await Promise.all([this.stop(), ...[...this.online].map(handle => handle.stop().catch(() => {}))]);
    this.online.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/** What a sandbox tool returns: the text the model sees. */
export interface SandboxToolOutput { text: string; isError?: boolean; exitCode?: number; jobId?: string; note?: string }
type CommandInput = { command: string; cwd?: string };
type RunCommandInput = CommandInput & { background?: boolean; notify?: boolean };
const commandProperties = {
  command: { type: 'string', minLength: 1, maxLength: SANDBOX_LIMITS.maxCommandChars, description: 'Shell command (bash).' },
  cwd: { type: 'string', maxLength: 500, description: 'Working directory, relative to this conversation\'s folder or absolute under /workspace. Default: this conversation\'s folder.' },
} as const;
const commandSchema = jsonSchema<CommandInput>({ type: 'object', properties: commandProperties, required: ['command'], additionalProperties: false });
const runCommandSchema = jsonSchema<RunCommandInput>({ type: 'object', properties: {
  ...commandProperties,
  background: { type: 'boolean', description: 'Run it in the background: returns at once with a jobId; it keeps running after your turn (up to hours) and you are told when it ends. Use for anything longer than a few minutes.' },
  notify: { type: 'boolean', description: 'With background: bring you a message when it ends (default true). false: check it yourself with command_status.' },
}, required: ['command'], additionalProperties: false });

const errorOutput = (error: unknown): SandboxToolOutput => {
  if (error instanceof SandboxError) return { text: `Error (${error.code}): ${error.message}`, isError: true };
  throw error;
};
function toModelOutput({ output }: { output: unknown }) {
  if (typeof output === 'string') return { type: 'text' as const, value: output };
  const result = output as SandboxToolOutput;
  return result.isError ? { type: 'error-text' as const, value: result.text } : { type: 'text' as const, value: result.text };
}
const managerOf = (context: unknown) => {
  const value = (context as Record<string, unknown> | undefined)?.[SANDBOX_CONTEXT];
  return value instanceof SandboxManager ? value : undefined;
};
const backgroundOf = (context: unknown) => {
  const background = managerOf(context)?.background;
  if (!background) throw new SandboxError('sandbox_unavailable', 'Background commands are not available in this session');
  return background;
};
const check = (command: string) => {
  if (!command.trim()) throw new SandboxError('command_invalid', 'The command is empty');
  if (command.length > SANDBOX_LIMITS.maxCommandChars) throw new SandboxError('command_invalid', `Commands can be up to ${SANDBOX_LIMITS.maxCommandChars} characters`);
};
const output = (result: CommandResult, timeoutMs: number, note?: string): SandboxToolOutput => ({ text: `${formatCommandResult(result, SANDBOX_LIMITS.maxOutputChars, timeoutMs)}${note ? `\n${note}` : ''}`, exitCode: result.exitCode });

/**
 * Run a command with its automatic job card (when the turn has jobs): live
 * output is read from ~3 s on and shown in the card; the card ends with the
 * command. The result, and so what the model gets, is the same as without.
 */
async function withCommandJob<T extends { result: CommandResult }>(context: unknown, toolCallId: string | undefined, command: string, timeoutMs: number, run: (onOutput?: CommandOutputListener) => Promise<T>): Promise<T> {
  const job: CommandJob | undefined = toolCallId ? commandJob(context as Readonly<Record<string, unknown>> | undefined, toolCallId, command) : undefined;
  if (!job) return run();
  let ran: T;
  try { ran = await run(chunk => job.output(chunk)); }
  catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    await job.finish({ error: aborted || !(error instanceof SandboxError) ? 'cancelled' : 'failed', ...(error instanceof SandboxError ? { message: error.message } : {}) });
    throw error;
  }
  const { result } = ran;
  await job.finish({ exitCode: result.exitCode, timedOut: result.timedOut, timeoutMs, stdout: result.stdout, stderr: result.stderr });
  return ran;
}

/**
 * Built-in shell tools. Add them with a `sandbox` option and permissions:
 * ```ts
 * tools: { ...sandboxTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS }, sandbox: { provider: 'docker' }
 * ```
 * - `run_command` runs in the conversation's sandbox, without network, via
 *   the AI SDK `experimental_sandbox` it is given (so it also works with any
 *   other `Experimental_SandboxSession`).
 * - `run_command_online` runs one command with network access, in a
 *   separate short-lived sandbox on the same workspace. It always needs the
 *   user's approval.
 */
export const sandboxTools: {
  run_command: Tool<RunCommandInput, SandboxToolOutput>; run_command_online: Tool<CommandInput, SandboxToolOutput>;
  command_status: Tool<{ jobId?: string }, SandboxToolOutput>; command_output: Tool<{ jobId: string; tail?: number }, SandboxToolOutput>; command_stop: Tool<{ jobId: string }, SandboxToolOutput>;
} = {
  run_command: tool({
    description: 'Run a bash command in an isolated Linux sandbox with no network. /workspace holds all resources, one folder per conversation; commands start in this conversation\'s folder. Files persist and are versioned. Has Python 3 (venv in /workspace/.venv), git, rg, jq, pdftotext, curl. You are not root: sudo, apt and system installs are impossible (read-only system); put tools in /workspace (pip/uv/npm into local folders, or prebuilt binaries downloaded with run_command_online, then chmod +x and call by path). Returns the exit code and output (long output is truncated). A command is stopped after about two minutes: for anything longer than a few minutes (benchmarks, training, game series, builds, test suites) pass background: true; it returns at once with a jobId, keeps running after your turn with a live card, and you get a message when it ends. Do not poll it in a loop; end your turn, and use command_status / command_output / command_stop only when needed.',
    inputSchema: runCommandSchema,
    execute: async ({ command, cwd, background, notify }, options) => {
      try {
        check(command);
        const manager = managerOf(options.context);
        if (background) {
          if (!manager?.background) throw new SandboxError('sandbox_unavailable', 'Background commands are not available in this session; run it in the foreground (it is stopped after the command timeout)');
          const job = options.toolCallId ? commandJob(options.context as Readonly<Record<string, unknown>> | undefined, options.toolCallId, command) : undefined;
          const record = await manager.runBackground({ command, cwd, notify: notify !== false, ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}), ...(job ? { job } : {}), signal: options.abortSignal });
          const note = `Running in the background; ${record.notify ? 'you\'ll be told when it finishes' : 'you will not be told when it finishes (notify: false)'}. Use command_status / command_output / command_stop.`;
          return { text: JSON.stringify({ jobId: record.id, note }), jobId: record.id, note };
        }
        if (manager) { const { result, note } = await withCommandJob(options.context, options.toolCallId, command, manager.config.timeoutMs, onOutput => manager.run({ command, cwd, signal: options.abortSignal, ...(onOutput ? { onOutput } : {}) })); return output(result, manager.config.timeoutMs, note); }
        const session = (options as { experimental_sandbox?: Experimental_SandboxSession }).experimental_sandbox;
        if (!session) throw new SandboxError('sandbox_unavailable', 'No sandbox is configured for this agent');
        const timeoutMs = SANDBOX_LIMITS.defaultTimeoutMs;
        const { result } = await withCommandJob(options.context, options.toolCallId, command, timeoutMs, async onOutput => ({ result: await runSandboxCommand(session, { command, cwd: resolveWorkingDirectory(cwd), env: sandboxEnvironment({ git: { name: 'Sandbox', email: 'sandbox@localhost' } }), timeoutMs, signal: options.abortSignal, ...(onOutput ? { onOutput } : {}) }) }));
        return output(result, timeoutMs);
      } catch (error) { return errorOutput(error); }
    },
    toModelOutput,
  }),
  command_status: tool({
    description: 'List this conversation\'s background commands (started with run_command background: true) with their state (running, done, failed, timed_out, stopped, interrupted), exit code and time; or one, with jobId. Do not call it in a loop: you are told when a command ends.',
    inputSchema: jsonSchema<{ jobId?: string }>({ type: 'object', properties: { jobId: { type: 'string', maxLength: 60, description: 'One command\'s jobId. Default: all of this conversation\'s.' } }, additionalProperties: false }),
    execute: async ({ jobId }, options) => {
      try {
        const background = backgroundOf(options.context);
        const records = background.commands.list({ owner: background.owner }).filter(r => !jobId || r.id === jobId);
        if (jobId && !records.length) throw new SandboxError('command_invalid', `No background command ${jobId} in this conversation`);
        const list = records.slice(-20).map(r => background.commands.summary(r));
        return { text: list.length ? JSON.stringify({ commands: list }) : 'No background commands in this conversation.' };
      } catch (error) { return errorOutput(error); }
    },
    toModelOutput,
  }),
  command_output: tool({
    description: 'The latest output of a background command (running or ended): the last lines of stdout and stderr (tail: lines per stream, default 60, at most 400), bounded. Its full output is in /workspace/.jobs/<jobId>/out and err.',
    inputSchema: jsonSchema<{ jobId: string; tail?: number }>({ type: 'object', properties: { jobId: { type: 'string', maxLength: 60 }, tail: { type: 'integer', minimum: 1, maximum: BACKGROUND_LIMITS.maxTailLines } }, required: ['jobId'], additionalProperties: false }),
    execute: async ({ jobId, tail }, options) => {
      try {
        const background = backgroundOf(options.context);
        const record = background.commands.get(jobId);
        if (!record || record.owner !== background.owner) throw new SandboxError('command_invalid', `No background command ${jobId} in this conversation`);
        const read = background.commands.output(jobId, tail)!;
        const summary = background.commands.summary(read.record);
        const head = `${summary.state}${summary.exitCode !== undefined ? ` · exit code ${summary.exitCode}` : ''} · ${summary.elapsedSeconds} s · stdout ${read.stdoutBytes} bytes, stderr ${read.stderrBytes} bytes (full output: /workspace/.jobs/${jobId}/out and err)`;
        return { text: [head, read.stdout.replace(/\n$/, '') || '(no output)', ...(read.stderr.trim() ? [`[stderr]\n${read.stderr.replace(/\n$/, '')}`] : [])].join('\n') };
      } catch (error) { return errorOutput(error); }
    },
    toModelOutput,
  }),
  command_stop: tool({
    description: 'Stop a running background command and everything it started.',
    inputSchema: jsonSchema<{ jobId: string }>({ type: 'object', properties: { jobId: { type: 'string', maxLength: 60 } }, required: ['jobId'], additionalProperties: false }),
    execute: async ({ jobId }, options) => {
      try {
        const background = backgroundOf(options.context);
        const record = background.commands.get(jobId);
        if (!record || record.owner !== background.owner) throw new SandboxError('command_invalid', `No background command ${jobId} in this conversation`);
        if (record.state !== 'running') return { text: `Already ended: ${record.state}${record.exitCode !== undefined ? ` (exit code ${record.exitCode})` : ''}.` };
        const ended = await background.commands.stop(jobId, 'agent');
        return { text: ended?.state === 'running' ? 'Asked it to stop; it has not ended yet.' : `Stopped${ended?.exitCode !== undefined ? ` (exit code ${ended.exitCode})` : ''}.` };
      } catch (error) { return errorOutput(error); }
    },
    toModelOutput,
  }),
  run_command_online: tool({
    description: 'Like run_command, but with internet access, e.g. pip install (into /workspace/.venv, kept across turns) or downloads of prebuilt binaries into /workspace (no sudo or apt: not root, read-only system). The user must approve each call; use run_command when no network is needed.',
    inputSchema: commandSchema,
    execute: async ({ command, cwd }, options) => {
      try {
        check(command);
        const manager = managerOf(options.context);
        if (!manager) throw new SandboxError('sandbox_unavailable', 'Network commands are not available in this session');
        const { result, note } = await withCommandJob(options.context, options.toolCallId, command, manager.config.timeoutMs, onOutput => manager.run({ command, cwd, network: true, signal: options.abortSignal, ...(onOutput ? { onOutput } : {}) }));
        return output(result, manager.config.timeoutMs, note);
      } catch (error) { return errorOutput(error); }
    },
    toModelOutput,
  }),
};

/** One short line about a mounted project folder; `name` is its folder name on the host (for context). */
export function projectNote(name: string): string {
  const clean = name.replace(/[\p{Cc}\p{Cf}<>"]/gu, '').trim().slice(0, 80) || 'project';
  return `The user's project folder "${clean}" is at ${SANDBOX_PATHS.project} (read-write; use run_command there, e.g. ls, rg, git). ${SANDBOX_PATHS.workspace} holds conversation files.`;
}

/**
 * The sandbox tools of a session whose sandbox mounts a project: the same
 * tools, with {@link projectNote} appended to their descriptions (so the
 * model knows where the project is without a per-turn note).
 */
export function withProjectDescriptions<T extends Record<string, unknown>>(tools: T, projectPath: string): T {
  const name = projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project';
  const out: Record<string, unknown> = { ...tools };
  for (const key of ['run_command', 'run_command_online'] as const) {
    const original = out[key] as { description?: unknown } | undefined;
    if (original && original === (sandboxTools as Record<string, unknown>)[key] && typeof original.description === 'string') out[key] = { ...original, description: `${original.description} ${key === 'run_command' ? projectNote(name) : `The project folder is at ${SANDBOX_PATHS.project}.`}` };
  }
  return out as T;
}

/**
 * Default policy for the sandbox tools: commands without network run
 * without asking (they are isolated); network commands always ask.
 * `run_command_online` cannot be set to `'allow'`.
 */
export const SANDBOX_TOOL_PERMISSIONS: Readonly<Record<SandboxToolName, ToolPermission>> = Object.freeze({ run_command: 'allow', run_command_online: 'ask', command_status: 'allow', command_output: 'allow', command_stop: 'allow' });

/** Does a definition run commands? True when it has a sandbox and includes the built-in `run_command` without denying it. */
export function sandboxEnabled(definition: { tools: object; permissions: Readonly<Record<string, ToolPermission>>; sandbox?: ResolvedSandboxConfig }): boolean {
  return !!definition.sandbox && (definition.tools as Record<string, unknown>).run_command === sandboxTools.run_command && ['allow', 'ask'].includes(definition.permissions.run_command ?? 'deny');
}
/** Bridge deadline for a sandbox tool: the command timeout plus time to start a sandbox, under the harness's five-minute limit. */
export function sandboxToolTimeout(config: ResolvedSandboxConfig): number { return Math.min(config.timeoutMs + 60_000, 290_000); }
