import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LettaAgent as LettaAgentState, LettaConversation } from '@letta-ai/letta-agent-sdk';
import { JIMINY_NAME } from './jiminy.js';
import { WEB_SUMMARIZER_NAME } from './web-summarizer.js';
import { validLocalAgentId } from './temporary-agents.js';
import type { ToolSet } from 'ai';
import { defineAgent, type AgentDefinition, type DreamingSettings, type ToolPermission } from './definition.js';
import { fileTools, FILE_TOOL_PERMISSIONS } from './file-tools.js';
import { checkProjectFolder, projectNote, sandboxTools, SandboxError, SANDBOX_LIMITS, SANDBOX_TOOL_PERMISSIONS, type SandboxConfig } from './sandbox.js';
import { decisionTools, DECISION_TOOL_PERMISSIONS } from './decisions.js';
import { webSearchTools, WEB_SEARCH_TOOL_PERMISSIONS } from './web-search.js';
import { askUserTool, ASK_USER_TOOL } from './tools.js';
import { webDevTools, WEBDEV_TOOL_PERMISSIONS, WEB_DEV_NOTE } from './webdev.js';
import { mcpAppDevTools, MCP_APP_DEV_TOOL_PERMISSIONS } from './mcp-app-dev.js';
import { MCP_APP_DEV_NOTE } from './mcp-app-guide.js';
import { SANDBOX_IMAGE } from './sandbox.js';

/**
 * Adopting existing local Letta agents in place: an agent made elsewhere
 * (for example with Letta Code) is opened by its ID, with its own memory and
 * conversations. Nothing is copied and no agent is ever created for it; its
 * system prompt, model and tags stay as they are unless a person approves an
 * instructions update (see {@link instructionsUpdate}).
 *
 * This module holds the pure and file-level parts: which agents may be
 * adopted, whether Letta Code is using one right now, the adoption records
 * (`<state>/adopted.json`), and the instructions section.
 *
 * @module
 */

/**
 * Tool sets an adopted agent may get, in their canonical order. `web_dev`
 * (`webDevTools`: dev server, Preview pane, headless browser) needs
 * `sandbox`; `mcp_app_dev` (`mcpAppDevTools`) needs `web_dev`. Both need a
 * host sandbox with the built-in `docker` or `apple-container` provider
 * (see {@link adoptedToolsRefusal}).
 */
export const ADOPTED_TOOL_SETS = ['files', 'sandbox', 'decisions', 'web_search', 'ask_user', 'web_dev', 'mcp_app_dev'] as const;
export type AdoptedToolSet = typeof ADOPTED_TOOL_SETS[number];

/** One adopted agent, as the app records it. */
export type AdoptionRecord = {
  /** The logical ID the app uses for it (lowercase, `-`). */
  definitionId: string;
  agentId: string;
  /** The agent's name and model when it was adopted. */
  name: string;
  model: string;
  /** Its reasoning effort (`none` … `max`) when set from the app's model picker; Letta's `model_settings` stay the source of truth. */
  effort?: string;
  /** Tool sets it gets in this app. */
  tools: AdoptedToolSet[];
  adoptedAt: string;
  /** An approved instructions update: the system prompt before it, and after it (for a revert). */
  instructions?: { before: string; after: string; at: string };
  /** Its project folder on this computer, as the person gave it (symlinks are resolved only for the mount): mounted read-write at `/project` in its sandbox. See {@link checkAdoptedProject}. */
  project?: string;
  /**
   * Its sandbox's per-command timeout (ms), replacing the host's
   * `sandbox.timeoutMs` (default 120000, at most 240000). Raise it for long
   * builds; see {@link SANDBOX_LIMITS}.
   */
  commandTimeoutMs?: number;
  /**
   * View only: the app shows its conversations (updated live as Letta Code
   * works) but never sends, opens a session, gives it tools, starts
   * containers, or reviews or reverts its memory. An agent in use in Letta
   * Code may be adopted this way; turning it off checks that again.
   */
  viewOnly?: true;
};
type AdoptionFile = { version: 1; agents: AdoptionRecord[] };

/** Most agents one app adopts. */
export const ADOPTION_LIMIT = 20;

