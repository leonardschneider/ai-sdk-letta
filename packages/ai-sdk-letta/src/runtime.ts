import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { LettaAgentClient, type LettaCodeClientSessionOptions, type LettaCodeSession, type LettaConversation, type SessionDeviceStatus } from '@letta-ai/letta-agent-sdk';
import { jsonSchema, tool, type Tool, type ToolSet, type UIMessage } from 'ai';
import { LettaAgent } from './agent.js';
import { creationOptions, dreamingCommand, INTERNAL_MEMORY_TOOLS, type AgentDefinition } from './definition.js';
import { acquireIdentity, validConversationId, type Identity } from './identity.js';
import { assertHistorySettled, historyPage, listConversations, loadHistory, projectHistory, sanitizeText } from './history.js';
import { allowMemoryTool, memoryCommitCommand } from './memory.js';
import { listNavigationEntries, type NavigationSource } from './navigation.js';
import { ToolInteractions } from './interactions.js';
import { createToolBridge, fileTraceWriter, type ToolActivity, type ToolBridge } from './tools.js';
import { resolveStateDirectory, statePaths } from './state.js';
import { AttachmentStore, ResourceStore } from './resources.js';
import { ATTACHMENTS_CONTEXT, filesEnabled } from './file-tools.js';
import { SANDBOX_CONTEXT, SANDBOX_TOOL_NAMES, SandboxManager, sandboxEnabled, sandboxToolTimeout } from './sandbox.js';
import { STAY_SILENT_DESCRIPTION, STAY_SILENT_SCHEMA, STAY_SILENT_TOOL } from './listening.js';
import { ACTOR_CONTEXT, CredentialStore, LOCAL_ACTOR, type TurnActor } from './credentials.js';
import { ATLASSIAN_CONTEXT, ATLASSIAN_TIMEOUT_MS, ATLASSIAN_TOOL_NAMES, WORKSPACE_CONTEXT, atlassianEnabled } from './atlassian.js';

/**
 * The application-owned tool an agent calls to listen without replying. It
 * succeeds only in a turn that allows silence (`allowed()`); otherwise it
 * tells the agent to reply.
 */
export function staySilentTool(allowed: () => boolean): Tool<{ reason?: string }, { listening: boolean }> {
  return tool({
    description: STAY_SILENT_DESCRIPTION,
    inputSchema: jsonSchema<{ reason?: string }>(STAY_SILENT_SCHEMA as Parameters<typeof jsonSchema>[0]),
    execute: async () => ({ listening: allowed() }),
    toModelOutput: ({ output }: { output: { listening: boolean } }) => output.listening
      ? { type: 'text' as const, value: 'OK: you listen this turn. End the turn now and write no text.' }
      : { type: 'error-text' as const, value: 'This turn needs a reply (you were mentioned, or the reply mode is "always"). Write your reply now.' },
  });
}

/** Which conversation to open. `null` means "open nothing" (for example, the user quit a picker). */
export type ConversationChoice = { conversationId: string } | { newTitle: string } | null;

/** Options for {@link openLettaAgent}. */
export interface OpenAgentOptions {
  /** State root; see {@link resolveStateDirectory}. */
  stateDirectory?: string;
  /** Open this conversation (`'default'` or a Letta conversation ID). */
  conversationId?: string;
  /** Create and open a new conversation with this title. */
  newTitle?: string;
  /** Interactive picker; takes precedence over `conversationId`/`newTitle`. */
  choose?: (identity: Identity, conversations: LettaConversation[]) => Promise<ConversationChoice>;
  /**
   * Keep application tools in the foreground for up to five minutes. Without
   * this, the Letta harness backgrounds a client tool after about 10 seconds,
   * which breaks human approvals and questions. @default true
   */
  foregroundExternalTools?: boolean;
  /** Tool audit trail: `true` writes private NDJSON under the state directory, or pass a sink. @default true */
  traces?: boolean | ((event: ToolActivity) => void);
  /**
   * Who turns act for when a call names no `actor` (personal credentials,
   * such as Atlassian tokens). Single-user apps act for the local user
   * ({@link LOCAL_ACTOR}); a shared server passes each turn's author
   * instead, and `null` means "nobody" (unattended runs). @default LOCAL_ACTOR
   */
  defaultActor?: TurnActor | null;
}

