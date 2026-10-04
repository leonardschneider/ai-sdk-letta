import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import type { Server } from 'node:http';
import type { ToolSet } from 'ai';
import { McpApps, mcpAppsDirectory, type ClaimMember, provenanceLabel, ASK_USER_TOOL, CredentialStore, LOCAL_USER_ID, PREPARE_CALL, WebDevRegistry, webDevEnabled, atlassianEnabled, sandboxEnabled, checkProjectFolder, checkConversation, createLettaAgent, decisionsEnabled, filesEnabled, openAgentHost, openResources, resolveStateDirectory, schedulingEnabled, statePaths, webSearchEnabled, type AgentDefinition, type AgentHost, type DecisionDesk, type LettaRuntime, type MemoryGuardEvents, type MemoryReview, type OpenAgentOptions, type TaskScheduler, type SandboxConfig, type DreamingSettings } from 'ai-sdk-letta';
import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';
import { DecisionBoard } from './decisions.js';
import { ThreadRuntime, type RewindHooks, type RuntimeHost } from './runtime.js';
import { guiApp, teamApp, tokenApiApp, type GuiAgentInfo, type TeamAgent } from './http.js';
import { TeamDirectory, authorOf } from './team.js';
import { AutomationService, AutomationStore, createToken, listenAutomation, revokeToken, tokenSummary, type AutomationAgent, type AutomationEndpoint, type AutomationVia } from './automation.js';
import { AdoptionRegistry, adoptedPeek } from './adoption.js';
import { conductorOrchestrator, n8nOrchestrator, type Orchestrator } from './scheduler.js';
import { PreviewTokens, previewOrigin, startPreviewServer, type PreviewServer } from './preview.js';
import { AppGate } from './mcp-apps.js';

/** Default GUI port (the token API uses the next one). */
export const DEFAULT_PORT = 4400;

/** Options shared by {@link startGuiServer} and {@link startApiServer}. */
export interface ServeOptions {
  /** Loopback port. `0` picks a free port. @default 4400 */
  port?: number;
  /** State root; see `resolveStateDirectory`. */
  stateDirectory?: string;
  /** Log sink for startup and shutdown lines. @default console.log */
  log?: (line: string) => void;
  /** Tests only: the `fetch` used to reach Atlassian for the integration routes. */
  integrations?: { fetch?: typeof fetch };
  /**
   * Serve the automation API (n8n, Conductor, scripts) on its own loopback
   * port, with per-trigger tokens managed in the app (Automations). Off unless set.
   */
  automation?: AutomationOptions;
  /**
   * Web search for agents with the `web_search` tool: the SearXNG base URL
   * (or researcher options; see `OpenAgentOptions.webSearch`). Defaults to
   * the `SEARXNG_URL` environment variable.
   */
  webSearch?: OpenAgentOptions['webSearch'];
  /**
   * Rewind: application tools whose calls change nothing outside the app (or
   * only the resources, which a rewind reverts), so the rewind confirmation
   * does not list them as side effects that stay. See `RuntimeOptions.rewindInternalTools`.
   */
  rewindInternalTools?: readonly string[];
  /**
   * Web app development (agents with `webDevTools`): the loopback port of
   * the preview listener, which serves each conversation's dev server at
   * `http://p-<token>.localhost:<port>/`, its own origin. `0` picks a free
   * port. @default 0
   */
  previewPort?: number;
  /**
   * Single-user GUI: adopt existing local Letta agents in place ("Add agent"
   * in the app; see `AdoptionRegistry`). `true` offers files, decisions and
   * ask_user (plus web search when configured); pass a sandbox to offer
   * shell commands too. @default true
   */
  adoption?: boolean | { sandbox?: SandboxConfig; dreaming?: Partial<DreamingSettings> };
}

/** The orchestrator `schedule_task` uses. `callbackUrl`: this server's automation API as the orchestrator reaches it (for example `http://host.docker.internal:4402` from Docker). */
export type SchedulerOptions =
  | { kind: 'n8n'; url: string; apiKey: string; callbackUrl: string; fetch?: typeof fetch }
  | { kind: 'conductor'; url: string; callbackUrl: string; headers?: Record<string, string>; fetch?: typeof fetch };
/** Options of the automation API (see {@link ServeOptions.automation}). */
export interface AutomationOptions {
  /** Port of the automation API. `0` picks a free port. */
  port: number;
  /** Address to bind; see `AutomationListenOptions.host`. @default '127.0.0.1' */
  host?: string;
  /** Agent self-scheduling: where `schedule_task` creates its one-off jobs. Without it, the tool answers that scheduling is not set up. */
  scheduler?: SchedulerOptions;
}

/** A running server. */
export interface RunningServer {
  url: string;
  port: number;
  /** The automation API, when enabled. */
  automation?: { url: string; port: number };
  /** The web app preview listener, for agents with the web development tools (single-user GUI). */
  preview?: { port: number };
  /** Stop accepting requests, close the agent, then release locks. Idempotent. */
  close(): Promise<void>;
}

