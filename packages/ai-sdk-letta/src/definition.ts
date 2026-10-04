import type { ToolSet } from 'ai';
import type { CreateAgentOptions } from '@letta-ai/letta-agent-sdk';
import { ASK_USER_TOOL } from './tools.js';
import { REQUEST_DECISION_TOOL } from './decisions.js';
import { resolveSandboxConfig, WEBDEV_IMAGE, type ResolvedSandboxConfig, type SandboxConfig } from './sandbox.js';
import { includesWebDevTools, isBrowserOutputTool, resolveWebDevConfig, webDevEnabled, WEB_DEV_NOTE, type ResolvedWebDevConfig, type WebDevConfig } from './webdev.js';
import { REPLY_MODE_SETTINGS, STAY_SILENT_TOOL, type ReplyModeSetting } from './listening.js';
import { resolveMcpApps, type McpAppConfig, type ResolvedMcpAppConfig } from './mcp-apps.js';

/**
 * How the agent's memory is protected and reviewed (see `MemoryGuard`).
 *
 * - `protected`: memory files only an admin's own turn with no untrusted
 *   content may change (exact paths, or `folder/**`; case-insensitive).
 * - `reviewer`: the model of Jiminy, the reviewer of memory changes: a
 *   handle, `'auto'` (a model of another family than the agent's when one is
 *   connected, else the agent's), or `'off'` (no review).
 * - `reviewTimeoutMs`: most time one review may take.
 * - `trustJiminy`: trust mode. Protected-file changes from a person's
 *   attended turn that is not an admin turn with no untrusted content are
 *   not refused up front; Jiminy reviews them (accept keeps them; reject and
 *   ask_human as usual). Automations, schedules, new root files and letter
 *   case aliases stay refused. Each conversation can override it. @default false
 * - `approveDreams`: when the Letta harness supports it (a capability it
 *   advertises), dreams are reviewed before they are merged into memory.
 *   Otherwise, and when `false`, they are reviewed right after.
 */
export interface MemorySettings {
  protected: readonly string[]; reviewer: string; reviewTimeoutMs: number; approveDreams: boolean; trustJiminy: boolean;
  /**
   * Application tools whose results are the app's own (computed, not
   * written by someone else), so reading them does not make a turn
   * untrusted. Other application tools count as untrusted content.
   */
  trustedTools: readonly string[];
}
/** Memory settings used when a definition sets none. */
export const DEFAULT_MEMORY: Readonly<MemorySettings> = Object.freeze({ protected: Object.freeze(['persona.md', 'rules.md', 'goals.md', 'MEMORY.md', 'system/**']), reviewer: 'auto', reviewTimeoutMs: 90_000, approveDreams: true, trustJiminy: false, trustedTools: Object.freeze([]) as readonly string[] });

/** Per-agent settings of the `web_search` tool. */
export interface WebSearchSettings {
  /**
   * How long a person has to review a web search result before it expires
   * (the agent is then told "Web research expired" and gets none of it; the
   * conversation stays usable). Also bounded by the Letta harness, which
   * ends any application tool call 5 minutes after it starts: the search
   * itself counts, so a review never lasts beyond about 4 min 50 s after the
   * search began. @default 280000 (the maximum)
   *
   * A result nobody reviews in time becomes a decision (on servers that keep
   * decisions): the agent ends its turn, and the result waits, without a
   * time limit, until the person who asked (or an admin) reviews it.
   */
  reviewTimeoutMs: number;
  /**
   * A result waiting as a decision that is older than this can also be
   * answered with "Search again" (the agent then searches anew). @default 604800000 (7 days)
   */
  staleAfterMs: number;
}
/** Bounds of {@link WebSearchSettings.reviewTimeoutMs}. */
export const WEB_SEARCH_REVIEW_LIMITS = Object.freeze({
  minTimeoutMs: 10_000,
  /** The Letta harness ends an application tool call after 300 s (it refuses longer timeouts); 20 s are kept for the search and the reply. */
  maxTimeoutMs: 280_000,
  defaultTimeoutMs: 280_000,
  /** Longest a review may last after the search started (the harness ends the call at 300 s). */
  callBudgetMs: 290_000,
  /** Bounds of {@link WebSearchSettings.staleAfterMs}: one minute to one year; default 7 days. */
  minStaleMs: 60_000,
  maxStaleMs: 366 * 86_400_000,
  defaultStaleMs: 7 * 86_400_000,
});
export const DEFAULT_WEB_SEARCH: Readonly<WebSearchSettings> = Object.freeze({ reviewTimeoutMs: WEB_SEARCH_REVIEW_LIMITS.defaultTimeoutMs, staleAfterMs: WEB_SEARCH_REVIEW_LIMITS.defaultStaleMs });

