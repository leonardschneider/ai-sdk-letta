import { tool, jsonSchema, type Tool } from 'ai';
import type { ToolPermission } from './definition.js';
import { SandboxError } from './sandbox.js';
import { WEBDEV_CONTEXT, WEBDEV_LIMITS, WebDevServices, devAppStateDir } from './webdev.js';
import { DEV_APP_NAME, MCP_APP_HTTP_DEFAULTS, MCP_APP_HTTP_PATH, MCP_APPS_CONTEXT, MCP_APP_LIMITS, McpAppError, McpApps, devAppId, type McpAppDevPersisted, type McpAppDevStart, type McpAppRuntime, type McpAppsContext, type McpCallResult } from './mcp-apps.js';
import { lintMcpApp, type McpAppLintFinding } from './mcp-app-lint.js';
import { MCP_APP_GUIDE } from './mcp-app-guide.js';

/**
 * MCP Apps dev mode: the agent writes an MCP server (with views) in its
 * sandbox and runs it as a **dev app** of its conversation in the
 * conversation's services container: over Streamable HTTP by default
 * (`WebDevServices.devAppHttpStart`, reached through a tunnel), or over stdio
 * (`WebDevServices.devAppLine`). Its
 * model-visible tools join the conversation from the next turn
 * (`dev_<name>__<tool>`), its views render in the side panel with a "Dev"
 * badge, and the agent checks the app against the MCP Apps contract
 * ({@link lintMcpApp}).
 *
 * @module
 */

/** A dev app tool name. */
export type McpAppDevToolName = 'mcp_app_guide' | 'mcp_app_dev_start' | 'mcp_app_dev_reload' | 'mcp_app_dev_stop' | 'mcp_app_dev_status' | 'mcp_app_dev_logs' | 'mcp_app_dev_call' | 'mcp_app_dev_check';
/** Every dev app tool. */
export const MCP_APP_DEV_TOOL_NAMES: readonly McpAppDevToolName[] = ['mcp_app_guide', 'mcp_app_dev_start', 'mcp_app_dev_reload', 'mcp_app_dev_stop', 'mcp_app_dev_status', 'mcp_app_dev_logs', 'mcp_app_dev_call', 'mcp_app_dev_check'];
/** Most text a dev app tool returns. */
export const MCP_APP_DEV_LIMITS = Object.freeze({ maxText: 14_000, maxStructured: 6_000, maxMeta: 2_000, maxFindings: 40 });