/**
 * The decisions of an agent that has `request_decision`: a desk for its
 * sessions now, bound to the board once the runtime exists.
 */
function decisionDesk(definition: AgentDefinition, memoryReviews = false) {
  let board: DecisionBoard | undefined;
  // Agents with request_decision, and agents with web_search (a review nobody answers in time becomes a decision).
  const agentDesk = decisionsEnabled(definition) || webSearchEnabled(definition);
  // Memory reviews a person must decide are decisions too (the bell): every agent whose memory is reviewed has a board.
  const keepBoard = agentDesk || (memoryReviews && definition.memory.reviewer !== 'off');
  const desk: DecisionDesk | undefined = agentDesk ? {
    request: (request, turn) => { if (!board) throw new Error('decisions_unavailable'); return board.desk.request(request, turn); },
    cancel: (turn, id) => { if (!board) throw new Error('decisions_unavailable'); return board.desk.cancel(turn, id); },
    review: (request, turn) => { if (!board) throw new Error('decisions_unavailable'); return board.desk.review!(request, turn); },
  } : undefined;
  return { desk, bind: (runtime: ThreadRuntime, directory: string, owner: string) => {
    if (!keepBoard) return undefined;
    board = new DecisionBoard(join(directory, 'decisions.json'), runtime, owner, { id: definition.id, name: definition.name });
    return board;
  } };
}

/**
 * Memory review wiring of one agent: reviews reach the runtime (pages
 * refresh; reverts show a toast), held changes become memory review
 * decisions, and the reviewer's model can be changed in the app (kept in
 * `<dir>/memory-review.json`; the definition's setting is the default).
 */