/** An opened agent plus the resources that belong to it. */
export interface LettaRuntime<TOOLS extends ToolSet = ToolSet> {
  agent: LettaAgent<TOOLS>;
  identity: Identity;
  /** Read-only conversation listing and search for the same agent. */
  navigation: NavigationSource;
  /** The agent's resources (all conversations' files, git-backed), when it has file tools or a sandbox. */
  resources?: ResourceStore;
  /** Close the session and SDK client, then release the identity lock. Idempotent. */
  close(): Promise<void>;
}

const managementClient = (requestTimeoutMs?: number) => new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', ...(requestTimeoutMs ? { requestTimeoutMs } : {}) } });

/** Letta local backend directory used to key identity mappings. */
export function localBackendDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.LETTA_LOCAL_BACKEND_DIR?.trim() || join(homedir(), '.letta', 'lc-local-backend'));
}

/** @throws unless the session is online, idle and has no queued or pending work. */
export function assertIdle(status: SessionDeviceStatus): void {
  if (status.isOnline !== true || status.isProcessing !== false || !Array.isArray(status.pendingControlRequests) || !status.raw || status.pendingControlRequests.length || (Array.isArray(status.raw.queue) && status.raw.queue.length) || (Array.isArray(status.raw.active_run_ids) && status.raw.active_run_ids.length)) throw new Error('Conversation has unfinished work or is offline; inspect backend before continuing (no retry/repair).');
}

/** Letta session options: application tools plus MemFS tools confined to the agent's memory. */
export function sessionOptions(bridge: ToolBridge, getMemoryRoot: () => string | undefined, cwd: string, memoryAuthor?: string): LettaCodeClientSessionOptions {
  return {
    stateless: false, cwd,
    toolset: { base: 'none', include: [...INTERNAL_MEMORY_TOOLS] },
    allowedTools: [...bridge.allowedTools, ...INTERNAL_MEMORY_TOOLS], tools: bridge.tools,
    permissionMode: 'strict', skillSources: [],
    // Avoid the SDK convenience `dreaming` option; app-scoped settings are applied after ready().
    canUseTool: async (name, input, context) => {
      if ((INTERNAL_MEMORY_TOOLS as readonly string[]).includes(name)) {
        const root = getMemoryRoot();
        if (allowMemoryTool(name, input, root, memoryAuthor)) return { behavior: 'allow' };
        return { behavior: 'deny', message: `Only own-memory Markdown operations are permitted.${root ? ` The only permitted Bash command is: ${memoryCommitCommand(root, memoryAuthor)}` : ''}` };
      }
      return bridge.canUseTool(name, input, context);
    },
  };
}

/**
 * Runtime-scoped protocol command that keeps application tools in the
 * foreground (no auto-backgrounding) with a five-minute timeout.
 */
export function foregroundToolsCommand(bridge: Pick<ToolBridge, 'tools'>, agentId: string, conversationId: string) {
  return { type: 'runtime_external_tools_update', updates: [{
    runtimes: [{ agent_id: agentId, conversation_id: conversationId }],
    external_tools: [{ tools: bridge.tools.map(tool => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, auto_background: false, timeout_ms: 300_000 })) }],
  }] };
}

/**
 * Open the agent's resources (git-backed, `<stateDir>/resources/<agentId>/`)
 * and move files from the earlier per-conversation attachment layout into it
 * (once, idempotently). `titles` names the folders of migrated conversations.
 */
export async function openResources(paths: ReturnType<typeof statePaths>, agentId: string, titles: Record<string, string | undefined> = {}): Promise<ResourceStore> {
  const resources = ResourceStore.open(paths.resources, agentId);
  await resources.init();
  if (resources.pendingMigration(paths.attachments).length) await resources.migrate(paths.attachments, id => titles[id]);
  return resources;
}

