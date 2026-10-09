import express from 'express';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { LettaConversation } from '@letta-ai/letta-agent-sdk';
import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';
import {
  ADOPTED_TOOL_SETS, AdoptionStore, adoptedToolsRefusal, orderedAdoptedTools, webDevSandbox, SandboxError, SANDBOX_LIMITS, adoptedDefinition, validCommandTimeout, checkAdoptedProject, adoptedDefinitionId, adoptedInstructionsSection, adoptionFile, adoptionRefusal, conversationGlance, defaultAdoptedTools,
  forgetIdentity, instructionsUpdate, lettaCodeActivity, listAdoptableAgents, localBackendDirectory, memoryPolicyInstructions, peekConversation, sanitizeText, statePaths, titleText,
  withoutInstructionsSection, type AdoptedToolSet, type AdoptionEnvironment, type AdoptionRecord, type AgentDefinition, type LocalAgentSummary,
} from 'ai-sdk-letta';
import { RuntimeFault, ThreadRuntime, type ImportedConversation, type RuntimeHost } from './runtime.js';
import { DecisionFeed, runtimeRoutes, BODY_LIMIT_BYTES, type GuiAdoption, type GuiAgentInfo } from './http.js';
import type { DecisionBoard } from './decisions.js';
import { LiveConversations, type LiveFs } from './live.js';

/** What the registry needs from the Letta backend (a test fake replaces it). */
export interface AdoptionBackend {
  /** Local agents for the picker. */
  list(adopted: readonly AdoptionRecord[]): Promise<LocalAgentSummary[]>;
  /** One agent (name, model, tags, system prompt), or `undefined` when it is gone. */
  agent(agentId: string): Promise<{ id: string; name: string; model: string; tags: string[]; system: string; hidden?: boolean } | undefined>;
  /** Its conversations (not archived), with `default` first. */
  conversations(agentId: string): Promise<ImportedConversation[]>;
  /** Change its system prompt (an approved instructions update or its revert). */
  setSystem(agentId: string, system: string): Promise<void>;
  /** Whether Letta Code is using it now. */
  activity(agentId: string): { active: boolean; recent: boolean; reason?: string; lastChange?: string };
  /** The local backend folder (live refresh watches its conversations). Without it, nothing is watched. */
  directory?: string;
}

/** The local Letta backend (read-only except {@link AdoptionBackend.setSystem}). */
export function lettaAdoptionBackend(): AdoptionBackend {
  const client = () => new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', requestTimeoutMs: 60_000 } });
  const using = async <T>(task: (c: LettaAgentClient) => Promise<T>) => { const c = client(); try { return await task(c); } finally { await c.close(); } };
  return {
    list: adopted => using(c => listAdoptableAgents(c as never, adopted)),
    agent: agentId => using(async c => {
      try {
        const agent = await c.agents.retrieve(agentId) as unknown as { id: string; name?: string; model?: string; llm_config?: { handle?: string }; tags?: string[]; system?: string; hidden?: boolean };
        return { id: agent.id, name: agent.name ?? agentId, model: agent.model ?? agent.llm_config?.handle ?? '', tags: agent.tags ?? [], system: agent.system ?? '', ...(agent.hidden ? { hidden: true } : {}) };
      } catch { return undefined; }
    }),
    conversations: agentId => using(async c => {
      const rows: LettaConversation[] = [];
      let after: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await c.conversations.list({ agentId, limit: 100, ...(after ? { after } : {}) });
        rows.push(...page.filter(row => row.agent_id === agentId && !row.archived));
        if (page.length < 100) break;
        after = page.at(-1)!.id;
      }
      const titled = async (id: string, summary: string | null | undefined, created?: string | null, last?: string | null): Promise<ImportedConversation> => {
        const fromSummary = titleText(sanitizeText(summary ?? '')).trim();
        const glance = fromSummary && last ? {} : await conversationGlance(agentId, id);
        const title = fromSummary || glance.firstUserText || (id === 'default' ? 'Default conversation' : 'Untitled conversation');
        const lastActivityAt = last ?? glance.lastMessageAt ?? created ?? undefined;
        return { conversationId: id, title, ...(created ? { createdAt: created } : {}), ...(lastActivityAt ? { lastActivityAt } : {}) };
      };
      const named = await Promise.all(rows.map(row => titled(row.id, row.summary, row.created_at, row.last_message_at)));
      const fallback = await titled('default', undefined);
      // The default conversation is listed only when it has messages.
      return [...(fallback.lastActivityAt ? [fallback] : []), ...named];
    }),
    setSystem: (agentId, system) => using(async c => { await c.agents.update(agentId, { system }); }),
    activity: agentId => lettaCodeActivity(agentId, { backendDirectory: localBackendDirectory() }),
    directory: localBackendDirectory(),
  };
}

