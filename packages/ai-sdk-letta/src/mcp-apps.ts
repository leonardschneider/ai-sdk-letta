import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { jsonSchema, tool, type Tool } from 'ai';
import type { ToolPermission } from './definition.js';
import { MCP_APPS_IMAGE, SANDBOX_LABEL, SandboxError, cliOf, ensureImage, exec, remove, sweepStaleSandboxes, track, type Cli, type ResolvedSandboxConfig } from './sandbox.js';
import { FrameMux, TUNNEL_SCRIPT, handleEgress } from './webdev-tunnel.js';
import { PORT_WAIT_SCRIPT, openHttpTunnel, type McpAppHttpEndpoint } from './mcp-app-http.js';
import { normalizeWebOrigin, type CommandLine } from './webdev.js';
import { TOOL_OUTPUT_LIMIT } from './tools.js';

/**
 * MCP Apps (run mode): MCP servers whose tools come with an interactive view
 * (`_meta.ui.resourceUri`, a `ui://` HTML resource, spec 2026-01-26), installed
 * from local packages or folders and run by this process.
 *
 * - Each app's server runs in its own container with no network at all
 *   (`MCP_APPS_IMAGE`: Node and Python only), the app's files mounted
 *   read-only at `/app`, no capabilities, the host user's UID. It is reached
 *   over the stdio of `<cli> exec -i` with `@ai-sdk/mcp`; this process kills
 *   that child explicitly when it closes (closing the client alone can leave
 *   the pipes open). Origins the definition approves (`origins`) are reachable
 *   from the server through a byte tunnel and a host-side check (the same as
 *   web development's browser), at `HTTPS_PROXY=http://127.0.0.1:3128`.
 * - Tools whose visibility includes `"model"` (the default is
 *   `["model", "app"]`) join the agent's tools as `<app id>__<tool>`, with the
 *   definition's per-tool policy (default `'ask'`). The model sees the
 *   result's `content` only, within the tool output limit.
 * - Every call the agent makes of a tool with a view is recorded (server,
 *   resource, the full result with `structuredContent`), so views render
 *   again after a reload. Apps call tools with "app" visibility only, through
 *   the server (see `@ai-sdk-letta/server`); the browser never holds an MCP
 *   client.
 *
 * @module
 */

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** How a call of an app's tool is authorized (by the agent, or by the app's view). */
export type McpAppToolPolicy = ToolPermission;

/** One entry of a definition's `mcpApps`. Local sources only: never a URL. */
export interface McpAppConfig {
  /** Short ID (lowercase letters, digits, `-`; 1–24), the prefix of its tools (`<id>__<tool>`). */
  id: string;
  /** A local npm package: a tarball (`.tgz`, from `npm pack`) or an unpacked package folder. It must be self-contained (bundled, or with its `node_modules`): nothing is installed. */
  package?: string;
  /** A local folder with the server (mounted read-only at `/app`). */
  path?: string;
  /** What runs in the container (argv, working directory `/app`), for example `["node", "dist/index.js", "--stdio"]`. @default the package's `bin` (or `main`), with `node` */
  command?: readonly string[];
  /** Arguments added to the default command (for example `["--stdio"]`). Not with `command`. */
  args?: readonly string[];
  /** The package version this definition expects; another version is refused. */
  version?: string;
  /** Policy per tool name (as the server names it). @default 'ask' for every tool */
  tools?: Readonly<Record<string, McpAppToolPolicy>>;
  /** HTTPS origins the app may reach: from its server (through the egress tunnel) and from its view (intersected with the view's declared CSP). @default none */
  origins?: readonly string[];
  /**
   * How the host talks to the server: `"stdio"` (the command speaks MCP on
   * stdin/stdout) or `"http"` (Streamable HTTP: the command listens on
   * `127.0.0.1:<port>` inside its container, with `PORT` and `HOST` set;
   * reached through a tunnel, no port is published). @default "stdio"
   */
  transport?: 'stdio' | 'http';
  /** Port of an `http` server inside its container (1024–65535, not 3128). @default 3000 */
  port?: number;
  /** Path of the MCP endpoint of an `http` server (`path` is the app's folder). @default "/mcp" */
  endpoint?: string;
}
/** A validated `mcpApps` entry. */
export interface ResolvedMcpAppConfig {
  readonly id: string;
  /** Absolute path of the package (tarball or folder) or folder; none for a bare `command`. */
  readonly source?: { readonly kind: 'tarball' | 'folder'; readonly path: string };
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly version?: string;
  readonly tools: Readonly<Record<string, McpAppToolPolicy>>;
  readonly origins: readonly string[];
  /** Streamable HTTP inside the container (absent: stdio). */
  readonly http?: { readonly port: number; readonly path: string };
}

/** Limits of MCP Apps. */
export const MCP_APP_LIMITS = Object.freeze({
  maxApps: 10,
  maxOrigins: 20,
  /** Most tools of one app the agent gets. */
  maxTools: 64,
  /** Largest view (HTML) served. */
  maxHtmlBytes: 2 * 1024 * 1024,
  /** Largest result kept per call (JSON); larger results are kept without `structuredContent`. */
  maxRecordBytes: 512 * 1024,
  /** Calls recorded per agent (oldest forgotten first). */
  maxRecords: 1000,
  /** Most text of a result the model sees. */
  maxModelText: 14_000,
  /** Deadline of one tool call. */
  callTimeoutMs: 60_000,
  /** Start (container, server, discovery) deadline of one app. */
  startTimeoutMs: 120_000,
  /** Longest stdio line accepted from a server. */
  maxLineBytes: 8 * 1024 * 1024,
  /** Dev apps running at once in one conversation. */
  maxDevApps: 3,
  /** How long an HTTP server may take to accept connections after it started. */
  httpReadyTimeoutMs: 60_000,
});

/** Defaults of Streamable HTTP servers (dev apps and installed apps). */
export const MCP_APP_HTTP_DEFAULTS = Object.freeze({ port: 3000, path: '/mcp' });
/** An MCP endpoint path: starts with "/", at most 200 URL path characters, no query. */
export const MCP_APP_HTTP_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,199}$/;
/** Is this a usable server port (1024–65535)? Ports the host uses itself are refused by the callers. */
export const validHttpPort = (port: unknown): port is number => typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535;

