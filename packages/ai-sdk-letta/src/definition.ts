import type { ToolSet } from 'ai';
import type { CreateAgentOptions } from '@letta-ai/letta-agent-sdk';
import { ASK_USER_TOOL } from './tools.js';

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
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid tool name "${name}"`);
  }
  const permissions: Record<string, ToolPermission> = {};
  for (const [name, mode] of Object.entries(input.permissions ?? {})) {
    if (!names.includes(name)) throw new Error(`Permission for unknown tool "${name}"`);
    if (!permissionValues.includes(mode as ToolPermission)) throw new Error(`Invalid permission for "${name}"`);
    permissions[name] = mode as ToolPermission;
  }
  if (names.includes(ASK_USER_TOOL)) {
    permissions[ASK_USER_TOOL] ??= 'allow';
    if (permissions[ASK_USER_TOOL] === 'ask') throw new Error('ask_user is already interactive; use "allow" or "deny"');
  }
  const missing = names.filter(name => !Object.hasOwn(permissions, name));
  if (missing.length) throw new Error(`Missing permission for tool(s): ${missing.join(', ')}. Every tool needs "allow", "ask" or "deny".`);
  const dreaming = { ...DEFAULT_DREAMING, ...input.dreaming };
  if (!['off', 'step-count', 'compaction-event'].includes(dreaming.trigger)) throw new Error('Invalid dreaming trigger');
  if (!Number.isInteger(dreaming.stepCount) || dreaming.stepCount < 1 || dreaming.stepCount > 10_000) throw new Error('Dreaming stepCount must be a positive integer');
  const toolTimeoutMs = input.toolTimeoutMs ?? 5000;
  if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 300_000) throw new Error('toolTimeoutMs must be 1–300000');
  return Object.freeze({
    id: input.id, name: input.name, model: input.model, instructions: input.instructions, tools: input.tools,
    permissions: Object.freeze(permissions), dreaming: Object.freeze(dreaming), toolTimeoutMs,
  });
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