/** How a single application tool call is authorized. */
export type ToolPermission = 'allow' | 'ask' | 'deny';

/** When Letta runs background memory consolidation ("dreaming"). */
export type DreamingTrigger = 'off' | 'step-count' | 'compaction-event';

export interface DreamingSettings {
  /** @default 'step-count' */
  trigger: DreamingTrigger;
  /** Steps between dreams when `trigger` is `'step-count'`. @default 25 */
  stepCount: number;
}

/** How the browser app presents this agent's replies. Other interfaces ignore it. */
export interface AgentUiSettings {
  /**
   * Render LaTeX maths in replies: `\(...\)` inline and `\[...\]` display
   * (never `$...$`, never inside code). Each conversation can override it in
   * the browser app ("LaTeX: Agent default / On / Off"). @default true
   */
  latex: boolean;
}

/** UI settings used when a definition sets none. */
export const DEFAULT_UI: Readonly<AgentUiSettings> = Object.freeze({ latex: true });

/** Input accepted by {@link defineAgent}. */
export interface AgentDefinitionInput<TOOLS extends ToolSet = ToolSet> {
  /**
   * Stable, application-owned logical ID (lowercase letters, digits and `-`).
   * It is mapped once to the Letta-generated agent ID and never re-created.
   */
  id: string;
  /** Display name. Also stored on the Letta agent and checked on every start. */
  name: string;
  /**
   * Letta model handle, e.g. `openai-codex/gpt-5.5` or `anthropic/claude-sonnet-4-5`.
   * Only used when the agent is first created; must be connected on the local backend.
   */
  model: string;
  /** System instructions, applied when the agent is first created. */
  instructions: string;
  /** AI SDK tools executed in this process when the agent calls them. */
  tools: TOOLS;
  /**
   * Permission per tool. Fail-closed: every tool must be listed.
   * `ask_user` defaults to `'allow'` (it is itself a human interaction).
   */
  permissions?: Partial<Record<Extract<keyof TOOLS, string>, ToolPermission>>;
  /** Background memory consolidation. @default { trigger: 'step-count', stepCount: 25 } */
  dreaming?: Partial<DreamingSettings>;
  /** Per-call tool execution deadline in milliseconds (human waits excluded). @default 5000 */
  toolTimeoutMs?: number;
  /**
   * Where `run_command` and `run_command_online` run commands. Without it,
   * those tools are never exposed. See `sandboxTools`.
   */
  sandbox?: SandboxConfig;
  /** Browser app presentation, e.g. `{ latex: false }`. @default { latex: true } */
  ui?: Partial<AgentUiSettings>;
  /**
   * When the agent replies in conversations shared by several people (team
   * servers): `'always'`, `'when-addressed'` (only when mentioned or asked
   * directly), `'agent-decides'`, or `'auto'`: always when one person uses
   * the agent, agent decides when it has several members. In the other modes the
   * agent still reads every message (and may use tools and update its memory)
   * but may only listen. Each conversation can override it. @default 'auto'
   */
  replyMode?: ReplyModeSetting;
  /** Settings of the `web_search` tool, e.g. `{ reviewTimeoutMs: 120_000 }`. @default { reviewTimeoutMs: 280000 } */
  webSearch?: Partial<WebSearchSettings>;
  /** Memory protection and review, e.g. `{ protected: ['persona.md', 'policies/**'], reviewer: 'anthropic/claude-sonnet-5' }`. See {@link MemorySettings}. */
  memory?: Partial<MemorySettings>;
  /**
   * Web app development (with `webDevTools` and a sandbox): the services
   * container's memory and idle timeout, e.g. `{ memory: '3G' }`. With the
   * web development tools, the sandbox uses `WEBDEV_IMAGE` (Node, Chromium,
   * chrome-devtools-mcp) unless `sandbox.image` names another.
   * @default { memory: '3G', idleTimeoutMs: 1800000 }
   */
  webDev?: WebDevConfig;
  /**
   * Adopt an existing local Letta agent in place (for example one made with
   * Letta Code): this definition opens that agent, by ID, with its memory and
   * conversations. It is never created, and its system prompt, model and
   * tags are not changed (`instructions` and `model` are not applied; set
   * `model` to the agent's model, which the reviewer and summarizer use).
   * Its own Letta Code commits are reviewed but never reverted.
   */
  adopt?: { agentId: string };
  /**
   * MCP Apps (run mode): MCP servers with interactive views, installed from
   * local packages or folders (never URLs), each run in its own container
   * with no network. Needs `sandbox` with the built-in `docker` or
   * `apple-container` provider (it names the container CLI; the app tools
   * do not need `sandboxTools`). See `McpAppConfig` and the README, "MCP Apps".
   */
  mcpApps?: readonly McpAppConfig[];
}