const ID = /^[a-z][a-z0-9-]{0,23}$/;
/** Validate a definition's `mcpApps`. */
export function resolveMcpApps(input: unknown): readonly ResolvedMcpAppConfig[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) throw new Error('mcpApps must be an array such as [{ id: "clock", package: "./clock-1.0.0.tgz" }]');
  if (input.length > MCP_APP_LIMITS.maxApps) throw new Error(`At most ${MCP_APP_LIMITS.maxApps} MCP Apps`);
  const seen = new Set<string>();
  return Object.freeze(input.map((entry: unknown, index) => {
    const where = `mcpApps[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} must be an object`);
    const value = entry as Record<string, unknown>;
    const unknown = Object.keys(value).filter(key => !['id', 'package', 'path', 'command', 'args', 'version', 'tools', 'origins', 'transport', 'port', 'endpoint'].includes(key));
    if (unknown.length) throw new Error(`Unknown ${where} setting(s): ${unknown.join(', ')}. Supported: id, package, path, command, args, version, tools, origins, transport, port, endpoint.`);
    if (typeof value.id !== 'string' || !ID.test(value.id)) throw new Error(`${where}.id must be 1–24 lowercase letters, digits or "-", starting with a letter`);
    if (seen.has(value.id)) throw new Error(`Duplicate MCP App id "${value.id}"`);
    seen.add(value.id);
    if (value.package !== undefined && value.path !== undefined) throw new Error(`${where}: give package or path, not both`);
    let source: ResolvedMcpAppConfig['source'];
    for (const key of ['package', 'path'] as const) {
      const raw = value[key];
      if (raw === undefined) continue;
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000) throw new Error(`${where}.${key} must be a local path`);
      // Local sources only (privacy): no registry names, URLs or git remotes.
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) || raw.trim().startsWith('//')) throw new Error(`${where}.${key} must be a local path, not a URL: MCP Apps are installed from local packages or folders only`);
      const path = resolve(raw.trim());
      if (!existsSync(path)) throw new Error(`${where}.${key}: ${path} does not exist`);
      const folder = lstatSync(path).isDirectory();
      if (key === 'path' && !folder) throw new Error(`${where}.path must be a folder`);
      if (key === 'package' && !folder && !/\.tgz$/i.test(path)) throw new Error(`${where}.package must be a package tarball (.tgz, from npm pack) or a package folder`);
      source = { kind: folder ? 'folder' : 'tarball', path };
    }
    let command: string[] | undefined;
    if (value.command !== undefined) {
      if (!Array.isArray(value.command) || !value.command.length || value.command.length > 32 || value.command.some(a => typeof a !== 'string' || !a || a.length > 500 || /[\0\r\n]/.test(a))) throw new Error(`${where}.command must be an argv array such as ["node", "dist/index.js", "--stdio"]`);
      command = [...value.command as string[]];
    }
    if (!source && !command) throw new Error(`${where} needs package, path or command`);
    let args: string[] | undefined;
    if (value.args !== undefined) {
      if (command) throw new Error(`${where}: give args only without command (put them in command)`);
      if (!Array.isArray(value.args) || value.args.length > 32 || value.args.some(a => typeof a !== 'string' || a.length > 500 || /[\0\r\n]/.test(a))) throw new Error(`${where}.args must be an array of strings such as ["--stdio"]`);
      args = [...value.args as string[]];
    }
    if (value.version !== undefined && (typeof value.version !== 'string' || !/^[\w.+-]{1,64}$/.test(value.version))) throw new Error(`${where}.version must be a version such as "2.0.3"`);
    const tools: Record<string, McpAppToolPolicy> = {};
    if (value.tools !== undefined) {
      if (!value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools)) throw new Error(`${where}.tools must map tool names to "allow", "ask" or "deny"`);
      for (const [name, policy] of Object.entries(value.tools as Record<string, unknown>)) {
        if (!/^[\w.:/-]{1,128}$/.test(name)) throw new Error(`${where}.tools: invalid tool name "${name.slice(0, 60)}"`);
        if (policy !== 'allow' && policy !== 'ask' && policy !== 'deny') throw new Error(`${where}.tools.${name} must be "allow", "ask" or "deny"`);
        tools[name] = policy;
      }
    }
    const origins: string[] = [];
    if (value.origins !== undefined) {
      if (!Array.isArray(value.origins) || value.origins.length > MCP_APP_LIMITS.maxOrigins) throw new Error(`${where}.origins must be up to ${MCP_APP_LIMITS.maxOrigins} HTTPS origins`);
      for (const origin of value.origins) {
        const normalized = normalizeWebOrigin(origin);
        if ('error' in normalized) throw new Error(`${where}.origins: ${normalized.error}`);
        if (!origins.includes(normalized.origin)) origins.push(normalized.origin);
      }
    }
    let http: ResolvedMcpAppConfig['http'];
    if (value.transport !== undefined && value.transport !== 'stdio' && value.transport !== 'http') throw new Error(`${where}.transport must be "stdio" or "http"`);
    if (value.transport === 'http') {
      const port = value.port ?? MCP_APP_HTTP_DEFAULTS.port;
      if (!validHttpPort(port) || port === MCP_APP_PROXY_PORT) throw new Error(`${where}.port must be an integer from 1024 to 65535, not ${MCP_APP_PROXY_PORT} (the egress proxy)`);
      const path = value.endpoint ?? MCP_APP_HTTP_DEFAULTS.path;
      if (typeof path !== 'string' || !MCP_APP_HTTP_PATH.test(path)) throw new Error(`${where}.endpoint must be a URL path such as "/mcp"`);
      http = Object.freeze({ port, path });
    } else if (value.port !== undefined || value.endpoint !== undefined) throw new Error(`${where}: port and endpoint need transport "http"`);
    return Object.freeze({ id: value.id, ...(http ? { http } : {}), ...(source ? { source: Object.freeze(source) } : {}), ...(command ? { command: Object.freeze(command) } : {}), ...(args?.length ? { args: Object.freeze(args) } : {}), ...(value.version ? { version: value.version as string } : {}), tools: Object.freeze(tools), origins: Object.freeze(origins) });
  }));
}

/* ------------------------------------------------------------------ */
/* Tool metadata: visibility and views                                 */
/* ------------------------------------------------------------------ */

/** An MCP tool definition, as `tools/list` returns it. */
export type McpToolDefinition = { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> };
/** Who may see a tool. */
export type McpToolVisibility = 'model' | 'app';

/**
 * Who may see a tool (`_meta.ui.visibility`; spec 2026-01-26): when it is
 * absent (or not an array), `["model", "app"]`. Unknown entries are dropped;
 * an explicit empty list means nobody.
 *
 * `@ai-sdk/mcp` 2.0.60's `splitMCPAppTools` treats a missing visibility as
 * model-only, and its `client.tools()` does not filter at all: this predicate
 * replaces both.
 */
export function toolVisibility(definition: Pick<McpToolDefinition, '_meta'>): McpToolVisibility[] {
  const ui = definition._meta?.ui;
  const raw = ui && typeof ui === 'object' && !Array.isArray(ui) ? (ui as { visibility?: unknown }).visibility : undefined;
  if (!Array.isArray(raw)) return ['model', 'app'];
  return [...new Set(raw.filter((v): v is McpToolVisibility => v === 'model' || v === 'app'))];
}
/** May the agent (model) see and call this tool? */
export const modelVisible = (definition: Pick<McpToolDefinition, '_meta'>) => toolVisibility(definition).includes('model');
/** May an app's view call this tool? */
export const appVisible = (definition: Pick<McpToolDefinition, '_meta'>) => toolVisibility(definition).includes('app');
/** The `ui://` view of a tool (`_meta.ui.resourceUri`, or the legacy `_meta["ui/resourceUri"]`), if it has one. */
export function toolResourceUri(definition: Pick<McpToolDefinition, '_meta'>): string | undefined {
  const ui = definition._meta?.ui;
  const uri = (ui && typeof ui === 'object' && !Array.isArray(ui) ? (ui as { resourceUri?: unknown }).resourceUri : undefined) ?? definition._meta?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') && uri.length <= 500 ? uri : undefined;
}

/** The name the agent knows an app's tool by: `<app id>__<tool>`, other characters as `_`, at most 64. */
export function agentToolName(appId: string, toolName: string): string {
  return `${appId}__${toolName.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

/* ------------------------------------------------------------------ */
/* Content Security Policy of a view                                   */
/* ------------------------------------------------------------------ */

/** A view's declared CSP domains (`_meta.ui.csp` of its resource). */
export type McpAppCspDomains = { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
const CSP_KEYS = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const;

/**
 * The CSP domains a view gets: each declared domain that is an exact HTTPS
 * origin the definition approved (`origins`). Anything else (other schemes,
 * wildcards, paths, keywords, `;` or quotes) is dropped.
 */
export function grantedCsp(declared: unknown, approved: readonly string[]): Required<McpAppCspDomains> {
  const value = declared && typeof declared === 'object' && !Array.isArray(declared) ? declared as Record<string, unknown> : {};
  const granted = { connectDomains: [] as string[], resourceDomains: [] as string[], frameDomains: [] as string[], baseUriDomains: [] as string[] };
  for (const key of CSP_KEYS) {
    const list = Array.isArray(value[key]) ? value[key] as unknown[] : [];
    for (const entry of list.slice(0, 50)) {
      if (typeof entry !== 'string') continue;
      const normalized = normalizeWebOrigin(entry);
      if ('origin' in normalized && approved.includes(normalized.origin) && !granted[key].includes(normalized.origin)) granted[key].push(normalized.origin);
    }
  }
  return granted;
}
/** Declared CSP domains as the admin sees them (strings only, bounded). */
export function declaredCsp(declared: unknown): McpAppCspDomains {
  const value = declared && typeof declared === 'object' && !Array.isArray(declared) ? declared as Record<string, unknown> : {};
  const out: McpAppCspDomains = {};
  for (const key of CSP_KEYS) if (Array.isArray(value[key])) out[key] = (value[key] as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 50).map(v => v.slice(0, 200));
  return out;
}

/**
 * The `Content-Security-Policy` of a view's sandbox: the spec's restrictive
 * default, plus the granted domains (see {@link grantedCsp}); never
 * `unsafe-eval`; `object-src 'none'`; `frame-src 'none'` and
 * `base-uri 'self'` unless granted; no forms; framed only by `frameAncestor`
 * (the app's origin).
 */
export function mcpAppCsp(granted: McpAppCspDomains, frameAncestor: string): string {
  const list = (values: readonly string[] | undefined) => (values ?? []).join(' ');
  const res = list(granted.resourceDomains);
  const add = (base: string) => `${base}${res ? ` ${res}` : ''}`;
  if (!/^https?:\/\/[a-z0-9.[\]:-]+$/i.test(frameAncestor)) throw new Error('invalid_frame_ancestor');
  return [
    "default-src 'none'",
    add("script-src 'self' 'unsafe-inline'"),
    add("style-src 'self' 'unsafe-inline'"),
    add("img-src 'self' data: blob:"),
    add("font-src 'self' data:"),
    add("media-src 'self' data: blob:"),
    `connect-src ${list(granted.connectDomains) || "'none'"}`,
    `frame-src ${list(granted.frameDomains) || "'none'"}`,
    `base-uri ${list(granted.baseUriDomains) || "'self'"}`,
    "object-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestor}`,
  ].join('; ');
}

/* ------------------------------------------------------------------ */
/* Model output                                                        */
/* ------------------------------------------------------------------ */