/** A conversation to open on an {@link AgentHost}: an existing one, or a new one with this title. */
export type ConversationTarget = { conversationId: string } | { newTitle: string };

/** One open conversation of an {@link AgentHost}: its own Letta session, tools, interactions and sandbox. */
export interface ConversationSession<TOOLS extends ToolSet = ToolSet> {
  agent: LettaAgent<TOOLS>;
  conversationId: string;
  title: string;
  /** Reload the display history from the backend (nothing is sent; projected like `presentation.initialMessages`). */
  history(): Promise<UIMessage[]>;
  /** Close this conversation's session (the host and other conversations stay open). Idempotent. */
  close(): Promise<void>;
}

/**
 * The persistent Letta agent of a definition, held open by one process (the
 * identity lock), with any number of conversations open at once. Each
 * conversation has its own Letta session, so turns in different conversations
 * run concurrently; turns within one conversation are one at a time.
 */
export interface AgentHost<TOOLS extends ToolSet = ToolSet> {
  readonly definition: AgentDefinition<TOOLS>;
  readonly identity: Identity;
  /** The agent's resources, when it has file tools or a sandbox. */
  readonly resources?: ResourceStore;
  /** Open a conversation. Opening one that is already open is refused; close it first. */
  open(target: ConversationTarget): Promise<ConversationSession<TOOLS>>;
  /** Close every open conversation and the SDK client, then release the identity lock. Idempotent. */
  close(): Promise<void>;
}

/**
 * Options for {@link openAgentHost}. `listening`: conversations shared by
 * several people; the agent gets the `stay_silent` tool so a turn with a
 * `replyMode` other than `'always'` may end without a reply (see `LettaCallOptions`).
 */
export type AgentHostOptions = Pick<OpenAgentOptions, 'stateDirectory' | 'foregroundExternalTools' | 'traces' | 'defaultActor'> & { listening?: boolean };

type OpenedConversation<TOOLS extends ToolSet> = ConversationSession<TOOLS> & { live: LettaCodeSession; truncated: boolean; startupStatus: string };
type Internals<TOOLS extends ToolSet> = AgentHost<TOOLS> & {
  lease: Awaited<ReturnType<typeof acquireIdentity>>;
  openConversation(target: ConversationTarget): Promise<OpenedConversation<TOOLS>>;
};

/**
 * Longest a whole turn may take before the Letta SDK gives up on it. In the
 * installed SDK (0.8.22), `appServer.requestTimeoutMs` is one wall-clock
 * timer per turn, started when the turn begins and never extended (not even
 * while a tool waits for a person). It must therefore cover inference plus
 * the longest human wait: the harness keeps an external tool for at most five
 * minutes (see {@link foregroundToolsCommand}), and the HTTP runtime's own
 * deadlines (three minutes of inference plus four of human waiting) end a
 * turn first. Requests other than turns get explicit, short timeouts.
 */
export const TURN_TIMEOUT_MS = 600_000;
/** Timeout of the session's setup and status requests (not turns). */
const REQUEST_TIMEOUT_MS = 60_000;
const lettaClient = () => new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', requestTimeoutMs: TURN_TIMEOUT_MS, startupTimeoutMs: 60_000 } });

/**
 * Open (creating on first use) the persistent Letta agent of a definition on
 * the local Letta backend, without opening a conversation yet. Holds the
 * identity lock until `close()`. Use {@link AgentHost.open} to open
 * conversations; several may be open (and run turns) at the same time.
 */
export async function openAgentHost<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, options: AgentHostOptions = {}): Promise<AgentHost<TOOLS>> {
  return hostInternals(definition, options);
}

