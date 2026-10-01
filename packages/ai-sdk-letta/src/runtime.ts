import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { LettaAgentClient, type LettaCodeClientSessionOptions, type LettaCodeSession, type LettaConversation, type SessionDeviceStatus } from '@letta-ai/letta-agent-sdk';
import type { ToolSet } from 'ai';
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

/** Open an agent, or throw if no conversation was selected. */
export async function createLettaAgent<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, options: Omit<OpenAgentOptions, 'choose'> = {}): Promise<LettaRuntime<TOOLS>> {
  const runtime = await openLettaAgent(definition, options);
  if (!runtime) throw new Error('No conversation selected');
  return runtime;
}

/**
 * Open (creating on first use) the persistent Letta agent for a definition on
 * the local Letta backend, and return a ready {@link LettaAgent}.
 *
 * Steps, each failing closed: acquire the identity lock and mapping; select or
 * create a conversation; resume the session; verify it is idle and its history
 * settled; restore display history; apply project-scoped dreaming and verify
 * it; confirm MemFS. Returns `undefined` if `choose` returned `null`.
 */
export async function openLettaAgent<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, options: OpenAgentOptions = {}): Promise<LettaRuntime<TOOLS> | undefined> {
  const paths = statePaths(resolveStateDirectory(options.stateDirectory));
  const cwd = paths.agents;
  const client = new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', requestTimeoutMs: 180_000, startupTimeoutMs: 60_000 } });
  let session: LettaCodeSession | undefined;
  let release: (() => void) | undefined;
  let interactions: ToolInteractions | undefined;
  let sandbox: SandboxManager | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { interactions?.close(); await sandbox?.close(); session?.close(); await client.close(); }
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
    // A fresh management client sees agents created by the SDK's separate process.
    const manager = managementClient();
    let conversationId = identity.conversationId;
    let conversationTitle = 'Default conversation';
    // Files of earlier versions are moved into the resources once; their folders are named after the conversations' titles.
    let titles: Record<string, string> = {};
    try {
      if ((filesEnabled(definition) || sandboxEnabled(definition)) && ResourceStore.open(paths.resources, identity.agentId).pendingMigration(paths.attachments).length) {
        titles = Object.fromEntries((await listConversations(query => manager.conversations.list(query), identity.agentId)).map(c => [c.id, sanitizeText(c.summary ?? '')]));
      }
      const choice: ConversationChoice = options.choose
        ? await options.choose(identity, await listConversations(query => manager.conversations.list(query), identity.agentId))
        : options.newTitle !== undefined ? { newTitle: options.newTitle } : { conversationId: options.conversationId ?? identity.conversationId };
      if (choice === null) { await close(); return undefined; }
      if ('newTitle' in choice) {
        if (!choice.newTitle.trim() || choice.newTitle.length > 120) throw new Error('Conversation title must contain 1–120 characters');
        conversationId = await createConversation(async agentId => {
          const created = await manager.conversations.create({ agentId, summary: sanitizeText(choice.newTitle.trim()) });
          if (created.agent_id !== agentId) throw new Error('Created conversation belongs to a different agent');
          return created.id;
        });
      } else conversationId = choice.conversationId;
      if (!validConversationId(conversationId)) throw new Error('Invalid conversation ID');
      if (conversationId !== 'default') {
        const conversation = await manager.conversations.retrieve(conversationId);
        if (conversation.agent_id !== identity.agentId || conversation.archived) throw new Error('Conversation is archived or belongs to another agent');
        conversationTitle = sanitizeText(conversation.summary ?? 'Untitled conversation');
      }
    } finally { await manager.close(); }
    assertNoPendingTurn(conversationId);
    let turnSignal: AbortSignal | undefined;
    const broker = interactions = new ToolInteractions();
    // Resources: every file of the agent in one git-backed folder, one folder
    // per conversation. The current conversation is bound here (never from
    // tool arguments); tools may read other conversations' folders too.
    let resources: ResourceStore | undefined;
    let attachments: AttachmentStore | undefined;
    if (filesEnabled(definition) || sandboxEnabled(definition)) {
      resources = await openResources(paths, identity.agentId, { ...titles, [conversationId]: conversationTitle });
      const workspace = new AttachmentStore(resources, conversationId, { title: conversationTitle });
      workspace.path; // create the conversation's folder now, named after its title
      if (filesEnabled(definition)) attachments = workspace;
      // Shell commands: one sandbox per conversation, created on the first
      // command, with all resources at /workspace and the conversation's folder as the working directory.
      if (sandboxEnabled(definition)) {
        const store = resources;
        sandbox = new SandboxManager(definition.sandbox!, { workspace: () => store.workTree(), folder: () => workspace.path, owner: `${identity.agentId}.${conversationId}` });
      }
    }
    const toolContext = Object.freeze({ ...(attachments ? { [ATTACHMENTS_CONTEXT]: attachments } : {}), ...(sandbox ? { [SANDBOX_CONTEXT]: sandbox } : {}) });
    // Without a sandbox, the shell tools are never exposed.
    const allowedTools = sandbox ? undefined : Object.keys(definition.tools).filter(name => !(SANDBOX_TOOL_NAMES as readonly string[]).includes(name));
    const sandboxTimeout = definition.sandbox ? sandboxToolTimeout(definition.sandbox) : undefined;
    const shell = sandbox;
    const persist = options.traces === false ? undefined : typeof options.traces === 'function' ? options.traces : fileTraceWriter(paths.traces);
    // Background harness work must never open a prompt over an idle chat input.
    const bridge = createToolBridge({
      tools: definition.tools, permissions: definition.permissions, timeoutMs: definition.toolTimeoutMs, persist, allowedTools,
      ...(sandboxTimeout ? { toolTimeouts: Object.fromEntries(SANDBOX_TOOL_NAMES.map(name => [name, sandboxTimeout])) } : {}),
      get interactions() { return turnSignal ? broker : undefined; }, get signal() { return turnSignal; },
      context: () => toolContext,
      sandbox: () => shell?.session,
    });
    let memoryRoot: string | undefined;
    session = client.resumeSession(conversationId === 'default' ? identity.agentId : conversationId, sessionOptions(bridge, () => memoryRoot, cwd, definition.name));
    const ready = await session.ready();
    if (ready.agentId !== identity.agentId || ready.conversationId !== conversationId) throw new Error('Backend resumed a different identity/conversation');
    assertIdle(await session.getDeviceStatus());
    if (options.foregroundExternalTools !== false && bridge.tools.length) {
      // The SDK's tools serializer drops auto_background/timeout_ms. Use the
      // supported runtime-scoped protocol rather than global defaults.
      const configured = await session.sendCommand(foregroundToolsCommand(bridge, ready.agentId, ready.conversationId), { responseType: 'runtime_external_tools_update_response' });
      if (configured.success !== true) throw new Error('Unable to configure foreground interaction tools');
    }
    const live = session;
    const history = await loadHistory(query => historyPage(live, identity.agentId, conversationId, query));
    assertHistorySettled(history.messages);
    const initialMessages = projectHistory(history.messages, Object.keys(definition.tools));
    // The SDK's dreaming option writes global defaults. Use the protocol
    // command with project scope (the private state cwd) instead.
    const configured = await session.sendCommand(dreamingCommand(definition, ready.agentId, ready.conversationId), { responseType: 'set_reflection_settings_response' });
    if (configured.success !== true) throw new Error('Unable to configure project-scoped dreaming');
    const status = await session.getDeviceStatus();
    if (!status.memoryDirectory) throw new Error('MemFS unavailable; refusing to run without memory');
    const reflection = status.raw.reflection_settings as { trigger?: string; step_count?: number } | undefined;
    if (reflection?.trigger !== definition.dreaming.trigger || reflection.step_count !== definition.dreaming.stepCount) throw new Error('Persistent dreaming configuration differs from the definition; inspect agent settings before continuing');
    assertIdle(status);
    memoryRoot = status.memoryDirectory;
    selectConversation(conversationId);
    // Navigation reads through this same mapped runtime; it never enumerates other agents.
    let listedIds = new Set<string>(['default']);
    const navigation: NavigationSource = {
      agentId: identity.agentId, currentId: conversationId,
      list: async signal => {
        assertIdle(await live.getDeviceStatus());
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
        assertIdle(await live.getDeviceStatus());
        assertNoPendingTurn(id);
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
    const sandboxLine = shell ? `\nSandbox: ${typeof shell.config.provider === 'string' ? shell.config.provider : 'custom'} · no network${definition.permissions.run_command_online === 'ask' ? ' (network commands ask first)' : ''}${shell.hasProject ? ` · project ${shell.config.project!.path}` : ''}` : '';
    const dreamingLine = definition.dreaming.trigger === 'off' ? 'Dreaming: off' : `Dreaming: ${reflection.trigger}${reflection.trigger === 'step-count' ? ` ${reflection.step_count}` : ''} configured (not evidence a dream ran)`;
    const startupStatus = `${definition.name}\nLogical ID: ${definition.id}\nLetta ID: ${identity.agentId}\nConversation: ${conversationTitle} (${conversationId})\nStartup status: idle / ready · MemFS confirmed enabled\n${dreamingLine}\nHistory: ${initialMessages.length} visible records restored${history.truncated ? ' · LIMITED to newest 10,000 backend records; older history omitted' : ' · complete backend pagination'}${sandboxLine}`;
    // Keep one session alive between turns so background dreaming can progress.
    // LettaAgent closes only its per-turn wrapper, not this shared session.
    const agent = new LettaAgent<TOOLS>({
      id: definition.id, tools: definition.tools, memoryTools: INTERNAL_MEMORY_TOOLS, lettaAgentId: identity.agentId, modelId: definition.model, interactions: broker, attachments,
      open: signal => {
        turnSignal = signal;
        return { send: message => live.send(message), stream: () => live.stream(), abort: () => live.abort(), close: () => { if (turnSignal === signal) turnSignal = undefined; } };
      },
      presentation: { conversationId, title: conversationTitle, initialMessages, status: startupStatus, memoryDirectory: memoryRoot, historyTruncated: history.truncated },
      delivery: { begin: () => beginTurn(conversationId), complete: () => completeTurn(conversationId) },
      // Whatever the agent changed in the resources during the turn becomes one commit.
      // Folder renames of this conversation wait while a turn runs, then apply after that commit.
      ...(resources ? { beforeTurn: () => resources!.beginTurn(conversationId), afterTurn: () => resources!.endTurn(conversationId) } : {}),
    });
    return { agent, identity, navigation, ...(resources ? { resources } : {}), close: async () => { agent.close(); await agent.idle(); await close(); } };
  } catch (error) { await close(); throw error; }
}