/** An MCP `tools/call` result. */
export type McpCallResult = { content?: { type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown }[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown>; [key: string]: unknown };

/**
 * What the model sees of an app tool's result: its `content` only (text,
 * and up to 3 images), within the bridge's output limit. `structuredContent`
 * is for the view.
 */
export function mcpAppModelOutput({ output }: { output: unknown }) {
  const result = (output as { result?: McpCallResult; error?: string })?.result;
  const failure = (output as { error?: string })?.error;
  if (failure) return { type: 'error-text' as const, value: failure.slice(0, 2000) };
  const parts: ({ type: 'text'; text: string } | { type: 'image-data'; data: string; mediaType: string })[] = [];
  let budget = Math.min(MCP_APP_LIMITS.maxModelText, TOOL_OUTPUT_LIMIT - 500);
  let images = 0;
  for (const item of result?.content ?? []) {
    if (item.type === 'image' && typeof item.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(String(item.mimeType)) && images < 3 && item.data.length < 4 * 1024 * 1024) { parts.push({ type: 'image-data', data: item.data, mediaType: String(item.mimeType) }); images++; continue; }
    const text = item.type === 'text' && typeof item.text === 'string' ? item.text : `[${String(item.type).slice(0, 40)} content omitted]`;
    if (budget <= 0) continue;
    const kept = text.length > budget ? `${text.slice(0, budget)}\n[… ${text.length - budget} more characters omitted …]` : text;
    budget -= kept.length;
    parts.push({ type: 'text', text: kept });
  }
  const text = parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n');
  if (result?.isError) return { type: 'error-text' as const, value: text || 'The app reported an error.' };
  if (!parts.length) parts.push({ type: 'text', text: '(no content)' });
  if (parts.every(p => p.type === 'text')) return { type: 'text' as const, value: text || '(no content)' };
  return { type: 'content' as const, value: parts };
}

/* ------------------------------------------------------------------ */
/* Stdio transport (explicit process cleanup)                          */
/* ------------------------------------------------------------------ */

type JsonRpc = Record<string, unknown>;
/**
 * A newline-delimited JSON-RPC transport over a child process's stdio
 * (`@ai-sdk/mcp`'s `MCPTransport`). `close()` ends stdin, destroys the pipes
 * and kills the child (SIGKILL), so no handle outlives it.
 */
export class ProcessStdioTransport {
  onmessage?: (message: JsonRpc) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private child?: ChildProcess;
  private buffer = '';
  private stderrTail = '';
  private closed = false;
  constructor(private readonly line: CommandLine, private readonly spawner: typeof spawn = spawn) {}
  /** The running child (tests). */
  get process(): ChildProcess | undefined { return this.child; }
  /** The last 4 KB the server wrote to stderr (diagnostics only; never shown to the model). */
  get stderr(): string { return this.stderrTail; }
  async start(): Promise<void> {
    if (this.child) throw new Error('already_started');
    const child = this.spawner(this.line.command, this.line.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}), ...(process.env.HOME ? { HOME: process.env.HOME } : {}) } });
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > MCP_APP_LIMITS.maxLineBytes) { this.onerror?.(new Error('line_too_long')); void this.close(); return; }
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const text = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!text) continue;
        try { const message = JSON.parse(text) as JsonRpc; if (message && typeof message === 'object' && message.jsonrpc === '2.0') this.onmessage?.(message); } catch { /* not JSON-RPC: a server's stray output */ }
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-4096); });
    child.on('error', error => { this.onerror?.(error); void this.close(); });
    child.on('exit', () => { void this.close(); });
    child.stdin!.on('error', () => { /* the child exited */ });
    await new Promise<void>((done, fail) => { child.once('spawn', () => done()); child.once('error', fail); });
  }
  async send(message: JsonRpc): Promise<void> {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('transport_closed');
    const text = `${JSON.stringify(message)}\n`;
    await new Promise<void>((done, fail) => this.child!.stdin!.write(text, error => error ? fail(error) : done()));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (child) {
      child.stdin?.end(); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    this.onclose?.();
  }
}

/* ------------------------------------------------------------------ */
/* Clients and launchers                                               */
/* ------------------------------------------------------------------ */

/** What this module needs of an MCP client. */
export interface McpAppClient {
  readonly serverInfo?: { name?: string; version?: string; title?: string };
  listTools(): Promise<{ tools: McpToolDefinition[] }>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  readResource(uri: string, signal?: AbortSignal): Promise<{ contents: { uri: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }[] }>;
  /** `resources/list` (the linter compares what is listed with what is read). Optional. */
  listResources?(signal?: AbortSignal): Promise<{ resources: { uri: string; name?: string; mimeType?: string; _meta?: Record<string, unknown> }[] }>;
  close(): Promise<void>;
}
/**
 * Connects a client to a server: a command line (stdio) or a Streamable HTTP
 * endpoint (default: `@ai-sdk/mcp`, advertising the MCP Apps extension).
 * `onClose` is called when the connection is gone (the process exited, or
 * the HTTP endpoint's tunnel closed or failed).
 */
export type McpAppConnector = (target: CommandLine | McpAppHttpEndpoint, onClose: () => void) => Promise<McpAppClient>;
/** Is this connector target a Streamable HTTP endpoint? */
export const isHttpTarget = (target: CommandLine | McpAppHttpEndpoint): target is McpAppHttpEndpoint => (target as McpAppHttpEndpoint).kind === 'http';

const loadMcp = async (): Promise<typeof import('@ai-sdk/mcp')> => {
  try { return await import('@ai-sdk/mcp'); }
  catch { throw new SandboxError('sandbox_unavailable', 'MCP Apps need the optional package @ai-sdk/mcp; install it (see the ai-sdk-letta README, "MCP Apps")'); }
};
type AiSdkMcpClient = Awaited<ReturnType<typeof import('@ai-sdk/mcp')['createMCPClient']>>;
const wrapClient = (client: AiSdkMcpClient, close: () => Promise<void>): McpAppClient => ({
  serverInfo: client.serverInfo as McpAppClient['serverInfo'],
  listTools: async () => await client.listTools() as { tools: McpToolDefinition[] },
  callTool: async (name, args, signal) => await client.callTool({ name, arguments: args, ...(signal ? { options: { signal } } : {}) }) as McpCallResult,
  readResource: async (uri, signal) => await client.readResource({ uri, ...(signal ? { options: { signal } } : {}) }) as never,
  listResources: async signal => await client.listResources({ ...(signal ? { options: { signal } } : {}) }) as never,
  close,
});

/** Streamable HTTP (`@ai-sdk/mcp`'s `http` transport with the endpoint's fetch). */
async function httpConnect(mcp: typeof import('@ai-sdk/mcp'), endpoint: McpAppHttpEndpoint, onClose: () => void): Promise<McpAppClient> {
  let closed = false;
  const closeOnce = () => { if (closed) return; closed = true; unsubscribe?.(); onClose(); };
  let unsubscribe: (() => void) | undefined;
  // A failing request (the server or tunnel is gone) rejects that call; the tunnel closing ends the app.
  const client = await mcp.createMCPClient({ transport: { type: 'http', url: endpoint.url, fetch: endpoint.fetch as never }, capabilities: mcp.mcpAppClientCapabilities as never, clientName: 'ai-sdk-letta', onUncaughtError: () => {} });
  unsubscribe = endpoint.onClosed?.(closeOnce);
  return wrapClient(client, async () => { await Promise.race([client.close().catch(() => {}), new Promise(done => setTimeout(done, 2000))]); closeOnce(); });
}

export const mcpAppConnector: McpAppConnector = async (target, onClose) => {
  const mcp = await loadMcp();
  if (isHttpTarget(target)) return httpConnect(mcp, target, onClose);
  const line = target;
  const transport = new ProcessStdioTransport(line);
  const client = await mcp.createMCPClient({ transport: transport as never, capabilities: mcp.mcpAppClientCapabilities as never, clientName: 'ai-sdk-letta', onUncaughtError: () => {} }).catch(async error => { await transport.close(); throw error; });
  // The client set its own close handler while connecting: chain ours after it.
  const wrapped = transport.onclose;
  transport.onclose = () => { wrapped?.(); onClose(); };
  // The transport kills the process whatever the client does.
  return wrapClient(client, async () => { await Promise.race([client.close().catch(() => {}), new Promise(done => setTimeout(done, 2000))]); await transport.close(); });
};

/**
 * A running app server's environment (a container, or a process in tests):
 * a command line to run with stdio attached (`line`), or a Streamable HTTP
 * server that already runs (`http`).
 */
export type McpAppRuntime = McpAppRuntimeBase & ({ line: CommandLine; http?: undefined } | { http: McpAppHttpEndpoint; line?: undefined });
/** What every {@link McpAppRuntime} has. */
export interface McpAppRuntimeBase {
  /** A byte stream end for the egress tunnel (`listen 3128`), when the app has origins. */
  tunnel?: CommandLine;
  /** Stop it (remove the container, close the HTTP tunnel). Idempotent. */
  stop(): Promise<void>;
}
/** What a connector reaches for a runtime. */
export const runtimeTarget = (runtime: McpAppRuntime): CommandLine | McpAppHttpEndpoint => runtime.http ?? runtime.line!;
/** Starts an app's environment. */
export type McpAppLauncher = (app: PreparedMcpApp, signal?: AbortSignal) => Promise<McpAppRuntime>;
/** An app ready to launch: its files on the host (unpacked), and its command. */
export type PreparedMcpApp = { config: ResolvedMcpAppConfig; folder?: string; command: string[]; packageName?: string; packageVersion?: string };