function memoryWiring(definition: AgentDefinition, directory: string, members?: () => readonly ClaimMember[]) {
  let runtime: ThreadRuntime | undefined;
  let board: DecisionBoard | undefined;
  const file = join(directory, 'memory-review.json');
  let model = definition.memory.reviewer;
  try { const saved = JSON.parse(readFileSync(file, 'utf8')) as { model?: unknown }; if (typeof saved.model === 'string' && (saved.model === 'auto' || /^[\w.-]+\/[\w.:-]+$/.test(saved.model))) model = saved.model; } catch { /* the definition's */ }
  let available: Promise<string[]> | undefined;
  const threadOf = (review: MemoryReview) => runtime ? (review.conversationId ? runtime.threadOfConversationAny(review.conversationId) : undefined) ?? runtime.latestThread() : undefined;
  const events: MemoryGuardEvents = {
    // Team servers: the agent's members (claims are confirmed by the member they name). Single-user: none but you, so claims about others go to you as a review.
    ...(members ? { members, confirmClaims: async (review: MemoryReview) => {
      if (!board || !runtime) return undefined;
      const author = review.turn ? runtime.authorOfRun(review.turn) : undefined;
      const requester = author ? { id: author.id, name: author.name } : review.provenance.actor.kind === 'person' ? { ...(review.provenance.actor.id ? { id: review.provenance.actor.id } : {}), name: review.provenance.actor.name ?? 'Someone' } : { name: provenanceLabel(review.provenance) };
      return board.claimConfirmation(review, threadOf(review), requester);
    } } : {}),
    changed: (review, event) => { runtime?.memoryChanged(); if (event === 'reverted') runtime?.memoryReverted(review); },
    askHuman: async (review: MemoryReview) => {
      if (!board || !runtime) return undefined;
      const threadId = (review.conversationId ? runtime.threadOfConversationAny(review.conversationId) : undefined) ?? runtime.latestThread();
      const author = review.turn ? runtime.authorOfRun(review.turn) : undefined;
      return board.memoryReview(review, threadId, author ? { id: author.id, name: author.name } : review.provenance.actor.kind === 'person' && review.provenance.actor.id ? { id: review.provenance.actor.id, name: review.provenance.actor.name ?? 'You' } : undefined);
    },
  };
  return {
    events, model: () => model,
    bind(value: ThreadRuntime, decisions?: DecisionBoard) {
      runtime = value; board = decisions;
      if (board) board.memoryReviews = {
        decide: async (id, choice, by) => { if (!runtime?.memory) throw new Error('memory_unavailable'); await runtime.memory.decideReview(id, choice, by); },
        decideClaim: async (id, answer, by, options) => { if (!runtime?.memory) throw new Error('memory_unavailable'); await runtime.memory.decideClaim(id, answer, by, options); },
      };
      if (definition.memory.reviewer !== 'off') value.reviewerModel = {
        value: () => model,
        set: next => { model = next; writeFileSync(file, JSON.stringify({ model }), { mode: 0o600 }); },
        available: () => available ??= (async () => {
          const client = new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', requestTimeoutMs: 30_000 } });
          try { return (await client.models.list()).entries.map(e => e.handle).filter((h): h is string => typeof h === 'string' && /^(anthropic|openai|openai-codex|google[^/]*)\//.test(h)).slice(0, 60); }
          catch { available = undefined; return []; }
          finally { await client.close(); }
        })(),
      };
    },
  };
}
type MemoryWiring = ReturnType<typeof memoryWiring>;

/** The agent's project folder (as given), when it runs commands with one mounted at `/project`: the Resources panel shows it read-only. */
function projectOf(definition: AgentDefinition<ToolSet>): string | undefined {
  const path = definition.sandbox?.project && sandboxEnabled(definition) ? definition.sandbox.project.path : undefined;
  // The same checks as mounting it: a folder the sandbox would refuse (a home folder, credentials) is not shown either.
  if (path) { try { checkProjectFolder(path); } catch { return undefined; } }
  return path;
}

function host<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, stateDirectory: string, scheduler?: TaskScheduler, decisions?: DecisionDesk, webSearch?: OpenAgentOptions['webSearch'], memory?: MemoryWiring, webDev?: WebDevRegistry, apps?: McpApps): RuntimeHost {
  let runtime: LettaRuntime<TOOLS> | undefined;
  const project = projectOf(definition as AgentDefinition<ToolSet>);
  return {
    ...(project ? { project } : {}),
    ...(filesEnabled(definition) || atlassianEnabled(definition) ? { attachmentsRoot: statePaths(stateDirectory).resources, resources: (agentId: string, titles: Record<string, string>) => openResources(statePaths(stateDirectory), agentId, titles) } : {}),
    open: async options => {
      // The single-user GUI and API act for the local user (their own Atlassian connection, if any).
      runtime = await createLettaAgent(definition, { ...options, stateDirectory, foregroundExternalTools: true, ...(scheduler ? { scheduler } : {}), ...(decisions ? { decisions } : {}), ...(webSearch ? { webSearch } : {}), ...(memory ? { memoryReview: { events: memory.events, model: memory.model } } : {}), ...(webDev ? { webDev: { registry: webDev } } : {}), ...(apps ? { mcpApps: { apps } } : {}) });
      const { agent } = runtime;
      if (!agent.lettaAgentId || !agent.presentation) throw new Error('Runtime identity unavailable');
      return { agent, agentId: agent.lettaAgentId, conversationId: agent.presentation.conversationId, history: agent.presentation.initialMessages, rewind: runtime.rewind, memory: runtime.memory, harnessCommand: runtime.harnessCommand };
    },
    close: async () => { const current = runtime; runtime = undefined; await current?.close(); },
    // Check and unlock (the runtime closed the session first): read-only, under the identity lock.
    check: (conversationId, otid) => checkConversation(definition, conversationId, { stateDirectory, ...(otid ? { otid } : {}) }),
    // Adopted agents: their conversations are read without opening a session until someone sends.
    ...(definition.adopt ? { peek: adoptedPeek(definition.adopt.agentId, Object.keys(definition.tools)) } : {}),
  };
}

/**
 * A host that keeps several conversations of one agent open at once (each its
 * own Letta session), for a shared runtime. The agent itself is opened on first use.
 */
function parallelHost<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, stateDirectory: string, scheduler?: TaskScheduler, decisions?: DecisionDesk, webSearch?: OpenAgentOptions['webSearch'], memory?: MemoryWiring): RuntimeHost {
  let agent: Promise<AgentHost<TOOLS>> | undefined;
  // Shared conversations: the agent may listen without replying (it gets the stay_silent tool).
  // Each turn acts for its author (the runtime passes it); a turn without one acts for nobody.
  const project = projectOf(definition as AgentDefinition<ToolSet>);
  const opened = () => agent ??= openAgentHost(definition, { stateDirectory, foregroundExternalTools: true, listening: true, defaultActor: null, ...(scheduler ? { scheduler } : {}), ...(decisions ? { decisions } : {}), ...(webSearch ? { webSearch } : {}), ...(memory ? { memoryReview: { events: memory.events, model: memory.model } } : {}) }).catch(error => { agent = undefined; throw error; });
  return {
    parallel: true,
    ...(project ? { project } : {}),
    ...(filesEnabled(definition) || atlassianEnabled(definition) ? { attachmentsRoot: statePaths(stateDirectory).resources, resources: (agentId: string, titles: Record<string, string>) => openResources(statePaths(stateDirectory), agentId, titles) } : {}),
    open: async options => {
      const host = await opened();
      const conversation = await host.open(options);
      const presentation = conversation.agent.presentation!;
      return { agent: conversation.agent, agentId: host.identity.agentId, conversationId: conversation.conversationId, history: presentation.initialMessages, reload: () => conversation.history(), rewind: conversation.rewind, memory: conversation.memory, harnessCommand: conversation.harnessCommand, close: () => conversation.close() };
    },
    close: async () => { const current = agent; agent = undefined; await (await current?.catch(() => undefined))?.close(); },
    check: async (conversationId, otid) => (await opened()).check(conversationId, otid),
  };
}

