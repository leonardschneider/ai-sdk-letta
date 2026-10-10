import { asSchema, type ToolSet } from 'ai';
import type { ToolPermission } from './definition.js';

/**
 * Per-tool control: overrides of a tool's permission on top of its tool set's
 * defaults (`allow`, `ask`, or `off`: the agent does not get the tool), the
 * rules no override (or definition) may loosen, and each tool's context cost.
 *
 * @module
 */

/** A per-tool override: its permission, or `off` (the tool is left out). */
export type ToolOverride = 'allow' | 'ask' | 'off';
export const TOOL_OVERRIDES: readonly ToolOverride[] = Object.freeze(['allow', 'ask', 'off']);
/** Settings a tool refuses, and why (shown to people). */
export type ToolLock = Readonly<{ refuse: readonly ToolOverride[]; reason: string }>;

/**
 * Safety rules of tool permissions, shared by `defineAgent` and per-tool
 * overrides: a tool here never gets a refused permission. `web_search`,
 * `run_command_online` and `allow_web_origin` always ask (or are off);
 * `request_decision` and `ask_user` already involve a person, so never `ask`.
 */
export const LOCKED_PERMISSIONS: Readonly<Record<string, ToolLock>> = Object.freeze({
  web_search: Object.freeze({ refuse: Object.freeze(['allow'] as const), reason: 'web_search results are reviewed by a person before the agent sees them' }),
  run_command_online: Object.freeze({ refuse: Object.freeze(['allow'] as const), reason: 'run_command_online uses the network' }),
  allow_web_origin: Object.freeze({ refuse: Object.freeze(['allow'] as const), reason: 'allow_web_origin lets the app reach the internet' }),
  request_decision: Object.freeze({ refuse: Object.freeze(['ask'] as const), reason: 'request_decision already asks people (it is the human gate)' }),
  ask_user: Object.freeze({ refuse: Object.freeze(['ask'] as const), reason: 'ask_user is already interactive' }),
});

/**
 * Overrides refused because a tool set needs the tool to work (turn the whole
 * set off instead): the sandbox runs on `run_command`, web development on
 * `dev_server_start`, MCP App development on `app_dev_start`, and jobs on an
 * allowed `job_start`, files on `read_file`.
 */
export const SET_ANCHORS: Readonly<Record<string, ToolLock>> = Object.freeze({
  read_file: Object.freeze({ refuse: Object.freeze(['off'] as const), reason: 'Files need read_file: turn the whole set off instead' }),
  run_command: Object.freeze({ refuse: Object.freeze(['off'] as const), reason: 'Shell commands need run_command: turn the whole set off instead' }),
  dev_server_start: Object.freeze({ refuse: Object.freeze(['off'] as const), reason: 'Web development needs dev_server_start: turn the whole set off instead' }),
  app_dev_start: Object.freeze({ refuse: Object.freeze(['off'] as const), reason: 'MCP App development needs app_dev_start: turn the whole set off instead' }),
  job_start: Object.freeze({ refuse: Object.freeze(['ask', 'off'] as const), reason: 'Jobs only report progress and need job_start: turn the whole set off instead' }),
});

/** What a tool refuses as an override, and why (both kinds of rules together), or `undefined`. */
export function toolLock(name: string): ToolLock | undefined {
  const locks = [LOCKED_PERMISSIONS[name], SET_ANCHORS[name]].filter((lock): lock is ToolLock => !!lock);
  if (!locks.length) return undefined;
  return { refuse: [...new Set(locks.flatMap(lock => lock.refuse))], reason: locks.map(lock => lock.reason).join('. ') };
}

/** Why `defineAgent` refuses a permission ({@link LOCKED_PERMISSIONS}), or `undefined`. */
export function lockedPermissionError(name: string, permission: ToolPermission | undefined): string | undefined {
  const lock = Object.hasOwn(LOCKED_PERMISSIONS, name) ? LOCKED_PERMISSIONS[name] : undefined;
  if (!lock || !permission || !lock.refuse.includes(permission as ToolOverride)) return undefined;
  return `${lock.reason}; ${lock.refuse.includes('allow') ? 'its permission must be "ask" or "deny"' : 'use "allow" or "deny"'}`;
}

/** A refused override: `invalid_input`, `tool_locked` (a safety rule or a set's needs) or `tighten_only` (a code-defined agent). */
export class ToolOverrideError extends Error { constructor(readonly code: 'invalid_input' | 'tool_locked' | 'tighten_only', message: string) { super(message); } }

/** Tools and their permissions (a definition, or the tool sets of an adopted agent). */
export type ToolBase = { tools: ToolSet; permissions: Readonly<Record<string, ToolPermission>> };
/** Options of the override checks. `tightenOnly`: a code-defined agent; `allow` only where the code already allows. */
export type OverrideOptions = { tightenOnly?: boolean };

/** Why one override is refused, or `undefined`. */
export function overrideRefusal(name: string, value: ToolOverride, base: ToolPermission | undefined, options: OverrideOptions = {}): ToolOverrideError | undefined {
  const lock = toolLock(name);
  if (lock?.refuse.includes(value)) return new ToolOverrideError('tool_locked', `${name} cannot be set to ${value}: ${lock.reason}.`);
  if (options.tightenOnly && ((value === 'allow' && base !== 'allow') || (value === 'ask' && base === 'deny'))) return new ToolOverrideError('tighten_only', `${name} is defined in code as "${base ?? 'deny'}": here it can only be tightened (Ask or Off).`);
  return undefined;
}