/** Tags and names of agents that are never offered: Letta Code subagents (memory, reflection, history), our own temporary ones. */
export function hiddenAgent(agent: Pick<LettaAgentState, 'name' | 'tags'> & { hidden?: boolean | null }): boolean {
  const tags = agent.tags ?? [];
  if (agent.hidden) return true;
  if (tags.some(tag => tag === 'role:subagent' || tag.startsWith('parent:') || tag === 'ai-sdk-letta:temporary' || /^ai-sdk-letta[:-]/.test(tag))) return true;
  return agent.name === JIMINY_NAME || agent.name === WEB_SUMMARIZER_NAME || /^(Reflection Subagent|History Analyzer)$/i.test(agent.name ?? '');
}

/** Why an agent cannot be adopted (a fixed code), or `undefined`. */
export function adoptionRefusal(agent: Pick<LettaAgentState, 'id' | 'name' | 'tags'> & { hidden?: boolean | null } | undefined): string | undefined {
  if (!agent || !validLocalAgentId(agent.id)) return 'agent_missing';
  if (hiddenAgent(agent)) return 'agent_hidden';
  if (!agent.tags?.includes('git-memory-enabled')) return 'agent_without_memfs';
  return undefined;
}

/** A stable logical ID for an adopted agent: its name, plus the start of its ID (`blog-2cc740f1`). */
export function adoptedDefinitionId(agent: { id: string; name: string }): string {
  const slug = agent.name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
  const suffix = agent.id.replace(/^agent-local-/, '').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  return `${slug}-${suffix}`.replace(/-+/g, '-');
}

/** A local agent as the "Add agent" picker lists it. */
export type LocalAgentSummary = { agentId: string; name: string; model: string; lastActivity?: string; conversations: number; adoptedAs?: string; refusal?: string };

/**
 * Local agents a person may adopt (hidden and temporary agents excluded),
 * newest activity first, with their conversation count (`default`
 * included) and last activity. Read-only.
 */
export async function listAdoptableAgents(client: {
  agents: { list(options?: { limit?: number }): Promise<LettaAgentState[]> };
  conversations: { list(options: { agentId: string; limit: number; after?: string }): Promise<LettaConversation[]> };
}, adopted: readonly Pick<AdoptionRecord, 'agentId' | 'definitionId'>[] = []): Promise<LocalAgentSummary[]> {
  const agents = (await client.agents.list({ limit: 1000 })).filter(agent => validLocalAgentId(agent.id) && !hiddenAgent(agent as never));
  const rows = await Promise.all(agents.map(async agent => {
    let conversations: LettaConversation[] = [];
    try {
      let after: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await client.conversations.list({ agentId: agent.id, limit: 100, ...(after ? { after } : {}) });
        conversations.push(...page.filter(c => c.agent_id === agent.id));
        if (page.length < 100) break;
        after = page.at(-1)!.id;
      }
    } catch { conversations = []; }
    const times = [...conversations.map(c => c.last_message_at ?? c.updated_at ?? c.created_at), (agent as { last_run_completion?: string | null }).last_run_completion].filter((t): t is string => typeof t === 'string' && Number.isFinite(Date.parse(t)));
    const lastActivity = times.sort().at(-1);
    const model = (agent as { model?: string | null }).model ?? (agent as { llm_config?: { handle?: string } }).llm_config?.handle ?? '';
    const mine = adopted.find(a => a.agentId === agent.id);
    const refusal = adoptionRefusal(agent as never);
    const summary: LocalAgentSummary = { agentId: agent.id, name: agent.name ?? agent.id, model, conversations: conversations.filter(c => !c.archived).length + 1, ...(lastActivity ? { lastActivity } : {}), ...(mine ? { adoptedAs: mine.definitionId } : {}), ...(refusal ? { refusal } : {}) };
    return summary;
  }));
  return rows.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* Is Letta Code using the agent?                                      */
/* ------------------------------------------------------------------ */

/** Whether Letta Code seems to use an agent now. `active`: a running Letta Code process names it (refuse); `recent`: its memory or conversations changed lately (warn). */
export type LettaCodeActivity = { active: boolean; recent: boolean; reason?: string; lastChange?: string };
/** Options of {@link lettaCodeActivity}: where the backend is, and (tests) the process list and clock. */
export type ActivityOptions = { backendDirectory: string; processes?: readonly string[]; now?: number; recentMs?: number; conversations?: readonly string[] };
/** How recent a change counts as "in use" for the warning. @default 15 minutes */
export const RECENT_ACTIVITY_MS = 15 * 60_000;