/** Port of the egress proxy inside an app's container. */
export const MCP_APP_PROXY_PORT = 3128;
/** Marks an installed app's Streamable HTTP server processes (`<mark>=1`), to tell when it exited. */
const MCP_APP_MARK = 'AI_SDK_LETTA_MCP_APP';

/** The `docker run` / `container run` arguments of an app's container. */
export function mcpAppRunArgs(kind: 'docker' | 'apple-container', name: string, options: { image: string; folder?: string; labels: Readonly<Record<string, string>>; uid?: { uid: number; gid: number }; memory?: string }): string[] {
  const user = options.uid ? ['--user', `${options.uid.uid}:${options.uid.gid}`] : [];
  const labels = Object.entries(options.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  const mount = options.folder ? ['--mount', `type=bind,src=${options.folder},dst=/app,readonly`] : [];
  const keepAlive = ['sh', '-c', 'while :; do sleep 3600; done'];
  const memory = options.memory ?? '512M';
  if (kind === 'docker') return ['run', '-d', '--name', name, '--init', '--network', 'none', ...user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=128m', '--pids-limit', '256', '--memory', memory, '--cpus', '1', ...labels, ...mount, '-w', options.folder ? '/app' : '/tmp', options.image, ...keepAlive];
  return ['run', '-d', '--name', name, '--init', '--network', 'none', ...user, '--cap-drop', 'ALL', '--read-only', '--tmpfs', '/tmp', '--memory', memory, '--cpus', '1', ...labels, ...mount, options.image, ...keepAlive];
}

/** The container launcher of a built-in sandbox provider. */
export function containerLauncher(config: Pick<ResolvedSandboxConfig, 'provider' | 'binary'>, image = MCP_APPS_IMAGE): McpAppLauncher {
  const cli = cliOf(config);
  return async (app, signal) => {
    if (!cli) throw new SandboxError('sandbox_unavailable', 'MCP Apps need the built-in "docker" or "apple-container" sandbox provider');
    await sweepStaleSandboxes(config);
    await ensureImage(cli, image);
    signal?.throwIfAborted();
    const name = `ai-sdk-letta-app-${app.config.id}-${randomUUID().slice(0, 8)}`;
    const uid = typeof process.getuid === 'function' ? { uid: process.getuid(), gid: process.getgid!() } : undefined;
    const labels = { [SANDBOX_LABEL]: '1', [`${SANDBOX_LABEL}.pid`]: String(process.pid), [`${SANDBOX_LABEL}.host`]: hostname(), [`${SANDBOX_LABEL}.role`]: 'mcp-app', [`${SANDBOX_LABEL}.app`]: app.config.id };
    track(cli, name);
    const started = await exec(cli.binary, mcpAppRunArgs(cli.kind, name, { image, ...(app.folder ? { folder: app.folder } : {}), labels, ...(uid ? { uid } : {}) }), 120_000);
    if (started.code !== 0) { await remove(cli, name); throw new SandboxError('sandbox_unavailable', `The MCP App container could not start: ${started.stderr.trim().slice(-300)}`); }
    const env = app.config.origins.length ? ['-e', `HTTPS_PROXY=http://127.0.0.1:${MCP_APP_PROXY_PORT}`, '-e', `https_proxy=http://127.0.0.1:${MCP_APP_PROXY_PORT}`, '-e', 'NODE_USE_ENV_PROXY=1'] : [];
    const workdir = cli.kind === 'apple-container' && app.folder ? ['-w', '/app'] : [];
    const tunnel = app.config.origins.length ? { tunnel: { command: cli.binary, args: ['exec', '-i', name, 'node', '-e', TUNNEL_SCRIPT, 'listen', String(MCP_APP_PROXY_PORT)] } } : {};
    if (!app.config.http) {
      return {
        line: { command: cli.binary, args: ['exec', '-i', ...workdir, ...env, name, ...app.command] },
        ...tunnel,
        stop: (() => { let stopped: Promise<void> | undefined; return () => stopped ??= remove(cli as Cli, name); })(),
      };
    }
    // Streamable HTTP: the server runs detached (output to /tmp/app.log in the container) and is reached through a `connect <port>` tunnel.
    const { port, path } = app.config.http;
    const httpEnv = [...env, '-e', `PORT=${port}`, '-e', 'HOST=127.0.0.1', '-e', `${MCP_APP_MARK}=1`];
    const fail = async (message: string) => { await remove(cli as Cli, name); throw new SandboxError('sandbox_unavailable', message); };
    const detached = await exec(cli.binary, ['exec', '-d', ...workdir, ...httpEnv, name, 'sh', '-c', 'exec >>/tmp/app.log 2>&1 </dev/null; exec "$@"', 'sh', ...app.command], 30_000);
    if (detached.code !== 0) return fail(`MCP App "${app.config.id}": the server could not start: ${detached.stderr.trim().slice(-300)}`);
    const seconds = Math.round(MCP_APP_LIMITS.httpReadyTimeoutMs / 1000);
    const waited = await exec(cli.binary, ['exec', name, 'node', '-e', PORT_WAIT_SCRIPT, 'wait', String(port), String(seconds), `${MCP_APP_MARK}=1`], MCP_APP_LIMITS.httpReadyTimeoutMs + 15_000);
    const outcome = waited.stdout.trim().split('\n').at(-1) ?? '';
    if (outcome !== 'ready') {
      const log = (await exec(cli.binary, ['exec', name, 'tail', '-n', '20', '/tmp/app.log'], 15_000)).stdout.trim().slice(-1500);
      return fail(`MCP App "${app.config.id}": ${outcome === 'exited' ? 'the server exited' : `nothing listened on 127.0.0.1:${port} within ${seconds} s`}${log ? `. Its output:\n${log}` : ''}`);
    }
    const http = openHttpTunnel({ command: cli.binary, args: ['exec', '-i', name, 'node', '-e', TUNNEL_SCRIPT, 'connect', String(port)] }, `http://127.0.0.1:${port}${path}`);
    return {
      http: http.endpoint,
      ...tunnel,
      stop: (() => { let stopped: Promise<void> | undefined; return () => stopped ??= (async () => { await http.close(); await remove(cli as Cli, name); })(); })(),
    };
  };
}

/**
 * Prepare a definition's MCP Apps ahead of the first start: build the
 * runtime image (once per machine) and remove stale containers. Optional;
 * the server does the same when it starts the apps.
 */
export async function prepareMcpApps(sandbox: Pick<ResolvedSandboxConfig, 'provider' | 'binary'> | { provider: unknown; binary?: string }, log?: (line: string) => void): Promise<void> {
  const cli = cliOf(sandbox as Pick<ResolvedSandboxConfig, 'provider' | 'binary'>);
  if (!cli) return;
  await sweepStaleSandboxes(sandbox as Pick<ResolvedSandboxConfig, 'provider' | 'binary'>);
  await ensureImage(cli, MCP_APPS_IMAGE, log);
}

/**
 * Unpack (tarballs) and check an app's files: `<directory>/<id>/<sha>/package`,
 * the package version against `version`, and the default command from its
 * `bin` or `main`. Tarball entries that would leave the folder are refused.
 */
export async function prepareMcpApp(config: ResolvedMcpAppConfig, directory: string): Promise<PreparedMcpApp> {
  let folder: string | undefined;
  if (config.source?.kind === 'folder') folder = realpathSync(config.source.path);
  else if (config.source?.kind === 'tarball') {
    const bytes = readFileSync(config.source.path);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const target = join(directory, config.id, digest);
    if (!existsSync(join(target, 'package'))) {
      const listed = await exec('tar', ['-tzf', config.source.path], 60_000);
      if (listed.code !== 0) throw new SandboxError('command_invalid', `MCP App "${config.id}": ${basename(config.source.path)} is not a readable package tarball`);
      const entries = listed.stdout.split('\n').filter(Boolean);
      if (!entries.length || entries.some(entry => isAbsolute(entry) || entry.split('/').includes('..') || !entry.startsWith('package/'))) throw new SandboxError('command_invalid', `MCP App "${config.id}": the tarball has entries outside "package/"`);
      const staging = `${target}.${process.pid}.tmp`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const unpacked = await exec('tar', ['-xzf', config.source.path, '-C', staging, '--no-same-owner', '--no-same-permissions'], 120_000);
      if (unpacked.code !== 0) { rmSync(staging, { recursive: true, force: true }); throw new SandboxError('command_invalid', `MCP App "${config.id}": the tarball could not be unpacked`); }
      // No links that point outside the package.
      const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isSymbolicLink()) { const real = (() => { try { return realpathSync(full); } catch { return ''; } })(); const rel = relative(staging, real); if (!real || rel.startsWith('..') || isAbsolute(rel)) { rmSync(staging, { recursive: true, force: true }); throw new SandboxError('command_invalid', `MCP App "${config.id}": the tarball has a link outside the package`); } } else if (entry.isDirectory()) walk(full); } };
      walk(staging);
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    }
    folder = join(target, 'package');
  }
  let packageName: string | undefined;
  let packageVersion: string | undefined;
  let command = config.command ? [...config.command] : undefined;
  const manifest = folder ? join(folder, 'package.json') : undefined;
  if (manifest && existsSync(manifest)) {
    let pkg: { name?: unknown; version?: unknown; bin?: unknown; main?: unknown };
    try { pkg = JSON.parse(readFileSync(manifest, 'utf8')); } catch { throw new SandboxError('command_invalid', `MCP App "${config.id}": package.json is not valid JSON`); }
    if (typeof pkg.name === 'string') packageName = pkg.name.slice(0, 214);
    if (typeof pkg.version === 'string') packageVersion = pkg.version.slice(0, 64);
    if (!command) {
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin as Record<string, unknown>).find(v => typeof v === 'string') as string | undefined : undefined;
      const entry = bin ?? (typeof pkg.main === 'string' ? pkg.main : undefined);
      if (entry && !entry.split('/').includes('..') && !isAbsolute(entry)) command = ['node', entry.replace(/^\.\//, ''), ...(config.args ?? [])];
    }
  }
  if (config.version !== undefined && packageVersion !== config.version) throw new SandboxError('command_invalid', `MCP App "${config.id}": expected version ${config.version}, found ${packageVersion ?? 'none'}`);
  if (!command) throw new SandboxError('command_invalid', `MCP App "${config.id}": no command (set "command", or a package.json "bin" or "main")`);
  return { config, ...(folder ? { folder } : {}), command, ...(packageName ? { packageName } : {}), ...(packageVersion ? { packageVersion } : {}) };
}