async function hostInternals<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, options: AgentHostOptions): Promise<Internals<TOOLS>> {
  const paths = statePaths(resolveStateDirectory(options.stateDirectory));
  const cwd = paths.agents;
  const client = lettaClient();
  let release: (() => void) | undefined;
  const open = new Set<OpenedConversation<TOOLS>>();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await Promise.allSettled([...open].map(conversation => conversation.close())); await client.close(); }
    finally { release?.(); }
  })();
  try {
    const backend = localBackendDirectory();
    const lease = await acquireIdentity(cwd, definition, backend, {
      create: async () => {
        const models = await client.models.list();
        if (!models.entries.some(model => model.handle === definition.model)) throw new Error(`Model "${definition.model}" is not available on the local Letta backend; connect its provider first`);
        return client.createAgent(creationOptions(definition, cwd));
      },
      validate: async id => {
        // Local management snapshots can predate createAgent's separate process.
        const inspector = managementClient();
        try {
          const agent = await inspector.agents.retrieve(id);
          if (agent.id !== id || agent.name !== definition.name) throw new Error('Mapped agent identity mismatch; refusing to recreate');
          if (!agent.tags?.includes('git-memory-enabled')) throw new Error('Mapped agent has MemFS disabled; refusing to continue');
        } finally { await inspector.close(); }
      },
    });
    const { identity, selectConversation, createConversation, assertNoPendingTurn, beginTurn, completeTurn } = lease;
    release = lease.release;
    // Files of earlier versions are moved into the resources once; their folders are named after the conversations' titles.
    let resources: ResourceStore | undefined;
    if (filesEnabled(definition) || sandboxEnabled(definition) || atlassianEnabled(definition)) {
      let titles: Record<string, string> = {};
      if (ResourceStore.open(paths.resources, identity.agentId).pendingMigration(paths.attachments).length) {
        const manager = managementClient();
        try { titles = Object.fromEntries((await listConversations(query => manager.conversations.list(query), identity.agentId)).map(c => [c.id, sanitizeText(c.summary ?? '')])); }
        finally { await manager.close(); }
      }
      resources = await openResources(paths, identity.agentId, titles);
    }
    const persist = options.traces === false ? undefined : typeof options.traces === 'function' ? options.traces : fileTraceWriter(paths.traces);
    // Per-user secrets (Atlassian tokens) live outside the resources, so neither the agent nor the sandbox can read them.
    const credentials = atlassianEnabled(definition) ? new CredentialStore(paths.credentials) : undefined;
    const defaultActor = options.defaultActor === undefined ? LOCAL_ACTOR : options.defaultActor ?? undefined;
    // Conversation creation writes one pending-intent file per agent: create one at a time.
    let creating: Promise<unknown> = Promise.resolve();
    const opened = new Set<string>();

    const openConversation = async (target: ConversationTarget): Promise<OpenedConversation<TOOLS>> => {
      if (closing) throw new Error('Agent host closed');
      const manager = managementClient();
      let conversationId: string;
      let conversationTitle = 'Default conversation';
      try {
        if ('newTitle' in target) {
          if (!target.newTitle.trim() || target.newTitle.length > 120) throw new Error('Conversation title must contain 1–120 characters');
          const created = creating.then(() => createConversation(async agentId => {
            const conversation = await manager.conversations.create({ agentId, summary: sanitizeText(target.newTitle.trim()) });
            if (conversation.agent_id !== agentId) throw new Error('Created conversation belongs to a different agent');
            return conversation.id;
          }));
          creating = created.catch(() => {});
          conversationId = await created;
        } else conversationId = target.conversationId;
        if (!validConversationId(conversationId)) throw new Error('Invalid conversation ID');
        if (conversationId !== 'default') {
          const conversation = await manager.conversations.retrieve(conversationId);
          if (conversation.agent_id !== identity.agentId || conversation.archived) throw new Error('Conversation is archived or belongs to another agent');
          conversationTitle = sanitizeText(conversation.summary ?? 'Untitled conversation');
        }
      } finally { await manager.close(); }
      if (opened.has(conversationId)) throw new Error('Conversation is already open in this process');
      assertNoPendingTurn(conversationId);
      opened.add(conversationId);
      const sessionClient = lettaClient();
      let session: LettaCodeSession | undefined;
      let sandbox: SandboxManager | undefined;
      const broker = new ToolInteractions();
      let closed: Promise<void> | undefined;
      let agent: LettaAgent<TOOLS> | undefined;
      let self: OpenedConversation<TOOLS> | undefined;
      const shutdown = () => closed ??= (async () => {
        try { agent?.close(); await agent?.idle(); broker.close(); await sandbox?.close(); session?.close(); await sessionClient.close(); }
        finally { opened.delete(conversationId); if (self) open.delete(self); }
      })();
      try {
        let turnSignal: AbortSignal | undefined;
        // Who the running turn acts for (read by tools that use personal credentials).
        let turnActor: TurnActor | undefined;
        // Whether the running turn may end without a reply (read by stay_silent when the agent calls it).
        let turnSilence = false;
        // Resources: every file of the agent in one git-backed folder, one folder
        // per conversation. The current conversation is bound here (never from
        // tool arguments); tools may read other conversations' folders too.
        let attachments: AttachmentStore | undefined;
        let folder: AttachmentStore | undefined;
        if (resources) {
          const workspace = new AttachmentStore(resources, conversationId, { title: conversationTitle });
          workspace.path; // create the conversation's folder now, named after its title
          folder = workspace;
          if (filesEnabled(definition)) attachments = workspace;
          // Shell commands: one sandbox per conversation, created on the first
          // command, with all resources at /workspace and the conversation's folder as the working directory.
          if (sandboxEnabled(definition)) {
            const store = resources;
            sandbox = new SandboxManager(definition.sandbox!, { workspace: () => store.workTree(), folder: () => workspace.path, owner: `${identity.agentId}.${conversationId}` });
          }
        }
        const staticContext = { ...(attachments ? { [ATTACHMENTS_CONTEXT]: attachments } : {}), ...(sandbox ? { [SANDBOX_CONTEXT]: sandbox } : {}),
          ...(folder && credentials ? { [WORKSPACE_CONTEXT]: folder } : {}), ...(credentials ? { [ATLASSIAN_CONTEXT]: { store: credentials } } : {}) };
        const toolContext = () => Object.freeze({ ...staticContext, ...(turnActor ? { [ACTOR_CONTEXT]: turnActor } : {}) });
        // Without a sandbox, the shell tools are never exposed.
        const listening = !!options.listening;
        const exposed = listening ? { ...definition.tools, [STAY_SILENT_TOOL]: staySilentTool(() => turnSilence) } : definition.tools;
        const allowedTools = sandbox ? undefined : Object.keys(exposed).filter(name => !(SANDBOX_TOOL_NAMES as readonly string[]).includes(name));
        const sandboxTimeout = definition.sandbox ? sandboxToolTimeout(definition.sandbox) : undefined;
        const shell = sandbox;
        // Background harness work must never open a prompt over an idle chat input.
        const bridge = createToolBridge({
          tools: exposed, permissions: listening ? { ...definition.permissions, [STAY_SILENT_TOOL]: 'allow' } : definition.permissions, timeoutMs: definition.toolTimeoutMs, persist, allowedTools,
          ...(listening ? { uncounted: [STAY_SILENT_TOOL] } : {}),
          toolTimeouts: { ...(sandboxTimeout ? Object.fromEntries(SANDBOX_TOOL_NAMES.map(name => [name, sandboxTimeout])) : {}), ...(credentials ? Object.fromEntries(ATLASSIAN_TOOL_NAMES.map(name => [name, Math.max(definition.toolTimeoutMs, ATLASSIAN_TIMEOUT_MS)])) : {}) },
          get interactions() { return turnSignal ? broker : undefined; }, get signal() { return turnSignal; },
          context: toolContext,
          sandbox: () => shell?.session,
        });
        let memoryRoot: string | undefined;
        session = sessionClient.resumeSession(conversationId === 'default' ? identity.agentId : conversationId, sessionOptions(bridge, () => memoryRoot, cwd, definition.name));
        const ready = await session.ready();
        if (ready.agentId !== identity.agentId || ready.conversationId !== conversationId) throw new Error('Backend resumed a different identity/conversation');
        assertIdle(await session.getDeviceStatus({ timeoutMs: REQUEST_TIMEOUT_MS }));
        if (options.foregroundExternalTools !== false && bridge.tools.length) {
          // The SDK's tools serializer drops auto_background/timeout_ms. Use the
          // supported runtime-scoped protocol rather than global defaults.
          const configured = await session.sendCommand(foregroundToolsCommand(bridge, ready.agentId, ready.conversationId), { responseType: 'runtime_external_tools_update_response', timeoutMs: REQUEST_TIMEOUT_MS });
          if (configured.success !== true) throw new Error('Unable to configure foreground interaction tools');
        }
        const live = session;
        const history = await loadHistory(query => historyPage(live, identity.agentId, conversationId, query, REQUEST_TIMEOUT_MS));
        assertHistorySettled(history.messages);
        const initialMessages = projectHistory(history.messages, Object.keys(definition.tools), undefined, { listening });
        // The SDK's dreaming option writes global defaults. Use the protocol
        // command with project scope (the private state cwd) instead.
        const configured = await session.sendCommand(dreamingCommand(definition, ready.agentId, ready.conversationId), { responseType: 'set_reflection_settings_response', timeoutMs: REQUEST_TIMEOUT_MS });
        if (configured.success !== true) throw new Error('Unable to configure project-scoped dreaming');
        const status = await session.getDeviceStatus({ timeoutMs: REQUEST_TIMEOUT_MS });
        if (!status.memoryDirectory) throw new Error('MemFS unavailable; refusing to run without memory');
        const reflection = status.raw.reflection_settings as { trigger?: string; step_count?: number } | undefined;
        if (reflection?.trigger !== definition.dreaming.trigger || reflection.step_count !== definition.dreaming.stepCount) throw new Error('Persistent dreaming configuration differs from the definition; inspect agent settings before continuing');
        assertIdle(status);
        memoryRoot = status.memoryDirectory;
        selectConversation(conversationId);
        const sandboxLine = shell ? `\nSandbox: ${typeof shell.config.provider === 'string' ? shell.config.provider : 'custom'} · no network${definition.permissions.run_command_online === 'ask' ? ' (network commands ask first)' : ''}${shell.hasProject ? ` · project ${shell.config.project!.path}` : ''}` : '';
        const dreamingLine = definition.dreaming.trigger === 'off' ? 'Dreaming: off' : `Dreaming: ${reflection.trigger}${reflection.trigger === 'step-count' ? ` ${reflection.step_count}` : ''} configured (not evidence a dream ran)`;
        const startupStatus = `${definition.name}\nLogical ID: ${definition.id}\nLetta ID: ${identity.agentId}\nConversation: ${conversationTitle} (${conversationId})\nStartup status: idle / ready · MemFS confirmed enabled\n${dreamingLine}\nHistory: ${initialMessages.length} visible records restored${history.truncated ? ' · LIMITED to newest 10,000 backend records; older history omitted' : ' · complete backend pagination'}${sandboxLine}`;
        // Keep one session alive between turns so background dreaming can progress.
        // LettaAgent closes only its per-turn wrapper, not this shared session.
        const store = resources;
        agent = new LettaAgent<TOOLS>({
          id: definition.id, tools: definition.tools, memoryTools: INTERNAL_MEMORY_TOOLS, lettaAgentId: identity.agentId, modelId: definition.model, interactions: broker, attachments,
          open: (signal, turn) => {
            turnSignal = signal; turnSilence = turn.silence; turnActor = turn.actor;
            return { send: (message, sendOptions) => live.send(message, sendOptions), stream: () => live.stream(), abort: () => live.abort(), close: () => { if (turnSignal === signal) { turnSignal = undefined; turnSilence = false; turnActor = undefined; } } };
          },
          listening, name: definition.name, ...(defaultActor ? { defaultActor } : {}),
          presentation: { conversationId, title: conversationTitle, initialMessages, status: startupStatus, memoryDirectory: memoryRoot, historyTruncated: history.truncated },
          delivery: { begin: () => beginTurn(conversationId), complete: () => completeTurn(conversationId) },
          // Whatever the agent changed in the resources during the turn becomes one commit.
          // Folder renames of this conversation wait while a turn runs, then apply after that commit.
          ...(store ? { beforeTurn: () => store.beginTurn(conversationId), afterTurn: () => store.endTurn(conversationId) } : {}),
        });
        const reload = async () => projectHistory((await loadHistory(query => historyPage(live, identity.agentId, conversationId, query, REQUEST_TIMEOUT_MS))).messages, Object.keys(definition.tools), undefined, { listening });
        self = { agent, conversationId, title: conversationTitle, live, history: reload, truncated: history.truncated, startupStatus, close: shutdown };
        open.add(self);
        return self;
      } catch (error) { await shutdown(); throw error; }
    };

    return {
      definition, identity, lease, ...(resources ? { resources } : {}),
      openConversation,
      open: async target => { const { agent, conversationId, title, history, close: closeConversation } = await openConversation(target); return { agent, conversationId, title, history, close: closeConversation }; },
      close,
    };
  } catch (error) { await close(); throw error; }
}

