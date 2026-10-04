/**
 * ai-sdk-letta: a persistent, Letta-backed Vercel AI SDK `Agent` with
 * application-owned tools and human-in-the-loop interactions.
 *
 * @packageDocumentation
 */
export { LettaAgent, TurnLimitError, STOP_CONFIRM_MS, type TurnOutcome, type TurnInfo, speakerNote, unattendedNote, reminderNote, historyKey, userTurnContent, parseUserTurn, storeUserTurn, MAX_INPUT_CHARACTERS, type ParsedTurn, type LettaCallOptions, type LettaTurnMetadata, type LettaAgentOptions, type AgentPresentation, type DeliveryHooks, type TurnSession, type TurnOptions } from './agent.js';
export {
  resolveReplyMode, mentionsAgent, mentionNames, turnNote, combinedText, speakerLabel, REPLY_MODES, REPLY_MODE_SETTINGS, REPLY_MODE_OVERRIDES, STAY_SILENT_TOOL, STAY_SILENT_DESCRIPTION, STAY_SILENT_SCHEMA,
  type ReplyMode, type ReplyModeSetting, type ReplyModeOverride, type TurnSpeaker, type TurnNoteOptions,
} from './listening.js';
export {
  IMAGE_LIMITS, IMAGE_MEDIA_TYPES, IMAGE_REFERENCE_PROVIDER, ImageInputError, validateImages, decodeImagePart, assertImageBudget, isImagePart, sniffImageType, toLettaImage, imagePartDigest, compactImagePart,
  type ImageInputErrorCode, type ImageMediaType, type ImageLimits, type DecodedImage,
} from './images.js';
export {
  defineAgent, creationOptions, dreamingCommand, memoryPolicyInstructions, DEFAULT_DREAMING, DEFAULT_UI, DEFAULT_WEB_SEARCH, DEFAULT_MEMORY, WEB_SEARCH_REVIEW_LIMITS, INTERNAL_MEMORY_TOOLS,
  type AgentDefinition, type WebSearchSettings, type MemorySettings, type AgentDefinitionInput, type AgentUiSettings, type DreamingSettings, type DreamingTrigger, type ToolPermission,
} from './definition.js';
export { mcpAppsDirectory, openLettaAgent, createLettaAgent, openAgentHost, checkConversation, peekConversation, conversationGlance, newConversationTitle, openResources, staySilentTool, TURN_TIMEOUT_MS, assertIdle, sessionOptions, foregroundToolsCommand, localBackendDirectory, memoryProvenanceTool, memoryReminder, MEMORY_PROVENANCE_TOOL, type OpenAgentOptions, type LettaRuntime, type ConversationChoice, type AgentHost, type AgentHostOptions, type ConversationSession, type ConversationTarget, type ConversationRewind, type HistoryRecord, type ConversationCheck } from './runtime.js';
export { MemoryJournal, AGENT_EMAIL, REVIEW_EMAIL, harnessCommit, type MemoryRewindPlan, type TurnCommits, type LineDrop } from './memory-journal.js';
export {
  turnProvenance, trustEligible, withSource, sourceOfTool, appSource, adminClean, untrusted, provenanceTrailers, parseProvenanceTrailers, provenanceLabel, blameProvenance, sections, commitTrailers, PROVENANCE_TRAILERS, TRUSTED_TOOLS,
  type TurnProvenance, type ContentSource, type ProvenanceActor, type LineProvenance, type SectionProvenance,
} from './provenance.js';
export { MemoryGuard, matchClaimPerson, type ClaimMember, isProtectedPath, isIndexUpkeep, DEFAULT_AUTOMATION_FLOOR, reviewFloor, failedReview, DEFAULT_PROTECTED_MEMORY, DEFAULT_MEMORY_SAFETY, type MemoryReview, type MemoryRefusal, type MemoryGuardEvents, type MemoryGuardOptions, type MemorySafetySettings } from './memory-guard.js';
export {
  lettaReviewer, sweepReviewers, reviewerSessionOptions, reviewPrompt, validateVerdict, stricter, chooseReviewerModel, modelFamily, VERDICTS, VERDICT_SCHEMA, JIMINY_INSTRUCTIONS, JIMINY_NAME, REVIEWER_PREFERENCES,
  type Verdict, type JiminyVerdict, type JiminyDrop, type JiminyClaim, type ReviewRequest, type MemoryReviewer, type LettaReviewerOptions,
} from './jiminy.js';
export { dreamHookSupported, dreamHookCommand, parseDreamRequest, reviewDreamRequest, DREAM_HOOK_CAPABILITY, type DreamRequest, type DreamResponse } from './dream-review.js';
export { sweepTemporaryAgents, removeTemporaryAgent, removeAgentFolders, hiddenAgentsOf, transcriptsDirectory, type TemporaryAgentKind, type TemporaryAgentPlaces } from './temporary-agents.js';
export { planRevert, changedBy, commitsWithTrailer, commitsSince, withTrailers, gitSupportsRevert, TURN_TRAILER, CONVERSATION_TRAILER, REWIND_TRAILER, SHARED_TRAILER, type GitRunner, type RevertPlan, type FilePlan, type FileChange, type CommitInfo } from './revert.js';
export { acquireIdentity, claimsOf, forgetIdentity, validConversationId, type Identity, type IdentityBackend, type IdentityLease, type PendingTurn, type SettledTurn } from './identity.js';
export { TurnClock, resolveTurnLimits, turnLimits, envTurnLimits, formatDuration, DEFAULT_TURN_IDLE_MS, DEFAULT_TURN_MAX_MS, SDK_TURN_TIMEOUT_MS, TURN_LIMIT_ENV, type TurnLimits, type TurnStopReason } from './turn-limits.js';
export { HISTORY_LIMIT, FOREIGN_OUTPUT_LIMIT, HISTORY_IMAGE_BUDGET, IMAGE_PLACEHOLDER, LISTENED_PART, sanitizeText, historyPage, loadHistory, projectHistory, assertHistorySettled, listConversations, type ProjectionOptions } from './history.js';
export { listNavigationEntries, searchConversations, snippet, SEARCH_CONVERSATIONS, SEARCH_RECORDS, SEARCH_TOTAL, SEARCH_MATCHES, SEARCH_MILLISECONDS, type ConversationEntry, type NavigationSource, type SearchMatch } from './navigation.js';
export { ToolInteractions, validateQuestion, validateResponse, type Question, type InteractionRequest, type InteractionResponse, type InteractionHandler, type ApprovalPreview } from './interactions.js';
export {
  UploadStaging, FileInputError, FILE_LIMITS, STAGING_TTL_MS, MAX_NAME_LENGTH, TEXT_EXTENSIONS, prepareFile, detectFileType, isText, decodeText, sanitizeFileName, isPlainFileName, numberedName,
  formatBytes, describeFile, attachmentNote, withAttachmentNote, parseAttachmentNote, decodeFilePart,
  type FileLimits, type FileInputErrorCode, type FileKind, type StoredFile, type StagedFile, type StagedUpload, type PreparedFile,
} from './attachments.js';
export {
  ResourceStore, AttachmentStore, RESOURCE_LIMITS, RESOURCES_GITIGNORE, splitResourcePath, joinResourcePath, folderNameFromTitle, titleFromFolderName, readRegularFile,
  type ResourceNode, type ResourceTree, type ResourceFile, type ResourceCommit, type ResourceRewindPlan,
} from './resources.js';
export { fileTools, FILE_TOOL_NAMES, FILE_TOOL_PERMISSIONS, ATTACHMENTS_CONTEXT, READ_LIMITS, filesEnabled, listFiles, readFile, searchFiles, parseRange, type FileToolName, type FileToolOutput } from './file-tools.js';
export {
  sandboxTools, SANDBOX_TOOL_NAMES, SANDBOX_TOOL_PERMISSIONS, SANDBOX_CONTEXT, SANDBOX_PATHS, SANDBOX_LIMITS, SANDBOX_DOCKERFILE, SANDBOX_IMAGE, SANDBOX_LABEL, KILL_SCRIPT, WEBDEV_DOCKERFILE, WEBDEV_IMAGE, MCP_APPS_DOCKERFILE, MCP_APPS_IMAGE,
  SandboxManager, SandboxError, sanitizeRepository, sandboxEnabled, sandboxToolTimeout, resolveSandboxConfig, checkProjectFolder, projectNote, withProjectDescriptions, gitConfigCredentials, sandboxEnvironment, resolveWorkingDirectory,
  commandScript, parseCommandOutput, formatCommandResult, runSandboxCommand, detectSandboxProvider, prepareSandbox, sweepStaleSandboxes,
  type SandboxConfig, type ResolvedSandboxConfig, type SandboxFactory, type SandboxHandle, type SandboxRequest, type SandboxMount, type SandboxProviderName, type SandboxToolName, type SandboxToolOutput, type SandboxErrorCode, type CommandResult, type CapturedStream,
} from './sandbox.js';
export {
  webDevTools, WEBDEV_TOOL_PERMISSIONS, WEBDEV_TOOL_NAMES, BROWSER_TOOL_NAMES, BROWSER_TOOL_BASE_NAMES, BROWSER_TOOL_SPECS, CHROME_DEVTOOLS_MCP_VERSION, WEBDEV_CONTEXT, WEBDEV_PORT, WEBDEV_PROXY_PORT, WEBDEV_LIMITS, WEBDEV_UNTRUSTED_TOOLS, WEB_DEV_GUIDE, WEB_DEV_NOTE, DEV_KILL_SCRIPT, BROWSER_KILL_SCRIPT,
  WebDevServices, WebDevRegistry, readOrigins, writeOrigins, webDevEnabled, includesWebDevTools, isBrowserOutputTool, resolveWebDevConfig, normalizeWebOrigin, browserFlags, browserModelOutput, servicesRunArgs, cliServicesDriver, mcpBrowserConnector, webDevToolTimeouts, readyScript,
  FrameMux, TUNNEL_SCRIPT, handleEgress, connectOrigin,
  type WebDevConfig, type ResolvedWebDevConfig, type WebDevStatus, type WebDevServicesOptions, type WebDevRegistryOptions, type ServicesDriver, type ServicesContainer, type ServicesRequest, type CommandLine, type BrowserClient, type BrowserConnector, type BrowserResult, type BrowserToolSpec, type BrowserToolBaseName, type BrowserToolName, type WebDevToolName, type TunnelStream, type EgressOptions,
} from './webdev.js';
export { extractPdfText, pdfPageImages, encodePng, PDF_LIMITS, PdfError, type PdfPageImage } from './pdf.js';
export { createToolBridge, askUserTool, fileTraceWriter, withPreparation, ASK_USER_TOOL, TOOL_OUTPUT_LIMIT, TOOL_IMAGE_LIMITS, PREPARE_CALL, PREPARED_CONTEXT, REVIEWED_CONTEXT, UNATTENDED_CODES, type AskUserResult, type ToolActivity, type ToolBridge, type ToolBridgeOptions, type PrepareCall, type PreparedCall, type UnattendedPolicy, type UnattendedCode } from './tools.js';
export { scheduleTaskTool, schedulingTools, schedulingEnabled, resolveWhen, SCHEDULE_TASK_TOOL, SCHEDULING_TOOL_PERMISSIONS, SCHEDULER_CONTEXT, SCHEDULE_LIMITS, type TaskScheduler, type ScheduleTaskInput, type ScheduleTaskOutput, type ScheduleRequest, type ScheduledTask, type SchedulerContext } from './scheduling.js';
export {
  requestDecisionTool, cancelDecisionTool, decisionTools, decisionsEnabled, parseDecision, decisionMessage, decisionOutcomeNote, pendingDecisionNote,
  REQUEST_DECISION_TOOL, CANCEL_DECISION_TOOL, DECISION_TOOL_NAMES, DECISION_TOOL_PERMISSIONS, DECISIONS_CONTEXT, DECISION_LIMITS, REQUEST_DECISION_DESCRIPTION,
  type DecisionDesk, type DecisionContext, type DecisionRequest, type DecisionOption, type DecisionOutcome, type RequestedDecision, type DecisionToolName,
  type RequestDecisionInput, type RequestDecisionOutput, type CancelDecisionInput, type CancelDecisionOutput,
} from './decisions.js';
export { adfToMarkdown, markdownToAdf, spliceMarkdown, splitBlocks, blockMarkdown, protectedElements, lostElements, validateAdf, isAdfDocument, adfHash, type AdfDocument, type AdfNode, type AdfMark, type MarkdownOptions, type ProtectedElement, type SpliceChange, type SpliceResult } from './adf.js';
export { ADF_SCHEMA, ADF_SCHEMA_VERSION } from './adf-schema.js';
export { CredentialStore, publicStatus, LOCAL_USER_ID, LOCAL_ACTOR, ACTOR_CONTEXT, type AtlassianCredentials, type AtlassianStatus, type TurnActor } from './credentials.js';
export {
  atlassianTools, ATLASSIAN_TOOL_NAMES, ATLASSIAN_TOOL_PERMISSIONS, ATLASSIAN_LIMITS, ATLASSIAN_TIMEOUT_MS, ATLASSIAN_CONTEXT, WORKSPACE_CONTEXT, AtlassianError,
  atlassianEnabled, atlassianFetch, atlassianUrl, normalizeSite, connectAtlassian, testAtlassian, responseText, expandMarkdown, parseReference, applyEdits, isSavedDocument, readSavedDocument, savedDocumentPath, mediaOptions, downloadAtlassianMedia,
  type AtlassianToolName, type AtlassianContext, type AtlassianConnectInput, type AtlassianSource, type AtlassianMedia, type SavedDocument,
} from './atlassian.js';
export { allowMemoryTool, memoryCommitCommand } from './memory.js';
export {
  webSearchTool, webSearchTools, webSearchEnabled, createWebResearcher, searxngSearch, validateResearch, deliverResearch, researchPreview, summaryPrompt, parseSummaryText,
  WEB_SEARCH_TOOL, WEB_SEARCH_TOOL_PERMISSIONS, WEB_SEARCH_CONTEXT, WEB_SEARCH_LIMITS, WEB_RESEARCH_PREVIEW, WEB_SUMMARY_SCHEMA, WEB_SUMMARIZER_INSTRUCTIONS, WEB_SEARCH_DISMISSED, WEB_SEARCH_EXPIRED, webSearchAwaitingReview, webResearchMessage, webResearchOutcomeNote, researchAge, type WebResearchOutcome,
  type WebSearchInput, type WebSearchOutput, type WebResearch, type WebClaim, type WebSource, type WebSearchResult, type WebSourceInput, type WebSummaryRequest, type WebSummarizer,
  type WebSearchEngine, type WebResearcher, type WebResearcherOptions, type WebSearchContext,
} from './web-search.js';
export { readPage, readableText, isBlockedAddress, checkPageUrl, PageError, PAGE_LIMITS, WEB_USER_AGENT, type ReadablePage, type ReadPageOptions, type PageErrorCode } from './web-fetch.js';
export { lettaSummarizer, sweepWebSummarizers, summarizerSessionOptions, WEB_SUMMARIZER_NAME, type LettaSummarizerOptions } from './web-summarizer.js';
export { parseTitle, titleText, nodesText, safeLinkHref, shortUrl, looksLikeUrl, type TitleNode } from './title.js';
export { resolveStateDirectory, statePaths, STATE_DIR_ENV } from './state.js';
export {
  AdoptionStore, adoptedDefinition, checkAdoptedProject, validCommandTimeout, defaultAdoptedTools, adoptionFile, adoptionRefusal, adoptedDefinitionId, hiddenAgent, listAdoptableAgents, lettaCodeActivity, adoptedInstructionsSection, withoutInstructionsSection, instructionsUpdate,
  ADOPTED_TOOL_SETS, ADOPTION_LIMIT, RECENT_ACTIVITY_MS, INSTRUCTIONS_BEGIN, INSTRUCTIONS_END,
  type AdoptionRecord, type AdoptedToolSet, type AdoptionEnvironment, type LocalAgentSummary, type LettaCodeActivity, type ActivityOptions,
} from './adoption.js';
export {
  McpApps, McpAppRecords, McpAppError, ProcessStdioTransport, agentInputSchema, resolveMcpApps, toolVisibility, modelVisible, appVisible, toolResourceUri, agentToolName, grantedCsp, declaredCsp, mcpAppCsp, mcpAppModelOutput,
  mcpAppConnector, containerLauncher, mcpAppRunArgs, prepareMcpApp, prepareMcpApps, MCP_APP_LIMITS, MCP_APPS_CONTEXT, MCP_APP_PROXY_PORT,
  type McpAppConfig, type ResolvedMcpAppConfig, type McpAppToolPolicy, type McpToolDefinition, type McpToolVisibility, type McpAppCspDomains, type McpCallResult, type McpAppClient, type McpAppConnector,
  type McpAppRuntime, type McpAppLauncher, type PreparedMcpApp, type McpAppRecord, type McpAppView, type McpAppToolInfo, type McpAppStatus, type McpAppsOptions, type McpAppsContext,
} from './mcp-apps.js';