/* ------------------------------------------------------------------ */
/* Records: the calls behind views                                     */
/* ------------------------------------------------------------------ */

/** One call of an app tool whose result a view shows (kept so it renders again after a reload). */
export type McpAppRecord = {
  conversationId: string; toolCallId: string; app: string; tool: string; agentTool: string; resourceUri: string; input: Record<string, unknown>;
  /** `running` while the call runs (its view shows the input), `done` with its result, `cancelled` when it failed or was interrupted (`reason`). */
  status: 'running' | 'done' | 'cancelled';
  result?: McpCallResult; reason?: string; at: string;
  /** The view's resource when the call ran (`fingerprintMCPAppResource`). */
  fingerprint?: string;
  /** The result was larger than the limit: kept without `structuredContent`. */
  truncated?: boolean;
};
/** Records of an agent's app calls, in one private JSON file (0600, atomic writes). */
export class McpAppRecords {
  private records: McpAppRecord[];
  constructor(private readonly file: string) {
    try { const saved = JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown }; this.records = Array.isArray(saved.records) ? saved.records as McpAppRecord[] : []; } catch { this.records = []; }
    // Calls that were running when the process stopped never finished here.
    let interrupted = false;
    for (const record of this.records) { record.status ??= record.result ? 'done' : 'cancelled'; if (record.status === 'running') { record.status = 'cancelled'; record.reason = 'interrupted'; interrupted = true; } }
    if (interrupted) this.save();
  }
  /** Keep a call (bounded: the result without `structuredContent` when too large; the oldest records forgotten first). */
  add(record: McpAppRecord): McpAppRecord {
    let kept = structuredClone(record);
    if (kept.result && Buffer.byteLength(JSON.stringify(kept.result)) > MCP_APP_LIMITS.maxRecordBytes) {
      const { structuredContent: _dropped, ...rest } = kept.result;
      kept = { ...kept, result: Buffer.byteLength(JSON.stringify(rest)) > MCP_APP_LIMITS.maxRecordBytes ? { content: [{ type: 'text', text: '[result too large to keep]' }], ...(rest.isError ? { isError: true } : {}) } : rest, truncated: true };
    }
    this.records = [...this.records.filter(r => !(r.toolCallId === kept.toolCallId && r.conversationId === kept.conversationId)), kept].slice(-MCP_APP_LIMITS.maxRecords);
    this.save();
    return kept;
  }
  /** The record of a call in one of these conversations. */
  get(toolCallId: string, conversations: readonly string[]): McpAppRecord | undefined {
    const found = this.records.find(r => r.toolCallId === toolCallId && conversations.includes(r.conversationId));
    return found ? structuredClone(found) : undefined;
  }
  get size(): number { return this.records.length; }
  /** The agent tool names of recorded calls (history shows their calls even when the app did not start). */
  agentToolNames(): string[] { return [...new Set(this.records.map(r => r.agentTool))]; }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, records: this.records }), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

/* ------------------------------------------------------------------ */
/* The apps of an agent                                                */
/* ------------------------------------------------------------------ */

/** A view's resource, read from its server. */
export type McpAppView = { uri: string; html: string; meta: { csp?: unknown; permissions?: unknown; prefersBorder?: boolean; domain?: unknown }; fingerprint: string };
/** One tool of an app, as discovered. */
export type McpAppToolInfo = { name: string; agentTool?: string; title?: string; description?: string; inputSchema: Record<string, unknown>; visibility: McpToolVisibility[]; policy: McpAppToolPolicy; resourceUri?: string };
/** What the admin sees of an app. */
export type McpAppStatus = {
  id: string; name: string; version?: string; packageName?: string; status: 'starting' | 'running' | 'failed' | 'stopped'; error?: string; enabled: boolean;
  tools: McpAppToolInfo[]; origins: string[];
  /** Each view's declared CSP domains, and those granted (declared and approved). */
  views: { uri: string; declared: McpAppCspDomains; granted: Required<McpAppCspDomains>; fingerprint?: string }[];
  /** A dev app (`mcp_app_dev_start`): the conversation it belongs to, its folder and command, and how many times it was (re)started. */
  dev?: { conversationId: string; folder: string; command: string; generation: number; startedAt: string };
};
/** A failure with a fixed code (refused calls, unavailable apps). */
export class McpAppError extends Error {
  override readonly name = 'McpAppError';
  constructor(readonly code: 'app_unknown' | 'app_unavailable' | 'app_disabled' | 'tool_unknown' | 'not_app_visible' | 'not_model_visible' | 'tool_denied' | 'resource_refused' | 'resource_invalid' | 'call_failed', message: string) { super(message); }
}

type Live = { prepared?: PreparedMcpApp; runtime?: McpAppRuntime; client?: McpAppClient; tunnel?: { mux: FrameMux; child: ChildProcess }; tools: McpToolDefinition[]; views: Map<string, McpAppView>; status: McpAppStatus['status']; error?: string; serverInfo?: McpAppClient['serverInfo']; dev?: DevApp };

/**
 * A dev app (MCP Apps dev mode, see `mcpAppDevTools`): an MCP server the
 * agent is writing, run over stdio in its conversation's services container.
 * It belongs to that conversation only: its tools are `dev_<name>__<tool>`
 * there, its views carry a "Dev" badge, and calls from its views ask.
 */
export interface McpAppDevSpec {
  /** Short name (lowercase letters, digits, `-`; 1–20): the app is `dev_<name>`. */
  name: string;
  conversationId: string;
  /** Where it runs (the container path), and the command, for status and reloads. */
  folder: string;
  command: string;
  /** Starts the server (the command line with stdio attached, and how to stop it). Called again by {@link McpApps.reloadDev}. */
  launch(signal?: AbortSignal): Promise<McpAppRuntime>;
  /** A call reached the app (keeps its container alive). */
  touch?(): void;
}
type DevApp = McpAppDevSpec & { generation: number; startedAt: string };
/** The app ID of a dev app: `dev_<name>`. */
export const devAppId = (name: string) => `dev_${name}`;
/** Valid dev app names: lowercase letters, digits and `-`, 1–20, starting with a letter. */
export const DEV_APP_NAME = /^[a-z][a-z0-9-]{0,19}$/;
/** Is this the ID of a dev app (`dev_<name>`)? */
export const isDevAppId = (id: string) => id.startsWith('dev_') && DEV_APP_NAME.test(id.slice(4));
/** What a (re)start of a dev app found: its tools and views, and what changed since the previous start. */
export type McpAppDevStart = {
  app: string; status: McpAppStatus['status']; error?: string; generation: number;
  tools: McpAppToolInfo[];
  views: { uri: string; fingerprint: string; changed?: boolean; error?: string }[];
  /** Compared with the previous start (reloads only). */
  changes?: { added: string[]; removed: string[]; changed: string[]; viewsChanged: string[] };
};
/** A model-visible tool's identity for the next turn: name, description, input schema. */
const toolSignature = (tools: readonly McpToolDefinition[]) => createHash('sha256').update(JSON.stringify(tools.filter(modelVisible).map(t => [t.name, t.description ?? '', t.title ?? '', t.inputSchema ?? null, toolResourceUri(t) ?? '']))).digest('base64url').slice(0, 16);

/** Options of {@link McpApps}. */
export interface McpAppsOptions {
  /** Where tarballs are unpacked, and records and settings are kept: `<directory>/` (private). */
  directory: string;
  /** The sandbox provider whose CLI runs the containers. */
  sandbox?: Pick<ResolvedSandboxConfig, 'provider' | 'binary'>;
  /** Starts an app's environment. @default containers of `sandbox`'s provider ({@link containerLauncher}) */
  launcher?: McpAppLauncher;
  /** @default {@link mcpAppConnector} */
  connector?: McpAppConnector;
  /** Something changed (an app started, stopped, was enabled). */
  onChange?: () => void;
  log?: (line: string) => void;
}
/** Key of a tool's context under which the bridge passes the conversation's apps (see {@link mcpAppTools}). */
export const MCP_APPS_CONTEXT = 'ai-sdk-letta.mcp-apps';