/** One hosted adopted agent. */
type Hosted = { record: AdoptionRecord; definition: AgentDefinition; runtime: ThreadRuntime; board?: DecisionBoard; router: express.Express; close?: () => Promise<void>; webDev?: boolean; apps?: boolean; live?: LiveConversations };
/**
 * How the server builds the runtime of an adopted agent (the same wiring as
 * its own agent). `close` stops what the runtime does not own (its web
 * development services, its MCP App servers), after the runtime closed;
 * `webDev` and `apps` tell the browser to show the Preview pane and app views.
 */
export type HostFactory = (definition: AgentDefinition, folder: string) => { runtime: ThreadRuntime; board?: DecisionBoard; close?: () => Promise<void>; webDev?: boolean; apps?: boolean };

/** Options of {@link AdoptionRegistry}. */
export interface AdoptionRegistryOptions {
  stateDirectory: string;
  owner: string;
  /** The app's own agent (never adoptable; its ID is reserved). */
  reserved: { definitionIds: readonly string[]; agentIds?: () => readonly string[] };
  environment?: AdoptionEnvironment;
  backend?: AdoptionBackend;
  build: HostFactory;
  log?: (line: string) => void;
  /** How a view-only agent reads a conversation (tests replace it). @default {@link adoptedPeek} without app tools */
  peek?: (agentId: string) => NonNullable<RuntimeHost['peek']>;
  /** Live refresh options (tests: fake file system and timers). */
  live?: { fs?: LiveFs; debounceMs?: number; pollMs?: number; idleMs?: number; maxConversations?: number };
}

const REFUSALS: Record<string, string> = {
  agent_missing: 'This agent no longer exists.', agent_hidden: 'This is a hidden or temporary agent; it cannot be added.', agent_without_memfs: 'This agent has no MemFS memory; only agents with MemFS can be added.',
  sandbox_unavailable: 'This server has no sandbox (web development needs the docker or apple-container one), so it cannot do that.',
  mcp_app_dev_needs_web_dev: 'MCP App development needs web development: turn both on.', web_dev_needs_sandbox: 'Web development needs shell commands (the sandbox): turn both on.',
  view_only: 'This agent is view only here: it works in Letta Code. Turn off View only to use it in the app.',
  agent_claimed: 'This agent is already in the app.', letta_code_active: 'Letta Code is using this agent right now. Close its Letta Code session, then retry.', capacity_reached: 'The app holds as many agents as it can.',
};

/**
 * Adopted agents of the single-user app: existing local Letta agents opened
 * in place (by ID), recorded in `<state>/adopted.json` so they come back
 * after a restart. Each gets its own runtime (`<state>/server/<id>/gui/`),
 * the app's tools and fail-closed permissions, and memory review.
 *
 * Routes (all behind the app's session and CSRF checks):
 * - `GET /api/adoption/agents`: local agents for the "Add agent" picker;
 * - `POST /api/adoption/agents` `{ agentId, tools?, viewOnly? }`: adopt one (view only: even while Letta Code uses it);
 * - `DELETE /api/adoption/agents/<id>`: remove it from the app (the Letta agent is never deleted);
 * - `PUT /api/adoption/agents/<id>/tools` `{ tools }`: its tool sets;
 * - `PUT /api/adoption/agents/<id>/project` `{ path | null }`: its project folder, mounted at `/project` in its sandbox (see `checkAdoptedProject`);
 * - `PUT /api/adoption/agents/<id>/view-only` `{ viewOnly }`: view only (reads only; off is refused while Letta Code uses it);
 * - `PUT /api/adoption/agents/<id>/sandbox` `{ commandTimeoutMs | null }`: its sandbox's per-command timeout (null: the host's);
 * - `GET|POST|DELETE /api/adoption/agents/<id>/instructions`: preview, apply, revert the instructions update;
 * - `/api/agents/<id>/v1/...`: the agent's API (threads, runs, memory, decisions).
 */