type TextOutput = { text: string; isError?: boolean };
const textModelOutput = ({ output }: { output: unknown }) => {
  const result = output as TextOutput;
  return result.isError ? { type: 'error-text' as const, value: result.text } : { type: 'text' as const, value: result.text };
};
const cap = (text: string, max: number, hint = '') => text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters omitted${hint} …]` : text;

/** The conversation's web development services and MCP Apps, or why they are missing. */
function contextOf(context: unknown): { services: WebDevServices; apps: McpApps; conversationId: string } | TextOutput {
  const record = context as Record<string, unknown> | undefined;
  const services = record?.[WEBDEV_CONTEXT];
  const apps = record?.[MCP_APPS_CONTEXT] as McpAppsContext | undefined;
  if (!(services instanceof WebDevServices)) return { text: 'Error (sandbox_unavailable): MCP App development is not available in this session (it needs web development: a sandbox with the built-in docker or apple-container provider).', isError: true };
  if (!(apps?.apps instanceof McpApps) || typeof apps.conversationId !== 'string') return { text: 'Error (app_unavailable): MCP Apps are not available in this session.', isError: true };
  return { services, apps: apps.apps, conversationId: apps.conversationId };
}
const isFailure = (value: unknown): value is TextOutput => typeof (value as TextOutput).text === 'string';
const failure = (error: unknown): TextOutput => {
  if ((error as { name?: string } | undefined)?.name === 'AbortError') throw error;
  if (error instanceof SandboxError || error instanceof McpAppError) return { text: `Error (${error.code}): ${error.message}`, isError: true };
  return { text: `Error: ${error instanceof Error ? error.message.slice(0, 300) : 'the dev app failed'}`, isError: true };
};
/** The dev app of this conversation named `name`, or an error. */
function ownApp(apps: McpApps, conversationId: string, name: unknown): string | TextOutput {
  if (typeof name !== 'string' || !DEV_APP_NAME.test(name)) return { text: 'Error (app_unknown): give the dev app\'s name (as passed to mcp_app_dev_start).', isError: true };
  const id = devAppId(name);
  const spec = apps.devSpec(id);
  if (!spec || spec.conversationId !== conversationId) {
    const mine = apps.devApps(conversationId).map(a => a.slice(4));
    return { text: `Error (app_unknown): no dev app "${name}" in this conversation${mine.length ? ` (it has: ${mine.join(', ')})` : ''}. Start it with mcp_app_dev_start.`, isError: true };
  }
  return id;
}

/** Start a dev app's server from its kept spec, in the conversation's services container (HTTP or stdio). */
export async function launchDevApp(services: WebDevServices, spec: Pick<McpAppDevPersisted, 'name' | 'folder' | 'command' | 'transport' | 'port' | 'path'>, signal?: AbortSignal): Promise<McpAppRuntime> {
  if (spec.transport === 'http') {
    const launched = await services.devAppHttpStart(spec.name, { command: spec.command, cwd: spec.folder, port: spec.port ?? MCP_APP_HTTP_DEFAULTS.port, path: spec.path ?? MCP_APP_HTTP_DEFAULTS.path }, signal);
    if (!launched.ok) throw new Error(launched.text);
    return { http: launched.endpoint, stop: () => services.stopDevApp(spec.name) };
  }
  const launched = await services.devAppLine(spec.name, { command: spec.command, cwd: spec.folder }, signal);
  if (!launched.ok) throw new Error(launched.text);
  return { line: launched.line, stop: () => services.stopDevApp(spec.name) };
}
const boundServices = new WeakMap<WebDevServices, Set<McpApps>>();
/**
 * Bind a conversation's dev apps to its web development services: kept dev
 * apps (after an idle stop or a restart) start again through them, and when
 * their container stops (`idle`, or stopped) the dev apps are marked stopped
 * with that reason, keeping their spec. Called by the runtime when a
 * conversation opens; idempotent.
 */
export function bindDevApps(apps: McpApps, conversationId: string, services: WebDevServices): void {
  apps.bindDev(conversationId, { launch: (spec, signal) => launchDevApp(services, spec, signal), touch: () => services.touch(), logs: (name, lines) => services.devAppLogs(name, lines) });
  const bound = boundServices.get(services) ?? new Set<McpApps>();
  if (bound.has(apps)) return;
  bound.add(apps); boundServices.set(services, bound);
  services.onStop(reason => apps.devContainerStopped(conversationId, reason === 'idle' ? 'idle' : 'stopped'));
}

/** The summary of a (re)start, for the model. */
export function formatDevStart(result: McpAppDevStart, findings?: McpAppLintFinding[] | string): string {
  const out: string[] = [];
  const name = result.app.slice(4);
  if (result.status !== 'running') {
    out.push(`Dev app "${name}" did not start (generation ${result.generation}): ${result.error ?? result.status}.`, `See mcp_app_dev_logs {"name":"${name}"} for its stderr; fix the server and call mcp_app_dev_reload (or mcp_app_dev_start again).`);
    return out.join('\n');
  }
  out.push(`Dev app "${name}" running (generation ${result.generation}): ${result.tools.length} tool(s), ${result.views.length} view(s).`);
  if (result.changes) {
    const c = result.changes;
    const parts = [c.added.length ? `added ${c.added.join(', ')}` : '', c.removed.length ? `removed ${c.removed.join(', ')}` : '', c.changed.length ? `changed ${c.changed.join(', ')}` : '', c.viewsChanged.length ? `views changed ${c.viewsChanged.join(', ')}` : ''].filter(Boolean);
    out.push(`Changes since the previous start: ${parts.length ? parts.join('; ') : 'none'}.`);
    if (c.added.length || c.removed.length || c.changed.length) out.push('Tool-list changes reach you at your next turn (the dev_<name>__<tool> tools you can call).');
  }
  out.push('Tools:');
  for (const t of result.tools) out.push(`  - ${t.name} [visibility: ${t.visibility.join(', ')}]${t.agentTool ? ` → you call it as ${t.agentTool} (from your next turn)` : ' (not model-visible: only its views call it)'}${t.resourceUri ? ` · view ${t.resourceUri}` : ''}`);
  if (!result.tools.length) out.push('  (none)');
  if (result.views.length) {
    out.push('Views:');
    for (const v of result.views) out.push(`  - ${v.uri}${v.fingerprint ? ` · fingerprint ${v.fingerprint.slice(0, 12)}` : ''}${v.changed ? ' · changed' : ''}${v.error ? ` · ERROR: ${v.error}` : ''}`);
  }
  if (findings !== undefined) out.push(typeof findings === 'string' ? `Check: ${findings}` : formatFindings(findings));
  return out.join('\n');
}
/** Linter findings, for the model. */
export function formatFindings(findings: readonly McpAppLintFinding[]): string {
  if (!findings.length) return 'Check: no findings; the app follows the MCP Apps contract as far as the linter can tell.';
  const errors = findings.filter(f => f.level === 'error').length;
  const lines = [`Check: ${errors} error(s), ${findings.length - errors} warning(s):`];
  for (const f of findings.slice(0, MCP_APP_DEV_LIMITS.maxFindings)) {
    const where = [f.tool ? `tool ${f.tool}` : '', f.resource ? `resource ${f.resource}` : ''].filter(Boolean).join(', ');
    lines.push(`  - [${f.level}] ${f.rule}${where ? ` (${where})` : ''}: ${f.message}${f.fix ? `\n    fix: ${f.fix}` : ''}`);
  }
  if (findings.length > MCP_APP_DEV_LIMITS.maxFindings) lines.push(`  … ${findings.length - MCP_APP_DEV_LIMITS.maxFindings} more`);
  return lines.join('\n');
}
async function lint(apps: McpApps, id: string, signal?: AbortSignal): Promise<McpAppLintFinding[] | string> {
  try { return await lintMcpApp(apps.client(id), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(MCP_APP_LIMITS.callTimeoutMs)]) : AbortSignal.timeout(MCP_APP_LIMITS.callTimeoutMs) }); }
  catch (error) { if ((error as { name?: string }).name === 'AbortError' && signal?.aborted) throw error; return `the linter could not run (${error instanceof Error ? error.message.slice(0, 200) : 'error'})`; }
}
/** A tool result, for the model: content text, structuredContent and _meta, bounded. */
export function formatCallResult(result: McpCallResult): string {
  const out: string[] = [result.isError ? 'The tool returned an error (isError: true).' : 'The tool returned:'];
  const content = Array.isArray(result.content) ? result.content : [];
  out.push('content:');
  for (const item of content.slice(0, 20)) out.push(item.type === 'text' && typeof item.text === 'string' ? `  ${item.text}` : `  [${item.type}${typeof item.mimeType === 'string' ? ` ${item.mimeType}` : ''} omitted]`);
  if (!content.length) out.push('  (none)');
  if (result.structuredContent !== undefined) out.push(`structuredContent:\n${cap(JSON.stringify(result.structuredContent, null, 2), MCP_APP_DEV_LIMITS.maxStructured)}`);
  if (result._meta !== undefined) out.push(`_meta:\n${cap(JSON.stringify(result._meta), MCP_APP_DEV_LIMITS.maxMeta)}`);
  return cap(out.join('\n'), MCP_APP_DEV_LIMITS.maxText);
}

type StartInput = { name: string; command: string; cwd?: string; transport?: 'http' | 'stdio'; port?: number; path?: string };
type NameInput = { name: string };
type LogsInput = { name: string; lines?: number };
type CallInput = { name: string; tool: string; args?: Record<string, unknown> };
const nameSchema = { type: 'string', pattern: DEV_APP_NAME.source, description: 'The dev app\'s short name (lowercase letters, digits, "-"; 1–20).' } as const;
const nameOnly = jsonSchema<NameInput>({ type: 'object', properties: { name: nameSchema }, required: ['name'], additionalProperties: false });

/**
 * The dev app tools (MCP Apps dev mode). Add them with the web development
 * tools (they run in the services container):
 * ```ts
 * tools: { ...sandboxTools, ...webDevTools, ...mcpAppDevTools },
 * permissions: { ...SANDBOX_TOOL_PERMISSIONS, ...WEBDEV_TOOL_PERMISSIONS, ...MCP_APP_DEV_TOOL_PERMISSIONS }
 * ```
 */
export const mcpAppDevTools: Record<McpAppDevToolName, Tool> = {
  mcp_app_guide: tool({
    description: 'The guide to building MCP Apps here (pinned SDK versions, how this host runs them, API cheat-sheet, a minimal working example, the dev loop). Read it once before you build or change an MCP App.',
    inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }),
    execute: async () => ({ text: MCP_APP_GUIDE }),
    toModelOutput: textModelOutput,
  }),
  mcp_app_dev_start: tool({
    description: 'Start (or restart) an MCP server you are writing as a dev app of this conversation, in the services container without network. By default it serves Streamable HTTP: the command listens on 127.0.0.1:<port> (default 3000; PORT and HOST are set) with the MCP endpoint at <path> (default /mcp); its output goes to its log. With transport "stdio", stdout is MCP and stderr the log. Its model-visible tools become yours from your next turn as dev_<name>__<tool>, and its views show in the user\'s side panel (marked Dev). The result lists its tools and views and the MCP Apps contract check. Example: {"name":"clock","cwd":"clock-app","command":"node dist/server.js"}. Build first (run_command); the command must not build or install anything. Read mcp_app_guide first.',
    inputSchema: jsonSchema<StartInput>({ type: 'object', properties: {
      name: nameSchema,
      command: { type: 'string', minLength: 1, maxLength: WEBDEV_LIMITS.maxCommandChars, description: 'Shell command that runs the MCP server in the foreground (it listens on 127.0.0.1:<port>, or speaks stdio with transport "stdio").' },
      cwd: { type: 'string', maxLength: 500, description: 'The server\'s folder, relative to this conversation\'s folder or absolute under /workspace.' },
      transport: { type: 'string', enum: ['http', 'stdio'], description: 'How the server speaks MCP: "http" (Streamable HTTP, the default) or "stdio".' },
      port: { type: 'integer', minimum: 1024, maximum: 65535, description: 'Port the server listens on inside the container (http only; default 3000; not 5173 or 3128).' },
      path: { type: 'string', maxLength: 200, pattern: MCP_APP_HTTP_PATH.source, description: 'Path of the MCP endpoint (http only; default "/mcp").' },
    }, required: ['name', 'command'], additionalProperties: false }),
    execute: async ({ name, command, cwd, transport = 'http', port, path }, options) => {
      const ctx = contextOf(options.context);
      if (isFailure(ctx)) return ctx;
      const { services, apps, conversationId } = ctx;
      if (!DEV_APP_NAME.test(name)) return { text: 'Error (app_unknown): a dev app name is 1–20 lowercase letters, digits or "-", starting with a letter.', isError: true };
      try {
        const known = apps.devSpec(devAppId(name));
        if (known && known.conversationId !== conversationId) return { text: `Error (app_unknown): the name "${name}" is used by another conversation; choose another name.`, isError: true };
        if (transport !== 'http' && transport !== 'stdio') return { text: 'Error (command_invalid): transport is "http" or "stdio".', isError: true };
        if (transport === 'http') {
          const http = { port: port ?? MCP_APP_HTTP_DEFAULTS.port, path: path ?? MCP_APP_HTTP_DEFAULTS.path };
          if (!MCP_APP_HTTP_PATH.test(http.path)) return { text: 'Error (command_invalid): path must be a URL path such as "/mcp".', isError: true };
          let folder = cwd;
          let stateDir = devAppStateDir(name);
          bindDevApps(apps, conversationId, services);
          const result = await apps.startDev({
            name, conversationId, folder: services.resolveFolder(cwd), command, transport: 'http', port: http.port, path: http.path,
            // Every launch (re)starts the server and opens a new tunnel; reloads use the folder found first.
            launch: async signal => {
              const launched = await services.devAppHttpStart(name, { command, ...(folder !== undefined ? { cwd: folder } : {}), ...http }, signal);
              if (!launched.ok) throw new Error(launched.text);
              folder = launched.folder; stateDir = launched.stateDir;
              return { http: launched.endpoint, stop: () => services.stopDevApp(name) };
            },
            touch: () => services.touch(),
          }, options.abortSignal);
          const findings = result.status === 'running' ? await lint(apps, result.app, options.abortSignal) : undefined;
          return { text: `${formatDevStart(result, findings)}\nFolder: ${services.resolveFolder(folder)}\nCommand: ${command}\nTransport: Streamable HTTP at http://127.0.0.1:${http.port}${http.path} (in the services container)\nSTATE_DIR: ${stateDir} (kept across restarts: persist server state there)`, ...(result.status === 'running' ? {} : { isError: true }) };
        }
        if (port !== undefined || path !== undefined) return { text: 'Error (command_invalid): port and path are for transport "http".', isError: true };
        // The folder is checked once, now; reloads launch the same line again.
        const first = await services.devAppLine(name, { command, ...(cwd !== undefined ? { cwd } : {}) }, options.abortSignal);
        if (!first.ok) return { text: first.text, isError: true };
        let fresh = true;
        bindDevApps(apps, conversationId, services);
        const result = await apps.startDev({
          name, conversationId, folder: first.folder, command, transport: 'stdio',
          // The first launch uses the line checked above; reloads build it again (the container may have restarted).
          launch: async signal => {
            const launched = fresh ? first : await services.devAppLine(name, { command, cwd: first.folder }, signal);
            fresh = false;
            if (!launched.ok) throw new Error(launched.text);
            return { line: launched.line, stop: () => services.stopDevApp(name) };
          },
          touch: () => services.touch(),
        }, options.abortSignal);
        const findings = result.status === 'running' ? await lint(apps, result.app, options.abortSignal) : undefined;
        return { text: `${formatDevStart(result, findings)}\nFolder: ${first.folder}\nCommand: ${command}\nTransport: stdio\nSTATE_DIR: ${first.stateDir} (kept across restarts: persist server state there)`, ...(result.status === 'running' ? {} : { isError: true }) };
      } catch (error) { return failure(error); }
    },
    toModelOutput: textModelOutput,
  }),
  mcp_app_dev_reload: tool({
    description: 'Restart a dev app after you changed (and rebuilt) it: same folder and command. Returns what changed (tools added, removed or changed; views changed) and the contract check. Open views of it render again; tool-list changes reach you at your next turn. See mcp_app_guide.',
    inputSchema: nameOnly,
    execute: async ({ name }, options) => {
      const ctx = contextOf(options.context);
      if (isFailure(ctx)) return ctx;
      const id = ownApp(ctx.apps, ctx.conversationId, name);
      if (typeof id !== 'string') return id;
      try {
        const result = await ctx.apps.reloadDev(id, options.abortSignal);
        const findings = result.status === 'running' ? await lint(ctx.apps, id, options.abortSignal) : undefined;
        return { text: formatDevStart(result, findings), ...(result.status === 'running' ? {} : { isError: true }) };
      } catch (error) { return failure(error); }
    },
    toModelOutput: textModelOutput,
  }),
  mcp_app_dev_stop: tool({
    description: 'Stop a dev app of this conversation: its server is killed and its tools and views go away (from your next turn).',
    inputSchema: nameOnly,
    execute: async ({ name }, options) => {
      const ctx = contextOf(options.context);
      if (isFailure(ctx)) return ctx;
      const id = ownApp(ctx.apps, ctx.conversationId, name);
      if (typeof id !== 'string') return id;
      try { await ctx.apps.stopDev(id); await ctx.services.stopDevApp(name); return { text: `Dev app "${name}" stopped. Its tools are gone from your next turn.` }; }
      catch (error) { return failure(error); }
    },
    toModelOutput: textModelOutput,
  }),
  mcp_app_dev_status: tool({
    description: 'The dev apps of this conversation: status, folder, command, generation, tools and views.',
    inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }),
    execute: async (_input, options) => {
      const ctx = contextOf(options.context);
      if (isFailure(ctx)) return ctx;
      const mine = ctx.apps.status().filter(s => s.dev?.conversationId === ctx.conversationId);
      if (!mine.length) return { text: 'No dev apps in this conversation (start one with mcp_app_dev_start).' };
      const lines = mine.flatMap(s => [
        `${s.id.slice(4)}: ${s.status}${s.error ? ` (${s.error})` : ''} · generation ${s.dev!.generation} since ${s.dev!.startedAt} · ${s.dev!.folder} $ ${s.dev!.command.slice(0, 200)}`,
        ...s.tools.map(t => `  - tool ${t.name} [${t.visibility.join(', ')}]${t.agentTool ? ` as ${t.agentTool}` : ''}${t.resourceUri ? ` · view ${t.resourceUri}` : ''}`),
        ...s.views.map(v => `  - view ${v.uri}${v.fingerprint ? ` · fingerprint ${v.fingerprint.slice(0, 12)}` : ''}`),
      ]);
      return { text: cap(lines.join('\n'), MCP_APP_DEV_LIMITS.maxText) };
    },
    toModelOutput: textModelOutput,
  }),
  mcp_app_dev_logs: tool({
    description: 'The last lines a dev app\'s server wrote to stderr (startup errors, stack traces, your console.error), and whether it runs. Untrusted content.',
    inputSchema: jsonSchema<LogsInput>({ type: 'object', properties: { name: nameSchema, lines: { type: 'integer', minimum: 1, maximum: WEBDEV_LIMITS.maxLogLines, description: 'How many lines (default 60).' } }, required: ['name'], additionalProperties: false }),
    execute: async ({ name, lines }, options) => {
      const ctx = contextOf(options.context);
      if (isFailure(ctx)) return ctx;
      if (!DEV_APP_NAME.test(name)) return { text: 'Error (app_unknown): invalid dev app name.', isError: true };
      // A server that failed to start is still worth reading: no ownership check beyond another conversation's name.
      const spec = ctx.apps.devSpec(devAppId(name));
      if (spec && spec.conversationId !== ctx.conversationId) return { text: `Error (app_unknown): no dev app "${name}" in this conversation.`, isError: true };
      try { return { text: await ctx.services.devAppLogs(name, lines ?? 60) }; } catch (error) { return failure(error); }
    },
    toModelOutput: textModelOutput,
  }),
  mcp_app_dev_call: tool({
    description: 'Call any tool of a dev app directly, also app-only ones (visibility ["app"]), as its views would. Returns the content text, structuredContent (JSON) and _meta, bounded. Nothing is shown to the user. Untrusted content.',
    inputSchema: jsonSchema<CallInput>({ type: 'object', properties: {
      name: nameSchema,
      tool: { type: 'string', minLength: 1, maxLength: 128, description: 'The server\'s own tool name (not dev_<name>__…).' },
      args: { type: 'object', description: 'Arguments (default {}).' },
    }, required: ['name', 'tool'], additionalProperties: false }),
    execute: async ({ name, tool: toolName, args }, options) => {
      const ctx = contextOf(options.context);
      if (isFailure(ctx)) return ctx;
      const id = ownApp(ctx.apps, ctx.conversationId, name);
      if (typeof id !== 'string') return id;
      if (!ctx.apps.toolDefinition(id, toolName)) return { text: `Error (tool_unknown): "${name}" has no tool "${String(toolName).slice(0, 128)}" (see mcp_app_dev_status).`, isError: true };
      try {
        const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(MCP_APP_LIMITS.callTimeoutMs)]) : AbortSignal.timeout(MCP_APP_LIMITS.callTimeoutMs);
        ctx.services.touch();
        const result = await ctx.apps.client(id).callTool(toolName, args && typeof args === 'object' && !Array.isArray(args) ? args : {}, signal);
        return { text: formatCallResult(result ?? {}), ...(result?.isError ? { isError: true } : {}) };
      } catch (error) { return failure(error); }
    },
    toModelOutput: textModelOutput,
  }),
  mcp_app_dev_check: tool({
    description: 'Check a running dev app against the MCP Apps contract (tool _meta.ui, resources and their MIME type, CSP and permissions metadata, how views call tools). Each finding has a rule, a level and a fix.',
    inputSchema: nameOnly,
    execute: async ({ name }, options) => {
      const ctx = contextOf(options.context);
      if (isFailure(ctx)) return ctx;
      const id = ownApp(ctx.apps, ctx.conversationId, name);
      if (typeof id !== 'string') return id;
      try {
        const findings = await lint(ctx.apps, id, options.abortSignal);
        return typeof findings === 'string' ? { text: `Error: ${findings}`, isError: true } : { text: formatFindings(findings) };
      } catch (error) { return failure(error); }
    },
    toModelOutput: textModelOutput,
  }),
};