/** A validated, immutable agent definition. */
export interface AgentDefinition<TOOLS extends ToolSet = ToolSet> {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly instructions: string;
  readonly tools: TOOLS;
  readonly permissions: Readonly<Record<string, ToolPermission>>;
  readonly dreaming: Readonly<DreamingSettings>;
  readonly toolTimeoutMs: number;
  readonly sandbox?: ResolvedSandboxConfig;
  readonly ui: Readonly<AgentUiSettings>;
  readonly replyMode: ReplyModeSetting;
  readonly webSearch: Readonly<WebSearchSettings>;
  readonly memory: Readonly<MemorySettings>;
  /** Web development settings (used when the definition has `webDevTools`). */
  readonly webDev: ResolvedWebDevConfig;
  /** An existing Letta agent this definition adopts in place (see {@link AgentDefinitionInput.adopt}). */
  readonly adopt?: Readonly<{ agentId: string }>;
  /** MCP Apps (see {@link AgentDefinitionInput.mcpApps}); empty without any. */
  readonly mcpApps?: readonly ResolvedMcpAppConfig[];
}

/** Tools the harness uses for MemFS. They are confined to the agent's own memory directory. */
export const INTERNAL_MEMORY_TOOLS = ['Read', 'Write', 'Edit', 'Bash'] as const;

export const DEFAULT_DREAMING: Readonly<DreamingSettings> = Object.freeze({ trigger: 'step-count', stepCount: 25 });

const permissionValues: readonly ToolPermission[] = ['allow', 'ask', 'deny'];

/**
 * Validate and freeze an agent definition.
 *
 * @throws if the ID is invalid, a tool lacks a permission, or a permission names an unknown tool.
 */
