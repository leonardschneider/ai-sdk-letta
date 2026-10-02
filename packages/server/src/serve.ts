import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { ToolSet } from 'ai';
import { CredentialStore, atlassianEnabled, createLettaAgent, filesEnabled, openAgentHost, openResources, resolveStateDirectory, statePaths, type AgentDefinition, type AgentHost, type LettaRuntime } from 'ai-sdk-letta';
import { ThreadRuntime, type RuntimeHost } from './runtime.js';
import { guiApp, teamApp, tokenApiApp, type GuiAgentInfo, type TeamAgent } from './http.js';
import { TeamDirectory } from './team.js';

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
}

/** A running server. */
export interface RunningServer {
  url: string;
  port: number;
  /** Stop accepting requests, close the agent, then release locks. Idempotent. */
  close(): Promise<void>;
}

function host<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, stateDirectory: string): RuntimeHost {
  let runtime: LettaRuntime<TOOLS> | undefined;
  return {
    ...(filesEnabled(definition) || atlassianEnabled(definition) ? { attachmentsRoot: statePaths(stateDirectory).resources, resources: (agentId: string, titles: Record<string, string>) => openResources(statePaths(stateDirectory), agentId, titles) } : {}),
    open: async options => {
      // The single-user GUI and API act for the local user (their own Atlassian connection, if any).
      runtime = await createLettaAgent(definition, { ...options, stateDirectory, foregroundExternalTools: true });
      const { agent } = runtime;
      if (!agent.lettaAgentId || !agent.presentation) throw new Error('Runtime identity unavailable');
      return { agent, agentId: agent.lettaAgentId, conversationId: agent.presentation.conversationId, history: agent.presentation.initialMessages };
    },
    close: async () => { const current = runtime; runtime = undefined; await current?.close(); },
  };
}

/**
 * A host that keeps several conversations of one agent open at once (each its
 * own Letta session), for a shared runtime. The agent itself is opened on first use.
 */
