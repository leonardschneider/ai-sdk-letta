import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LettaAgent as LettaAgentState, LettaConversation } from '@letta-ai/letta-agent-sdk';
import { JIMINY_NAME } from './jiminy.js';
import { WEB_SUMMARIZER_NAME } from './web-summarizer.js';
import { validLocalAgentId } from './temporary-agents.js';

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

/** Tool sets an adopted agent may get. */
export const ADOPTED_TOOL_SETS = ['files', 'sandbox', 'decisions', 'web_search', 'ask_user'] as const;
export type AdoptedToolSet = typeof ADOPTED_TOOL_SETS[number];

/** One adopted agent, as the app records it. */
export type AdoptionRecord = {
  /** The logical ID the app uses for it (lowercase, `-`). */
  definitionId: string;
  agentId: string;
  /** The agent's name and model when it was adopted. */
  name: string;
  model: string;
  /** Tool sets it gets in this app. */
  tools: AdoptedToolSet[];
  adoptedAt: string;
  /** An approved instructions update: the system prompt before it, and after it (for a revert). */
  instructions?: { before: string; after: string; at: string };
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

const conversationFile = (backend: string, id: string) => join(backend, 'conversations', Buffer.from(`conversation:${id}`).toString('base64url'), 'conversation.json');
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

/** The ai-sdk-letta section of an adopted agent's instructions: the tools it has here, and the memory policy. */
export function adoptedInstructionsSection(tools: readonly string[], memoryPolicy: string): string {
  return [INSTRUCTIONS_BEGIN, '## In the ai-sdk-letta app',
    'You are also used through the ai-sdk-letta app (a browser app). There, only these tools are available: '
      + (tools.length ? tools.join(', ') : 'none besides memory') + '. Letta Code tools (shell, file editing outside memory, subagents) are not available in the app; do not call them there.',
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