function serviceLock(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'service.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new Error(`Server already running or stale lock: ${lock}. Verify the recorded PID is not running before removing it.`); }
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  return () => unlinkSync(lock);
}

async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.once('listening', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener unavailable');
  return address.port || port;
}

function lifecycle(server: Server, runtime: ThreadRuntime, unlock: () => void, log: (line: string) => void, label: string, extra?: { server?: Server; service?: AutomationService; webDev?: { registry?: WebDevRegistry; preview: PreviewServer }; apps?: McpApps }) {
  let closing: Promise<void> | undefined;
  return () => closing ??= (async () => {
    // SDK shutdown can await unref'ed resources; keep Node alive until locks release.
    const keepAlive = setInterval(() => {}, 1000);
    server.close(); server.closeAllConnections?.();
    extra?.service?.close(); extra?.server?.close(); extra?.server?.closeAllConnections?.(); extra?.webDev?.preview.close();
    // Web development containers stop with the server (each also stops when idle).
    // MCP App servers are killed and their containers removed.
    try { await runtime.close(); await extra?.webDev?.registry?.close(); await extra?.apps?.close(); unlock(); log(`${label} stopped cleanly.`); }
    catch (error) { log(`${label} shutdown incomplete; inspect the recorded locks before restarting.`); throw error; }
    finally { clearInterval(keepAlive); }
  })();
}

/**
 * Serve the assistant-ui web app for one agent on 127.0.0.1.
 *
 * No agent session is opened until the browser creates or opens a thread.
 * @param assets Directory of the built web app (for example `@ai-sdk-letta/web`'s `dist`).
 */
