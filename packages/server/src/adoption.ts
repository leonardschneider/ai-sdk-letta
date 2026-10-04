import express from 'express';
import { join } from 'node:path';
import type { LettaConversation } from '@letta-ai/letta-agent-sdk';
import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';
import {
  ADOPTED_TOOL_SETS, AdoptionStore, adoptedDefinition, adoptedDefinitionId, adoptedInstructionsSection, adoptionFile, adoptionRefusal, conversationGlance, defaultAdoptedTools,
  forgetIdentity, instructionsUpdate, lettaCodeActivity, listAdoptableAgents, localBackendDirectory, memoryPolicyInstructions, peekConversation, sanitizeText, statePaths, titleText,
  withoutInstructionsSection, type AdoptedToolSet, type AdoptionEnvironment, type AdoptionRecord, type AgentDefinition, type LocalAgentSummary,
} from 'ai-sdk-letta';
import { RuntimeFault, ThreadRuntime, type ImportedConversation, type RuntimeHost } from './runtime.js';
import { DecisionFeed, runtimeRoutes, BODY_LIMIT_BYTES, type GuiAdoption, type GuiAgentInfo } from './http.js';
import type { DecisionBoard } from './decisions.js';

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
  };
}

/** One hosted adopted agent. */
type Hosted = { record: AdoptionRecord; definition: AgentDefinition; runtime: ThreadRuntime; board?: DecisionBoard; router: express.Express };
/** How the server builds the runtime of an adopted agent (the same wiring as its own agent). */
export type HostFactory = (definition: AgentDefinition, folder: string) => { runtime: ThreadRuntime; board?: DecisionBoard };

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
}