/** An override that changes nothing (the tool's default). */
const isDefault = (value: ToolOverride, base: ToolPermission | undefined) => value === 'off' ? base === 'deny' : value === base;

/**
 * Check overrides from a request: an object of `allow`, `ask` or `off`.
 * Unknown tools and overrides equal to the default are dropped; a refused
 * one throws {@link ToolOverrideError}.
 */
export function checkToolOverrides(value: unknown, base: ToolBase, options: OverrideOptions = {}): Record<string, ToolOverride> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 500) throw new ToolOverrideError('invalid_input', 'Tool overrides must be an object of "allow", "ask" or "off".');
  const result: Record<string, ToolOverride> = {};
  for (const [name, mode] of Object.entries(value as Record<string, unknown>)) {
    if (!TOOL_OVERRIDES.includes(mode as ToolOverride)) throw new ToolOverrideError('invalid_input', `Invalid override for "${name.slice(0, 64)}": use "allow", "ask" or "off".`);
    if (!Object.hasOwn(base.tools, name) || !Object.hasOwn(base.permissions, name)) continue;
    const refused = overrideRefusal(name, mode as ToolOverride, base.permissions[name], options);
    if (refused) throw refused;
    if (!isDefault(mode as ToolOverride, base.permissions[name])) result[name] = mode as ToolOverride;
  }
  return result;
}

/**
 * Apply overrides to tools and permissions: `off` removes the tool (and its
 * permission), `allow` and `ask` set its permission. Unknown tools and
 * refused overrides (a stored file edited by hand) are ignored.
 */
export function applyToolOverrides<T extends ToolBase>(base: T, overrides: Readonly<Record<string, unknown>> | undefined, options: OverrideOptions = {}): { tools: ToolSet; permissions: Record<string, ToolPermission> } {
  const tools: ToolSet = { ...base.tools };
  const permissions: Record<string, ToolPermission> = { ...base.permissions };
  for (const [name, mode] of Object.entries(overrides ?? {})) {
    if (!TOOL_OVERRIDES.includes(mode as ToolOverride) || !Object.hasOwn(tools, name) || !Object.hasOwn(permissions, name)) continue;
    if (overrideRefusal(name, mode as ToolOverride, base.permissions[name], options)) continue;
    if (mode === 'off') { delete tools[name]; delete permissions[name]; }
    else permissions[name] = mode as ToolPermission;
  }
  return { tools, permissions };
}

const costs = new WeakMap<object, number>();
/**
 * A tool's context cost estimate, in tokens: the characters of its description
 * and JSON schema, divided by 4. Computed once per tool object.
 */
export function toolTokens(tool: unknown): number {
  if (!tool || typeof tool !== 'object') return 0;
  const known = costs.get(tool);
  if (known !== undefined) return known;
  const { description, inputSchema } = tool as { description?: string; inputSchema?: Parameters<typeof asSchema>[0] };
  let schema = '';
  try {
    const json = inputSchema === undefined ? undefined : asSchema(inputSchema).jsonSchema;
    if (json && typeof (json as PromiseLike<unknown>).then !== 'function') schema = JSON.stringify(json);
  } catch { /* the description alone */ }
  const tokens = Math.ceil(((description ?? '').length + schema.length) / 4);
  costs.set(tool, tokens);
  return tokens;
}

/** One tool as the settings show it. */
export type ToolControlTool = { name: string; description: string; default: ToolOverride; override?: ToolOverride; locked?: ToolLock; tokens: number };
/** One tool set as the settings show it. `fixed`: it cannot be turned on or off here (a code-defined agent). */
export type ToolControlSet = { set: string; enabled: boolean; fixed?: boolean; tools: ToolControlTool[]; tokens: number };
/** `GET .../tools`: each set with its tools, defaults, overrides, locks and costs; `tokens`: what the enabled ones cost now. */
export type ToolControl = { sets: ToolControlSet[]; tokens: number; tightenOnly?: boolean };

/** A tool's default as an override value. */
const asOverride = (permission: ToolPermission | undefined): ToolOverride => permission === 'deny' || !permission ? 'off' : permission;

/** The settings' view of tool sets (see {@link ToolControl}). */
export function toolControl(groups: readonly { set: string; enabled: boolean; fixed?: boolean; base: ToolBase }[], overrides: Readonly<Record<string, ToolOverride>> = {}, options: OverrideOptions = {}): ToolControl {
  const sets = groups.map(({ set, enabled, fixed, base }) => {
    const tools = Object.keys(base.tools).map(name => {
      const lock = toolLock(name);
      const override = Object.hasOwn(overrides, name) ? overrides[name] : undefined;
      return { name, description: (base.tools[name] as { description?: string }).description ?? '', default: asOverride(base.permissions[name]), ...(override ? { override } : {}), ...(lock ? { locked: lock } : {}), tokens: toolTokens(base.tools[name]) };
    });
    return { set, enabled, ...(fixed ? { fixed: true } : {}), tools, tokens: tools.reduce((sum, t) => sum + ((t.override ?? t.default) === 'off' ? 0 : t.tokens), 0) };
  });
  return { sets, tokens: sets.reduce((sum, s) => sum + (s.enabled ? s.tokens : 0), 0), ...(options.tightenOnly ? { tightenOnly: true } : {}) };
}