export async function startGuiServer<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, assets: string, options: ServeOptions = {}): Promise<RunningServer> {
  const log = options.log ?? console.log;
  const stateDirectory = resolveStateDirectory(options.stateDirectory);
  const directory = join(statePaths(stateDirectory).server(definition.id), 'gui');
  if (!existsSync(join(assets, 'index.html'))) throw new Error(`Web assets not found in ${assets}; build @ai-sdk-letta/web first`);
  const unlock = serviceLock(directory);
  try {
    const port = options.port ?? DEFAULT_PORT;
    const owner = 'local-gui';
    // Known once the listeners are bound (the app gate builds origins and CSPs from them).
    const appPortRef = { port }; const previewRef = { port: 0 };
    const scheduling = automationScheduling(options.automation, [definition]);
    const decisions = decisionDesk(definition, true);
    const memory = memoryWiring(definition, directory);
    // Web app development: each conversation's services (kept across sessions), and the preview listener.
    let notify: (() => void) | undefined;
    const webDev = webDevEnabled(definition) ? new WebDevRegistry({ directory: join(statePaths(stateDirectory).root, 'webdev'), onChange: () => notify?.() }) : undefined;
    // MCP Apps: started now (in the background), kept across sessions, stopped with the server.
    const apps = definition.mcpApps?.length ? new McpApps(definition.mcpApps, { directory: mcpAppsDirectory(statePaths(stateDirectory).root, definition.id), ...(definition.sandbox ? { sandbox: definition.sandbox } : {}), onChange: () => notify?.(), log }) : undefined;
    void apps?.ready();
    const runtime = new ThreadRuntime(host(definition, stateDirectory, scheduling.schedulerFor(definition.id), decisions.desk, options.webSearch, memory, webDev, apps), join(directory, 'state.json'), owner, { ...(options.rewindInternalTools ? { rewindInternalTools: options.rewindInternalTools } : {}) });
    notify = () => runtime.webDevChanged();
    if (apps) runtime.apps = new AppGate({ apps, runtime, owner, appOrigin: () => `http://127.0.0.1:${appPortRef.port}`, sandboxPort: () => previewRef.port, auditFile: join(directory, 'app-audit.ndjson'), person: () => ({ id: LOCAL_USER_ID, name: 'You' }) });
    const board = decisions.bind(runtime, directory, owner);
    memory.bind(runtime, board);
    const credentials = atlassianEnabled(definition) ? new CredentialStore(statePaths(stateDirectory).credentials) : undefined;
    let automation: { service: AutomationService; server: Server; url: string; port: number; endpoint: AutomationEndpoint } | undefined;
    if (options.automation) {
      const automationEntry = automationAgent(definition, runtime, owner, stateDirectory, false);
      const service = new AutomationService({ agents: [automationEntry], ...scheduling.service, log });
      scheduling.bind(service);
      runtime.rewindHooks = rewindHooks(service, automationEntry);
      const listening = await listenAutomation(service, options.automation);
      automation = { service, ...listening, endpoint: endpointOf(listening.url, options.automation) };
    }
    // Adopted agents (existing local Letta agents opened in place), each with its own runtime and memory review.
    const adoption = options.adoption === false ? undefined : new AdoptionRegistry({
      stateDirectory, owner, reserved: { definitionIds: [definition.id], agentIds: () => runtime.agentIds() }, log,
      environment: { ...(typeof options.adoption === 'object' && options.adoption.sandbox ? { sandbox: options.adoption.sandbox } : {}), ...(typeof options.adoption === 'object' && options.adoption.dreaming ? { dreaming: options.adoption.dreaming } : {}), webSearch: !!(options.webSearch ?? process.env.SEARXNG_URL?.trim()) },
      build: (adopted, folder) => {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const desk = decisionDesk(adopted, true);
        const wiring = memoryWiring(adopted, folder);
        const hosted = new ThreadRuntime(host(adopted, stateDirectory, undefined, desk.desk, options.webSearch, wiring), join(folder, 'state.json'), owner, { ...(options.rewindInternalTools ? { rewindInternalTools: options.rewindInternalTools } : {}) });
        const hostedBoard = desk.bind(hosted, folder, owner);
        wiring.bind(hosted, hostedBoard);
        hostedBoard?.resumeAll();
        return { runtime: hosted, ...(hostedBoard ? { board: hostedBoard } : {}) };
      },
    });
    adoption?.start();
    let preview: PreviewServer | undefined;
    try {
      let appPort = port;
      if (webDev || apps) {
        const tokens = new PreviewTokens();
        // Web app previews (p-<token>) and MCP App views (s-<token>, one origin per view) share one loopback listener.
        preview = await startPreviewServer({ port: options.previewPort ?? 0, frameAncestors: () => [`http://127.0.0.1:${appPort}`],
          resolve: token => {
            const threadId = tokens.threadOf(token);
            if (!threadId || !webDev) return undefined;
            const services = () => { const identity = runtime.conversationIdentity(threadId); return identity ? webDev.get(identity.agentId, identity.conversationId) : undefined; };
            return { connect: () => services()?.connectPreview(), get origins() { return services()?.origins ?? []; } };
          },
          ...(runtime.apps ? { sandbox: (token: string) => runtime.apps!.sandboxPage(token) } : {}) });
        const previewPort = preview.port;
        previewRef.port = previewPort;
        if (webDev) runtime.webDev = { registry: webDev, previewUrl: threadId => `${previewOrigin(tokens.tokenOf(threadId), previewPort)}/` };
      }
      const server = guiApp(runtime, owner, port, assets, { ...agentInfo(definition), ...(automation ? { automations: true } : {}) }, credentials, options.integrations, automation ? { service: automation.service, endpoint: automation.endpoint } : undefined, preview ? { frameSrc: `http://*.localhost:${preview.port}` } : undefined, adoption?.gui()).listen(port, '127.0.0.1');
      const bound = await listen(server, port);
      appPort = bound; appPortRef.port = bound;
      const url = `http://127.0.0.1:${bound}`;
      // Rewinds a stop interrupted are finished first, then outcomes decided before a restart and not sent yet are sent (once).
      await runtime.resumeRewinds(owner).catch(() => {});
      board?.resumeAll();
      log(`${definition.name} GUI: ${url}\nDefinition: ${definition.id} · state: ${stateDirectory}${automation ? `\nAutomation API: ${automation.url} (tokens: Automations in the app)${options.automation?.scheduler ? ` · schedule_task → ${options.automation.scheduler.kind}` : ''}` : ''}${preview && webDev ? `\nWeb app previews: http://p-<conversation token>.localhost:${preview.port}/ (loopback, own origin)` : ''}${preview && apps ? `\nMCP App views: http://s-<view token>.localhost:${preview.port}/ (loopback, one origin per view) · apps: ${definition.mcpApps!.map(a => a.id).join(', ')}` : ''}\nPID ${process.pid}. Stop with Ctrl-C or SIGTERM.`);
      const stop = lifecycle(server, runtime, unlock, log, 'GUI', { ...automation, ...(preview ? { webDev: { ...(webDev ? { registry: webDev } : {}), preview } } : {}), ...(apps ? { apps } : {}) });
      return { url, port: bound, ...(automation ? { automation: { url: automation.url, port: automation.port } } : {}), ...(preview ? { preview: { port: preview.port } } : {}), close: async () => { await adoption?.close(); await stop(); } };
    } catch (error) { automation?.service.close(); automation?.server.close(); preview?.close(); await webDev?.close(); await apps?.close(); await adoption?.close(); throw error; }
  } catch (error) { unlock(); throw error; }
}

/**
 * Serve the token-authenticated server-to-server API for one agent on 127.0.0.1.
 * The token is created once (0600) in the state directory and printed by path only.
 */
export async function startApiServer<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, options: ServeOptions & { owner?: string } = {}): Promise<RunningServer & { tokenPath: string; owner: string }> {
  const log = options.log ?? console.log;
  const stateDirectory = resolveStateDirectory(options.stateDirectory);
  const directory = join(statePaths(stateDirectory).server(definition.id), 'api');
  const unlock = serviceLock(directory);
  try {
    const tokenPath = join(directory, 'token');
    if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    const token = readFileSync(tokenPath, 'utf8').trim();
    const owner = options.owner ?? 'local-api';
    const port = options.port ?? DEFAULT_PORT + 1;
    const runtime = new ThreadRuntime(host(definition, stateDirectory, undefined, undefined, options.webSearch), join(directory, 'state.json'), owner);
    let stop: (() => Promise<void>) | undefined;
    const server = tokenApiApp(runtime, token, owner, port, () => stop!()).listen(port, '127.0.0.1');
    const bound = await listen(server, port);
    stop = lifecycle(server, runtime, unlock, log, 'API');
    const url = `http://127.0.0.1:${bound}`;
    log(`${definition.name} API: ${url} (bearer token required)\nDefinition: ${definition.id} · owner: ${owner} · token file: ${tokenPath}`);
    return { url, port: bound, tokenPath, owner, close: stop };
  } catch (error) { unlock(); throw error; }
}