export class AdoptionRegistry {
  readonly store: AdoptionStore;
  private readonly hosted = new Map<string, Hosted>();
  private feed?: DecisionFeed;
  private readonly backend: AdoptionBackend;
  private closing = false;
  constructor(private readonly options: AdoptionRegistryOptions) {
    this.store = new AdoptionStore(adoptionFile(options.stateDirectory));
    this.backend = options.backend ?? lettaAdoptionBackend();
  }
  /** Host every recorded adoption (at startup). Nothing is opened until a conversation is. */
  start() { for (const record of this.store.read()) { try { this.host(record); } catch (error) { this.options.log?.(`Adopted agent ${record.definitionId} not loaded: ${error instanceof Error ? error.message : String(error)}`); } } }
  private host(record: AdoptionRecord): Hosted {
    // A project folder that became unsafe or went away (moved, credentials added) is left out, so the agent still opens; the app keeps showing the path.
    let usable = record;
    if (record.project) {
      try { checkAdoptedProject(record.project); }
      catch (error) { const { project: _skipped, ...rest } = record; usable = rest; this.options.log?.(`Project folder of ${record.definitionId} not mounted: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const definition = adoptedDefinition(usable, this.options.environment);
    const folder = join(statePaths(this.options.stateDirectory).server(definition.id), 'gui');
    // View only: a runtime that can only read (no session, tools, containers, decisions or memory review).
    const { runtime, board, close, webDev, apps } = record.viewOnly ? { runtime: this.viewer(record, folder), board: undefined, close: undefined, webDev: undefined, apps: undefined } : this.options.build(definition, folder);
    const router = runtimeRoutes(express(), runtime, this.options.owner);
    const hosted: Hosted = { record, definition, runtime, ...(board ? { board } : {}), router, ...(close ? { close } : {}), ...(webDev ? { webDev } : {}), ...(apps ? { apps } : {}) };
    hosted.live = this.liveOf(hosted);
    this.hosted.set(record.definitionId, hosted);
    if (board) this.feed?.add({ agent: { id: definition.id, name: definition.name }, board, runtime, owner: this.options.owner });
    return hosted;
  }
  /** The runtime of a view-only agent: history is read with `peek`; opening a session is refused (`view_only`). */
  private viewer(record: AdoptionRecord, folder: string): ThreadRuntime {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const peek = this.options.peek?.(record.agentId) ?? adoptedPeek(record.agentId, []);
    return new ThreadRuntime({ open: async () => { throw new RuntimeFault('view_only', 403); }, close: async () => {}, peek }, join(folder, 'state.json'), this.options.owner);
  }
  /** Live refresh of an adopted agent's conversations (changes made in Letta Code), when the backend folder is known. */
  private liveOf(hosted: Hosted): LiveConversations | undefined {
    const directory = this.backend.directory;
    if (!directory) return undefined;
    const id = hosted.definition.id;
    return new LiveConversations({
      backendDirectory: directory, agentId: hosted.record.agentId, ...this.options.live,
      onChange: (conversationId, at) => { if (this.hosted.get(id) === hosted) hosted.runtime.externalChange(this.options.owner, conversationId, at); },
      onNewConversation: () => { if (this.hosted.get(id) === hosted) void this.refreshConversations(id).catch(() => 0); },
    });
  }
  /** Stop a hosted agent: its runtime, then what it does not own (web development services, MCP App servers). */
  private async unhost(hosted: Hosted) {
    this.hosted.delete(hosted.record.definitionId); this.feed?.remove(hosted.record.definitionId);
    hosted.live?.close();
    try { await hosted.runtime.close(); } finally { await hosted.close?.().catch(error => this.options.log?.(`Services of ${hosted.record.definitionId} not stopped: ${error instanceof Error ? error.message : String(error)}`)); }
  }
  /** The runtime of an adopted agent (by its definition ID), if hosted. */
  runtime(definitionId: string): ThreadRuntime | undefined { return this.hosted.get(definitionId)?.runtime; }
  /** The runtimes of the adopted agents. */
  runtimes(): ThreadRuntime[] { return [...this.hosted.values()].map(h => h.runtime); }
  /** Agents for the session (the switcher). */
  agents(): GuiAgentInfo[] {
    return [...this.hosted.values()].map(({ record, definition, runtime, webDev, apps }) => ({
      id: definition.id, name: definition.name, approvalTools: Object.keys(definition.permissions).filter(name => definition.permissions[name] === 'ask'),
      files: !record.viewOnly && record.tools.includes('files'), ui: { latex: definition.ui.latex }, memory: true,
      ...(record.viewOnly ? { viewOnly: true } : {}),
      // Web development: the Preview pane (and the Resources panel without files); MCP App development: app views.
      ...(webDev ? { webDev: true, ...(!record.tools.includes('files') ? { resources: true } : {}) } : {}), ...(apps ? { apps: true } : {}),
      // A mounted project folder: the Resources panel shows it read-only.
      ...(runtime.project ? { project: runtime.project.name } : {}),
      adopted: { agentId: record.agentId, model: record.model, tools: [...record.tools], instructions: !!record.instructions, ...(record.project ? { project: record.project } : {}), ...(record.viewOnly ? { viewOnly: true } : {}), ...(this.options.environment?.sandbox ? { sandbox: true, commandTimeoutMs: record.commandTimeoutMs ?? this.options.environment.sandbox.timeoutMs ?? SANDBOX_LIMITS.defaultTimeoutMs } : {}), available: availableTools(this.options.environment) },
    }));
  }
  bindFeed(feed: DecisionFeed) {
    this.feed = feed;
    for (const hosted of this.hosted.values()) if (hosted.board) feed.add({ agent: { id: hosted.definition.id, name: hosted.definition.name }, board: hosted.board, runtime: hosted.runtime, owner: this.options.owner });
  }
  /** List the agent's existing conversations as threads (on adoption, and each time the app lists them). */
  async refreshConversations(definitionId: string) {
    const hosted = this.hosted.get(definitionId);
    if (!hosted) throw new RuntimeFault('not_found', 404);
    const rows = await this.backend.conversations(hosted.record.agentId);
    return hosted.runtime.importConversations(this.options.owner, hosted.record.agentId, rows);
  }
  /** Adopt an agent (see the class notes). Refusals have fixed codes ({@link REFUSALS}). */
  async adopt(input: unknown): Promise<AdoptionRecord> {
    const { agentId, tools, viewOnly } = (input ?? {}) as { agentId?: unknown; tools?: unknown; viewOnly?: unknown };
    if (typeof agentId !== 'string' || !/^agent-local-[a-zA-Z0-9-]{1,100}$/.test(agentId)) throw new RuntimeFault('invalid_input', 400);
    if (viewOnly !== undefined && typeof viewOnly !== 'boolean') throw new RuntimeFault('invalid_input', 400);
    const sets = tools === undefined ? defaultAdoptedTools(this.options.environment) : this.validTools(tools);
    if (this.store.read().some(r => r.agentId === agentId) || this.options.reserved.agentIds?.().includes(agentId)) throw new RuntimeFault('agent_claimed');
    const agent = await this.backend.agent(agentId);
    const refused = adoptionRefusal(agent);
    if (refused) throw new RuntimeFault(refused, refused === 'agent_missing' ? 404 : 409);
    // View only: it may be in use in Letta Code (the app only reads).
    if (!viewOnly && this.backend.activity(agentId).active) throw new RuntimeFault('letta_code_active');
    let definitionId = adoptedDefinitionId(agent!);
    if (this.options.reserved.definitionIds.includes(definitionId)) definitionId = `${definitionId}-adopted`.slice(0, 64);
    const record: AdoptionRecord = { definitionId, agentId, name: agent!.name, model: agent!.model, tools: sets, adoptedAt: new Date().toISOString(), ...(viewOnly ? { viewOnly: true as const } : {}) };
    try { this.store.add(record, { definitionIds: this.options.reserved.definitionIds }); }
    catch (error) { throw new RuntimeFault(error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'adoption_failed'); }
    try { this.host(record); } catch (error) { this.store.remove(record.definitionId); throw error; }
    await this.refreshConversations(definitionId).catch(error => this.options.log?.(`Conversations of ${definitionId} not listed yet: ${error instanceof Error ? error.message : String(error)}`));
    return record;
  }
  /** Remove an adopted agent from the app: its runtime closes and its records go. The Letta agent, its memory and conversations stay. */
  async remove(definitionId: string) {
    const hosted = this.hosted.get(definitionId);
    if (!hosted) throw new RuntimeFault('not_found', 404);
    if (hosted.runtime.busy) throw new RuntimeFault('runtime_busy');
    await this.unhost(hosted);
    try { forgetIdentity(statePaths(this.options.stateDirectory).agents, definitionId); } catch { /* reopened later by the same mapping */ }
    this.store.remove(definitionId);
    return { removed: true, agentId: hosted.record.agentId };
  }
  /**
   * Turn View only on or off (`{ viewOnly }`). Off is refused
   * (`letta_code_active`) while Letta Code uses the agent. Its runtime
   * restarts: view only reads, otherwise it gets its tools back.
   */
  async setViewOnly(definitionId: string, input: unknown) {
    const hosted = this.hosted.get(definitionId);
    if (!hosted) throw new RuntimeFault('not_found', 404);
    const value = (input as { viewOnly?: unknown } | undefined)?.viewOnly;
    if (typeof value !== 'boolean') throw new RuntimeFault('invalid_input', 400);
    if (!value && this.backend.activity(hosted.record.agentId).active) throw new RuntimeFault('letta_code_active');
    if (hosted.runtime.busy) throw new RuntimeFault('runtime_busy');
    if (!!hosted.record.viewOnly === value) return { viewOnly: value };
    const record = this.store.update(definitionId, r => { const { viewOnly: _old, ...rest } = r; return value ? { ...rest, viewOnly: true as const } : rest; });
    await this.unhost(hosted);
    this.host(record);
    return { viewOnly: value };
  }
  /** A hosted agent that may change (refused with `view_only` for a view-only one). */
  private writable(definitionId: string): Hosted {
    const hosted = this.hosted.get(definitionId);
    if (!hosted) throw new RuntimeFault('not_found', 404);
    if (hosted.record.viewOnly) throw new RuntimeFault('view_only', 403);
    return hosted;
  }
  /** Change an adopted agent's tool sets: its runtime restarts with the new definition. */
  async setTools(definitionId: string, input: unknown) {
    const hosted = this.writable(definitionId);
    const sets = this.validTools((input as { tools?: unknown } | undefined)?.tools);
    if (hosted.runtime.busy) throw new RuntimeFault('runtime_busy');
    const record = this.store.update(definitionId, r => ({ ...r, tools: sets }));
    await this.unhost(hosted);
    this.host(record);
    return record;
  }
  /**
   * Set or clear an adopted agent's project folder (`{ path }` or `{ path: null }`).
   * The path is checked (`checkAdoptedProject`) and kept as given; its real
   * path is mounted read-write at `/project`. Setting one turns on the
   * sandbox tools. Its runtime restarts, so open conversations get the new
   * sandbox on their next message. Refusals: `project_unsafe` and
   * `project_has_credentials` (with the reason), `sandbox_unavailable`.
   */
  async setProject(definitionId: string, input: unknown) {
    const hosted = this.writable(definitionId);
    const path = (input as { path?: unknown } | undefined)?.path;
    if (path !== null && typeof path !== 'string') throw new RuntimeFault('invalid_input', 400);
    if (path !== null) {
      if (!this.options.environment?.sandbox) throw new RuntimeFault('sandbox_unavailable');
      try { checkAdoptedProject(path); }
      catch (error) { if (error instanceof SandboxError) throw new ProjectRefusal(error.code, error.message); throw error; }
    }
    if (hosted.runtime.busy) throw new RuntimeFault('runtime_busy');
    const record = this.store.update(definitionId, r => {
      const { project: _old, ...rest } = r;
      return path === null ? rest : { ...rest, project: path, tools: r.tools.includes('sandbox') ? r.tools : orderedAdoptedTools([...r.tools, 'sandbox']) };
    });
    await this.unhost(hosted);
    this.host(record);
    return { project: record.project ?? null, tools: record.tools };
  }
  /**
   * Set or clear an adopted agent's sandbox command timeout
   * (`{ commandTimeoutMs }` in ms, 1000–240000, or `null` for the host's).
   * Its runtime restarts, like a project change.
   */
  async setSandbox(definitionId: string, input: unknown) {
    const hosted = this.writable(definitionId);
    const value = (input as { commandTimeoutMs?: unknown } | undefined)?.commandTimeoutMs;
    if (value !== null && !validCommandTimeout(value)) throw new RuntimeFault('invalid_input', 400);
    if (!this.options.environment?.sandbox) throw new RuntimeFault('sandbox_unavailable');
    if (hosted.runtime.busy) throw new RuntimeFault('runtime_busy');
    const record = this.store.update(definitionId, r => { const { commandTimeoutMs: _old, ...rest } = r; return value === null ? rest : { ...rest, commandTimeoutMs: value }; });
    await this.unhost(hosted);
    this.host(record);
    return { commandTimeoutMs: record.commandTimeoutMs ?? null, effectiveMs: record.commandTimeoutMs ?? this.options.environment.sandbox.timeoutMs ?? SANDBOX_LIMITS.defaultTimeoutMs };
  }
  /** The instructions section for an adopted agent: the tools it has here, its project folder, and the memory policy. */
  private section(hosted: Hosted) {
    const project = hosted.definition.sandbox?.project && hosted.record.project ? basename(hosted.record.project) : undefined;
    return adoptedInstructionsSection(Object.keys(hosted.definition.tools), memoryPolicyInstructions(hosted.definition.dreaming), project);
  }
  /** Preview the instructions update (nothing changes). */
  async instructions(definitionId: string) {
    const hosted = this.hosted.get(definitionId);
    if (!hosted) throw new RuntimeFault('not_found', 404);
    const agent = await this.backend.agent(hosted.record.agentId);
    if (!agent) throw new RuntimeFault('agent_missing', 404);
    const update = instructionsUpdate(agent.system, this.section(hosted));
    return { diff: update.diff, changed: update.changed, applied: !!hosted.record.instructions, revertible: !!hosted.record.instructions && agent.system === hosted.record.instructions.after };
  }
  /** Apply the instructions update (approved by the person in the app). */
  async applyInstructions(definitionId: string) {
    const hosted = this.writable(definitionId);
    if (hosted.runtime.busy) throw new RuntimeFault('runtime_busy');
    const agent = await this.backend.agent(hosted.record.agentId);
    if (!agent) throw new RuntimeFault('agent_missing', 404);
    const update = instructionsUpdate(agent.system, this.section(hosted));
    if (!update.changed) return { applied: false };
    await this.backend.setSystem(hosted.record.agentId, update.next);
    // The first prompt before any update is kept, so a revert restores the original.
    hosted.record = this.store.update(definitionId, r => ({ ...r, instructions: { before: r.instructions?.before ?? agent.system, after: update.next, at: new Date().toISOString() } }));
    return { applied: true };
  }
  /** Revert the instructions update (only while the prompt is still the one we set). */
  async revertInstructions(definitionId: string) {
    const hosted = this.hosted.get(definitionId);
    if (!hosted?.record.instructions) throw new RuntimeFault('not_found', 404);
    if (hosted.record.viewOnly) throw new RuntimeFault('view_only', 403);
    if (hosted.runtime.busy) throw new RuntimeFault('runtime_busy');
    const agent = await this.backend.agent(hosted.record.agentId);
    if (!agent) throw new RuntimeFault('agent_missing', 404);
    // Changed since (in Letta Code): remove only our section.
    const restored = agent.system === hosted.record.instructions.after ? hosted.record.instructions.before : withoutInstructionsSection(agent.system);
    await this.backend.setSystem(hosted.record.agentId, restored);
    hosted.record = this.store.update(definitionId, r => { const { instructions: _removed, ...rest } = r; return rest; });
    return { reverted: true };
  }
  /** Routes (see the class notes). */
  routes(): express.Express {
    const app = express();
    const json = express.json({ limit: BODY_LIMIT_BYTES });
    const refusal = (error: unknown) => error instanceof RuntimeFault ? { status: error.status, code: error.code } : { status: 503, code: 'adoption_unavailable' };
    const wrap = (handler: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
      try { res.json(await handler(req)); }
      catch (error) {
        // A refused project folder: the reason is shown to the person who chose it (their own paths only).
        if (error instanceof ProjectRefusal) return void res.status(409).json({ error: error.code, message: error.message });
        const { status, code } = refusal(error); res.status(status).json({ error: code, ...(REFUSALS[code] ? { message: REFUSALS[code] } : {}) });
      }
    };
    app.get('/adoption/agents', wrap(async () => {
      const adopted = this.store.read();
      const rows = await this.backend.list(adopted);
      const reserved = new Set(this.options.reserved.agentIds?.() ?? []);
      return { agents: rows.map(row => ({ ...row, ...(reserved.has(row.agentId) ? { refusal: 'agent_claimed', inApp: true } : {}), ...(this.backend.activity(row.agentId).active ? { busy: true } : {}) })), tools: { available: availableTools(this.options.environment), defaults: defaultAdoptedTools(this.options.environment) } };
    }));
    app.get('/adoption/agents/:id/activity', wrap(async req => {
      const record = this.store.read().find(r => r.agentId === req.params.id || r.definitionId === req.params.id);
      const agentId = record?.agentId ?? String(req.params.id);
      if (!/^agent-local-[a-zA-Z0-9-]{1,100}$/.test(agentId)) throw new RuntimeFault('invalid_input', 400);
      return this.backend.activity(agentId);
    }));
    app.post('/adoption/agents', json, wrap(async req => this.adopt(req.body)));
    app.delete('/adoption/agents/:id', wrap(async req => this.remove(String(req.params.id))));
    app.put('/adoption/agents/:id/tools', json, wrap(async req => this.setTools(String(req.params.id), req.body)));
    app.put('/adoption/agents/:id/project', json, wrap(async req => this.setProject(String(req.params.id), req.body)));
    app.put('/adoption/agents/:id/view-only', json, wrap(async req => this.setViewOnly(String(req.params.id), req.body)));
    app.put('/adoption/agents/:id/sandbox', json, wrap(async req => this.setSandbox(String(req.params.id), req.body)));
    app.get('/adoption/agents/:id/instructions', wrap(async req => this.instructions(String(req.params.id))));
    app.post('/adoption/agents/:id/instructions', json, wrap(async req => this.applyInstructions(String(req.params.id))));
    app.delete('/adoption/agents/:id/instructions', wrap(async req => this.revertInstructions(String(req.params.id))));
    // Each adopted agent's API. Listing threads also lists conversations made elsewhere (Letta Code) since.
    app.use('/agents/:agent', async (req, res, next) => {
      const hosted = this.hosted.get(String(req.params.agent));
      if (!hosted) return res.status(404).json({ error: 'not_found' });
      // Someone watches this agent: its conversations are refreshed live (the one viewed, and new ones).
      hosted.live?.touch(req.method === 'GET' ? this.viewedConversation(hosted, req.path) : undefined);
      if (hosted.record.viewOnly && !viewOnlyAllowed(req.method, req.path)) return res.status(403).json({ error: 'view_only', message: REFUSALS.view_only });
      if (req.method === 'GET' && req.path === '/v1/threads') await this.refreshConversations(hosted.definition.id).catch(() => 0);
      // Sending, or opening a conversation's session, is refused while Letta Code uses the agent (viewing is read-only and allowed).
      if (req.method === 'POST' && (req.path === '/v1/runs' || req.path === '/v1/threads') && this.backend.activity(hosted.record.agentId).active) return res.status(409).json({ error: 'letta_code_active', message: REFUSALS.letta_code_active });
      hosted.router(req, res, next);
    });
    return app;
  }
  /** The conversation a request views (`/v1/threads/<id>/view` or `/history`), if any. */
  private viewedConversation(hosted: Hosted, path: string): string | undefined {
    const match = /^\/v1\/threads\/([^/]+)\/(?:view|history)$/.exec(path);
    if (!match) return undefined;
    try { return hosted.runtime.conversationOf(this.options.owner, decodeURIComponent(match[1]!)); } catch { return undefined; }
  }
  /** What the GUI app needs (see {@link GuiAdoption}). */
  gui(): GuiAdoption { return { routes: this.routes(), agents: () => this.agents(), bindFeed: feed => this.bindFeed(feed) }; }
  async close() {
    if (this.closing) return;
    this.closing = true;
    for (const hosted of this.hosted.values()) hosted.live?.close();
    await Promise.allSettled([...this.hosted.values()].map(hosted => this.unhost(hosted)));
  }
  /** Tool sets from a request: known, in order, and fitting the host (see `adoptedToolsRefusal`). */
  private validTools(value: unknown): AdoptedToolSet[] {
    const sets = validTools(value);
    const refused = adoptedToolsRefusal(sets, this.options.environment);
    if (refused) throw new RuntimeFault(refused, refused === 'sandbox_unavailable' ? 409 : 400);
    return sets;
  }
}

/** A refused project folder, with its human-readable reason. */
class ProjectRefusal extends Error { constructor(readonly code: string, message: string) { super(message); } }

/**
 * Requests a view-only agent's API answers (deny by default): reads only.
 * Threads (list, view, history, files), resources and memory reads, the
 * change channel, capabilities and decisions lists. Everything else
 * (sending, new threads, renames, rewinds, decisions, apps, previews,
 * uploads, resource writes, memory settings) is refused with `view_only`.
 */
export const VIEW_ONLY_READS: readonly RegExp[] = [
  /^\/v1\/capabilities$/, /^\/v1\/changes$/, /^\/v1\/threads$/, /^\/v1\/threads\/[^/]+\/(?:view|history|files)$/, /^\/v1\/threads\/[^/]+\/files\/[^/]+$/,
  /^\/v1\/resources$/, /^\/v1\/resources\/(?:history|file|preview)$/, /^\/v1\/memory\/(?:reviews|provenance|reverts)$/, /^\/v1\/decisions$/,
];
export const viewOnlyAllowed = (method: string, path: string) => (method === 'GET' || method === 'HEAD') && VIEW_ONLY_READS.some(pattern => pattern.test(path));

/** Tool sets the host can offer. */
export const availableTools = (environment: AdoptionEnvironment = {}): AdoptedToolSet[] => ADOPTED_TOOL_SETS.filter(set => (set !== 'sandbox' || !!environment.sandbox) && (set !== 'web_search' || !!environment.webSearch) && ((set !== 'web_dev' && set !== 'mcp_app_dev') || webDevSandbox(environment)));
function validTools(value: unknown): AdoptedToolSet[] {
  if (!Array.isArray(value) || value.length > ADOPTED_TOOL_SETS.length || value.some(v => typeof v !== 'string' || !(ADOPTED_TOOL_SETS as readonly string[]).includes(v))) throw new RuntimeFault('invalid_input', 400);
  return orderedAdoptedTools(value as AdoptedToolSet[]);
}

/** A read-only `peek` for the runtime host of an adopted agent (see {@link RuntimeHost.peek}). */
export const adoptedPeek = (agentId: string, appTools: readonly string[]): NonNullable<RuntimeHost['peek']> => async conversationId => (await peekConversation(agentId, conversationId, appTools)).messages;