const REFUSALS: Record<string, string> = {
  agent_missing: 'This agent no longer exists.', agent_hidden: 'This is a hidden or temporary agent; it cannot be added.', agent_without_memfs: 'This agent has no MemFS memory; only agents with MemFS can be added.',
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
 * - `POST /api/adoption/agents` `{ agentId, tools? }`: adopt one;
 * - `DELETE /api/adoption/agents/<id>`: remove it from the app (the Letta agent is never deleted);
 * - `PUT /api/adoption/agents/<id>/tools` `{ tools }`: its tool sets;
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
    const definition = adoptedDefinition(record, this.options.environment);
    const folder = join(statePaths(this.options.stateDirectory).server(definition.id), 'gui');
    const { runtime, board } = this.options.build(definition, folder);
    const router = runtimeRoutes(express(), runtime, this.options.owner);
    const hosted: Hosted = { record, definition, runtime, ...(board ? { board } : {}), router };
    this.hosted.set(record.definitionId, hosted);
    if (board) this.feed?.add({ agent: { id: definition.id, name: definition.name }, board, runtime, owner: this.options.owner });
    return hosted;
  }
  /** Agents for the session (the switcher). */
  agents(): GuiAgentInfo[] {
    return [...this.hosted.values()].map(({ record, definition }) => ({
      id: definition.id, name: definition.name, approvalTools: Object.keys(definition.permissions).filter(name => definition.permissions[name] === 'ask'),
      files: record.tools.includes('files'), ui: { latex: definition.ui.latex }, memory: true,
      adopted: { agentId: record.agentId, model: record.model, tools: [...record.tools], instructions: !!record.instructions },
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
    const { agentId, tools } = (input ?? {}) as { agentId?: unknown; tools?: unknown };
    if (typeof agentId !== 'string' || !/^agent-local-[a-zA-Z0-9-]{1,100}$/.test(agentId)) throw new RuntimeFault('invalid_input', 400);
    const sets = tools === undefined ? defaultAdoptedTools(this.options.environment) : validTools(tools);
    if (this.store.read().some(r => r.agentId === agentId) || this.options.reserved.agentIds?.().includes(agentId)) throw new RuntimeFault('agent_claimed');
    const agent = await this.backend.agent(agentId);
    const refused = adoptionRefusal(agent);
    if (refused) throw new RuntimeFault(refused, refused === 'agent_missing' ? 404 : 409);
    const activity = this.backend.activity(agentId);
    if (activity.active) throw new RuntimeFault('letta_code_active');
    let definitionId = adoptedDefinitionId(agent!);
    if (this.options.reserved.definitionIds.includes(definitionId)) definitionId = `${definitionId}-adopted`.slice(0, 64);
    const record: AdoptionRecord = { definitionId, agentId, name: agent!.name, model: agent!.model, tools: sets, adoptedAt: new Date().toISOString() };
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
    this.hosted.delete(definitionId);
    this.feed?.remove(definitionId);
    await hosted.runtime.close();
    try { forgetIdentity(statePaths(this.options.stateDirectory).agents, definitionId); } catch { /* reopened later by the same mapping */ }
    this.store.remove(definitionId);
    return { removed: true, agentId: hosted.record.agentId };
  }
  /** Change an adopted agent's tool sets: its runtime restarts with the new definition. */
  async setTools(definitionId: string, input: unknown) {
    const hosted = this.hosted.get(definitionId);
    if (!hosted) throw new RuntimeFault('not_found', 404);
    const sets = validTools((input as { tools?: unknown } | undefined)?.tools);
    if (hosted.runtime.busy) throw new RuntimeFault('runtime_busy');
    const record = this.store.update(definitionId, r => ({ ...r, tools: sets }));
    this.hosted.delete(definitionId); this.feed?.remove(definitionId);
    await hosted.runtime.close();
    this.host(record);
    return record;
  }
  /** The instructions section for an adopted agent: the tools it has here and the memory policy. */
  private section(hosted: Hosted) {
    return adoptedInstructionsSection(Object.keys(hosted.definition.tools), memoryPolicyInstructions(hosted.definition.dreaming));
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
    const hosted = this.hosted.get(definitionId);
    if (!hosted) throw new RuntimeFault('not_found', 404);
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
      catch (error) { const { status, code } = refusal(error); res.status(status).json({ error: code, ...(REFUSALS[code] ? { message: REFUSALS[code] } : {}) }); }
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
    app.get('/adoption/agents/:id/instructions', wrap(async req => this.instructions(String(req.params.id))));
    app.post('/adoption/agents/:id/instructions', json, wrap(async req => this.applyInstructions(String(req.params.id))));
    app.delete('/adoption/agents/:id/instructions', wrap(async req => this.revertInstructions(String(req.params.id))));
    // Each adopted agent's API. Listing threads also lists conversations made elsewhere (Letta Code) since.
    app.use('/agents/:agent', async (req, res, next) => {
      const hosted = this.hosted.get(String(req.params.agent));
      if (!hosted) return res.status(404).json({ error: 'not_found' });
      if (req.method === 'GET' && req.path === '/v1/threads') await this.refreshConversations(hosted.definition.id).catch(() => 0);
      // Sending, or opening a conversation's session, is refused while Letta Code uses the agent (viewing is read-only and allowed).
      if (req.method === 'POST' && (req.path === '/v1/runs' || req.path === '/v1/threads') && this.backend.activity(hosted.record.agentId).active) return res.status(409).json({ error: 'letta_code_active', message: REFUSALS.letta_code_active });
      hosted.router(req, res, next);
    });
    return app;
  }
  /** What the GUI app needs (see {@link GuiAdoption}). */
  gui(): GuiAdoption { return { routes: this.routes(), agents: () => this.agents(), bindFeed: feed => this.bindFeed(feed) }; }
  async close() {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.hosted.values()].map(hosted => hosted.runtime.close()));
  }
}

/** Tool sets the host can offer. */
export const availableTools = (environment: AdoptionEnvironment = {}): AdoptedToolSet[] => ADOPTED_TOOL_SETS.filter(set => (set !== 'sandbox' || !!environment.sandbox) && (set !== 'web_search' || !!environment.webSearch));
function validTools(value: unknown): AdoptedToolSet[] {
  if (!Array.isArray(value) || value.length > ADOPTED_TOOL_SETS.length || value.some(v => typeof v !== 'string' || !(ADOPTED_TOOL_SETS as readonly string[]).includes(v))) throw new RuntimeFault('invalid_input', 400);
  return [...new Set(value as AdoptedToolSet[])];
}

/** A read-only `peek` for the runtime host of an adopted agent (see {@link RuntimeHost.peek}). */
export const adoptedPeek = (agentId: string, appTools: readonly string[]): NonNullable<RuntimeHost['peek']> => async conversationId => (await peekConversation(agentId, conversationId, appTools)).messages;