/** Options of {@link startTeamServer}. */
export interface TeamServeOptions extends ServeOptions {
  /**
   * Tailscale logins of the server's owners (for example
   * `alice@example.com`). They are admins of every hosted agent and add
   * everyone else. At least one is required.
   */
  owners: readonly string[];
  /**
   * The origins `tailscale serve` publishes the app under, for example
   * `https://machine.tailnet.ts.net`. Requests for other hosts are refused.
   */
  origins: readonly string[];
}

/** What the browser may know about a definition. */
export const agentInfo = (definition: AgentDefinition): GuiAgentInfo => ({ id: definition.id, name: definition.name, ...(definition.mcpApps?.length ? { apps: true } : {}), approvalTools: Object.keys(definition.permissions).filter(name => definition.permissions[name] === 'ask'), files: filesEnabled(definition), ...((atlassianEnabled(definition) || webDevEnabled(definition)) && !filesEnabled(definition) ? { resources: true } : {}), ...(webDevEnabled(definition) ? { webDev: true } : {}), ui: { latex: definition.ui?.latex ?? true }, integrations: atlassianEnabled(definition) ? ['atlassian'] : [], ...(definition.memory?.reviewer !== 'off' ? { memory: true } : {}), ...(definition.memory?.trustJiminy ? { trustJiminy: true } : {}), ...(projectOf(definition) ? { project: basename(projectOf(definition)!) } : {}) });

/**
 * Serve several agents to a team, on 127.0.0.1 behind `tailscale serve`.
 *
 * Who is who comes from Tailscale (see `teamApp`); each agent has its own
 * members, and everything inside an agent (conversations, resources, memory)
 * is shared by them. Conversations run turns at the same time; turns of one
 * conversation wait in a visible queue. Each agent keeps its own runtime
 * state (`<state>/server/<id>/team/`); people and memberships live in
 * `<state>/team/team.json`.
 *
 * No agent session is opened until someone opens a conversation.
 */