/**
 * The folder of a Letta Code conversation in the local backend:
 * `<backend>/conversations/<base64url("conversation:<id>")>/`, or
 * `base64url("default:<agent>")` for an agent's default conversation. It holds
 * `conversation.json` and `messages.jsonl` (which grows as messages arrive).
 */
export const conversationDirectory = (backend: string, id: string, agentId?: string) => join(backend, 'conversations', Buffer.from(id === 'default' && agentId ? `default:${agentId}` : `conversation:${id}`).toString('base64url'));
const conversationFile = (backend: string, id: string) => join(conversationDirectory(backend, id), 'conversation.json');
const runningProcesses = (): string[] => {
  try { return execFileSync('ps', ['-axo', 'args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }).split('\n'); } catch { return []; }
};

/**
 * Detect a Letta Code session of an agent (best effort, read-only):
 *
 * - **active** (refuse): a running Letta Code process names the agent
 *   (`--agent <id>`) or one of its conversations (`--conv <id>`).
 * - **recent** (warn only): its memory repository got a commit, or one of
 *   its conversations changed, within {@link RECENT_ACTIVITY_MS}. A Letta
 *   Code session started without arguments resumes its last agent and is
 *   not visible in the process list, so this is a warning, not a lock.
 */
export function lettaCodeActivity(agentId: string, options: ActivityOptions): LettaCodeActivity {
  if (!validLocalAgentId(agentId)) return { active: false, recent: false };
  const now = options.now ?? Date.now();
  const window = options.recentMs ?? RECENT_ACTIVITY_MS;
  for (const line of options.processes ?? runningProcesses()) {
    if (!/letta(\.js|-code)?\b/.test(line) || /\bserver --listen\b/.test(line) || /--new-agent\b/.test(line)) continue;
    const args = line.split(/\s+/);
    for (let i = 0; i < args.length - 1; i++) {
      const flag = args[i]!; const value = args[i + 1]!;
      if ((flag === '--agent' || flag === '-a') && value === agentId) return { active: true, recent: true, reason: 'A Letta Code session of this agent is running' };
      if ((flag === '--conv' || flag === '--conversation') && /^[\w-]+$/.test(value)) {
        try { const stored = JSON.parse(readFileSync(conversationFile(options.backendDirectory, value), 'utf8')) as { agent_id?: string }; if (stored.agent_id === agentId) return { active: true, recent: true, reason: `A Letta Code session of this agent is running (conversation ${value})` }; } catch { /* not ours */ }
      }
    }
  }
  const times: number[] = [];
  try {
    const out = execFileSync('git', ['-C', join(options.backendDirectory, 'memfs', agentId, 'memory'), 'log', '-1', '--format=%ct'], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
    if (/^\d+$/.test(out)) times.push(Number(out) * 1000);
  } catch { /* no memory repository */ }
  for (const id of options.conversations ?? []) {
    try { const stored = JSON.parse(readFileSync(conversationFile(options.backendDirectory, id), 'utf8')) as { agent_id?: string; last_message_at?: string }; if (stored.agent_id === agentId && stored.last_message_at) times.push(Date.parse(stored.last_message_at)); } catch { /* unknown */ }
  }
  const last = times.filter(Number.isFinite).sort((a, b) => b - a)[0];
  const recent = last !== undefined && now - last < window;
  return { active: false, recent, ...(last !== undefined ? { lastChange: new Date(last).toISOString() } : {}), ...(recent ? { reason: 'This agent changed in the last few minutes; it may be open in Letta Code' } : {}) };
}

/* ------------------------------------------------------------------ */
/* Adoption records                                                    */
/* ------------------------------------------------------------------ */

/**
 * The agents an app adopted (`<state>/adopted.json`, 0600, written
 * atomically). Removing a record never touches the Letta agent.
 */
export class AdoptionStore {
  constructor(readonly file: string) {}
  read(): AdoptionRecord[] {
    try {
      if (lstatSync(this.file).isSymbolicLink()) throw new Error('Unsafe adoption file');
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as AdoptionFile;
      if (value.version !== 1 || !Array.isArray(value.agents)) throw new Error('Invalid adoption file');
      return value.agents.filter(a => typeof a.definitionId === 'string' && validLocalAgentId(a.agentId));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private write(agents: AdoptionRecord[]) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp-${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, agents }, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file);
  }
  get(definitionId: string) { return this.read().find(a => a.definitionId === definitionId); }
  /**
   * Record an adoption. Refused (`agent_claimed`) when another record, or a
   * definition the app already hosts (`reserved`), names the same agent or ID.
   */
  add(record: AdoptionRecord, reserved: { definitionIds?: readonly string[]; agentIds?: readonly string[] } = {}): AdoptionRecord {
    const agents = this.read();
    if (agents.some(a => a.agentId === record.agentId) || reserved.agentIds?.includes(record.agentId)) throw new Error('agent_claimed');
    if (agents.some(a => a.definitionId === record.definitionId) || reserved.definitionIds?.includes(record.definitionId)) throw new Error('agent_claimed');
    if (agents.length >= ADOPTION_LIMIT) throw new Error('capacity_reached');
    this.write([...agents, record]);
    return record;
  }
  update(definitionId: string, change: (record: AdoptionRecord) => AdoptionRecord): AdoptionRecord {
    const agents = this.read();
    const index = agents.findIndex(a => a.definitionId === definitionId);
    if (index < 0) throw new Error('not_found');
    agents[index] = change(structuredClone(agents[index]!));
    this.write(agents);
    return agents[index]!;
  }
  /** Forget an adoption (the Letta agent and its memory stay as they are). */
  remove(definitionId: string): boolean {
    const agents = this.read();
    const kept = agents.filter(a => a.definitionId !== definitionId);
    if (kept.length === agents.length) return false;
    this.write(kept);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Instructions                                                        */
/* ------------------------------------------------------------------ */

export const INSTRUCTIONS_BEGIN = '<!-- ai-sdk-letta: begin -->';
export const INSTRUCTIONS_END = '<!-- ai-sdk-letta: end -->';

/** The ai-sdk-letta section of an adopted agent's instructions: the tools it has here, its project folder (its name, when one is mounted), and the memory policy. */
export function adoptedInstructionsSection(tools: readonly string[], memoryPolicy: string, project?: string): string {
  return [INSTRUCTIONS_BEGIN, '## In the ai-sdk-letta app',
    'You are also used through the ai-sdk-letta app (a browser app). There, only these tools are available: '
      + (tools.length ? tools.join(', ') : 'none besides memory') + '. Letta Code tools (shell, file editing outside memory, subagents) are not available in the app; do not call them there.',
    ...(project ? [projectNote(project)] : []),
    // Web and MCP App development: the agent learns to call their guides first (its own system prompt never gets the app's notes otherwise).
    ...(tools.includes('web_dev_guide') ? [WEB_DEV_NOTE] : []),
    ...(tools.includes('app_dev_guide') ? [MCP_APP_DEV_NOTE] : []),
    memoryPolicy, INSTRUCTIONS_END].join('\n');
}


/** `system` without the ai-sdk-letta section (if any). */
export function withoutInstructionsSection(system: string): string {
  const start = system.indexOf(INSTRUCTIONS_BEGIN);
  const end = system.indexOf(INSTRUCTIONS_END);
  if (start < 0 || end < start) return system;
  return (system.slice(0, start).replace(/\n+$/, '') + system.slice(end + INSTRUCTIONS_END.length).replace(/^\n+/, '\n')).replace(/\n$/, system.endsWith('\n') ? '\n' : '');
}

/** A proposed instructions update: the new text, and a line diff of what changes (only appended or replaced lines). */
export function instructionsUpdate(system: string, section: string): { next: string; diff: string; changed: boolean } {
  const base = withoutInstructionsSection(system).replace(/\s+$/, '');
  const next = `${base}\n\n${section}\n`;
  const before = system.split('\n');
  const after = next.split('\n');
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const removed = before.slice(prefix, before.length - suffix).map(line => `- ${line}`);
  const added = after.slice(prefix, after.length - suffix).map(line => `+ ${line}`);
  const context = before.slice(Math.max(0, prefix - 2), prefix).map(line => `  ${line}`);
  return { next, diff: [`@@ line ${prefix + 1} @@`, ...context, ...removed, ...added].join('\n'), changed: next !== system };
}

/* ------------------------------------------------------------------ */
/* The definition of an adopted agent                                  */
/* ------------------------------------------------------------------ */

/** Where adoption records live in a state root. */
export const adoptionFile = (stateDirectory: string) => join(stateDirectory, 'adopted.json');

/* ------------------------------------------------------------------ */
/* Project folder                                                      */
/* ------------------------------------------------------------------ */

const MOUNT_UNSAFE = /[,=\p{Cc}]/u;

/**
 * Check an adopted agent's project folder before recording or mounting it:
 * an absolute path to an existing folder that is not the file system root,
 * the home folder (or one of its ancestors), inside `~/.letta`, nor refused
 * by `checkProjectFolder` (home-like folders, credentials in `.git/config`,
 * linked worktrees). Returns the real path (symlinks resolved), which is
 * what gets mounted; the record keeps the path as given.
 * @throws {SandboxError} `project_unsafe` or `project_has_credentials`
 */
export function checkAdoptedProject(path: string, home = homedir()): string {
  if (typeof path !== 'string' || !path || path.length > 1000 || !isAbsolute(path)) throw new SandboxError('project_unsafe', 'The project folder must be an absolute path, such as /Users/you/blog');
  if (MOUNT_UNSAFE.test(path)) throw new SandboxError('project_unsafe', 'The project folder path must not contain commas, equal signs or control characters');
  let real: string;
  try { real = realpathSync(path); } catch { throw new SandboxError('project_unsafe', `${path} does not exist`); }
  const realOf = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const inside = (child: string, parent: string) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  if (real === sep || real === realOf(home)) throw new SandboxError('project_unsafe', `Refusing ${path}: it is ${real === sep ? 'the file system root' : 'your home folder'}. Pick the project's own folder.`);
  if (inside(real, realOf(join(home, '.letta')))) throw new SandboxError('project_unsafe', `Refusing ${path}: it is inside ~/.letta (Letta's own data).`);
  if (MOUNT_UNSAFE.test(real)) throw new SandboxError('project_unsafe', 'The project folder\'s real path must not contain commas, equal signs or control characters');
  return checkProjectFolder(real, home);
}

/** Whether `value` is a sandbox command timeout an adopted agent may have (see {@link AdoptionRecord.commandTimeoutMs}). */
export function validCommandTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= SANDBOX_LIMITS.maxTimeoutMs;
}

/** What the host offers adopted agents: a sandbox (for `sandbox`), whether web search is set up (for `web_search`), and dreaming in the app (default off). */
export type AdoptionEnvironment = { sandbox?: SandboxConfig; webSearch?: boolean; dreaming?: Partial<DreamingSettings> };

/** Whether the host's sandbox can run web development (`web_dev`, `mcp_app_dev`): the built-in `docker` or `apple-container` provider. */
export const webDevSandbox = (environment: AdoptionEnvironment = {}): boolean => environment.sandbox?.provider === 'docker' || environment.sandbox?.provider === 'apple-container';

/**
 * Why a choice of tool sets is refused (a fixed code), or `undefined`:
 * `sandbox_unavailable` (`web_dev` or `mcp_app_dev` without a docker or
 * apple-container sandbox on the host), `mcp_app_dev_needs_web_dev`,
 * `web_dev_needs_sandbox`.
 */
export function adoptedToolsRefusal(sets: readonly AdoptedToolSet[], environment: AdoptionEnvironment = {}): string | undefined {
  const has = new Set(sets);
  if ((has.has('web_dev') || has.has('mcp_app_dev')) && !webDevSandbox(environment)) return 'sandbox_unavailable';
  if (has.has('mcp_app_dev') && !has.has('web_dev')) return 'mcp_app_dev_needs_web_dev';
  if (has.has('web_dev') && !has.has('sandbox')) return 'web_dev_needs_sandbox';
  return undefined;
}

/** Tool sets in their canonical order ({@link ADOPTED_TOOL_SETS}), without duplicates. */
export const orderedAdoptedTools = (sets: readonly AdoptedToolSet[]): AdoptedToolSet[] => ADOPTED_TOOL_SETS.filter(set => sets.includes(set));

/** Tool sets an adopted agent gets by default: files, decisions and `ask_user`, plus the sandbox and web search when the host has them. */
export function defaultAdoptedTools(environment: AdoptionEnvironment = {}): AdoptedToolSet[] {
  return ['files', ...(environment.sandbox ? ['sandbox' as const] : []), 'decisions', ...(environment.webSearch ? ['web_search' as const] : []), 'ask_user'];
}

/**
 * The definition an adopted agent runs with: the agent itself (by ID, with
 * its name and model), the app's tools for the record's tool sets (each
 * with its fail-closed permission), and the default memory protection.
 * Its system prompt is never applied (see {@link instructionsUpdate}).
 * With a project folder ({@link AdoptionRecord.project}) and the sandbox,
 * the folder is mounted at `/project`. With `web_dev` the sandbox uses the
 * web development image (unless the host names another than the default).
 * A view-only record ({@link AdoptionRecord.viewOnly}) gets no tools, no
 * sandbox and no dreaming.
 */
export function adoptedDefinition(record: AdoptionRecord, environment: AdoptionEnvironment = {}): AgentDefinition {
  // View only: no tools, no sandbox, no dreaming (the app only reads its conversations).
  const sets = new Set(record.viewOnly ? [] : record.tools);
  // Web development needs the shell tools and a CLI sandbox; MCP App development needs web development (a record that no longer fits the host just loses them).
  const webDev = sets.has('web_dev') && sets.has('sandbox') && webDevSandbox(environment);
  const appDev = webDev && sets.has('mcp_app_dev');
  // Its own project folder replaces the host's (if any); the sandbox checks it again and mounts its real path.
  // With web development, the default image becomes the web development one (defineAgent picks WEBDEV_IMAGE when no image is named).
  const base = environment.sandbox ? (webDev && environment.sandbox.image === SANDBOX_IMAGE ? (({ image: _default, ...rest }) => rest)(environment.sandbox) : environment.sandbox) : undefined;
  const sandbox = base ? { ...base, ...(record.project ? { project: record.project } : {}), ...(validCommandTimeout(record.commandTimeoutMs) ? { timeoutMs: record.commandTimeoutMs } : {}) } : undefined;
  const tools: ToolSet = {
    ...(sets.has('files') ? fileTools : {}), ...(sets.has('sandbox') && environment.sandbox ? sandboxTools : {}),
    ...(sets.has('decisions') ? decisionTools : {}), ...(sets.has('web_search') && environment.webSearch ? webSearchTools : {}), ...(sets.has('ask_user') ? { [ASK_USER_TOOL]: askUserTool } : {}),
    ...(webDev ? webDevTools : {}), ...(appDev ? mcpAppDevTools : {}),
  };
  const permissions: Record<string, ToolPermission> = {
    ...(sets.has('files') ? FILE_TOOL_PERMISSIONS : {}), ...(sets.has('sandbox') && environment.sandbox ? SANDBOX_TOOL_PERMISSIONS : {}),
    ...(sets.has('decisions') ? DECISION_TOOL_PERMISSIONS : {}), ...(sets.has('web_search') && environment.webSearch ? WEB_SEARCH_TOOL_PERMISSIONS : {}), ...(sets.has('ask_user') ? { [ASK_USER_TOOL]: 'allow' as const } : {}),
    ...(webDev ? WEBDEV_TOOL_PERMISSIONS : {}), ...(appDev ? MCP_APP_DEV_TOOL_PERMISSIONS : {}),
  };
  return defineAgent({
    id: record.definitionId, name: record.name.slice(0, 120) || record.agentId, model: record.model.includes('/') ? record.model : 'unknown/unknown',
    // Never applied: an adopted agent keeps its own system prompt.
    instructions: 'Adopted agent: its own system prompt is kept.',
    tools, permissions, adopt: { agentId: record.agentId },
    ...(sets.has('sandbox') && sandbox ? { sandbox } : {}),
    // Dreaming stays off unless the host turns it on: an adopted agent keeps its own Letta Code reflection settings, and the app never starts a dream of it by surprise.
    dreaming: record.viewOnly ? { trigger: 'off' } : environment.dreaming ?? { trigger: 'off' },
  });
}