/**
 * The MCP Apps of an agent: started once (lazily, by {@link ready}) and
 * shared by its conversations until {@link close}. Servers that fail to
 * start are reported (status `failed`); the others still work.
 */
export class McpApps {
  private readonly live = new Map<string, Live>();
  private starting?: Promise<void>;
  private closed = false;
  readonly records: McpAppRecords;
  private readonly settingsFile: string;
  private disabled = new Set<string>();
  private readonly launcher: McpAppLauncher;
  private readonly connector: McpAppConnector;
  constructor(readonly configs: readonly ResolvedMcpAppConfig[], private readonly options: McpAppsOptions) {
    this.records = new McpAppRecords(join(options.directory, 'records.json'));
    this.settingsFile = join(options.directory, 'settings.json');
    try { const saved = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as { disabled?: unknown }; if (Array.isArray(saved.disabled)) this.disabled = new Set(saved.disabled.filter((v): v is string => typeof v === 'string')); } catch { /* none yet */ }
    const sandbox = options.sandbox;
    this.launcher = options.launcher ?? (sandbox ? containerLauncher(sandbox) : async () => { throw new SandboxError('sandbox_unavailable', 'MCP Apps need a sandbox (provider "docker" or "apple-container")'); });
    this.connector = options.connector ?? mcpAppConnector;
    for (const config of configs) this.live.set(config.id, { tools: [], views: new Map(), status: 'stopped' });
  }