export async function startTeamServer(definitions: readonly AgentDefinition<ToolSet>[], assets: string, options: TeamServeOptions): Promise<RunningServer> {
  const log = options.log ?? console.log;
  if (!definitions.length) throw new Error('At least one agent definition is required');
  if (new Set(definitions.map(d => d.id)).size !== definitions.length) throw new Error('Agent definition IDs must be unique');
  if (!options.owners.length) throw new Error('At least one owner (a Tailscale login) is required');
  // MCP App views need one *.localhost origin per view, which `tailscale serve` cannot publish: single-user only for now.
  const withApps = definitions.filter(d => d.mcpApps?.length);
  if (withApps.length) throw new Error(`MCP Apps are single-user only for now (their views need per-view *.localhost origins, which tailscale serve cannot publish): remove mcpApps from ${withApps.map(d => d.id).join(', ')} or use startGuiServer`);
  const stateDirectory = resolveStateDirectory(options.stateDirectory);
  if (!existsSync(join(assets, 'index.html'))) throw new Error(`Web assets not found in ${assets}; build @ai-sdk-letta/web first`);
  const teamDirectory = join(stateDirectory, 'team');
  const unlocks: (() => void)[] = [];
  const unlockAll = () => { for (const unlock of unlocks.splice(0).reverse()) { try { unlock(); } catch { /* already gone */ } } };
  const runtimes: ThreadRuntime[] = [];
  const boards: (DecisionBoard | undefined)[] = [];
  let automationServer: Server | undefined;
  let automationService: AutomationService | undefined;
  try {
    unlocks.push(serviceLock(teamDirectory));
    const directory = new TeamDirectory(join(teamDirectory, 'team.json'), options.owners);
    directory.bootstrap(definitions.map(d => d.id));
    const agents = new Map<string, TeamAgent>();
    const scheduling = automationScheduling(options.automation, definitions);
    const automationAgents: AutomationAgent[] = [];
    for (const definition of definitions) {
      const folder = join(statePaths(stateDirectory).server(definition.id), 'team');
      unlocks.push(serviceLock(folder));
      const decisions = decisionDesk(definition, true);
      const memory = memoryWiring(definition, folder, () => directory.members(definition.id).map(m => ({ id: m.id, name: m.name, login: m.login })));
      const runtime = new ThreadRuntime(parallelHost(definition, stateDirectory, scheduling.schedulerFor(definition.id), decisions.desk, options.webSearch, memory), join(folder, 'state.json'), 'team', { queue: true, parallel: true, replyMode: definition.replyMode ?? 'auto', agentName: definition.name,
        // An agent with several members is a group from the first message: "auto" means agent decides.
        members: () => directory.members(definition.id).length, ...(options.rewindInternalTools ? { rewindInternalTools: options.rewindInternalTools } : {}) });
      runtimes.push(runtime);
      const board = decisions.bind(runtime, folder, 'team');
      boards.push(board);
      memory.bind(runtime, board);
      agents.set(definition.id, { info: { ...agentInfo(definition), replyMode: definition.replyMode ?? 'auto', ...(options.automation ? { automations: true } : {}) }, runtime });
      automationAgents.push(automationAgent(definition, runtime, 'team', stateDirectory, true));
    }
    let automation: { service: AutomationService; endpoint: AutomationEndpoint; url: string; port: number } | undefined;
    if (options.automation) {
      // A token acts for a member of the agent; once they are no longer a member, it stops working.
      const service = automationService = new AutomationService({ agents: automationAgents, members: (agentId, userId) => { const user = directory.user(userId); return user && directory.role(agentId, userId) ? authorOf(user) : undefined; }, ...scheduling.service, log });
      scheduling.bind(service);
      for (const entry of automationAgents) entry.runtime.rewindHooks = rewindHooks(service, entry);
      const listening = await listenAutomation(service, options.automation);
      automationServer = listening.server;
      automation = { service, url: listening.url, port: listening.port, endpoint: endpointOf(listening.url, options.automation) };
    }
    const port = options.port ?? DEFAULT_PORT;
    const credentials = definitions.some(atlassianEnabled) ? new CredentialStore(statePaths(stateDirectory).credentials) : undefined;
    const server = teamApp({ port, assets, agents, directory, origins: options.origins, ...(credentials ? { credentials } : {}), ...(options.integrations ? { integrationOptions: options.integrations } : {}), ...(automation ? { automation: { service: automation.service, endpoint: automation.endpoint } } : {}) }).listen(port, '127.0.0.1');
    const bound = await listen(server, port);
    const url = `http://127.0.0.1:${bound}`;
    for (const runtime of runtimes) await runtime.resumeRewinds('team').catch(() => {});
    for (const board of boards) board?.resumeAll();
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      const keepAlive = setInterval(() => {}, 1000);
      server.close(); server.closeAllConnections?.();
      automationService?.close(); automationServer?.close(); automationServer?.closeAllConnections?.();
      try { await Promise.all(runtimes.map(runtime => runtime.close())); unlockAll(); log('Team server stopped cleanly.'); }
      catch (error) { log('Team server shutdown incomplete; inspect the recorded locks before restarting.'); throw error; }
      finally { clearInterval(keepAlive); }
    })();
    log(`Team server: ${url} (behind tailscale serve: ${options.origins.join(', ') || 'no origin configured'})\nAgents: ${definitions.map(d => `${d.name} (${d.id})`).join(', ')} · owners: ${options.owners.join(', ')} · state: ${stateDirectory}${automation ? `\nAutomation API: ${automation.url} (tokens: Automations in the app)${options.automation?.scheduler ? ` · schedule_task → ${options.automation.scheduler.kind}` : ''}` : ''}\nPID ${process.pid}. Stop with Ctrl-C or SIGTERM.`);
    return { url, port: bound, ...(automation ? { automation: { url: automation.url, port: automation.port } } : {}), close };
  } catch (error) {
    automationService?.close(); automationServer?.close();
    await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    unlockAll(); throw error;
  }
}

