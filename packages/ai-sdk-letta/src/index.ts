/**
 * ai-sdk-letta: a persistent, Letta-backed Vercel AI SDK `Agent` with
 * application-owned tools and human-in-the-loop interactions.
 *
 * @packageDocumentation
 */
export { LettaAgent, historyKey, type LettaAgentOptions, type AgentPresentation, type DeliveryHooks, type TurnSession } from './agent.js';
export {
  defineAgent, creationOptions, dreamingCommand, memoryPolicyInstructions, DEFAULT_DREAMING, INTERNAL_MEMORY_TOOLS,
  type AgentDefinition, type AgentDefinitionInput, type DreamingSettings, type DreamingTrigger, type ToolPermission,
} from './definition.js';
export { openLettaAgent, createLettaAgent, assertIdle, sessionOptions, foregroundToolsCommand, localBackendDirectory, type OpenAgentOptions, type LettaRuntime, type ConversationChoice } from './runtime.js';
export { acquireIdentity, validConversationId, type Identity, type IdentityBackend, type IdentityLease } from './identity.js';
export { HISTORY_LIMIT, sanitizeText, historyPage, loadHistory, projectHistory, assertHistorySettled, listConversations } from './history.js';
export { listNavigationEntries, searchConversations, snippet, SEARCH_CONVERSATIONS, SEARCH_RECORDS, SEARCH_TOTAL, SEARCH_MATCHES, SEARCH_MILLISECONDS, type ConversationEntry, type NavigationSource, type SearchMatch } from './navigation.js';
export { ToolInteractions, validateQuestion, validateResponse, type Question, type InteractionRequest, type InteractionResponse, type InteractionHandler } from './interactions.js';
export { createToolBridge, askUserTool, fileTraceWriter, ASK_USER_TOOL, type AskUserResult, type ToolActivity, type ToolBridge, type ToolBridgeOptions } from './tools.js';
export { allowMemoryTool, memoryCommitCommand } from './memory.js';
export { resolveStateDirectory, statePaths, STATE_DIR_ENV } from './state.js';