/** Policy of the dev app tools: all `'allow'` (the agent's own code, in its own container without network, like `run_command`). */
export const MCP_APP_DEV_TOOL_PERMISSIONS: Readonly<Record<McpAppDevToolName, ToolPermission>> = Object.freeze(Object.fromEntries(MCP_APP_DEV_TOOL_NAMES.map(name => [name, 'allow'])) as Record<McpAppDevToolName, ToolPermission>);

/** Does a tool set include the dev app tools? */
export const includesMcpAppDevTools = (tools: object) => (tools as Record<string, unknown>).mcp_app_dev_start === mcpAppDevTools.mcp_app_dev_start;
/** Does a definition use MCP Apps dev mode? Web development enabled, and `mcp_app_dev_start` from {@link mcpAppDevTools}, allowed. */
export function mcpAppDevEnabled(definition: { tools: object; permissions: Readonly<Record<string, ToolPermission>> }, webDev: boolean): boolean {
  return webDev && includesMcpAppDevTools(definition.tools) && ['allow', 'ask'].includes(definition.permissions.mcp_app_dev_start ?? 'deny');
}
/** Bridge deadlines of the dev app tools (a start waits for the server, then lints it). */
export function mcpAppDevToolTimeouts(fallbackMs: number): Record<string, number> {
  const long = Math.max(fallbackMs, MCP_APP_LIMITS.startTimeoutMs + MCP_APP_LIMITS.callTimeoutMs + 15_000);
  const call = Math.max(fallbackMs, MCP_APP_LIMITS.callTimeoutMs + 5000);
  return { mcp_app_dev_start: long, mcp_app_dev_reload: long, mcp_app_dev_stop: Math.max(fallbackMs, 30_000), mcp_app_dev_status: fallbackMs, mcp_app_dev_logs: Math.max(fallbackMs, 30_000), mcp_app_dev_call: call, mcp_app_dev_check: call };
}