  /** Start every app (once; later calls wait for the same start). Never throws: failures are per app. */
  ready(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.starting ??= Promise.allSettled(this.configs.map(config => this.start(config))).then(() => undefined);
  }
  private async start(config: ResolvedMcpAppConfig): Promise<void> {
    const live = this.live.get(config.id)!;
    live.status = 'starting'; this.changed();
    const deadline = AbortSignal.timeout(MCP_APP_LIMITS.startTimeoutMs);
    const started = Date.now();
    try {
      const prepared = live.prepared = await prepareMcpApp(config, join(this.options.directory, 'packages'));
      const runtime = live.runtime = await this.launcher(prepared, deadline);
      if (this.closed) { await runtime.stop(); return; }
      if (runtime.tunnel) live.tunnel = this.egress(config, runtime.tunnel);
      const client = live.client = await withDeadline(this.connector(runtimeTarget(runtime), () => { if (live.client === client) { live.status = 'stopped'; live.error = 'The app server exited.'; this.changed(); } }), deadline, 'start_timeout');
      live.serverInfo = client.serverInfo;
      const listed = await withDeadline(client.listTools(), deadline, 'start_timeout');
      live.tools = (Array.isArray(listed.tools) ? listed.tools : []).filter(t => t && typeof t.name === 'string' && /^[\w.:/-]{1,128}$/.test(t.name)).slice(0, MCP_APP_LIMITS.maxTools);
      // Read every view now: its CSP is known to the admin, and its fingerprint to the records.
      for (const uri of new Set(live.tools.map(toolResourceUri).filter((u): u is string => !!u))) {
        try { live.views.set(uri, await this.readView(client, uri, deadline)); } catch (error) { this.options.log?.(`MCP App ${config.id}: its view ${uri} could not be read (${error instanceof Error ? error.message.slice(0, 200) : 'error'}).`); }
      }
      live.status = 'running'; delete live.error;
      this.options.log?.(`MCP App ${config.id}: ${live.serverInfo?.name ?? prepared.packageName ?? config.id}${prepared.packageVersion ? ` ${prepared.packageVersion}` : ''} started in ${Date.now() - started} ms · ${live.tools.length} tool(s), ${live.views.size} view(s).`);
    } catch (error) {
      live.status = 'failed';
      live.error = error instanceof Error ? error.message.slice(0, 500) : 'The app could not start.';
      this.options.log?.(`MCP App ${config.id} failed to start: ${live.error}`);
      await this.stopOne(live);
      live.status = 'failed';
    } finally { this.changed(); }
  }
  private egress(config: ResolvedMcpAppConfig, line: CommandLine) {
    const child = spawn(line.command, line.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const mux = FrameMux.of(child);
    mux.onIncoming = stream => { void handleEgress(stream, { allowed: origin => config.origins.includes(origin) }); };
    return { mux, child };
  }
  private async readView(client: McpAppClient, uri: string, signal?: AbortSignal): Promise<McpAppView> {
    const read = await client.readResource(uri, signal);
    const content = (read?.contents ?? []).find(c => c.uri === uri);
    if (!content) throw new McpAppError('resource_invalid', 'The view resource is missing');
    if (content.mimeType !== 'text/html;profile=mcp-app') throw new McpAppError('resource_invalid', `The view has MIME type ${String(content.mimeType).slice(0, 80)}, not text/html;profile=mcp-app`);
    const html = typeof content.text === 'string' ? content.text : typeof content.blob === 'string' ? Buffer.from(content.blob, 'base64').toString('utf8') : '';
    if (!html || Buffer.byteLength(html) > MCP_APP_LIMITS.maxHtmlBytes) throw new McpAppError('resource_invalid', 'The view is empty or too large');
    const ui = content._meta?.ui && typeof content._meta.ui === 'object' ? content._meta.ui as Record<string, unknown> : {};
    const meta = { ...(ui.csp !== undefined ? { csp: ui.csp } : {}), ...(ui.permissions !== undefined ? { permissions: ui.permissions } : {}), ...(typeof ui.prefersBorder === 'boolean' ? { prefersBorder: ui.prefersBorder } : {}), ...(ui.domain !== undefined ? { domain: ui.domain } : {}) };
    const fingerprint = createHash('sha256').update(JSON.stringify([html, declaredCsp(meta.csp), meta.permissions ?? null])).digest('base64url');
    return { uri, html, meta, fingerprint };
  }
  private changed() { try { this.options.onChange?.(); } catch { /* observer */ } }

  /** The app of an ID (dev apps: no policies, no origins). */
  config(appId: string): ResolvedMcpAppConfig | undefined {
    return this.configs.find(c => c.id === appId) ?? (this.live.get(appId)?.dev ? Object.freeze({ id: appId, tools: Object.freeze({}), origins: Object.freeze([]) }) : undefined);
  }
  private running(appId: string): Live & { client: McpAppClient } {
    const live = this.live.get(appId);
    if (!live) throw new McpAppError('app_unknown', `No MCP App "${appId}"`);
    if (this.disabled.has(appId)) throw new McpAppError('app_disabled', `The MCP App "${appId}" is disabled`);
    if (live.status !== 'running' || !live.client) throw new McpAppError('app_unavailable', `The MCP App "${appId}" is not running${live.error ? `: ${live.error}` : ''}`);
    return live as Live & { client: McpAppClient };
  }
  /**
   * Policy of an app's tool (the definition's, default `'ask'`). Dev apps:
   * the agent's own calls run (`'allow'`: its code, in its own container
   * without network, like `run_command`); calls from their views ask.
   */
  policy(appId: string, toolName: string, caller: 'agent' | 'app' = 'app'): McpAppToolPolicy {
    if (this.live.get(appId)?.dev) return caller === 'agent' ? 'allow' : 'ask';
    return this.config(appId)?.tools[toolName] ?? 'ask';
  }
  /** May a view of this app render in (and act for) this conversation? Installed apps: any; dev apps: only their own. */
  servesConversation(appId: string, conversationId: string): boolean {
    const dev = this.live.get(appId)?.dev;
    return !dev || dev.conversationId === conversationId;
  }
  /** Is this app a dev app? */
  isDev(appId: string): boolean { return !!this.live.get(appId)?.dev; }
  /** A tool definition of a running (or started) app. */
  toolDefinition(appId: string, toolName: string): McpToolDefinition | undefined { return this.live.get(appId)?.tools.find(t => t.name === toolName); }

  /**
   * The agent's tools: model-visible tools of running apps whose policy is
   * not `'deny'`; with a conversation, also the tools of its running dev
   * apps (`dev_<name>__<tool>`), and those of every conversation with `'*'`.
   */
  agentTools(conversationId?: string): { tools: Record<string, Tool>; permissions: Record<string, ToolPermission>; names: Map<string, { app: string; tool: string }> } {
    const tools: Record<string, Tool> = {};
    const permissions: Record<string, ToolPermission> = {};
    const names = new Map<string, { app: string; tool: string }>();
    const ids = [...this.configs.map(c => c.id), ...[...this.live.entries()].filter(([, live]) => live.dev && (conversationId === '*' || live.dev.conversationId === conversationId)).map(([id]) => id)];
    for (const id of ids) {
      const live = this.live.get(id)!;
      if (live.status !== 'running') continue;
      for (const definition of live.tools) {
        const policy = this.policy(id, definition.name, 'agent');
        if (!modelVisible(definition) || policy === 'deny') continue;
        const name = agentToolName(id, definition.name);
        if (names.has(name)) continue;
        names.set(name, { app: id, tool: definition.name });
        tools[name] = mcpAppTool(id, definition, live.serverInfo?.title ?? live.serverInfo?.name ?? id, !!live.dev);
        permissions[name] = policy;
      }
    }
    return { tools, permissions, names };
  }
  /** The model-visible tools of a conversation's dev apps, as one value: when it changes, its sessions need the new tool list (at the next turn). */
  devSignature(conversationId: string): string {
    return [...this.live.entries()].filter(([, live]) => live.dev?.conversationId === conversationId && live.status === 'running').map(([id, live]) => `${id}:${toolSignature(live.tools)}`).sort().join(',');
  }

  /** Call a tool as the agent (model-visible tools only). Records calls of tools with a view. */
  async callAsAgent(agentTool: string, input: Record<string, unknown>, call: { conversationId: string; toolCallId: string; signal?: AbortSignal }): Promise<McpCallResult> {
    const target = this.agentTools(call.conversationId).names.get(agentTool);
    if (!target) throw new McpAppError('tool_unknown', `No app tool ${agentTool}`);
    const definition = this.toolDefinition(target.app, target.tool);
    if (!definition || !modelVisible(definition)) throw new McpAppError('not_model_visible', 'That tool is not available to the agent');
    const uri = toolResourceUri(definition);
    const fingerprint = uri ? this.live.get(target.app)?.views.get(uri)?.fingerprint : undefined;
    const base = uri ? { conversationId: call.conversationId, toolCallId: call.toolCallId, app: target.app, tool: target.tool, agentTool, resourceUri: uri, input: structuredClone(input), ...(fingerprint ? { fingerprint } : {}) } : undefined;
    // The view can show while the call runs (with its input); it gets the result, or a cancellation, when the call ends.
    if (base) this.records.add({ ...base, status: 'running', at: new Date().toISOString() });
    try {
      const result = await this.call(target.app, target.tool, input, call.signal);
      if (base) this.records.add({ ...base, status: 'done', result, at: new Date().toISOString() });
      return result;
    } catch (error) {
      if (base) this.records.add({ ...base, status: 'cancelled', reason: call.signal?.aborted ? 'cancelled' : error instanceof McpAppError ? error.code : 'call_failed', at: new Date().toISOString() });
      throw error;
    }
  }
  /**
   * Call a tool for an app's view: only tools whose visibility includes
   * `"app"` (spec: refused otherwise), and never one whose policy is `'deny'`.
   * The caller (the server) asks the person first when the policy is `'ask'`.
   */
  async callAsApp(appId: string, toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const live = this.running(appId);
    const definition = live.tools.find(t => t.name === toolName);
    if (!definition) throw new McpAppError('tool_unknown', `The app has no tool ${toolName.slice(0, 80)}`);
    if (!appVisible(definition)) throw new McpAppError('not_app_visible', `Tool ${toolName.slice(0, 80)} is not available to apps`);
    if (this.policy(appId, toolName) === 'deny') throw new McpAppError('tool_denied', `Tool ${toolName.slice(0, 80)} is denied by policy`);
    return this.call(appId, toolName, input, signal);
  }
  private async call(appId: string, toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const live = this.running(appId);
    try { live.dev?.touch?.(); } catch { /* observer */ }
    const deadline = AbortSignal.timeout(MCP_APP_LIMITS.callTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const result = await withDeadline(live.client.callTool(toolName, input, combined), combined, 'call_timeout');
      if (!result || typeof result !== 'object' || (result.content !== undefined && !Array.isArray(result.content))) throw new McpAppError('call_failed', 'The app returned an invalid result');
      return result;
    } catch (error) {
      if (error instanceof McpAppError) throw error;
      throw new McpAppError('call_failed', combined.aborted ? 'The app did not answer in time' : `The app failed: ${error instanceof Error ? error.message.slice(0, 300) : 'error'}`);
    }
  }
  /** A view of an app (read at start; read again when unknown). */
  async view(appId: string, uri: string): Promise<McpAppView> {
    const live = this.running(appId);
    if (!uri.startsWith('ui://')) throw new McpAppError('resource_refused', 'Only ui:// resources are views');
    const known = live.views.get(uri);
    if (known) return known;
    if (!live.tools.some(t => toolResourceUri(t) === uri)) throw new McpAppError('resource_refused', 'No tool of this app has that view');
    const read = await this.readView(live.client, uri);
    live.views.set(uri, read);
    return read;
  }
  /** `resources/read` for a view: `ui://` resources of the same app only. */
  async readResource(appId: string, uri: string): Promise<{ contents: unknown[] }> {
    const live = this.running(appId);
    if (typeof uri !== 'string' || !uri.startsWith('ui://') || uri.length > 500) throw new McpAppError('resource_refused', 'Apps may only read ui:// resources');
    const read = await withDeadline(live.client.readResource(uri), AbortSignal.timeout(MCP_APP_LIMITS.callTimeoutMs), 'call_timeout');
    const contents = (read?.contents ?? []).filter(c => c && c.uri === uri).slice(0, 4);
    if (Buffer.byteLength(JSON.stringify(contents)) > MCP_APP_LIMITS.maxHtmlBytes) throw new McpAppError('resource_invalid', 'The resource is too large');
    return { contents };
  }

  /** Enable or disable an app (its tools refuse calls and its views do not render while disabled). Kept across restarts. */
  setEnabled(appId: string, enabled: boolean): void {
    if (!this.live.has(appId) || this.live.get(appId)!.dev) throw new McpAppError('app_unknown', `No MCP App "${appId}"`);
    if (enabled) this.disabled.delete(appId); else this.disabled.add(appId);
    mkdirSync(dirname(this.settingsFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.settingsFile, JSON.stringify({ disabled: [...this.disabled] }), { mode: 0o600 });
    this.changed();
  }
  enabled(appId: string): boolean { return !this.disabled.has(appId); }
  /** Display name of an app. */
  name(appId: string): string { const live = this.live.get(appId); return String(live?.serverInfo?.title ?? live?.serverInfo?.name ?? live?.prepared?.packageName ?? appId).slice(0, 120); }

  /** Every app, for the admin. */
  status(): McpAppStatus[] {
    const devs = [...this.live.entries()].filter(([, live]) => live.dev).map(([id]) => this.config(id)!);
    return [...this.configs, ...devs].map(config => {
      const live = this.live.get(config.id)!;
      const dev = live.dev ? { dev: { conversationId: live.dev.conversationId, folder: live.dev.folder, command: live.dev.command, generation: live.dev.generation, startedAt: live.dev.startedAt } } : {};
      return { ...dev,
        id: config.id, name: this.name(config.id), ...(live.prepared?.packageVersion ?? live.serverInfo?.version ? { version: String(live.prepared?.packageVersion ?? live.serverInfo?.version).slice(0, 64) } : {}), ...(live.prepared?.packageName ? { packageName: live.prepared.packageName } : {}),
        status: live.status, ...(live.error ? { error: live.error } : {}), enabled: this.enabled(config.id), origins: [...config.origins],
        tools: live.tools.map(t => { const uri = toolResourceUri(t); const visibility = toolVisibility(t); return { name: t.name, ...(visibility.includes('model') && this.policy(config.id, t.name, 'agent') !== 'deny' ? { agentTool: agentToolName(config.id, t.name) } : {}), ...(typeof t.title === 'string' ? { title: t.title.slice(0, 120) } : {}), ...(typeof t.description === 'string' ? { description: t.description.slice(0, 500) } : {}), inputSchema: t.inputSchema ?? { type: 'object' }, visibility, policy: this.policy(config.id, t.name), ...(uri ? { resourceUri: uri } : {}) }; }),
        views: [...live.views.values()].map(view => ({ uri: view.uri, declared: declaredCsp(view.meta.csp), granted: grantedCsp(view.meta.csp, config.origins), fingerprint: view.fingerprint })),
      };
    });
  }
  /** App tools of the agent with a view: `agentTool → { app, tool, title }`, for the browser. */
  viewTools(): Record<string, { app: string; appName: string; tool: string; title?: string; dev?: true }> {
    const out: Record<string, { app: string; appName: string; tool: string; title?: string; dev?: true }> = {};
    for (const [name, target] of this.agentTools('*').names) {
      const definition = this.toolDefinition(target.app, target.tool);
      if (definition && toolResourceUri(definition)) out[name] = { app: target.app, appName: this.name(target.app), tool: target.tool, ...(typeof definition.title === 'string' ? { title: definition.title.slice(0, 120) } : {}), ...(this.isDev(target.app) ? { dev: true as const } : {}) };
    }
    return out;
  }
  /**
   * Each dev app's generation (it grows with every reload): open views of an
   * app render again when it changes. While a (re)start runs, the previous
   * one: views remount once the new server answers, not while it starts.
   */
  devGenerations(): Record<string, number> {
    return Object.fromEntries([...this.live.entries()].filter(([, live]) => live.dev).map(([id, live]) => [id, live.dev!.generation - (live.status === 'starting' ? 1 : 0)]));
  }

  /* ---------------- dev apps (MCP Apps dev mode) ---------------- */

  /** The dev apps of a conversation (their IDs). */
  devApps(conversationId: string): string[] { return [...this.live.entries()].filter(([, live]) => live.dev?.conversationId === conversationId).map(([id]) => id); }
  /** A dev app's spec, if `appId` is one. */
  devSpec(appId: string): Readonly<DevApp> | undefined { return this.live.get(appId)?.dev; }
  /** The running client of an app (the linter and `mcp_app_dev_call`). */
  client(appId: string): McpAppClient { return this.running(appId).client; }
  /**
   * Start a dev app for a conversation (`dev_<name>`), or restart it with a
   * new spec. A name another conversation uses is refused. Never throws for
   * a server that fails: the result says `failed`, with the error.
   */
  async startDev(spec: McpAppDevSpec, signal?: AbortSignal): Promise<McpAppDevStart> {
    if (this.closed) throw new McpAppError('app_unavailable', 'MCP Apps are closed');
    if (!DEV_APP_NAME.test(spec.name)) throw new McpAppError('app_unknown', 'A dev app name is 1–20 lowercase letters, digits or "-", starting with a letter');
    const id = devAppId(spec.name);
    if (this.configs.some(c => c.id === id)) throw new McpAppError('app_unknown', `"${id}" is an installed app`);
    const known = this.live.get(id);
    if (known?.dev && known.dev.conversationId !== spec.conversationId) throw new McpAppError('app_unknown', `The dev app name "${spec.name}" is used by another conversation; choose another name`);
    if (!known && this.devApps(spec.conversationId).length >= MCP_APP_LIMITS.maxDevApps) throw new McpAppError('app_unknown', `At most ${MCP_APP_LIMITS.maxDevApps} dev apps per conversation; stop one first`);
    const before = known ? { tools: known.tools, views: new Map(known.views) } : undefined;
    if (known) await this.stopOne(known);
    const live: Live = known ?? { tools: [], views: new Map(), status: 'stopped' };
    live.dev = { ...spec, generation: (known?.dev?.generation ?? 0) + 1, startedAt: new Date().toISOString() };
    live.tools = []; live.views = new Map(); delete live.error; delete live.serverInfo;
    this.live.set(id, live);
    live.status = 'starting'; this.changed();
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(MCP_APP_LIMITS.startTimeoutMs)]) : AbortSignal.timeout(MCP_APP_LIMITS.startTimeoutMs);
    const viewErrors = new Map<string, string>();
    try {
      const runtime = live.runtime = await spec.launch(deadline);
      if (this.closed) { await runtime.stop(); throw new Error('closed'); }
      const client = live.client = await withDeadline(this.connector(runtimeTarget(runtime), () => { if (live.client === client) { live.status = 'stopped'; live.error = 'The dev app server exited (see mcp_app_dev_logs).'; this.changed(); } }), deadline, 'start_timeout');
      live.serverInfo = client.serverInfo;
      const listed = await withDeadline(client.listTools(), deadline, 'start_timeout');
      live.tools = (Array.isArray(listed?.tools) ? listed.tools : []).filter(t => t && typeof t.name === 'string' && /^[\w.:/-]{1,128}$/.test(t.name)).slice(0, MCP_APP_LIMITS.maxTools);
      for (const uri of new Set(live.tools.map(toolResourceUri).filter((u): u is string => !!u))) {
        try { live.views.set(uri, await this.readView(client, uri, deadline)); } catch (error) { viewErrors.set(uri, error instanceof Error ? error.message.slice(0, 200) : 'unreadable'); }
      }
      live.status = 'running';
      this.options.log?.(`Dev app ${id}: generation ${live.dev.generation} started · ${live.tools.length} tool(s), ${live.views.size} view(s).`);
    } catch (error) {
      const message = error instanceof Error ? (error.message === 'start_timeout' ? `The server did not answer within ${MCP_APP_LIMITS.startTimeoutMs / 1000} s (${live.runtime?.http ? `does it serve Streamable HTTP at ${live.runtime.http.url}?` : 'does it speak MCP over stdio?'} see mcp_app_dev_logs)` : error.message.slice(0, 500)) : 'The dev app could not start.';
      await this.stopOne(live);
      live.status = 'failed'; live.error = message;
    } finally { this.changed(); }
    const tools = this.status().find(s => s.id === id)?.tools ?? [];
    const views = [...new Set([...live.views.keys(), ...viewErrors.keys()])].map(uri => ({ uri, fingerprint: live.views.get(uri)?.fingerprint ?? '', ...(before && before.views.get(uri)?.fingerprint !== live.views.get(uri)?.fingerprint ? { changed: true } : {}), ...(viewErrors.has(uri) ? { error: viewErrors.get(uri)! } : {}) }));
    const changes = before ? (() => {
      const old = new Map(before.tools.map(t => [t.name, JSON.stringify(t)]));
      const now = new Map(live.tools.map(t => [t.name, JSON.stringify(t)]));
      return { added: [...now.keys()].filter(n => !old.has(n)), removed: [...old.keys()].filter(n => !now.has(n)), changed: [...now.keys()].filter(n => old.has(n) && old.get(n) !== now.get(n)), viewsChanged: views.filter(v => v.changed).map(v => v.uri) };
    })() : undefined;
    return { app: id, status: live.status, ...(live.error ? { error: live.error } : {}), generation: live.dev.generation, tools, views, ...(changes ? { changes } : {}) };
  }
  /** Restart a dev app with the same folder and command: its server is started again and its views read again (see {@link startDev}). */
  async reloadDev(appId: string, signal?: AbortSignal): Promise<McpAppDevStart> {
    const dev = this.live.get(appId)?.dev;
    if (!dev) throw new McpAppError('app_unknown', `No dev app "${appId}"`);
    const { generation: _g, startedAt: _s, ...spec } = dev;
    return this.startDev(spec, signal);
  }
  /** Stop a dev app and forget it (its server is killed; its recorded calls stay). Idempotent. */
  async stopDev(appId: string): Promise<boolean> {
    const live = this.live.get(appId);
    if (!live?.dev) return false;
    await this.stopOne(live);
    this.live.delete(appId);
    this.changed();
    return true;
  }
  /** Stop every dev app of a conversation. */
  async stopDevApps(conversationId: string): Promise<void> { await Promise.allSettled(this.devApps(conversationId).map(id => this.stopDev(id))); }