/** Close `server` on SIGINT/SIGTERM and set a non-zero exit code if shutdown fails. */
export function closeOnSignals(server: Pick<RunningServer, 'close'>): void {
  const stop = () => { server.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

/* ------------------------------------------------------------------ */
/* Automation                                                          */
/* ------------------------------------------------------------------ */

/** Where an agent's automation records live: `<state>/server/<id>/automation.json`. */
export const automationFile = (stateDirectory: string, definitionId: string) => join(statePaths(stateDirectory).server(definitionId), 'automation.json');

/**
 * Tools whose approvals an automation token may give in advance: tools with
 * permission `'ask'`, and allowed tools that ask for some calls (such as
 * `atlassian_request` for changes). Never `ask_user`.
 */
export function preApprovableTools(definition: AgentDefinition): string[] {
  return Object.keys(definition.tools).filter(name => name !== ASK_USER_TOOL && (definition.permissions[name] === 'ask'
    || (definition.permissions[name] === 'allow' && typeof (definition.tools[name] as { [PREPARE_CALL]?: unknown })[PREPARE_CALL] === 'function' && name !== 'schedule_task')));
}

/** What a rewind withdraws through the automation service: the tasks the rewound turns scheduled. */
function rewindHooks(service: AutomationService, agent: AutomationAgent): RewindHooks {
  return { schedules: runIds => service.schedulesOf(agent, runIds), cancelSchedules: runIds => service.cancelSchedulesOf(agent, runIds) };
}
function automationAgent(definition: AgentDefinition, runtime: ThreadRuntime, owner: string, stateDirectory: string, team: boolean): AutomationAgent {
  return { id: definition.id, name: definition.name, runtime, owner, store: new AutomationStore(automationFile(stateDirectory, definition.id)), preApprovable: preApprovableTools(definition), replyModes: team };
}
function endpointOf(url: string, options: AutomationOptions): AutomationEndpoint {
  const port = new URL(url).port;
  const host = options.host ?? '127.0.0.1';
  return { url, ...(host === '127.0.0.1' || host === 'localhost' ? { docker: `http://host.docker.internal:${port}` } : {}), ...(options.scheduler ? { scheduler: options.scheduler.kind } : {}) };
}
/** The orchestrator of `schedule_task`, created once; the service is bound after the runtimes exist. */
function automationScheduling(options: AutomationOptions | undefined, definitions: readonly AgentDefinition<ToolSet>[]) {
  let service: AutomationService | undefined;
  const config = options?.scheduler;
  const orchestrator: Orchestrator | undefined = !config ? undefined : config.kind === 'n8n'
    ? n8nOrchestrator({ url: config.url, apiKey: config.apiKey, ...(config.fetch ? { fetch: config.fetch } : {}) })
    : conductorOrchestrator({ url: config.url, ...(config.headers ? { headers: config.headers } : {}), ...(config.fetch ? { fetch: config.fetch } : {}) });
  if (config) new URL(config.callbackUrl);
  return {
    service: orchestrator && config ? { scheduler: { orchestrator, callbackUrl: config.callbackUrl } } : {},
    bind(value: AutomationService) { service = value; },
    /** The `schedule_task` backend of an agent that has the tool (and only when an orchestrator is configured). */
    schedulerFor(id: string): TaskScheduler | undefined {
      const definition = definitions.find(d => d.id === id);
      if (!orchestrator || !definition || !schedulingEnabled(definition)) return undefined;
      return { schedule: (request, turn) => { const scheduler = service?.schedulerFor(id); if (!scheduler) throw new Error('scheduler_unavailable'); return scheduler.schedule(request, turn); } };
    },
  };
}

/** Options of {@link createAutomationToken}. */
export interface CreateAutomationTokenOptions {
  stateDirectory?: string;
  /** Shown in the app ("via n8n") and in the conversations its turns start. */
  name: string;
  via?: AutomationVia;
  /** Tools whose `'ask'` calls run without asking in this token's turns. */
  preApproved?: string[];
  /** Team servers: the Tailscale login of the member the token acts for (they must belong to the agent). Single-user: omit (the local user). */
  actor?: string;
  /** Team servers: reply mode of its turns. @default 'always' */
  replyMode?: 'always' | 'when-addressed' | 'agent-decides';
}
/**
 * Create an automation token from the command line (the server owner), also
 * while the server runs. Returns the secret once; only its hash is stored.
 */
export function createAutomationToken(definition: AgentDefinition, options: CreateAutomationTokenOptions): { id: string; secret: string; token: ReturnType<typeof tokenSummary> } {
  const stateDirectory = resolveStateDirectory(options.stateDirectory);
  let actor = { id: LOCAL_USER_ID, name: 'You' } as { id: string; name: string; login?: string };
  if (options.actor) {
    const team = join(stateDirectory, 'team', 'team.json');
    if (!existsSync(team)) throw new Error('No team server state: --actor applies to team servers only');
    const directory = new TeamDirectory(team);
    const user = directory.userByLogin(options.actor.trim().toLowerCase());
    if (!user || !directory.role(definition.id, user.id)) throw new Error(`${options.actor} is not a member of ${definition.id}`);
    actor = { id: user.id, name: user.name, login: user.login };
  }
  const { token, secret } = createToken(new AutomationStore(automationFile(stateDirectory, definition.id)), { name: options.name, via: options.via ?? 'api', preApproved: options.preApproved ?? [], ...(options.replyMode ? { replyMode: options.replyMode } : {}) },
    { actor, createdBy: actor, preApprovable: preApprovableTools(definition) });
  return { id: token.id, secret, token: tokenSummary(token) };
}
/** Revoke an automation token from the command line. */
export function revokeAutomationToken(definition: AgentDefinition, id: string, options: { stateDirectory?: string } = {}): boolean {
  return revokeToken(new AutomationStore(automationFile(resolveStateDirectory(options.stateDirectory), definition.id)), id);
}
/** List an agent's automation tokens (never their secrets). */
export function listAutomationTokens(definition: AgentDefinition, options: { stateDirectory?: string } = {}) {
  return new AutomationStore(automationFile(resolveStateDirectory(options.stateDirectory), definition.id)).read().tokens.map(tokenSummary);
}
