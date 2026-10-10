import express from 'express';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolSet } from 'ai';
import {
  applyToolOverrides, checkToolOverrides, statePaths, toolControl, ToolOverrideError, TOOL_OVERRIDES,
  fileTools, sandboxTools, decisionTools, jobTools, webSearchTools, askUserTool, ASK_USER_TOOL, webDevTools, mcpAppDevTools, schedulingTools, atlassianTools,
  type AgentDefinition, type ToolControl, type ToolOverride, type ToolPermission,
} from 'ai-sdk-letta';
import { BODY_LIMIT_BYTES } from './http.js';
import { RuntimeFault } from './runtime.js';

/**
 * Per-tool overrides of a code-defined agent (the app's own agent), **tighten
 * only**: a tool can be switched to `ask` or `off`, and back to `allow` only
 * where the definition already allows it. Kept in
 * `<state>/server/<definition id>/tool-overrides.json` (0600) and applied
 * when the runtime builds the definition (the next session, so after the
 * current reply). Locked tools follow `LOCKED_PERMISSIONS` as everywhere.
 */
export class DefinitionToolOverrides<TOOLS extends ToolSet = ToolSet> {
  readonly file: string;
  private overrides: Record<string, ToolOverride>;
  private current: AgentDefinition<TOOLS>;
  /** Bumped on each change: a session opened before is reopened (see `toolsStale`). */
  version = 0;
  constructor(readonly definition: AgentDefinition<TOOLS>, stateDirectory: string, private readonly onChange?: (definition: AgentDefinition<TOOLS>) => void) {
    this.file = join(statePaths(stateDirectory).server(definition.id), 'tool-overrides.json');
    this.overrides = this.read();
    this.current = withToolOverrides(definition, this.overrides);
  }
  /** The definition with its overrides applied. */
  effective(): AgentDefinition<TOOLS> { return this.current; }
  /** The settings' view of its tools (`GET /api/tools`). */
  control(): ToolControl { return definitionToolControl(this.definition, this.overrides); }
  /** Replace the overrides (`PUT /api/tools` `{ overrides }`); refused ones throw {@link ToolOverrideError}. */
  set(input: unknown): ToolControl {
    const overrides = checkToolOverrides((input as { overrides?: unknown } | undefined)?.overrides, this.definition, { tightenOnly: true });
    this.write(overrides);
    this.overrides = overrides; this.current = withToolOverrides(this.definition, overrides); this.version++;
    this.onChange?.(this.current);
    return this.control();
  }
  /** Routes: `GET /tools` and `PUT /tools` (mounted under the app's `/api`). */
  routes(): express.Router {
    const router = express.Router();
    router.get('/tools', (_req, res) => { res.json(this.control()); });
    router.put('/tools', express.json({ limit: BODY_LIMIT_BYTES }), (req, res) => {
      try { res.json(this.set(req.body)); }
      catch (error) {
        if (error instanceof ToolOverrideError) return void res.status(400).json({ error: error.code, message: error.message });
        if (error instanceof RuntimeFault) return void res.status(error.status).json({ error: error.code });
        res.status(500).json({ error: 'tool_overrides_unavailable' });
      }
    });
    return router;
  }
  private read(): Record<string, ToolOverride> {
    try {
      if (lstatSync(this.file).isSymbolicLink()) return {};
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; overrides?: unknown };
      if (value.version !== 1 || !value.overrides || typeof value.overrides !== 'object') return {};
      return Object.fromEntries(Object.entries(value.overrides).filter(([, mode]) => TOOL_OVERRIDES.includes(mode as ToolOverride))) as Record<string, ToolOverride>;
    } catch { return {}; }
  }
  private write(overrides: Record<string, ToolOverride>) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp-${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, overrides }, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file);
  }
}

/** A definition with tighten-only overrides applied (a refused one, from a hand-edited file, is ignored). */
export function withToolOverrides<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, overrides: Readonly<Record<string, ToolOverride>>): AgentDefinition<TOOLS> {
  if (!Object.keys(overrides).length) return definition;
  const { tools, permissions } = applyToolOverrides(definition, overrides, { tightenOnly: true });
  return Object.freeze({ ...definition, tools: tools as TOOLS, permissions: Object.freeze(permissions) });
}

/** The built-in tool sets a code-defined agent's tools are grouped by (by tool identity); the rest are its own (`custom`). */
const KNOWN_SETS: readonly [string, Record<string, unknown>][] = [
  ['files', fileTools], ['sandbox', sandboxTools], ['decisions', decisionTools], ['jobs', jobTools], ['web_search', webSearchTools], ['ask_user', { [ASK_USER_TOOL]: askUserTool }],
  ['web_dev', webDevTools], ['mcp_app_dev', mcpAppDevTools], ['scheduling', schedulingTools], ['atlassian', atlassianTools],
];

/** Per-tool control of a code-defined agent: its tools grouped by set (fixed: sets are chosen in code), tighten only. */
export function definitionToolControl(definition: AgentDefinition, overrides: Readonly<Record<string, ToolOverride>>): ToolControl {
  const groups = new Map<string, { tools: ToolSet; permissions: Record<string, ToolPermission> }>();
  for (const [name, value] of Object.entries(definition.tools)) {
    const set = KNOWN_SETS.find(([, tools]) => tools[name] === value)?.[0] ?? 'custom';
    const group = groups.get(set) ?? { tools: {}, permissions: {} };
    group.tools[name] = value; group.permissions[name] = definition.permissions[name] ?? 'deny';
    groups.set(set, group);
  }
  const order = [...KNOWN_SETS.map(([set]) => set), 'custom'];
  return toolControl([...groups].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([set, base]) => ({ set, enabled: true, fixed: true, base })), overrides, { tightenOnly: true });
}