/** Open an agent, or throw if no conversation was selected. */
export async function createLettaAgent<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, options: Omit<OpenAgentOptions, 'choose'> = {}): Promise<LettaRuntime<TOOLS>> {
  const runtime = await openLettaAgent(definition, options);
  if (!runtime) throw new Error('No conversation selected');
  return runtime;
}

/**
 * Open (creating on first use) the persistent Letta agent for a definition on
 * the local Letta backend, and return a ready {@link LettaAgent} for one
 * conversation (see {@link openAgentHost} for several at once).
 *
 * Steps, each failing closed: acquire the identity lock and mapping; select or
 * create a conversation; resume the session; verify it is idle and its history
 * settled; restore display history; apply project-scoped dreaming and verify
 * it; confirm MemFS. Returns `undefined` if `choose` returned `null`.
 */
export async function openLettaAgent<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, options: OpenAgentOptions = {}): Promise<LettaRuntime<TOOLS> | undefined> {
  const host = await hostInternals(definition, options);
  try {
    const { identity, lease } = host;
    let choice: ConversationChoice;
    if (options.choose) {
      const manager = managementClient();
      try { choice = await options.choose(identity, await listConversations(query => manager.conversations.list(query), identity.agentId)); }
      finally { await manager.close(); }
    } else choice = options.newTitle !== undefined ? { newTitle: options.newTitle } : { conversationId: options.conversationId ?? identity.conversationId };
    if (choice === null) { await host.close(); return undefined; }
    const conversation = await host.openConversation(choice);
    const { live, conversationId } = conversation;
    // Navigation reads through this same mapped runtime; it never enumerates other agents.
    let listedIds = new Set<string>(['default']);
    const navigation: NavigationSource = {
      agentId: identity.agentId, currentId: conversationId,
      list: async signal => {
        assertIdle(await live.getDeviceStatus({ timeoutMs: REQUEST_TIMEOUT_MS }));
        const reader = managementClient(15_000);
        try {
          const result = await listNavigationEntries(query => reader.conversations.list(query), identity.agentId, signal);
          listedIds = new Set(result.entries.map(entry => entry.id));
          return result;
        } finally { await reader.close(); }
      },
      page: async (id, pageOptions) => {
        if (!listedIds.has(id)) throw new Error('Conversation outside current-agent listing');
        return historyPage(live, identity.agentId, id, pageOptions, 10_000);
      },
      validate: async (id, signal) => {
        if (!listedIds.has(id) || !validConversationId(id)) throw new Error('Conversation outside current-agent listing');
        assertIdle(await live.getDeviceStatus({ timeoutMs: REQUEST_TIMEOUT_MS }));
        lease.assertNoPendingTurn(id);
        const deadline = Date.now() + 30_000;
        const loaded = await loadHistory(pageOptions => {
          signal?.throwIfAborted();
          if (Date.now() >= deadline) throw new Error('Selection validation deadline reached');
          return historyPage(live, identity.agentId, id, pageOptions, 10_000);
        });
        signal?.throwIfAborted();
        assertHistorySettled(loaded.messages);
      },
    };
    return { agent: conversation.agent, identity, navigation, ...(host.resources ? { resources: host.resources } : {}), close: () => host.close() };
  } catch (error) { await host.close(); throw error; }
}