function parallelHost<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, stateDirectory: string): RuntimeHost {
  let agent: Promise<AgentHost<TOOLS>> | undefined;
  // Shared conversations: the agent may listen without replying (it gets the stay_silent tool).
  // Each turn acts for its author (the runtime passes it); a turn without one acts for nobody.
  const opened = () => agent ??= openAgentHost(definition, { stateDirectory, foregroundExternalTools: true, listening: true, defaultActor: null }).catch(error => { agent = undefined; throw error; });
  return {
    parallel: true,
    ...(filesEnabled(definition) || atlassianEnabled(definition) ? { attachmentsRoot: statePaths(stateDirectory).resources, resources: (agentId: string, titles: Record<string, string>) => openResources(statePaths(stateDirectory), agentId, titles) } : {}),
    open: async options => {
      const host = await opened();
      const conversation = await host.open(options);
      const presentation = conversation.agent.presentation!;
      return { agent: conversation.agent, agentId: host.identity.agentId, conversationId: conversation.conversationId, history: presentation.initialMessages, reload: () => conversation.history(), close: () => conversation.close() };
    },
    close: async () => { const current = agent; agent = undefined; await (await current?.catch(() => undefined))?.close(); },
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

function lifecycle(server: Server, runtime: ThreadRuntime, unlock: () => void, log: (line: string) => void, label: string) {
  let closing: Promise<void> | undefined;
  return () => closing ??= (async () => {
    // SDK shutdown can await unref'ed resources; keep Node alive until locks release.
    const keepAlive = setInterval(() => {}, 1000);
    server.close(); server.closeAllConnections?.();
    try { await runtime.close(); unlock(); log(`${label} stopped cleanly.`); }
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
    const runtime = new ThreadRuntime(host(definition, stateDirectory), join(directory, 'state.json'), owner);
    const credentials = atlassianEnabled(definition) ? new CredentialStore(statePaths(stateDirectory).credentials) : undefined;
    const server = guiApp(runtime, owner, port, assets, agentInfo(definition), credentials, options.integrations).listen(port, '127.0.0.1');
    const bound = await listen(server, port);
    const url = `http://127.0.0.1:${bound}`;
    log(`${definition.name} GUI: ${url}\nDefinition: ${definition.id} · state: ${stateDirectory}\nPID ${process.pid}. Stop with Ctrl-C or SIGTERM.`);
    return { url, port: bound, close: lifecycle(server, runtime, unlock, log, 'GUI') };
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
    const runtime = new ThreadRuntime(host(definition, stateDirectory), join(directory, 'state.json'), owner);
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
export const agentInfo = (definition: AgentDefinition): GuiAgentInfo => ({ id: definition.id, name: definition.name, approvalTools: Object.keys(definition.permissions).filter(name => definition.permissions[name] === 'ask'), files: filesEnabled(definition), ...(atlassianEnabled(definition) && !filesEnabled(definition) ? { resources: true } : {}), ui: { latex: definition.ui?.latex ?? true }, integrations: atlassianEnabled(definition) ? ['atlassian'] : [] });

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
  const stateDirectory = resolveStateDirectory(options.stateDirectory);
  if (!existsSync(join(assets, 'index.html'))) throw new Error(`Web assets not found in ${assets}; build @ai-sdk-letta/web first`);
  const teamDirectory = join(stateDirectory, 'team');
  const unlocks: (() => void)[] = [];
  const unlockAll = () => { for (const unlock of unlocks.splice(0).reverse()) { try { unlock(); } catch { /* already gone */ } } };
  const runtimes: ThreadRuntime[] = [];
  try {
    unlocks.push(serviceLock(teamDirectory));
    const directory = new TeamDirectory(join(teamDirectory, 'team.json'), options.owners);
    directory.bootstrap(definitions.map(d => d.id));
    const agents = new Map<string, TeamAgent>();
    for (const definition of definitions) {
      const folder = join(statePaths(stateDirectory).server(definition.id), 'team');
      unlocks.push(serviceLock(folder));
      const runtime = new ThreadRuntime(parallelHost(definition, stateDirectory), join(folder, 'state.json'), 'team', { queue: true, parallel: true, replyMode: definition.replyMode ?? 'auto', agentName: definition.name,
        // An agent with several members is a group from the first message: "auto" means agent decides.
        members: () => directory.members(definition.id).length });
      runtimes.push(runtime);
      agents.set(definition.id, { info: { ...agentInfo(definition), replyMode: definition.replyMode ?? 'auto' }, runtime });
    }
    const port = options.port ?? DEFAULT_PORT;
    const credentials = definitions.some(atlassianEnabled) ? new CredentialStore(statePaths(stateDirectory).credentials) : undefined;
    const server = teamApp({ port, assets, agents, directory, origins: options.origins, ...(credentials ? { credentials } : {}), ...(options.integrations ? { integrationOptions: options.integrations } : {}) }).listen(port, '127.0.0.1');
    const bound = await listen(server, port);
    const url = `http://127.0.0.1:${bound}`;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      const keepAlive = setInterval(() => {}, 1000);
      server.close(); server.closeAllConnections?.();
      try { await Promise.all(runtimes.map(runtime => runtime.close())); unlockAll(); log('Team server stopped cleanly.'); }
      catch (error) { log('Team server shutdown incomplete; inspect the recorded locks before restarting.'); throw error; }
      finally { clearInterval(keepAlive); }
    })();
    log(`Team server: ${url} (behind tailscale serve: ${options.origins.join(', ') || 'no origin configured'})\nAgents: ${definitions.map(d => `${d.name} (${d.id})`).join(', ')} · owners: ${options.owners.join(', ')} · state: ${stateDirectory}\nPID ${process.pid}. Stop with Ctrl-C or SIGTERM.`);
    return { url, port: bound, close };
  } catch (error) {
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
