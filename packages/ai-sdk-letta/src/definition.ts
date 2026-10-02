import type { ToolSet } from 'ai';
import type { CreateAgentOptions } from '@letta-ai/letta-agent-sdk';
import { ASK_USER_TOOL } from './tools.js';
import { REQUEST_DECISION_TOOL } from './decisions.js';
import { resolveSandboxConfig, type ResolvedSandboxConfig, type SandboxConfig } from './sandbox.js';
import { REPLY_MODE_SETTINGS, STAY_SILENT_TOOL, type ReplyModeSetting } from './listening.js';

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
  // Network commands always need a human: approval is the only network switch.
  if (permissions.run_command_online === 'allow') throw new Error('run_command_online uses the network; its permission must be "ask" or "deny"');
  const sandbox = input.sandbox === undefined ? undefined : resolveSandboxConfig(input.sandbox);
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
  return Object.freeze({
    id: input.id, name: input.name, model: input.model, instructions: input.instructions, tools: input.tools,
    permissions: Object.freeze(permissions), dreaming: Object.freeze(dreaming), toolTimeoutMs, ...(sandbox ? { sandbox } : {}), ui, replyMode,
  });
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
    + 'Bash is restricted to the exact memory commit command supplied in tool permission feedback; no general shell or filesystem actions are available. '
    + (dreaming.trigger === 'off'
      ? 'Background dreaming is off.'
      : `Background dreaming consolidates memory${dreaming.trigger === 'step-count' ? ` after ${dreaming.stepCount} steps` : ' after compaction'}; do not claim a dream ran without evidence.`);
}

/** Letta Agent SDK creation options for a definition. */
export function creationOptions(definition: AgentDefinition, cwd: string): CreateAgentOptions {
  return {
    name: definition.name, model: definition.model, cwd, memfs: true,
    baseTools: [], skillSources: [], systemPrompt: `${definition.instructions}\n\n${memoryPolicyInstructions(definition.dreaming)}`,
    // Do not pass `dreaming` here: the SDK applies it with scope 'both', which
    // mutates the user's global Letta defaults. The runtime installs the
    // definition's settings with scope 'local_project' in the private state cwd.
  };
}

/** Protocol command that applies dreaming settings to this project scope only. */
export function dreamingCommand(definition: AgentDefinition, agentId: string, conversationId = 'default') {
  return {
    type: 'set_reflection_settings', runtime: { agent_id: agentId, conversation_id: conversationId },
    scope: 'local_project', settings: { trigger: definition.dreaming.trigger, step_count: definition.dreaming.stepCount },
  } as const;
}
