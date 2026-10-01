import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { ToolSet } from 'ai';
import { createLettaAgent, filesEnabled, openResources, resolveStateDirectory, statePaths, type AgentDefinition, type LettaRuntime } from 'ai-sdk-letta';
import { ThreadRuntime, type RuntimeHost } from './runtime.js';
import { guiApp, tokenApiApp } from './http.js';

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
    ...(filesEnabled(definition) ? { attachmentsRoot: statePaths(stateDirectory).resources, resources: (agentId: string, titles: Record<string, string>) => openResources(statePaths(stateDirectory), agentId, titles) } : {}),
    open: async options => {
      runtime = await createLettaAgent(definition, { ...options, stateDirectory, foregroundExternalTools: true });
      const { agent } = runtime;
      if (!agent.lettaAgentId || !agent.presentation) throw new Error('Runtime identity unavailable');
      return { agent, agentId: agent.lettaAgentId, conversationId: agent.presentation.conversationId, history: agent.presentation.initialMessages };
    },
    close: async () => { const current = runtime; runtime = undefined; await current?.close(); },
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
    const server = guiApp(runtime, owner, port, assets, { id: definition.id, name: definition.name, approvalTools: Object.keys(definition.permissions).filter(name => definition.permissions[name] === 'ask'), files: filesEnabled(definition), ui: { latex: definition.ui?.latex ?? true } }).listen(port, '127.0.0.1');
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

/** Close `server` on SIGINT/SIGTERM and set a non-zero exit code if shutdown fails. */
export function closeOnSignals(server: Pick<RunningServer, 'close'>): void {
  const stop = () => { server.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