export function defineAgent<TOOLS extends ToolSet>(input: AgentDefinitionInput<TOOLS>): AgentDefinition<TOOLS> {
  if (typeof input.id !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input.id)) {
    throw new Error('Agent id must be 1–64 lowercase letters, digits or "-", starting and ending with a letter or digit');
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('Agent name must contain 1–120 characters');
  if (typeof input.model !== 'string' || !input.model.includes('/')) throw new Error('Agent model must be a Letta model handle such as "provider/model"');
  if (typeof input.instructions !== 'string' || !input.instructions.trim()) throw new Error('Agent instructions are required');
  if (input.tools === null || typeof input.tools !== 'object' || Array.isArray(input.tools)) throw new Error('Agent tools must be an object of AI SDK tools; use {} for none');
  const names = Object.keys(input.tools);
  for (const name of names) {
    if ((INTERNAL_MEMORY_TOOLS as readonly string[]).includes(name)) throw new Error(`Tool name "${name}" is reserved for memory operations`);
    if (name === STAY_SILENT_TOOL) throw new Error(`Tool name "${name}" is reserved: team servers provide it so the agent can listen without replying`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid tool name "${name}"`);
  }
  const permissions: Record<string, ToolPermission> = {};
  for (const [name, mode] of Object.entries(input.permissions ?? {})) {
    if (!names.includes(name)) throw new Error(`Permission for unknown tool "${name}"`);
    if (!permissionValues.includes(mode as ToolPermission)) throw new Error(`Invalid permission for "${name}"`);
    permissions[name] = mode as ToolPermission;
  }
  if (names.includes(REQUEST_DECISION_TOOL) && permissions[REQUEST_DECISION_TOOL] === 'ask') throw new Error('request_decision already asks people (it is the human gate); use "allow" or "deny"');
  if (names.includes(ASK_USER_TOOL)) {
    permissions[ASK_USER_TOOL] ??= 'allow';
    if (permissions[ASK_USER_TOOL] === 'ask') throw new Error('ask_user is already interactive; use "allow" or "deny"');
  }
  // Every web search result is reviewed by a person (or pre-approved by an automation): never 'allow'.
  if (permissions.web_search === 'allow') throw new Error('web_search results are reviewed by a person before the agent sees them; its permission must be "ask" or "deny"');
  // Network commands always need a human: approval is the only network switch.
  if (permissions.run_command_online === 'allow') throw new Error('run_command_online uses the network; its permission must be "ask" or "deny"');
  // Approving an outside origin for the app always needs a person.
  if (permissions.allow_web_origin === 'allow') throw new Error('allow_web_origin lets the app reach the internet; its permission must be "ask" or "deny"');
  // Web development needs Node and Chromium: its image, unless the definition names another.
  const sandbox = input.sandbox === undefined ? undefined : resolveSandboxConfig(includesWebDevTools(input.tools) && input.sandbox && typeof input.sandbox === 'object' && input.sandbox.image === undefined ? { ...input.sandbox, image: WEBDEV_IMAGE } : input.sandbox);
  const webDev = resolveWebDevConfig(input.webDev);
  const missing = names.filter(name => !Object.hasOwn(permissions, name));
  if (missing.length) throw new Error(`Missing permission for tool(s): ${missing.join(', ')}. Every tool needs "allow", "ask" or "deny".`);
  const dreaming = { ...DEFAULT_DREAMING, ...input.dreaming };
  if (!['off', 'step-count', 'compaction-event'].includes(dreaming.trigger)) throw new Error('Invalid dreaming trigger');
  if (!Number.isInteger(dreaming.stepCount) || dreaming.stepCount < 1 || dreaming.stepCount > 10_000) throw new Error('Dreaming stepCount must be a positive integer');
  const toolTimeoutMs = input.toolTimeoutMs ?? 5000;
  if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 300_000) throw new Error('toolTimeoutMs must be 1–300000');
  const ui = resolveUi(input.ui);
  const replyMode = input.replyMode ?? 'auto';
  if (!REPLY_MODE_SETTINGS.includes(replyMode)) throw new Error(`replyMode must be one of: ${REPLY_MODE_SETTINGS.join(', ')}`);
  const webSearch = resolveWebSearch(input.webSearch);
  if (names.includes('memory_provenance')) throw new Error('Tool name "memory_provenance" is reserved: the runtime provides it');
  const memory = resolveMemory(input.memory);
  if (input.adopt !== undefined && (input.adopt === null || typeof input.adopt !== 'object' || typeof input.adopt.agentId !== 'string' || !/^agent-local-[a-zA-Z0-9-]{1,100}$/.test(input.adopt.agentId))) throw new Error('adopt.agentId must be a local Letta agent ID (agent-local-...)');
  const adopt = input.adopt ? Object.freeze({ agentId: input.adopt.agentId }) : undefined;
  const mcpApps = resolveMcpApps(input.mcpApps);
  if (mcpApps.length && (!sandbox || (sandbox.provider !== 'docker' && sandbox.provider !== 'apple-container'))) throw new Error('mcpApps need sandbox with the built-in "docker" or "apple-container" provider: each app server runs in its own container');
  // App tools are named <app id>__<tool>: an application tool must not look like one.
  const clash = names.find(name => mcpApps.some(app => name.startsWith(`${app.id}__`)));
  if (clash) throw new Error(`Tool name "${clash}" is reserved for the MCP App "${clash.split('__')[0]}"`);
  const trustedApp = memory.trustedTools.find(name => mcpApps.some(app => name.startsWith(`${app.id}__`)));
  if (trustedApp) throw new Error(`memory.trustedTools cannot include ${trustedApp}: MCP App results are the app's content, always untrusted`);
  return Object.freeze({
    ...(adopt ? { adopt } : {}), ...(mcpApps.length ? { mcpApps } : {}),
    id: input.id, name: input.name, model: input.model, instructions: input.instructions, tools: input.tools,
    permissions: Object.freeze(permissions), dreaming: Object.freeze(dreaming), toolTimeoutMs, ...(sandbox ? { sandbox } : {}), ui, replyMode, webSearch, memory, webDev,
  });
}

function resolveMemory(input: unknown): Readonly<MemorySettings> {
  if (input === undefined) return DEFAULT_MEMORY;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('memory must be an object such as { reviewer: "auto" }');
  const unknown = Object.keys(input).filter(key => !['protected', 'reviewer', 'reviewTimeoutMs', 'approveDreams', 'trustJiminy', 'trustedTools'].includes(key));
  if (unknown.length) throw new Error(`Unknown memory setting(s): ${unknown.join(', ')}. Supported: protected, reviewer, reviewTimeoutMs, approveDreams, trustJiminy, trustedTools.`);
  const { protected: patterns = DEFAULT_MEMORY.protected, reviewer = DEFAULT_MEMORY.reviewer, reviewTimeoutMs = DEFAULT_MEMORY.reviewTimeoutMs, approveDreams = DEFAULT_MEMORY.approveDreams, trustJiminy = DEFAULT_MEMORY.trustJiminy, trustedTools = DEFAULT_MEMORY.trustedTools } = input as Partial<Record<keyof MemorySettings, unknown>>;
  if (!Array.isArray(trustedTools) || trustedTools.some(t => typeof t !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(t))) throw new Error('memory.trustedTools must be tool names');
  // What a page or a dev server shows is never the app's own content.
  const browser = (trustedTools as string[]).filter(t => t.startsWith('browser_') || isBrowserOutputTool(t));
  if (browser.length) throw new Error(`memory.trustedTools cannot include ${browser.join(', ')}: browser and dev server output is page content, always untrusted`);
  if (!Array.isArray(patterns) || patterns.length > 100 || patterns.some(p => typeof p !== 'string' || !/^[\w .@-]+(?:\/[\w .@-]+)*(?:\/\*\*)?$/.test(p) || p.split('/').some(part => part === '..' || part === '.' || part.startsWith('.')))) throw new Error('memory.protected must be up to 100 memory paths such as "persona.md" or "policies/**"');
  if (typeof reviewer !== 'string' || !(reviewer === 'auto' || reviewer === 'off' || /^[\w.-]+\/[\w.:-]+$/.test(reviewer))) throw new Error('memory.reviewer must be "auto", "off" or a model handle such as "anthropic/claude-sonnet-5"');
  if (typeof reviewTimeoutMs !== 'number' || !Number.isInteger(reviewTimeoutMs) || reviewTimeoutMs < 5000 || reviewTimeoutMs > 600_000) throw new Error('memory.reviewTimeoutMs must be 5000–600000');
  if (typeof approveDreams !== 'boolean') throw new Error('memory.approveDreams must be true or false');
  if (typeof trustJiminy !== 'boolean') throw new Error('memory.trustJiminy must be true or false');
  return Object.freeze({ protected: Object.freeze([...patterns as string[]]), reviewer, reviewTimeoutMs, approveDreams, trustJiminy, trustedTools: Object.freeze([...trustedTools as string[]]) });
}

function resolveWebSearch(input: unknown): Readonly<WebSearchSettings> {
  if (input === undefined) return DEFAULT_WEB_SEARCH;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('webSearch must be an object such as { reviewTimeoutMs: 120000 }');
  const unknown = Object.keys(input).filter(key => key !== 'reviewTimeoutMs' && key !== 'staleAfterMs');
  if (unknown.length) throw new Error(`Unknown webSearch setting(s): ${unknown.join(', ')}. Supported: reviewTimeoutMs, staleAfterMs.`);
  const { reviewTimeoutMs = DEFAULT_WEB_SEARCH.reviewTimeoutMs, staleAfterMs = DEFAULT_WEB_SEARCH.staleAfterMs } = input as { reviewTimeoutMs?: unknown; staleAfterMs?: unknown };
  const { minTimeoutMs, maxTimeoutMs, minStaleMs, maxStaleMs } = WEB_SEARCH_REVIEW_LIMITS;
  if (typeof reviewTimeoutMs !== 'number' || !Number.isInteger(reviewTimeoutMs) || reviewTimeoutMs < minTimeoutMs || reviewTimeoutMs > maxTimeoutMs) {
    throw new Error(`webSearch.reviewTimeoutMs must be ${minTimeoutMs}–${maxTimeoutMs} ms: the Letta harness ends an application tool call (the search and its review) after 5 minutes`);
  }
  if (typeof staleAfterMs !== 'number' || !Number.isInteger(staleAfterMs) || staleAfterMs < minStaleMs || staleAfterMs > maxStaleMs) {
    throw new Error(`webSearch.staleAfterMs must be ${minStaleMs}–${maxStaleMs} ms`);
  }
  return Object.freeze({ reviewTimeoutMs, staleAfterMs });
}

function resolveUi(input: unknown): Readonly<AgentUiSettings> {
  if (input === undefined) return DEFAULT_UI;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('ui must be an object such as { latex: false }');
  const unknown = Object.keys(input).filter(key => key !== 'latex');
  if (unknown.length) throw new Error(`Unknown ui setting(s): ${unknown.join(', ')}. Supported: latex.`);
  const { latex = DEFAULT_UI.latex } = input as { latex?: unknown };
  if (typeof latex !== 'boolean') throw new Error('ui.latex must be true or false');
  return Object.freeze({ latex });
}

/**
 * Appended to the definition's instructions at creation, so the model knows
 * what the (enforced) memory policy allows.
 */
export function memoryPolicyInstructions(dreaming: DreamingSettings): string {
  return 'Maintain useful long-term memory in your own MemFS only. Read, Write and Edit are restricted to Markdown files in your memory directory. '
    + 'Every memory Markdown file starts with frontmatter (--- then name: and description: lines, then ---), except MEMORY.md indexes, which have none; dreaming refuses to commit files without it. '
    + 'Some memory files are protected (your persona, rules, goals and index): only an admin\'s own turn that read no untrusted content may change them. Every memory change is recorded with who asked for it and what you had read, and reviewed; a change may be reverted. Call memory_provenance with a path to see who changed a memory file and why. '
    + 'Bash is restricted to the exact memory commit command supplied in tool permission feedback; no general shell or filesystem actions are available. '
    + (dreaming.trigger === 'off'
      ? 'Background dreaming is off.'
      : `Background dreaming consolidates memory${dreaming.trigger === 'step-count' ? ` after ${dreaming.stepCount} steps` : ' after compaction'}; do not claim a dream ran without evidence.`);
}

/** Letta Agent SDK creation options for a definition. */
export function creationOptions(definition: AgentDefinition, cwd: string): CreateAgentOptions {
  return {
    name: definition.name, model: definition.model, cwd, memfs: true,
    baseTools: [], skillSources: [], systemPrompt: `${definition.instructions}\n\n${webDevEnabled(definition) ? `${WEB_DEV_NOTE}\n\n` : ''}${memoryPolicyInstructions(definition.dreaming)}`,
    // Do not pass `dreaming` here: the SDK applies it with scope 'both', which
    // mutates the user's global Letta defaults. The runtime installs the
    // definition's settings with scope 'local_project' in the private state cwd.
  };
}

/**
 * Protocol command that applies dreaming settings to this project scope
 * only. The merge mode is always `auto` (the harness merges dreams itself;
 * the memory guard reviews them), never `explicit`, whatever the user's
 * global Letta settings say.
 */
export function dreamingCommand(definition: AgentDefinition, agentId: string, conversationId = 'default') {
  return {
    type: 'set_reflection_settings', runtime: { agent_id: agentId, conversation_id: conversationId },
    scope: 'local_project', settings: { trigger: definition.dreaming.trigger, step_count: definition.dreaming.stepCount, merge: 'auto' },
  } as const;
}