  private async stopOne(live: Live) {
    const client = live.client; live.client = undefined;
    await client?.close().catch(() => {});
    live.tunnel?.mux.close(); live.tunnel?.child.kill('SIGKILL'); live.tunnel = undefined;
    const runtime = live.runtime; live.runtime = undefined;
    await runtime?.stop().catch(() => {});
    live.status = 'stopped';
  }
  /** Stop every app (servers killed, containers removed). Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.starting?.catch(() => {});
    await Promise.allSettled([...this.live.values()].map(live => this.stopOne(live)));
  }
}

const withDeadline = <T>(work: Promise<T>, signal: AbortSignal, code: string): Promise<T> => new Promise<T>((done, fail) => {
  if (signal.aborted) { fail(new Error(code)); return; }
  const abort = () => fail(new Error(code));
  signal.addEventListener('abort', abort, { once: true });
  work.then(value => { signal.removeEventListener('abort', abort); done(value); }, error => { signal.removeEventListener('abort', abort); fail(error); });
});

/** The context a conversation passes to app tools. */
export type McpAppsContext = { apps: McpApps; conversationId: string };
/** One app tool for the agent: content-only output; calls of tools with a view are recorded. */
/**
 * An app tool's input schema as the agent gets it: an object schema without
 * `$schema` (servers built with zod 4 declare draft 2020-12, which the
 * bridge's validator does not load; the keywords they use are the same) and
 * without `$id` (no remote references).
 */
export function agentInputSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || (input as { type?: unknown }).type !== 'object') return { type: 'object', properties: {} };
  const { $schema: _schema, $id: _id, ...rest } = input as Record<string, unknown>;
  return rest;
}
function mcpAppTool(appId: string, definition: McpToolDefinition, appName: string, dev = false): Tool {
  const schema = agentInputSchema(definition.inputSchema);
  const name = agentToolName(appId, definition.name);
  return tool({
    description: `[${dev ? 'Dev app (yours, in development)' : 'App'}: ${appName.slice(0, 60)}${toolResourceUri(definition) ? ', shows an interactive view to the user' : ''}] ${String(definition.description ?? definition.title ?? definition.name).slice(0, 1500)} Results are the app's content (untrusted).`,
    inputSchema: jsonSchema<Record<string, unknown>>(schema as Parameters<typeof jsonSchema>[0]),
    execute: async (input, options) => {
      const context = (options.context as Record<string, unknown> | undefined)?.[MCP_APPS_CONTEXT] as McpAppsContext | undefined;
      if (!context) return { error: 'Error (app_unavailable): MCP Apps are not available in this session.' };
      try { return { result: await context.apps.callAsAgent(name, input ?? {}, { conversationId: context.conversationId, toolCallId: options.toolCallId, ...(options.abortSignal ? { signal: options.abortSignal } : {}) }) }; }
      catch (error) {
        if ((error as { name?: string } | undefined)?.name === 'AbortError') throw error;
        return { error: error instanceof McpAppError ? `Error (${error.code}): ${error.message}` : 'Error (call_failed): the app failed' };
      }
    },
    toModelOutput: mcpAppModelOutput as never,
  });
}
