import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UIMessage, UserContent } from 'ai';
import type { DecisionBoard } from './decisions.js';
import { externalEffects, forkPoint, rewindTurn, rewoundSpan, soloRefusal, type RewindSummary } from './rewind.js';
import {
  REPLY_MODE_OVERRIDES, combinedText, mentionsAgent, resolveReplyMode, LISTENED_PART, type ReplyMode, type ReplyModeOverride, type ReplyModeSetting,
  decisionOutcomeNote, webResearchOutcomeNote, provenanceLabel,
  type MemoryGuard, type MemoryReview,
  AttachmentStore, FILE_LIMITS, FileInputError, IMAGE_PLACEHOLDER, IMAGE_REFERENCE_PROVIDER, ImageInputError, MAX_INPUT_CHARACTERS, ResourceStore, UploadStaging, attachmentNote, sanitizeFileName, titleFromFolderName, validateImages, validateResponse,
  appSource, type ContentSource, type ConversationRewind, type DecodedImage, type InteractionRequest, type InteractionResponse, type LettaAgent, type ResourceTree, type StagedFile, type StoredFile, type WebDevRegistry, type WebDevStatus,
} from 'ai-sdk-letta';

/** One NDJSON event of a run. The application, never the HTTP consumer, owns tools. */
export type RuntimeEvent = { sequence: number; type: string; data: Record<string, unknown> };
/**
 * A conversation's override of a display setting: `'inherit'` uses the
 * agent's setting (the definition's `ui`), `'on'`/`'off'` override it.
 */
export type DisplayOverride = 'inherit' | 'on' | 'off';
const DISPLAY_OVERRIDES: readonly DisplayOverride[] = ['inherit', 'on', 'off'];
// createdAt/lastActivityAt/latex are optional: threads recorded before they existed stay valid (latex: inherit).
type Thread = { id: string; owner: string; conversationId?: string; agentId?: string; title: string; archived: boolean; state: 'creating' | 'ready'; createdAt?: string; lastActivityAt?: string; latex?: Exclude<DisplayOverride, 'inherit'>; createdBy?: RunAuthor; replyMode?: ReplyMode;
  /** Trust mode of this conversation (memory review; see `MemorySettings.trustJiminy`); absent: the agent's setting. */
  trustJiminy?: Exclude<DisplayOverride, 'inherit'>;
  /** Letta conversations this thread used before a rewind replaced them (archived, kept for audit), oldest first. */
  previousConversations?: string[] };
/** Metadata of an image sent with a run. The bytes live only in Letta history, never in runtime state. */
export type RunImage = { mediaType: string; bytes: number; sha256: string };
/**
 * Who wrote a turn, in a shared (team) runtime. `id` is the stable user ID;
 * `name` the display name at the time; `login` the identity provider login.
 */
export type RunAuthor = { id: string; login: string; name: string; avatar?: string;
  /** Their role in the agent when they sent the turn (team servers): memory provenance records it, and only an admin's turn may change protected memory. */
  role?: 'admin' | 'member' };
/**
 * What started a turn that no person typed: an automation (a workflow in n8n
 * or Conductor, a script) through the automation API, or a task the agent
 * scheduled itself. `via` is what the browser app shows ("via n8n"); `name`
 * the automation's (token's) name. Never a secret.
 */
export type RunSource = { kind: 'automation' | 'schedule'; via: 'n8n' | 'conductor' | 'api'; tokenId: string; name: string };
/**
 * A turn that brings a decision's outcome to the agent (see `DecisionBoard`):
 * which decision, what was decided and by whom. Shown in the app as a compact
 * "Decided by …" line instead of a message bubble.
 */
export type RunDecision = { id: string; outcome: 'decided' | 'stopped'; question: string; by: { id: string; name: string }; choice?: { id: string; label: string }; comment?: string;
  /** `web-research`: a web search result reviewed later (`choice.id` is `approve`, `reject` or `search_again`; `age`: how old the result was then). */
  kind?: 'web-research'; age?: string };
/**
 * A turn an MCP App's view sent (`ui/message`), after the person allowed it:
 * which app, from which tool call's view, and who allowed it. The text is
 * the app's (untrusted content); the app shows it with an "App" badge.
 */
export type RunApp = { id: string; name: string; toolCallId: string; approvedBy: { id: string; name: string } };
/** What the browser may know about an app's turn. */
export const publicRunApp = (app: RunApp) => ({ id: app.id, name: app.name, toolCallId: app.toolCallId, approvedBy: { ...app.approvedBy } });
/** How an automation's turn runs: unattended (nobody is asked), with the tools pre-approved for it and the reply mode it asks for. */
export type RunAutomation = { source: RunSource; preApproved: readonly string[]; onBehalfOf?: string; replyMode?: ReplyMode;
  /** The starting verdict of the turn's untrusted memory writes (the token's setting; schedules: the default). */
  memoryFloor?: 'accept' | 'flag' | 'ask_human' };
/**
 * A single user turn and the events observed while it ran. In a shared runtime
 * a run may first wait in its conversation's queue (`queued`); `author` names
 * who wrote it.
 */
export type Run = { id: string; threadId: string; input: string; images?: RunImage[]; files?: RunFile[]; uploads?: string[]; parentRunId: string | null; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; events: RuntimeEvent[]; startedAt?: string; queuedAt?: string; author?: RunAuthor; notSent?: boolean;
  /** Shared runtimes: the reply mode the turn was sent with. */
  replyMode?: ReplyMode;
  /** The agent listened to this turn without replying. */
  listened?: boolean;
  /** Queued messages delivered together as one turn: on the first (which carries the turn's events), every message's run ID in order. */
  batch?: string[];
  /** On the other messages of such a turn: the first message's run ID. */
  batchOf?: string;
  /** Started by an automation (see {@link RunSource}); such turns are unattended. */
  source?: RunSource;
  /** Unattended turns: tools whose approvals are given in advance, and by whom. */
  unattended?: { preApproved: string[]; onBehalfOf?: string; memoryFloor?: 'accept' | 'flag' | 'ask_human' };
  /** The reply mode an automation asked for (instead of the conversation's). */
  replyModeOverride?: ReplyMode;
  /** When the turn ended (completed, failed, cancelled or withdrawn). */
  endedAt?: string;
  /** An unattended turn needed a person: the first refused call (`approval_required` or `question_required`) and its tool. The turn itself ended normally. */
  refused?: { code: string; tool: string };
  /** The turn brings a decision's outcome to the agent. */
  decision?: RunDecision;
  /** An MCP App's view sent this message (see {@link RunApp}). */
  app?: RunApp;
  /** Sent with its run ID as the message's OTID, and its resources and memory changes recorded under it: a rewind can undo it. */
  tagged?: boolean;
  /** Removed from the conversation by this rewind (kept here for audit; no longer part of the conversation). */
  rewound?: string };
/** Metadata of a file sent with a run (as stored in the conversation's folder). */
export type RunFile = Pick<StoredFile, 'name' | 'kind' | 'mediaType' | 'label' | 'bytes' | 'sha256' | 'pages' | 'lines'>;
/**
 * Input of `POST /v1/runs`. `images` carry base64 data (no data: prefix) and
 * are validated against `IMAGE_LIMITS`. `files` are upload IDs returned by
 * `POST /v1/uploads` (at most `FILE_LIMITS.maxFilesPerMessage`).
 */
export type RunInput = { id: string; threadId: string; text: string; parentRunId: string | null; images?: { mediaType: string; data: string; name?: string }[]; files?: string[] };
/**
 * Options of a shared (team) runtime. Without them the runtime is the
 * single-owner, one-turn-at-a-time service it always was.
 *
 * - `queue`: a turn sent while another of the same conversation runs waits in
 *   that conversation's queue (visible to everyone) instead of being refused;
 *   `parentRunId` is not required then. Up to {@link MAX_QUEUED} per conversation.
 * - `parallel`: conversations run turns at the same time, each in its own
 *   session (needs a host whose `parallel` is true).
 */
export type RuntimeOptions = { deadlineMs?: number; humanWaitMs?: number; queue?: boolean; parallel?: boolean;
  /**
   * Shared runtimes whose sessions can listen (the agent was opened with
   * `listening`): the agent's reply mode setting (`'auto'` by default:
   * always when the agent has one member, agent decides when it has
   * several, from the first message). Each conversation can override it
   * (`PATCH { replyMode }`). With several members, queued messages of a
   * conversation are delivered together as one turn.
   */
  replyMode?: ReplyModeSetting;
  /** How many people share the agent now (its members); read on every turn. @default () => 1 */
  members?: () => number;
  /** The agent's name, to recognise mentions (`@Name` or its name), which always get a reply. */
  agentName?: string;
  /** How long a typing signal lasts without a new one. @default 5000 */
  typingMs?: number;
  /**
   * Application tools that change nothing outside the app (or only the
   * agent's resources, which a rewind reverts): a rewind's confirmation does
   * not list their calls as side effects that stay. Built-in tools are
   * known already (file, decision, web search, Atlassian reads).
   */
  rewindInternalTools?: readonly string[] };
/** Most queued messages delivered together as one turn (every message a conversation's queue can hold). */
export const MAX_BATCH = 10;
/** Most turns waiting in one conversation's queue. */
export const MAX_QUEUED = 10;
/**
 * A rewind in progress or done (see {@link ThreadRuntime.rewind}): written
 * before each step, so a restart finishes it (or leaves the thread as it was
 * when nothing had changed yet). `stage`: `started` (nothing changed),
 * `forked` (the new conversation exists: `fork`), `switched` (the thread
 * uses it; the old one's later turns are gone), `done`, or `failed`.
 */
export type RewindIntent = { id: string; threadId: string; runId: string; text: string; newRunId: string; from: string; fork?: string; forkAt?: string | null; turns: string[]; since?: string;
  stage: 'started' | 'forked' | 'switched' | 'done' | 'failed'; createdAt: string; endedAt?: string; error?: string; author?: RunAuthor;
  result?: { resources?: { reverted: number; conflicts: number; commit?: string }; memory?: { reverted: number; conflicts: number; commit?: string }; decisions: string[]; schedules: string[]; archived: boolean } };
type State = { version: 1; threads: Thread[]; runs: Run[]; rewinds?: RewindIntent[] };
/**
 * Work outside the runtime that a rewind withdraws: tasks the rewound turns
 * scheduled (the server's automation service sets this when it schedules).
 */
export interface RewindHooks {
  schedules(runIds: ReadonlySet<string>): { id: string; at: string; prompt: string; state: 'pending' | 'fired' }[];
  cancelSchedules(runIds: ReadonlySet<string>): Promise<string[]>;
}
/** A memory review as the app shows it. */
export type PublicMemoryReview = Pick<MemoryReview, 'id' | 'kind' | 'files' | 'status' | 'verdict' | 'floor' | 'rule' | 'outcome' | 'decision' | 'mergedAt' | 'createdAt' | 'settledAt' | 'error' | 'beforeMerge' | 'dropped' | 'claims'> & {
  provenance: string; threadId?: string; diff?: string;
  jiminy?: { trust: number; verdict: string; reason: string; model?: string; ms?: number };
  /** Dreams merged before review: how long the change was in memory before the review settled (ms). */
  exposureMs?: number;
};
function publicReview(review: MemoryReview, runtime: ThreadRuntime): PublicMemoryReview {
  const threadId = review.conversationId ? runtime.threadOfConversationAny(review.conversationId) : undefined;
  const exposure = review.kind === 'dream' && !review.beforeMerge && review.mergedAt && review.settledAt ? Math.max(0, Date.parse(review.settledAt) - Date.parse(review.mergedAt)) : undefined;
  return { id: review.id, kind: review.kind, files: structuredClone(review.files), status: review.status, provenance: provenanceLabel(review.provenance), createdAt: review.createdAt,
    ...(review.verdict ? { verdict: review.verdict } : {}), ...(review.floor ? { floor: review.floor } : {}), ...(review.rule ? { rule: review.rule } : {}), ...(review.outcome ? { outcome: review.outcome } : {}), ...(review.decision ? { decision: review.decision } : {}),
    ...(review.mergedAt ? { mergedAt: review.mergedAt } : {}), ...(review.settledAt ? { settledAt: review.settledAt } : {}), ...(review.error ? { error: review.error } : {}), ...(review.beforeMerge ? { beforeMerge: structuredClone(review.beforeMerge) } : {}),
    ...(threadId ? { threadId } : {}), ...(review.diff ? { diff: review.diff } : {}), ...(review.dropped?.length ? { dropped: structuredClone(review.dropped) } : {}), ...(review.claims?.length ? { claims: structuredClone(review.claims) } : {}),
    ...(review.jiminy ? { jiminy: { trust: review.jiminy.trust, verdict: review.jiminy.verdict, reason: review.jiminy.reason, ...(review.jiminy.model ? { model: review.jiminy.model } : {}), ...(review.jiminy.ms ? { ms: review.jiminy.ms } : {}) } } : {}),
    ...(exposure !== undefined ? { exposureMs: exposure } : {}) };
}
/** The provenance line and review outcome of a memory commit, for the rewind confirmation. */
function memoryChip(rewind: ConversationRewind, commit: string): { provenance?: string; review?: string } {
  const entry = rewind.memory.entryOf(commit);
  const review = rewind.guard?.reviewsOf(new Set([commit]))[0];
  const provenance = entry?.provenance ? provenanceLabel(entry.provenance) : review ? provenanceLabel(review.provenance) : undefined;
  return { ...(provenance ? { provenance } : {}), ...(review?.verdict ? { review: `${review.verdict}${review.jiminy ? ` · trust ${review.jiminy.trust.toFixed(2)}` : ''}` } : {}) };
}
/** One conversation's session and its single running turn (one lane per runtime unless parallel). */
type Lane = { key: string; locked: boolean; usedAt?: number; current?: RuntimeSession; active?: { run: Run; control: AbortController }; pending?: { runId: string; request: InteractionRequest; resolve(value: InteractionResponse): void }; draining?: boolean };
/** An opened agent conversation as seen by the runtime. */
export interface RuntimeSession {
  agentId: string;
  conversationId: string;
  history: UIMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: Pick<LettaAgent<any>, 'stream' | 'interactions' | 'transcript'> & { attachments?: AttachmentStore; listening?: boolean };
  /** Reload display history from the backend without reopening (parallel hosts). */
  reload?(): Promise<UIMessage[]>;
  /** Close only this conversation's session (parallel hosts). */
  close?(): Promise<void>;
  /** Rewind support (fork, history records, memory journal); without it, rewinds are refused with `rewind_unavailable`. */
  rewind?: ConversationRewind;
  /** The agent's memory guard (provenance, reviews), when the host has one. */
  memory?: MemoryGuard;
  /** Run a Letta harness command (`reflect`) in this conversation, when the host supports it. */
  harnessCommand?(command: 'reflect', args?: string): Promise<string>;
}
/** Opens and closes the single agent session the runtime drives. */
export interface RuntimeHost {
  /**
   * Open a conversation. A single-session host closes the previous one first;
   * a `parallel` host keeps several open (each with its own `close`).
   */
  open(options: { conversationId: string } | { newTitle: string }): Promise<RuntimeSession>;
  /** Close every session (and, for a parallel host, release the agent). */
  close(): Promise<void>;
  /** Sessions of different conversations may be open and run turns at the same time. */
  parallel?: boolean;
  /**
   * Root of the agents' resources (`<stateDir>/resources`), when the agent
   * accepts files (its definition includes the file tools). Without it,
   * uploads, file lists and the resources API are refused with `files_unavailable`.
   */
  attachmentsRoot?: string;
  /**
   * Prepare the resources before any conversation is opened: create them and
   * migrate files of earlier versions (`titles` names the folders, by conversation ID).
   */
  resources?(agentId: string, titles: Record<string, string>): Promise<ResourceStore>;
  /**
   * Read a conversation's display history without opening a session (nothing
   * is sent or configured). When present, viewing a conversation that is not
   * running uses it (adopted agents: their conversations are only read until
   * someone sends a message).
   */
  peek?(conversationId: string): Promise<UIMessage[]>;
}
/** Titles of conversations whose real title was not known yet. */
const FALLBACK_TITLES = new Set(['Untitled conversation', 'Default conversation']);
/** A Letta conversation to list as a thread without opening it (see {@link ThreadRuntime.importConversations}). */
export type ImportedConversation = { conversationId: string; title: string; createdAt?: string; lastActivityAt?: string };
/** A client-visible failure with a fixed code and HTTP status. */
export class RuntimeFault extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Only app-defined, fixed failure codes (e.g. user_denied) are surfaced; never free-form error text. */
/** Time a self-expiring prompt (see `InteractionRequest.expiresAt`) is given beyond its expiry, for the tool to withdraw it. */
const EXPIRY_MARGIN_MS = 15_000;
const failureReasons = new Set(['review_expired', 'approval_required', 'question_required', 'unattended_stopped', 'user_denied', 'approval_cancelled', 'tool_denied', 'tool_cancelled', 'tool_timeout', 'tool_failed', 'invalid_arguments', 'interaction_unavailable', 'permission_denied', 'duplicate_or_limit', 'tool_output_limit']);
/** HTTP status for a refused file. */
const fileStatus = (code: string) => code === 'file_too_large' ? 413 : code === 'file_not_found' ? 404 : ['conversation_files_full', 'files_too_many', 'file_exists', 'resources_full'].includes(code) ? 409 : code === 'resources_busy' ? 503 : 400;
/** A FileInputError as a fixed-code RuntimeFault; anything else unchanged. */
export const fileFault = (error: unknown) => error instanceof FileInputError ? new RuntimeFault(error.code, fileStatus(error.code)) : error;
/** Public metadata of a stored file (what list and upload return). */
export const fileSummary = (file: StoredFile | StagedFile) => ({ ...('id' in file ? { id: file.id } : {}), name: file.name, kind: file.kind, mediaType: file.mediaType, label: file.label, bytes: file.bytes,
  ...(file.pages !== undefined ? { pages: file.pages } : {}), ...(file.lines !== undefined ? { lines: file.lines } : {}), createdAt: file.createdAt });
export function toolFailureReason(error: unknown): { reason?: string } {
  let value = error;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  const reason = value && typeof value === 'object' && !Array.isArray(value) ? (value as { error?: unknown }).error : undefined;
  return typeof reason === 'string' && failureReasons.has(reason) ? { reason } : {};
}

/** Transport observations for reconnects/failed-turn inspection only, never agent input. */
export function displayRun(run: Run): UIMessage[] {
  const parts: UIMessage['parts'] = [];
  for (const event of run.events) {
    const data = event.data;
    if (event.type === 'text') {
      const last = parts.at(-1);
      if (last?.type === 'text') last.text += String(data.text);
      else parts.push({ type: 'text', text: String(data.text) });
    } else if (event.type === 'reasoning') {
      const last = parts.at(-1);
      if (last?.type === 'reasoning') last.text += String(data.text);
      else parts.push({ type: 'reasoning', text: String(data.text) });
    } else if (event.type === 'listened') parts.push({ type: LISTENED_PART as `data-${string}`, data: typeof data.reason === 'string' ? { reason: data.reason } : {} });
    else if (event.type === 'tool_started') parts.push({ type: 'dynamic-tool', toolName: String(data.name), toolCallId: String(data.toolCallId), state: 'input-available', input: data.input });
    else if (event.type === 'tool_completed' || event.type === 'tool_failed') {
      const index = parts.findIndex(p => p.type === 'dynamic-tool' && p.toolCallId === data.toolCallId);
      const part = parts[index];
      if (part?.type === 'dynamic-tool' && part.state === 'input-available') parts[index] = event.type === 'tool_completed'
        ? { ...part, state: 'output-available', output: data.output }
        : { ...part, state: 'output-error', errorText: typeof data.reason === 'string' ? JSON.stringify({ error: data.reason }) : String(data.code) };
    }
  }
  if (run.status !== 'completed' && run.status !== 'running') for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === 'dynamic-tool' && part.state === 'input-available') parts[i] = { ...part, state: 'output-error', errorText: `Turn ${run.status}; execution not confirmed.` };
  }
  const metadata = run.startedAt || run.author || run.source || run.decision || run.app ? { metadata: { ...(run.startedAt ? { createdAt: run.startedAt } : {}), ...(run.author ? { author: run.author } : {}), ...(run.source ? { source: publicSource(run.source) } : {}), ...(run.decision ? { decision: publicDecisionRun(run.decision) } : {}), ...(run.app ? { app: publicRunApp(run.app) } : {}) } } : {};
  // Runtime state never stores image bytes; failed/reconnecting runs show a placeholder.
  // Files are shown by the same "Attached: ..." note the agent received.
  const note = run.files?.length ? attachmentNote(run.files) : '';
  const text = note ? `${run.input.trimEnd()}${run.input.trim() ? '\n\n' : ''}${note}` : run.input;
  const user: UIMessage['parts'] = [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...(run.images ?? []).map(() => ({ type: 'text' as const, text: IMAGE_PLACEHOLDER }))];
  return [{ id: `${run.id}-user`, role: 'user', parts: user, ...metadata }, { id: `${run.id}-assistant`, role: 'assistant', parts }];
}

/** Run fields of an automation's turn. */
const automationFields = (automation?: RunAutomation): Partial<Run> => automation ? { source: { ...automation.source }, unattended: { preApproved: [...automation.preApproved], ...(automation.onBehalfOf ? { onBehalfOf: automation.onBehalfOf } : {}), ...(automation.memoryFloor ? { memoryFloor: automation.memoryFloor } : {}) }, ...(automation.replyMode ? { replyModeOverride: automation.replyMode } : {}) } : {};
/** What the browser may know about a decision's outcome turn (no user IDs beyond the decider's). */
export const publicDecisionRun = (decision: RunDecision) => ({ id: decision.id, outcome: decision.outcome, question: decision.question, by: { ...decision.by }, ...(decision.choice ? { choice: { ...decision.choice } } : {}), ...(decision.comment ? { comment: decision.comment } : {}), ...(decision.kind ? { kind: decision.kind } : {}), ...(decision.age ? { age: decision.age } : {}) });
/** What the browser may know about a run's source (no token ID). */
export const publicSource = (source: RunSource) => ({ kind: source.kind, via: source.via, name: source.name });
const sameImages = (a: RunImage[] = [], b: RunImage[] = []) => a.length === b.length && a.every((image, index) => image.sha256 === b[index]!.sha256);
const sameUploads = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Thread service over one agent.
 *
 * By default single-owner and single-turn: one session, one turn at a time.
 * With {@link RuntimeOptions} it serves a shared agent: conversations run in
 * parallel (each in its own session) and turns of one conversation wait in a
 * visible queue.
 *
 * Runs are recorded durably before delivery; a run that was in flight when the
 * process stopped is marked `interrupted` and blocks further turns on that
 * thread (uncertain delivery is never replayed). Human answers are validated
 * and accepted exactly once.
 */
export class ThreadRuntime {
  private state: State;
  private lanes = new Map<string, Lane>();
  private listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  /** Validated uploads waiting to be sent, next to this runtime's state (`<dir>/uploads/.staging`). */
  readonly uploads?: UploadStaging;
  private readonly deadlineMs: number;
  private readonly humanWaitMs: number;
  /** Turns of one conversation queue instead of being refused (shared runtimes). */
  readonly queueing: boolean;
  /** Conversations run turns at the same time, each in its own session. */
  readonly parallel: boolean;
  private changes = 0;
  private waiting = new Set<() => void>();
  /** The agent's reply mode setting, when its sessions can listen (shared runtimes). */
  readonly replyMode?: ReplyModeSetting;
  private readonly agentName?: string;
  private readonly typingMs: number;
  private readonly rewindInternal: ReadonlySet<string>;
  private readonly members: () => number;
  /** The agent's decisions, when the server keeps them (set by `DecisionBoard`). */
  decisions?: DecisionBoard;
  /**
   * Web app development (set by the server for agents with `webDevTools`):
   * each conversation's services, and its preview's origin.
   */
  webDev?: { registry: WebDevRegistry; previewUrl(threadId: string): string | undefined };
  /** Tasks the agent scheduled, when the server schedules them (set by the automation service). */
  rewindHooks?: RewindHooks;
  /**
   * The agent's memory guard (provenance and reviews of memory changes),
   * once a conversation is open. Set by the server's host.
   */
  memory?: MemoryGuard;
  /**
   * MCP Apps (set by the server's app gate): extra context for a thread's
   * next turn (what views set with `ui/update-model-context`, consumed once).
   */
  turnContext?: (threadId: string) => { reminder?: string; sources?: ContentSource[] };
  /** MCP Apps' gate (set by the server for agents with `mcpApps`). */
  apps?: import('./mcp-apps.js').AppGate;
  /** The reviewer's model setting, when the app may change it (see {@link setReviewerModel}). */
  reviewerModel?: { value(): string; set(model: string): void; available(): Promise<string[]> };
  constructor(host: RuntimeHost, filename: string, owner: string, deadlineMs?: number, humanWaitMs?: number);
  constructor(host: RuntimeHost, filename: string, owner: string, options: RuntimeOptions);
  constructor(private readonly host: RuntimeHost, private readonly filename: string, private readonly owner: string, deadlineOrOptions?: number | RuntimeOptions, humanWaitMs?: number) {
    const options: RuntimeOptions = typeof deadlineOrOptions === 'object' ? deadlineOrOptions : { deadlineMs: deadlineOrOptions, humanWaitMs };
    this.deadlineMs = options.deadlineMs ?? 180_000;
    this.humanWaitMs = options.humanWaitMs ?? 4 * 60_000;
    this.queueing = !!options.queue;
    this.parallel = !!options.parallel;
    if (this.parallel && !host.parallel) throw new Error('A parallel runtime needs a parallel host');
    if (options.replyMode !== undefined) {
      if (!this.queueing) throw new Error('Reply modes need a shared runtime (queue: true)');
      this.replyMode = options.replyMode;
    }
    this.agentName = options.agentName;
    this.members = options.members ?? (() => 1);
    this.typingMs = options.typingMs ?? 5000;
    this.rewindInternal = new Set(options.rewindInternalTools ?? []);
    if (host.attachmentsRoot) this.uploads = new UploadStaging(join(dirname(filename), 'uploads'));
    this.state = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) as State : { version: 1, threads: [], runs: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.threads) || !Array.isArray(this.state.runs)) throw new Error('Invalid runtime state');
    for (const thread of this.state.threads) thread.archived ??= false;
    for (const run of this.state.runs) if (run.status === 'running') {
      run.status = 'interrupted';
      run.events.push({ sequence: (run.events.at(-1)?.sequence ?? 0) + 1, type: 'failed', data: { code: 'delivery_uncertain' } });
    } else if (run.status === 'queued') {
      // Never sent: a queued turn does not survive a restart, and nothing was delivered.
      run.status = 'cancelled'; run.notSent = true;
      run.events.push({ sequence: (run.events.at(-1)?.sequence ?? 0) + 1, type: 'failed', data: { code: 'not_sent' } });
    }
    this.save();
  }
  private saveTimer?: ReturnType<typeof setTimeout>;
  private save() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    // A leftover temporary file is an uncertain write, not permission to overwrite it.
    const fd = openSync(`${this.filename}.tmp`, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${this.filename}.tmp`, this.filename);
    const directory = openSync(dirname(this.filename), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  /** Streamed text is display-only: batch its writes (every other event, and the end of a run, writes at once). */
  private saveSoon() { this.saveTimer ??= setTimeout(() => { this.saveTimer = undefined; try { this.save(); } catch { /* the next event retries */ } }, 250); }
  /** Something visible changed (a thread or a run): wake {@link waitForChange}. */
  private changed() {
    this.changes++;
    const waiting = [...this.waiting]; this.waiting.clear();
    for (const wake of waiting) wake();
    for (const observer of this.observers) { try { observer(); } catch { /* observer */ } }
  }
  private observers = new Set<() => void>();
  /** Call `observer` after every visible change (see {@link version}). Returns an unsubscribe function. */
  observe(observer: () => void): () => void { this.observers.add(observer); return () => this.observers.delete(observer); }
  /**
   * A counter that increases whenever threads or runs change (created, renamed,
   * archived, a run queued, started or ended). Pass the last value back to
   * {@link waitForChange} to wait for the next change.
   */
  get version(): number { return this.changes; }
  /** Resolves with the new {@link version} once it differs from `since`, or after `timeoutMs`. */
  waitForChange(since: number, timeoutMs = 25_000, signal?: AbortSignal): Promise<number> {
    if (since !== this.changes || signal?.aborted) return Promise.resolve(this.changes);
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiting.delete(done); signal?.removeEventListener('abort', done); resolve(this.changes); };
      const timer = setTimeout(done, timeoutMs);
      this.waiting.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  private authorize(owner: string) { if (owner !== this.owner) throw new RuntimeFault('forbidden', 403); }
  private thread(owner: string, id: string) {
    this.authorize(owner);
    const thread = this.state.threads.find(t => t.id === id && t.owner === owner);
    if (!thread) throw new RuntimeFault('not_found', 404);
    if (thread.state !== 'ready') throw new RuntimeFault('creation_uncertain');
    return thread;
  }
  private run(owner: string, id: string) {
    this.authorize(owner);
    const run = this.state.runs.find(r => r.id === id);
    if (!run) throw new RuntimeFault('not_found', 404);
    this.thread(owner, run.threadId);
    return run;
  }
  /** The lane of a thread: its own in a parallel runtime, the single shared one otherwise. */
  private lane(threadId: string): Lane {
    const key = this.parallel ? threadId : '';
    let lane = this.lanes.get(key);
    if (!lane) { lane = { key, locked: false }; this.lanes.set(key, lane); }
    return lane;
  }
  private laneOfRun(runId: string) { return [...this.lanes.values()].find(lane => lane.active?.run.id === runId); }
  private async exclusive<T>(lane: Lane, fn: () => Promise<T>) {
    if (lane.locked || lane.active) throw new RuntimeFault('runtime_busy');
    lane.locked = true;
    try { return await fn(); } finally { lane.locked = false; }
  }
  private async open(lane: Lane, thread: Thread) {
    if (lane.current && lane.current.conversationId === thread.conversationId) return lane.current;
    await this.closeLane(lane);
    const session = await this.host.open(thread.conversationId ? { conversationId: thread.conversationId } : { newTitle: thread.title });
    const identity = this.state.threads.find(t => t.agentId)?.agentId;
    if (identity && session.agentId !== identity) { await (session.close?.() ?? this.host.close()); throw new RuntimeFault('identity_mismatch'); }
    lane.current = session;
    if (session.memory) this.memory = session.memory;
    return session;
  }
  private async closeLane(lane: Lane) {
    const current = lane.current; lane.current = undefined;
    if (this.parallel) await current?.close?.();
    else await this.host.close();
  }
  /** Display metadata only; timestamps are omitted for legacy threads that never recorded them. */
  private summary(thread: Thread) {
    const { id, title, state, archived, createdAt, lastActivityAt, latex, trustJiminy } = thread;
    const pendingDecision = this.decisions?.pending().find(d => d.threadId === id)?.id;
    const base = { id, title, state, archived, ...(createdAt ? { createdAt } : {}), ...(lastActivityAt ? { lastActivityAt } : {}), latex: latex ?? 'inherit' as DisplayOverride, ...(trustJiminy ? { trustJiminy } : {}), ...(pendingDecision ? { pendingDecision } : {}) };
    if (!this.queueing) return base;
    // Reply modes: the conversation's override, the mode in effect now, and how many people share the agent.
    const modes = this.replyMode !== undefined ? { replyMode: (thread.replyMode ?? 'inherit') as ReplyModeOverride, replyModeInEffect: this.modeOf(thread), members: this.memberCount() } : {};
    // Shared runtimes also show who started a conversation and whether a turn is running or waiting.
    const runs = this.state.runs.filter(r => r.threadId === id);
    const running = runs.find(r => r.status === 'running');
    const queued = runs.filter(r => r.status === 'queued').length;
    const typing = this.typingIn(id);
    return { ...base, ...modes, ...(typing.length ? { typing: typing.map(({ id: userId, name }) => ({ id: userId, name })) } : {}), ...(thread.createdBy ? { createdBy: thread.createdBy } : {}), ...(running ? { running: running.id } : {}), ...(queued ? { queued } : {}) };
  }
  /** People who share the agent now (at least one). */
  private memberCount(): number {
    try { const count = this.members(); return Number.isSafeInteger(count) && count > 0 ? count : 1; } catch { return 1; }
  }
  /** The reply mode in effect in a conversation now (see `resolveReplyMode`). */
  private modeOf(thread: Thread): ReplyMode {
    return resolveReplyMode(this.replyMode, thread.replyMode, this.memberCount());
  }
  /** The agent's members changed: listed reply modes may have changed too (wakes `waitForChange`). */
  membersChanged() { this.changed(); }
  /** A decision changed (requested, decided, cancelled): open pages refresh (wakes `waitForChange`). */
  decisionsChanged() { this.changed(); }
  /** The turn running in a conversation now, if any (a copy). */
  activeRun(threadId: string): Run | undefined {
    const run = this.lane(threadId).active?.run;
    return run && run.threadId === threadId ? structuredClone(run) : undefined;
  }
  /** Letta agents this runtime's threads use. */
  agentIds(): string[] { return [...new Set(this.state.threads.map(t => t.agentId).filter((id): id is string => !!id))]; }
  /** Whether a turn runs or waits, or a session is being opened (an adopted agent is not removed meanwhile). */
  get busy(): boolean { return [...this.lanes.values()].some(lane => lane.locked || !!lane.active) || this.state.runs.some(r => r.status === 'running' || r.status === 'queued'); }
  list(owner: string) {
    this.authorize(owner);
    return this.state.threads.filter(t => t.owner === owner).map(t => this.summary(t));
  }

  /* ---------------- typing presence (shared runtimes) ---------------- */

  /** Who is typing where: thread ID → user ID → (person, expiry). In memory only; never stored, never sent to the agent. */
  private typists = new Map<string, Map<string, { author: RunAuthor; until: number }>>();
  private typingTimer?: ReturnType<typeof setTimeout>;
  /**
   * Someone is typing in a conversation (`typing: true`, repeated as a
   * heartbeat while they type) or stopped (`false`). Only presence is shared,
   * never what they type: the input is exactly `{ typing: boolean }`. A
   * signal lasts {@link RuntimeOptions.typingMs} unless repeated; sending a
   * message ends it.
   */
  typing(owner: string, threadId: string, author: RunAuthor | undefined, input: unknown) {
    const thread = this.thread(owner, threadId);
    if (!this.queueing || !author) throw new RuntimeFault('not_found', 404);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof (input as { typing?: unknown }).typing !== 'boolean') throw new RuntimeFault('invalid_input', 400);
    if ((input as { typing: boolean }).typing && !thread.archived) {
      const people = this.typists.get(threadId) ?? new Map();
      const fresh = !people.has(author.id);
      people.set(author.id, { author, until: Date.now() + this.typingMs });
      this.typists.set(threadId, people);
      if (fresh) this.changed();
      this.scheduleTypingSweep();
    } else this.stopTyping(threadId, author.id);
    return { typing: this.typingIn(threadId) };
  }
  /** People typing in a conversation now, in the order they started. */
  typingIn(threadId: string): RunAuthor[] {
    const now = Date.now();
    return [...(this.typists.get(threadId)?.values() ?? [])].filter(entry => entry.until > now).map(entry => entry.author);
  }
  private stopTyping(threadId: string, userId: string) {
    const people = this.typists.get(threadId);
    if (people?.delete(userId)) { if (!people.size) this.typists.delete(threadId); this.changed(); }
  }
  /** Forget expired signals (and tell everyone) shortly after they expire. */
  private scheduleTypingSweep() {
    if (this.typingTimer) return;
    const next = Math.min(...[...this.typists.values()].flatMap(people => [...people.values()].map(entry => entry.until)));
    if (!Number.isFinite(next)) return;
    this.typingTimer = setTimeout(() => {
      this.typingTimer = undefined;
      const now = Date.now();
      let removed = false;
      for (const [threadId, people] of this.typists) {
        for (const [userId, entry] of people) if (entry.until <= now) { people.delete(userId); removed = true; }
        if (!people.size) this.typists.delete(threadId);
      }
      if (removed) this.changed();
      this.scheduleTypingSweep();
    }, Math.max(10, next - Date.now() + 10));
    this.typingTimer.unref?.();
  }
  /**
   * Local display metadata only: never opens a session or edits backend history.
   * Fields: `title` (1–120 characters), `archived` (boolean), and `latex`
   * (`'inherit' | 'on' | 'off'`: whether the browser app renders LaTeX in this
   * conversation; `'inherit'` follows the agent's `ui.latex`).
   */
  updateMetadata(owner: string, id: string, input: unknown) {
    const thread = this.thread(owner, id);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeFault('invalid_input', 400);
    const fields = Object.keys(input);
    if (!fields.length || fields.some(key => key !== 'title' && key !== 'archived' && key !== 'latex' && key !== 'replyMode' && key !== 'trustJiminy')) throw new RuntimeFault('invalid_input', 400);
    const patch = input as { title?: unknown; archived?: unknown; latex?: unknown; replyMode?: unknown; trustJiminy?: unknown };
    if (fields.includes('trustJiminy') && !DISPLAY_OVERRIDES.includes(patch.trustJiminy as DisplayOverride)) throw new RuntimeFault('invalid_input', 400);
    if (fields.includes('latex') && !DISPLAY_OVERRIDES.includes(patch.latex as DisplayOverride)) throw new RuntimeFault('invalid_input', 400);
    if (fields.includes('replyMode') && (this.replyMode === undefined || !REPLY_MODE_OVERRIDES.includes(patch.replyMode as ReplyModeOverride))) throw new RuntimeFault('invalid_input', 400);
    let title = thread.title;
    if (fields.includes('title')) {
      // Reject terminal controls and invisible formatting/bidi controls before trimming.
      if (typeof patch.title !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(patch.title)) throw new RuntimeFault('invalid_input', 400);
      title = patch.title.trim();
      if (!title || title.length > 120) throw new RuntimeFault('invalid_input', 400);
    }
    if (fields.includes('archived') && typeof patch.archived !== 'boolean') throw new RuntimeFault('invalid_input', 400);
    // locked covers session opening before start() has installed its active run; queued turns would run in an archived conversation.
    const lane = this.lane(id);
    if (patch.archived === true && (lane.locked || lane.active?.run.threadId === id || this.state.runs.some(r => r.threadId === id && r.status === 'queued'))) throw new RuntimeFault('runtime_busy');
    const retitled = thread.title !== title;
    thread.title = title;
    if (typeof patch.archived === 'boolean') thread.archived = patch.archived;
    // An archived conversation's pending decision can no longer be decided.
    if (patch.archived === true) this.decisions?.archived(id);
    if (patch.latex === 'inherit') delete thread.latex; else if (patch.latex === 'on' || patch.latex === 'off') thread.latex = patch.latex;
    if (patch.replyMode === 'inherit') delete thread.replyMode; else if (fields.includes('replyMode')) thread.replyMode = patch.replyMode as ReplyMode;
    if (patch.trustJiminy === 'inherit') delete thread.trustJiminy; else if (patch.trustJiminy === 'on' || patch.trustJiminy === 'off') thread.trustJiminy = patch.trustJiminy;
    this.save(); this.changed();
    // The conversation's folder follows its title (after the running turn, if any). A failure never fails the rename.
    if (retitled && this.host.attachmentsRoot && thread.agentId && thread.conversationId) {
      const conversationId = thread.conversationId;
      const store = this.resourcesOf(thread.agentId);
      // The title when the rename runs: a folder renamed in the panel meanwhile already set it (and is not renamed back).
      this.renaming = this.renaming.then(() => store.retitle(conversationId, thread.title)).then(() => {}, () => {});
    }
    return this.summary(thread);
  }
  private renaming: Promise<void> = Promise.resolve();
  /* ---------------- memory: provenance and reviews ---------------- */

  /** The memory guard, opening a session if none is open yet (the guard needs the memory directory). */
  private async guardOf(owner: string): Promise<MemoryGuard> {
    this.authorize(owner);
    if (this.memory) return this.memory;
    throw new RuntimeFault('memory_unavailable', 409);
  }
  /** Memory reviews, newest first (a view without internals beyond what people need), and the reviewer setting. */
  async memoryReviews(owner: string, limit = 50): Promise<{ reviews: PublicMemoryReview[]; refused: { path: string; code: string; tool: string; at: string; provenance?: string; threadId?: string }[]; ready: boolean; reviewer?: { model: string; available: string[] } }> {
    this.authorize(owner);
    // Before a conversation is opened the guard does not exist yet: nothing to show (not an error).
    const reviews = (this.memory?.list() ?? []).reverse().slice(0, Math.min(200, Math.max(1, limit))).map(r => publicReview(r, this));
    // Writes refused by the memory guard (protected files, new root files from untrusted turns), newest first.
    const refused = (this.memory?.refusals ?? []).slice(-20).reverse().map(r => { const run = r.turn ? this.state.runs.find(x => x.id === r.turn) : undefined; return { path: r.path, code: r.code, tool: r.tool, at: r.at, ...(r.provenance ? { provenance: r.provenance } : {}), ...(run ? { threadId: run.threadId } : {}) }; });
    return { reviews, refused, ready: !!this.memory, ...(this.reviewerModel ? { reviewer: { model: this.reviewerModel.value(), available: await this.reviewerModel.available().catch(() => []) } } : {}) };
  }
  /** Per-section provenance of a memory file (see `MemoryGuard.provenanceOf`). */
  async memoryProvenance(owner: string, path: unknown) {
    const guard = await this.guardOf(owner);
    if (typeof path !== 'string' || path.length > 300) throw new RuntimeFault('invalid_input', 400);
    try { return await guard.provenanceOf(path); }
    catch (error) { throw new RuntimeFault(error instanceof Error && error.message === 'invalid_path' ? 'invalid_input' : 'not_found', error instanceof Error && error.message === 'invalid_path' ? 400 : 404); }
  }
  /** Change the reviewer's model (`'auto'`, `'off'` is not offered here, or a connected model's handle). */
  setReviewerModel(owner: string, input: unknown) {
    this.authorize(owner);
    const model = (input as { model?: unknown } | undefined)?.model;
    if (!this.reviewerModel || typeof model !== 'string' || !(model === 'auto' || /^[\w.-]+\/[\w.:-]+$/.test(model))) throw new RuntimeFault('invalid_input', 400);
    this.reviewerModel.set(model);
    this.changed();
    return { model: this.reviewerModel.value() };
  }
  /**
   * Start a dream (reflection) of a thread's conversation now, instead of
   * waiting for the step count: for operators checking how dreams are
   * reviewed. `instruction` steers what the dream looks at. Refused while a
   * turn runs in the thread.
   */
  async dreamNow(owner: string, threadId: string, input: unknown): Promise<{ started: true; output: string }> {
    const thread = this.thread(owner, threadId);
    const instruction = (input as { instruction?: unknown } | undefined)?.instruction;
    if (instruction !== undefined && (typeof instruction !== 'string' || instruction.length > 1000)) throw new RuntimeFault('invalid_input', 400);
    const lane = this.lane(thread.id);
    return this.exclusive(lane, async () => {
      const session = await this.openIn(lane, thread);
      if (!session.harnessCommand) throw new RuntimeFault('dream_unavailable');
      const output = await session.harnessCommand('reflect', typeof instruction === 'string' && instruction.trim() ? `--instruction ${JSON.stringify(instruction.trim())}` : '');
      return { started: true as const, output: output.slice(0, 500) };
    });
  }
  /** Memory reviews changed (one started, settled or reverted something): open pages refresh. */
  memoryChanged() { this.memoryVersion++; this.changed(); }
  /** Changes the memory guard reverted or removed recently, newest last (for a toast in the app; in memory only). */
  private reverts: { id: string; at: string; files: string[]; reason?: string; held: boolean; kind: 'turn' | 'dream' }[] = [];
  /** Bumped whenever a memory review changes (the app polls `/v1/memory/reviews` only then). */
  memoryVersion = 0;
  /** A memory change was reverted (reject) or removed until approved (ask_human): the app shows a toast. */
  memoryReverted(review: MemoryReview) {
    this.reverts.push({ id: review.id, at: new Date().toISOString(), files: review.files.map(f => f.path), ...(review.jiminy?.reason ? { reason: review.jiminy.reason.slice(0, 200) } : review.rule ? { reason: review.rule } : {}), held: review.outcome === 'removed', kind: review.kind });
    if (this.reverts.length > 50) this.reverts = this.reverts.slice(-50);
    this.changed();
  }
  /** Recent reverts (for toasts): those after `since` (an ISO time). */
  memoryReverts(owner: string, since?: string) { this.authorize(owner); return this.reverts.filter(r => !since || r.at > since).map(r => ({ ...r, files: [...r.files] })); }

  /* ---------------- rewind ---------------- */

  /** A rewind of this thread is being prepared or applied (no turn may start). */
  private rewinding(threadId: string) { return (this.state.rewinds ?? []).some(r => r.threadId === threadId && (r.stage === 'started' || r.stage === 'forked' || r.stage === 'switched')) || this.rewindLocks.has(threadId); }
  private rewindLocks = new Set<string>();
  /**
   * The turns a rewind of `runId` removes, checked: the conversation is
   * idle (nothing running or queued), solo for `who` (see `soloRefusal`),
   * and every turn was recorded with its changes.
   * @throws RuntimeFault with a fixed code (see `REWIND_REFUSALS`)
   */
  private rewindSpan(thread: Thread, runId: string, who?: RunAuthor) {
    const lane = this.lane(thread.id);
    if (lane.locked || lane.active || this.state.runs.some(r => r.threadId === thread.id && (r.status === 'queued' || r.status === 'running')) || this.rewinding(thread.id)) throw new RuntimeFault('runtime_busy');
    if (thread.archived) throw new RuntimeFault('thread_archived');
    // Threads of earlier versions that use the agent's default Letta conversation are never forked or rewound.
    if (thread.conversationId === 'default') throw new RuntimeFault('rewind_legacy_conversation');
    const delivered = this.delivered(thread.id);
    let span: Run[];
    try { span = rewoundSpan(delivered, runId); } catch { throw new RuntimeFault('not_found', 404); }
    const all = this.state.runs.filter(r => r.threadId === thread.id && !r.rewound);
    const refusal = soloRefusal(all, span, who, this.queueing);
    if (refusal) throw new RuntimeFault(refusal, refusal === 'not_found' ? 404 : 409);
    return span;
  }
  /** The open session of a thread, for rewind support (opened if needed, under the lane). */
  private async rewindSession(lane: Lane, thread: Thread): Promise<RuntimeSession & { rewind: ConversationRewind }> {
    const session = await this.openIn(lane, thread);
    if (!session.rewind) throw new RuntimeFault('rewind_unavailable');
    return session as RuntimeSession & { rewind: ConversationRewind };
  }
  /**
   * What editing the message of turn `runId` and rewinding would do (see
   * {@link RewindSummary}); nothing changes. Solo conversations only: in a
   * shared runtime, `who` must have written every message.
   */
  async rewindPreview(owner: string, threadId: string, runId: string, who?: RunAuthor): Promise<RewindSummary> {
    const thread = this.thread(owner, threadId);
    const span = this.rewindSpan(thread, runId, who);
    const lane = this.lane(thread.id);
    return this.exclusive(lane, async () => {
      const session = await this.rewindSession(lane, thread);
      const { records } = await session.rewind.records();
      try { forkPoint(records, span[0]!.id); } catch { throw new RuntimeFault('rewind_too_old'); }
      return this.summarize(thread, span, session.rewind);
    });
  }
  private async summarize(thread: Thread, span: Run[], rewind: ConversationRewind): Promise<RewindSummary> {
    try { return await this.summarizeOnce(thread, span, rewind); }
    catch (error) { throw error instanceof Error && error.message.startsWith('rewind_unavailable') ? new RuntimeFault('rewind_unavailable') : error; }
  }
  private async summarizeOnce(thread: Thread, span: Run[], rewind: ConversationRewind): Promise<RewindSummary> {
    const turns = new Set(span.map(r => r.id));
    const since = span[0]!.startedAt;
    const resources = this.host.attachmentsRoot && thread.agentId && thread.conversationId ? await this.resourcesOf(thread.agentId).planRewind(thread.conversationId, turns, since).catch(error => { throw fileFault(error); }) : null;
    const memory = await rewind.memory.planRewind(turns, since);
    const decisions = this.decisions?.rewindable(thread.id, turns) ?? [];
    const schedules = this.rewindHooks?.schedules(turns) ?? [];
    const fired = schedules.filter(s => s.state === 'fired');
    const lead = span[0]!;
    return {
      message: { runId: lead.id, input: lead.input, ...((lead.images?.length ?? 0) + (lead.files?.length ?? 0) ? { attachments: (lead.images?.length ?? 0) + (lead.files?.length ?? 0) } : {}) },
      turns: span.map(rewindTurn),
      resources: resources ? { files: resources.files, kept: resources.kept } : null,
      memory: { files: memory.files, kept: memory.kept.map(c => ({ ...c, ...memoryChip(rewind, c.commit) })), commits: memory.commits.map(c => ({ ...c, ...memoryChip(rewind, c.commit) })) },
      external: [...externalEffects(span, this.rewindInternal), ...fired.map(s => ({ runId: '', tool: 'schedule_task', label: 'A scheduled task already ran', detail: s.prompt.slice(0, 160) }))],
      cancel: { decisions: decisions.map(d => ({ id: d.id, question: d.kind === 'web-research' ? (d.research?.query ?? d.question) : d.question, ...(d.kind ? { kind: d.kind } : {}) })), schedules: schedules.filter(s => s.state === 'pending') },
    };
  }
  /**
   * Edit the message of turn `runId` and rewind: the conversation continues
   * from the edited message (`text`, sent as a new turn `newRunId`), and its
   * later turns are gone. What those turns changed in the resources and the
   * agent's memory is reverted (`git revert`-style new commits; files changed
   * since by something else are kept and reported), the decisions and
   * reviews they asked for are withdrawn, and the tasks they scheduled are
   * cancelled. The Letta conversation is forked just before the edited
   * message; the old one is archived (kept for audit).
   *
   * Crash-safe: each step is recorded first ({@link RewindIntent}); a
   * restart finishes a rewind that had begun to change things. Idempotent:
   * the same `rewindId` returns the same result.
   */
  async rewind(owner: string, threadId: string, input: { rewindId: string; runId: string; text: string; newRunId: string }, who?: RunAuthor): Promise<{ rewind: RewindIntent; run?: { id: string; status: Run['status'] } }> {
    this.authorize(owner);
    if (!input || typeof input !== 'object' || ![input.rewindId, input.runId, input.newRunId].every(id => typeof id === 'string' && uuid.test(id)) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_INPUT_CHARACTERS) throw new RuntimeFault('invalid_input', 400);
    const previous = (this.state.rewinds ?? []).find(r => r.id === input.rewindId);
    if (previous) {
      if (previous.threadId !== threadId || previous.runId !== input.runId || previous.text !== input.text || previous.newRunId !== input.newRunId) throw new RuntimeFault('id_conflict');
      // Given up before anything changed: try again from the start.
      if (previous.stage === 'failed') this.state.rewinds = this.state.rewinds!.filter(r => r !== previous);
      else return this.finishRewind(owner, previous, who);
    }
    if (this.state.runs.some(r => r.id === input.newRunId)) throw new RuntimeFault('id_conflict');
    const thread = this.thread(owner, threadId);
    const span = this.rewindSpan(thread, input.runId, who);
    const lane = this.lane(thread.id);
    this.rewindLocks.add(thread.id);
    let intent: RewindIntent | undefined;
    try {
      await this.exclusive(lane, async () => {
        const session = await this.rewindSession(lane, thread);
        const { records } = await session.rewind.records();
        let point: ReturnType<typeof forkPoint>;
        try { point = forkPoint(records, span[0]!.id); } catch { throw new RuntimeFault('rewind_too_old'); }
        // Everything the rewind needs is checked before anything changes (git can plan the reverts, the files are not busy).
        await this.summarize(thread, span, session.rewind);
        intent = { id: input.rewindId, threadId: thread.id, runId: input.runId, text: input.text, newRunId: input.newRunId, from: thread.conversationId!, forkAt: point.messageId, turns: span.map(r => r.id), ...(span[0]!.startedAt ? { since: span[0]!.startedAt } : {}), stage: 'started', createdAt: new Date().toISOString(), ...(who ? { author: who } : {}) };
        (this.state.rewinds ??= []).push(intent);
        if (this.state.rewinds.length > 200) this.state.rewinds = this.state.rewinds.filter(r => r.stage !== 'done' && r.stage !== 'failed').concat(this.state.rewinds.filter(r => r.stage === 'done' || r.stage === 'failed').slice(-100));
        this.save(); this.changed();
        await this.applyRewind(lane, intent, session.rewind);
      });
    } catch (error) {
      if (intent && intent.stage === 'started') { intent.stage = 'failed'; intent.endedAt = new Date().toISOString(); intent.error = error instanceof RuntimeFault ? error.code : 'rewind_failed'; this.save(); this.changed(); }
      if (error instanceof RuntimeFault) throw error;
      throw new RuntimeFault(intent && intent.stage !== 'failed' ? 'rewind_incomplete' : 'rewind_failed', 503);
    } finally { this.rewindLocks.delete(thread.id); }
    return this.finishRewind(owner, intent!, who);
  }
  /** A retried (or just applied) rewind: finish it if a restart interrupted it, then send the edited message once. */
  private async finishRewind(owner: string, intent: RewindIntent, who?: RunAuthor): Promise<{ rewind: RewindIntent; run?: { id: string; status: Run['status'] } }> {
    if (intent.stage === 'forked' || intent.stage === 'switched') {
      const thread = this.thread(owner, intent.threadId);
      const lane = this.lane(thread.id);
      this.rewindLocks.add(thread.id);
      try { await this.exclusive(lane, async () => { const session = await this.rewindSession(lane, thread); await this.applyRewind(lane, intent, session.rewind); }); }
      catch (error) { throw error instanceof RuntimeFault ? error : new RuntimeFault('rewind_incomplete', 503); }
      finally { this.rewindLocks.delete(thread.id); }
    }
    // The edited message, as a new turn of the (new) conversation (sent once: a retry finds it).
    let run: { id: string; status: Run['status'] } | undefined;
    const existing = this.state.runs.find(r => r.id === intent.newRunId);
    if (existing) run = { id: existing.id, status: existing.status };
    else if (intent.stage === 'done') {
      try { run = await this.start(owner, { id: intent.newRunId, threadId: intent.threadId, text: intent.text, parentRunId: this.delivered(intent.threadId).at(-1)?.id ?? null }, who); }
      catch { run = undefined; }
    }
    return { rewind: structuredClone(intent), ...(run ? { run } : {}) };
  }
  /** Carry out (or finish) a rewind from its recorded stage. The lane is held by the caller. */
  private async applyRewind(lane: Lane, intent: RewindIntent, rewind: ConversationRewind) {
    const thread = this.state.threads.find(t => t.id === intent.threadId)!;
    if (intent.stage === 'started') {
      // 1. The new conversation: the history before the edited message. Its ID is recorded as soon as it exists.
      await rewind.fork(intent.forkAt ?? null, id => { intent.fork = id; intent.stage = 'forked'; this.save(); });
      if (!intent.fork) throw new RuntimeFault('rewind_fork_failed', 503);
    }
    if (intent.stage === 'forked') {
      // 2. The thread now uses it (atomically, in one write); the rewound turns leave the conversation.
      if (thread.conversationId === intent.from) {
        thread.previousConversations = [...(thread.previousConversations ?? []), intent.from];
        thread.conversationId = intent.fork!;
      }
      for (const run of this.state.runs) if (intent.turns.includes(run.id) || (run.batchOf && intent.turns.includes(run.batchOf))) run.rewound = intent.id;
      intent.stage = 'switched';
      thread.lastActivityAt = new Date().toISOString();
      this.save(); this.changed();
      // The conversation's folder follows (its attachment links too).
      if (this.host.attachmentsRoot && thread.agentId) { try { this.resourcesOf(thread.agentId).rebind(intent.from, intent.fork!); } catch { /* the folder is adopted again on first use */ } }
      await this.closeLane(lane);
    }
    if (intent.stage === 'switched') {
      const turns = new Set(intent.turns);
      const result: NonNullable<RewindIntent['result']> = intent.result ?? { decisions: [], schedules: [], archived: false };
      // 3. Undo what the turns changed (each idempotent through its X-Rewind trailer), and withdraw what they started.
      if (this.host.attachmentsRoot && thread.agentId) {
        const applied = await this.resourcesOf(thread.agentId).applyRewind(intent.id, intent.fork!, turns, intent.since);
        result.resources ??= { reverted: applied.files.filter(f => f.status === 'revert').length, conflicts: applied.files.filter(f => f.status === 'conflict').length, ...(applied.commit ? { commit: applied.commit } : {}) };
      }
      const memory = await rewind.memory.applyRewind(intent.id, turns, intent.since);
      result.memory ??= { reverted: memory.files.filter(f => f.status === 'revert').length, conflicts: memory.files.filter(f => f.status === 'conflict').length, ...(memory.commit ? { commit: memory.commit } : {}) };
      result.decisions = [...new Set([...result.decisions, ...(this.decisions?.rewound(thread.id, turns) ?? [])])];
      result.schedules = [...new Set([...result.schedules, ...(await this.rewindHooks?.cancelSchedules(turns) ?? [])])];
      // 4. The old conversation is archived (kept for audit; the default conversation cannot be).
      if (!result.archived) result.archived = await rewind.archive(intent.from).catch(() => false);
      intent.result = result;
      intent.stage = 'done'; intent.endedAt = new Date().toISOString();
      this.save(); this.changed();
    }
  }
  /**
   * Finish rewinds a restart interrupted: one that had not changed anything
   * yet (`started`) is given up; one that had forked or switched is
   * completed, so the thread always points at a conversation (the old one
   * until it switched, the new one after). Called on startup by the server.
   */
  async resumeRewinds(owner: string): Promise<void> {
    this.authorize(owner);
    for (const intent of (this.state.rewinds ?? []).filter(r => r.stage === 'started' || r.stage === 'forked' || r.stage === 'switched')) {
      if (intent.stage === 'started') { intent.stage = 'failed'; intent.error = 'interrupted'; intent.endedAt = new Date().toISOString(); this.save(); this.changed(); continue; }
      const thread = this.state.threads.find(t => t.id === intent.threadId);
      if (!thread) continue;
      const lane = this.lane(thread.id);
      try {
        await this.exclusive(lane, async () => {
          // The old conversation may hold the session (forked, not switched yet): its rewind support is the agent's either way.
          const session = await this.rewindSession(lane, thread);
          await this.applyRewind(lane, intent, session.rewind);
        });
      } catch { /* retried at the next start; the thread points at a conversation either way */ }
    }
  }
  /** Rewinds of a thread (newest 20), for the app and diagnostics. */
  rewinds(owner: string, threadId: string): RewindIntent[] {
    this.thread(owner, threadId);
    return (this.state.rewinds ?? []).filter(r => r.threadId === threadId).slice(-20).map(r => structuredClone(r));
  }
  /** Turn IDs of a thread's delivered turns a rewind may start from, for the app (your own ordinary messages; see `soloRefusal`). */
  editable(owner: string, threadId: string, who?: RunAuthor): { runIds: string[]; refusal?: string } {
    const thread = this.thread(owner, threadId);
    if (thread.conversationId === 'default') return { runIds: [], refusal: 'rewind_legacy_conversation' };
    const delivered = this.delivered(thread.id);
    const runIds: string[] = [];
    let refusal: string | undefined;
    for (const run of delivered) {
      if (run.batchOf || run.source || run.decision) continue;
      const span = rewoundSpan(delivered, run.id);
      const all = this.state.runs.filter(r => r.threadId === thread.id && !r.rewound);
      const why = soloRefusal(all, span, who, this.queueing);
      if (!why) runIds.push(run.id); else if (why === 'rewind_not_solo') refusal = why;
    }
    return { runIds, ...(refusal ? { refusal } : {}) };
  }

  /** Resolves when folder renames requested by {@link updateMetadata} are done (or deferred to the end of a turn). */
  folderRenamed(): Promise<void> { return this.renaming; }
  /** Create a thread (and its Letta conversation). In a shared runtime, `author` records who started it. */
  async create(owner: string, id: string, title: string, author?: RunAuthor) {
    this.authorize(owner);
    if (!uuid.test(id) || typeof title !== 'string' || !title.trim() || title.length > 120) throw new RuntimeFault('invalid_input', 400);
    const previous = this.state.threads.find(t => t.id === id);
    if (previous) {
      if (previous.owner !== owner || previous.title !== title) throw new RuntimeFault('id_conflict');
      this.thread(owner, id); return { id, title };
    }
    if (this.state.threads.length >= 200) throw new RuntimeFault('capacity_reached');
    const lane = this.lane(id);
    return this.exclusive(lane, async () => {
      const now = new Date().toISOString();
      const thread: Thread = { id, owner, title, archived: false, state: 'creating', createdAt: now, lastActivityAt: now, ...(author ? { createdBy: author } : {}) };
      this.state.threads.push(thread); this.save();
      const session = await this.openIn(lane, thread);
      thread.agentId = session.agentId; thread.conversationId = session.conversationId; thread.state = 'ready'; this.save(); this.changed();
      if (this.host.attachmentsRoot) { try { this.resourcesOf(session.agentId).adopt(session.conversationId, title); } catch { /* created on first use */ } }
      return { id, title };
    });
  }
  /**
   * List existing Letta conversations of the agent as threads (adopted
   * agents), without opening them. Conversations already listed (also under
   * an earlier rewind) are skipped; their activity time is refreshed.
   * @returns how many were added
   */
  importConversations(owner: string, agentId: string, conversations: readonly ImportedConversation[]): number {
    this.authorize(owner);
    const known = new Map<string, Thread>();
    for (const thread of this.state.threads) { if (thread.conversationId) known.set(thread.conversationId, thread); for (const previous of thread.previousConversations ?? []) known.set(previous, thread); }
    let added = 0; let touched = false;
    for (const row of conversations) {
      const title = row.title.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim().slice(0, 120) || 'Untitled conversation';
      const existing = known.get(row.conversationId);
      if (existing) {
        if (row.lastActivityAt && (!existing.lastActivityAt || row.lastActivityAt > existing.lastActivityAt)) { existing.lastActivityAt = row.lastActivityAt; touched = true; }
        // A fallback title gets a real one once it is known (a conversation renamed in the app keeps its name).
        if (existing.conversationId === row.conversationId && FALLBACK_TITLES.has(existing.title) && !FALLBACK_TITLES.has(title)) { existing.title = title; touched = true; }
        continue;
      }
      if (this.state.threads.length >= 200) break;
      const now = new Date().toISOString();
      const thread: Thread = { id: randomUUID(), owner, title, archived: false, state: 'ready', agentId, conversationId: row.conversationId, createdAt: row.createdAt ?? now, lastActivityAt: row.lastActivityAt ?? row.createdAt ?? now };
      this.state.threads.push(thread); known.set(row.conversationId, thread); added++;
    }
    if (added || touched) { this.save(); this.changed(); }
    return added;
  }
  /** Turns that reached (or may have reached) the agent: not waiting, not withdrawn before sending. */
  private delivered(threadId: string) { return this.state.runs.filter(r => r.threadId === threadId && r.status !== 'queued' && !r.notSent && !r.rewound); }
  /**
   * In a shared runtime, user turns in display history carry their author
   * (matched by the OTID they were sent with). A combined turn (several queued
   * messages sent as one) is shown as its messages again, each with its author.
   */
  private annotate(threadId: string, messages: UIMessage[]): UIMessage[] {
    if (!this.queueing) {
      // Single-user runtimes tag only automation turns (their OTID is the run ID), to show what started them.
      // (and the turns that brought a decision's outcome, shown as a compact line).
      const tagged = new Map(this.state.runs.filter(r => r.threadId === threadId && (r.source || r.decision || r.app)).map(r => [r.id, r]));
      if (!tagged.size) return messages;
      return messages.map(message => {
        const otid = (message.metadata as { otid?: unknown } | undefined)?.otid;
        const run = message.role === 'user' && typeof otid === 'string' ? tagged.get(otid) : undefined;
        return run ? { ...message, metadata: { ...(message.metadata as object), ...(run.source ? { source: publicSource(run.source) } : {}), ...(run.decision ? { decision: publicDecisionRun(run.decision) } : {}), ...(run.app ? { app: publicRunApp(run.app) } : {}) } } : message;
      });
    }
    const runs = new Map(this.state.runs.filter(r => r.threadId === threadId).map(r => [r.id, r]));
    return this.markListened(runs, messages.flatMap(message => {
      const otid = (message.metadata as { otid?: unknown } | undefined)?.otid;
      const run = message.role === 'user' && typeof otid === 'string' ? runs.get(otid) : undefined;
      if (!run) return [message];
      const members = run.batch?.map(id => runs.get(id)).filter((r): r is Run => !!r && r.threadId === threadId);
      if (members && members.length > 1) return members.map((member, index): UIMessage => ({ id: `${message.id}-${index}`, role: 'user', parts: [{ type: 'text', text: member.input }],
        metadata: { ...(message.metadata as object), otid: member.id, ...(member.author ? { author: member.author } : {}) } }));
      return [run.author || run.source || run.decision || run.app ? { ...message, metadata: { ...(message.metadata as object), ...(run.author ? { author: run.author } : {}), ...(run.source ? { source: publicSource(run.source) } : {}), ...(run.decision ? { decision: publicDecisionRun(run.decision) } : {}), ...(run.app ? { app: publicRunApp(run.app) } : {}) } } : message];
    }));
  }
  /**
   * A turn the runtime recorded as listened (`run.listened`) whose history has
   * no listened marker (the agent ended without a word instead of calling
   * stay_silent): its reply is marked as listened, so it reads the same as live.
   */
  private markListened(runs: Map<string, Run>, messages: UIMessage[]): UIMessage[] {
    const result: UIMessage[] = [];
    let open: { run: Run; marked: boolean; lastAssistant?: number } | undefined;
    const close = () => {
      if (!open || open.marked || !open.run.listened) return;
      const marker = { type: LISTENED_PART as `data-${string}`, data: {} };
      if (open.lastAssistant !== undefined) { const m = result[open.lastAssistant]!; result[open.lastAssistant] = { ...m, parts: [...m.parts, marker] }; }
      else result.push({ id: `${open.run.id}-listened`, role: 'assistant', parts: [marker] });
    };
    for (const message of messages) {
      if (message.role === 'user') {
        const otid = (message.metadata as { otid?: unknown } | undefined)?.otid;
        const run = typeof otid === 'string' ? runs.get(otid) : undefined;
        // The other messages of a combined turn belong to its first one.
        if (run?.batchOf && open?.run.id === run.batchOf) { result.push(message); continue; }
        close(); open = run ? { run, marked: false } : undefined;
      } else if (open) {
        if (message.parts.some(part => part.type === LISTENED_PART)) open.marked = true;
        open.lastAssistant = result.length;
      }
      result.push(message);
    }
    close();
    return result;
  }
  /** Transport observations of a conversation's delivered turns (combined turns shown as their messages, then the reply). */
  private observed(threadId: string): UIMessage[] {
    const delivered = this.delivered(threadId);
    return delivered.filter(r => !r.batchOf).flatMap(run => this.displayTurn(run, (run.batch ?? []).slice(1).map(id => delivered.find(r => r.id === id)).filter((r): r is Run => !!r)));
  }
  async history(owner: string, id: string) {
    const thread = this.thread(owner, id);
    const lane = this.lane(id);
    // Several readers may open the same idle conversation at once (people, a reloaded page, an automation): wait briefly for another reader rather than refusing.
    for (let i = 0; lane.locked && !lane.active && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100));
    // Hosts that can read history without a session (adopted agents): conversations are only read until someone sends.
    if (this.host.peek && thread.conversationId && !this.parallel && !lane.active && !(lane.current && lane.current.conversationId === thread.conversationId)) {
      const messages = await this.host.peek(thread.conversationId);
      return { messages: this.annotate(id, messages), lastRunId: this.delivered(id).at(-1)?.id ?? null };
    }
    return this.exclusive(lane, async () => {
      let session: RuntimeSession;
      const current = lane.current;
      if (this.parallel && current?.reload && current.conversationId === thread.conversationId) {
        // Shared sessions stay open: reload backend history instead of reopening.
        session = current; session.history = await current.reload();
      } else {
        // Refresh through backend history, not a display transcript replay into the agent.
        await this.closeLane(lane);
        session = await this.openIn(lane, thread);
      }
      const lastRunId = this.delivered(id).at(-1)?.id ?? null;
      return { messages: this.annotate(id, session.history.filter(m => m.id !== 'session-status')), lastRunId };
    });
  }
  /** Turns waiting in a thread's queue, oldest first (shared runtimes). */
  private queueOf(threadId: string) {
    return this.state.runs.filter(r => r.threadId === threadId && r.status === 'queued').map(r => ({ id: r.id, input: r.input, ...(r.author ? { author: r.author } : {}), ...(r.source ? { source: publicSource(r.source) } : {}), ...(r.decision ? { decision: publicDecisionRun(r.decision) } : {}), ...(this.sending.has(r.id) ? { sending: true } : {}),
      ...(r.images?.length ? { images: r.images.length } : {}), ...(r.uploads?.length ? { files: r.uploads.length } : {}), ...(r.queuedAt ? { queuedAt: r.queuedAt } : {}) }));
  }
  async view(owner: string, id: string): Promise<Awaited<ReturnType<ThreadRuntime['viewOnce']>>> {
    // A queued turn may start between the checks below and reading history: then show it live instead.
    for (let attempt = 0; ; attempt++) {
      try { return await this.viewOnce(owner, id); }
      catch (error) { if (!this.parallel || attempt >= 3 || !(error instanceof RuntimeFault) || error.code !== 'runtime_busy') throw error; }
    }
  }
  private async viewOnce(owner: string, id: string) {
    this.thread(owner, id);
    const lane = this.lane(id);
    const latest = this.delivered(id).at(-1);
    const queue = this.queueing ? { queue: this.queueOf(id) } : {};
    const active = lane.active?.run.threadId === id ? lane.active.run : undefined;
    if (active && lane.current) return {
      messages: this.annotate(id, lane.current.history.filter(m => m.id !== 'session-status')),
      lastRunId: latest?.id ?? null,
      live: { id: active.id, input: active.input, ...(active.author ? { author: active.author } : {}), ...(active.source ? { source: publicSource(active.source) } : {}), ...(active.decision ? { decision: publicDecisionRun(active.decision) } : {}), ...(active.app ? { app: publicRunApp(active.app) } : {}),
        // A combined turn: the other messages sent with it, in order.
        ...(active.batch && active.batch.length > 1 ? { batch: active.batch.slice(1).flatMap(id => { const r = this.state.runs.find(x => x.id === id); return r ? [{ id: r.id, input: r.input, ...(r.author ? { author: r.author } : {}) }] : []; }) } : {}), ...(active.startedAt && this.queueing ? { startedAt: active.startedAt } : {}), ...(active.images?.length ? { images: active.images.length } : {}), ...(active.files?.length ? { files: active.files.map(({ name, label, bytes, pages, lines, kind }) => ({ name, label, bytes, kind, ...(pages !== undefined ? { pages } : {}), ...(lines !== undefined ? { lines } : {}) })) } : {}) },
      status: 'running', ...queue,
    };
    if (latest && !['running', 'completed'].includes(latest.status)) return {
      messages: this.observed(id),
      lastRunId: latest.id, live: null, status: latest.status, source: 'transport-observations', ...queue,
    };
    return { ...await this.history(owner, id), live: null, status: latest?.status ?? null, source: 'backend-history', ...queue };
  }
  private emit(run: Run, type: string, data: Record<string, unknown>) {
    // Sequence numbers continue from the last event (compacted runs have fewer events than their last number).
    const event = { sequence: (run.events.at(-1)?.sequence ?? 0) + 1, type, data };
    run.events.push(event);
    // Streamed text is display-only; in a shared runtime its writes are batched.
    if (this.queueing && type === 'text') this.saveSoon(); else this.save();
    for (const listener of this.listeners.get(run.id) ?? []) listener(event);
    if (type !== 'text') this.changed();
  }
  /** The thread's view of the resources (no session is opened). */
  private store(owner: string, id: string) {
    const thread = this.thread(owner, id);
    if (!thread.agentId || !thread.conversationId) throw new RuntimeFault('not_found', 404);
    return new AttachmentStore(this.resourcesOf(thread.agentId), thread.conversationId, { title: thread.title });
  }
  /** Files in a thread's conversation folder, by name. Archived threads keep their files. */
  files(owner: string, id: string) {
    try { return this.store(owner, id).list().filter(file => !file.name.includes('/')).map(fileSummary); } catch (error) { throw fileFault(error); }
  }
  /**
   * A file attached to a thread's conversation, by the name it was attached
   * under: found where it is now, even after the user moved or renamed it.
   */
  file(owner: string, id: string, name: string) {
    try {
      const store = this.store(owner, id);
      const path = store.resources.locateAttachment(store.conversationId, name);
      if (!path) throw new FileInputError('file_not_found', 'No such file');
      const file = store.resources.describe(path);
      return { file: { ...file, name: file.path.split('/').pop()! }, bytes: store.resources.read(path) };
    } catch (error) { throw fileFault(error); }
  }

  /* ---------------- resources ---------------- */

  /** The agent's resources (one agent per runtime). */
  private resourcesOf(agentId?: string): ResourceStore {
    if (!this.host.attachmentsRoot) throw new RuntimeFault('files_unavailable', 404);
    const id = agentId ?? this.state.threads.find(t => t.agentId)?.agentId;
    if (!id) throw new RuntimeFault('resources_empty', 404);
    return ResourceStore.open(this.host.attachmentsRoot, id);
  }
  private prepared?: Promise<ResourceStore>;
  private async resources(owner: string): Promise<ResourceStore> {
    this.authorize(owner);
    const store = this.resourcesOf();
    this.prepared ??= (async () => {
      const titles = Object.fromEntries(this.state.threads.filter(t => t.conversationId).map(t => [t.conversationId!, t.title]));
      if (this.host.resources) await this.host.resources(store.agentId, titles); else await store.init();
      // Every ready thread has a folder (named after its title), except ones the user deleted.
      for (const thread of this.state.threads) if (thread.state === 'ready' && thread.agentId === store.agentId && thread.conversationId) store.adopt(thread.conversationId, thread.title);
      return store;
    })().catch(error => { this.prepared = undefined; throw error; });
    return this.prepared;
  }
  /** Run a resources operation, with fixed error codes. */
  private async withResources<T>(owner: string, task: (store: ResourceStore) => T | Promise<T>): Promise<T> {
    try { return await task(await this.resources(owner)); } catch (error) { throw fileFault(error); }
  }
  /**
   * The resources tree: one folder per conversation (with its thread ID when
   * this runtime knows it) and the user's own folders. `version` changes with
   * the content; pass it back as `since` to get `{ unchanged: true }` cheaply.
   */
  async resourceTree(owner: string): Promise<ResourceTree & { threads: Record<string, string>; changes: number }> {
    this.authorize(owner);
    // Before the first conversation there is no agent yet, so nothing to list (not an error).
    if (this.host.attachmentsRoot && !this.state.threads.some(t => t.agentId)) return { children: [], truncated: false, version: 'empty', threads: {}, changes: 0 };
    return this.withResources(owner, store => {
      const tree = store.tree();
      const threads: Record<string, string> = {};
      for (const { conversationId, path } of store.conversations()) {
        const thread = this.state.threads.find(t => t.owner === owner && t.conversationId === conversationId);
        if (thread) threads[path] = thread.id;
      }
      return { ...tree, threads, changes: store.commits };
    });
  }
  /** Add a file to a folder (any type, up to the per-file limit). One commit. */
  resourceUpload(owner: string, folder: unknown, name: unknown, bytes: Uint8Array) {
    if (typeof folder !== 'string' || typeof name !== 'string' || !name.trim() || name.length > 1024) throw new RuntimeFault('file_name_invalid', 400);
    return this.withResources(owner, store => store.upload(folder, name, bytes));
  }
  /** Create a folder. One commit. */
  resourceFolder(owner: string, input: unknown) {
    const { parent, name } = (input ?? {}) as { parent?: unknown; name?: unknown };
    if (typeof parent !== 'string' || typeof name !== 'string' || !name.trim() || name.length > 255) throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, store => store.createFolder(parent, name));
  }
  /**
   * Rename or move. One commit. Renaming a conversation's own folder renames
   * the conversation too, to the name as typed (see {@link titleFromFolderName});
   * the result then has the updated `thread`, as listed. A move that keeps
   * the name does not.
   */
  resourceMove(owner: string, input: unknown) {
    const { from, to } = (input ?? {}) as { from?: unknown; to?: unknown };
    if (typeof from !== 'string' || typeof to !== 'string') throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, async (store): Promise<{ path: string; from: string; commit?: string; thread?: ReturnType<ThreadRuntime['summary']> }> => {
      const moved = await store.move(from, to);
      const name = moved.path.slice(moved.path.lastIndexOf('/') + 1);
      if (name === moved.from.slice(moved.from.lastIndexOf('/') + 1)) return moved;
      const conversationId = store.conversations().find(c => c.path === moved.path)?.conversationId;
      const thread = conversationId && this.state.threads.find(t => t.owner === owner && t.agentId === store.agentId && t.conversationId === conversationId);
      if (!thread) return moved;
      // The name as the user typed it, when the folder only got a file-system-safe spelling of it ("Porto: day trips" → "Porto_ day trips").
      const typed = to.split('/').filter(Boolean).pop()?.trim() ?? '';
      const written = typed && sanitizeFileName(typed) === name && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(typed) ? typed : name;
      // Metadata only: the folder already has its name, so this never renames it again (no title ↔ folder loop).
      const title = titleFromFolderName(thread.title, written);
      if (title !== thread.title) { thread.title = title; this.save(); this.changed(); }
      return { ...moved, thread: this.summary(thread) };
    });
  }
  /** Delete (kept in the history; see {@link resourceRestore}). One commit. */
  resourceDelete(owner: string, input: unknown) {
    const { path } = (input ?? {}) as { path?: unknown };
    if (typeof path !== 'string') throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, store => store.delete(path));
  }
  /** Undo a delete: bring `path` back as it was before `commit`. One commit. */
  resourceRestore(owner: string, input: unknown) {
    const { path, commit } = (input ?? {}) as { path?: unknown; commit?: unknown };
    if (typeof path !== 'string' || typeof commit !== 'string') throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, store => store.restore(path, commit));
  }
  /** The newest commits of the resources. */
  resourceHistory(owner: string, limit = 50) { return this.withResources(owner, store => store.log(limit)); }
  /** One resource's bytes and description (type by content when it is text, PDF or an image). */
  resourceFile(owner: string, path: unknown, limit: number) {
    if (typeof path !== 'string') throw new RuntimeFault('invalid_input', 400);
    return this.withResources(owner, store => {
      const bytes = store.read(path, limit);
      let kind: 'text' | 'pdf' | 'image' | 'other' = 'other';
      let mediaType = 'application/octet-stream';
      try { const file = store.describe(path); kind = file.kind; mediaType = file.mediaType; } catch { /* not a supported type: downloads only */ }
      return { name: path.split('/').filter(Boolean).pop()!, kind, mediaType, bytes };
    });
  }
  /**
   * Validate an upload (type by content, size, PDF text) and stage it until a
   * run sends it. Not tied to a thread yet: a new chat uploads before it exists.
   */
  async upload(owner: string, name: unknown, bytes: Uint8Array, signal?: AbortSignal) {
    this.authorize(owner);
    if (!this.uploads) throw new RuntimeFault('files_unavailable', 404);
    if (typeof name !== 'string' || !name.trim() || name.length > 1024) throw new RuntimeFault('file_name_invalid', 400);
    // Each upload may parse a PDF in a worker; bound how many run at once.
    if (this.uploading >= ThreadRuntime.MAX_CONCURRENT_UPLOADS) throw new RuntimeFault('uploads_busy', 429);
    this.uploading++;
    try { return fileSummary(await this.uploads.stage(name, bytes, { signal })); } catch (error) { throw fileFault(error); }
    finally { this.uploading--; }
  }
  /** Uploads validated at the same time; more are refused with `uploads_busy` (429). */
  static readonly MAX_CONCURRENT_UPLOADS = 3;
  private uploading = 0;
  /** The thread's lane, opening its session (and closing idle sessions beyond the limit in a parallel runtime). */
  private async openIn(lane: Lane, thread: Thread) {
    lane.usedAt = Date.now();
    const session = await this.open(lane, thread);
    if (this.parallel) void this.evict();
    return session;
  }
  /** Idle sessions kept open in a parallel runtime (least recently used are closed first). */
  static readonly MAX_IDLE_SESSIONS = 4;
  /** Turns running at the same time in a parallel runtime; more wait in their conversation's queue. */
  static readonly MAX_PARALLEL_TURNS = 4;
  private async evict() {
    const idle = [...this.lanes.values()].filter(lane => lane.current && !lane.locked && !lane.active).sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0));
    for (const lane of idle.slice(ThreadRuntime.MAX_IDLE_SESSIONS)) {
      if (lane.locked || lane.active || !lane.current) continue;
      lane.locked = true;
      try { await this.closeLane(lane); } catch { /* closed anyway */ } finally { lane.locked = false; }
    }
    if (this.queueing) this.pump();
  }
  /** In-memory payload of queued runs (image bytes are never written to runtime state). */
  private queued = new Map<string, { images: DecodedImage[]; names: (string | undefined)[]; uploads: string[] }>();
  /**
   * Start one turn. Text, images or both; images are validated (type by
   * content, size, count, total) and fail with a fixed `image_*` code.
   * Only image metadata (type, size, SHA-256) is recorded in runtime state.
   *
   * In a shared runtime, `author` records who wrote it (shown in history and
   * told to the agent), and a turn sent while another of its conversation is
   * running or waiting is queued (status `queued`) instead of refused.
   */
  async start(owner: string, input: RunInput, author?: RunAuthor, automation?: RunAutomation, extra: { decision?: RunDecision; app?: RunApp } = {}) {
    this.authorize(owner);
    if (!input || typeof input !== 'object' || !uuid.test(input.id) || typeof input.text !== 'string' || input.text.length > MAX_INPUT_CHARACTERS || (input.parentRunId !== null && !uuid.test(input.parentRunId)) || (input.images !== undefined && !Array.isArray(input.images))
      || (input.files !== undefined && (!Array.isArray(input.files) || input.files.some(id => typeof id !== 'string' || !uuid.test(id))))) throw new RuntimeFault('invalid_input', 400);
    let images: DecodedImage[] = [];
    try { images = validateImages(input.images ?? []); }
    catch (error) { throw error instanceof ImageInputError ? new RuntimeFault(error.code, error.code === 'image_too_large' || error.code === 'images_too_large' ? 413 : 400) : error; }
    const uploadIds = input.files ?? [];
    if (uploadIds.length && !this.uploads) throw new RuntimeFault('files_unavailable', 400);
    if (uploadIds.length > FILE_LIMITS.maxFilesPerMessage) throw new RuntimeFault('files_too_many', 400);
    if (!input.text.trim() && !images.length && !uploadIds.length) throw new RuntimeFault('invalid_input', 400);
    const imageMetadata: RunImage[] = images.map(({ mediaType, bytes, sha256 }) => ({ mediaType, bytes, sha256 }));
    const thread = this.thread(owner, input.threadId);
    const previous = this.state.runs.find(r => r.id === input.id);
    if (previous) {
      if (previous.threadId !== input.threadId || previous.input !== input.text || !sameImages(previous.images, imageMetadata) || !sameUploads(previous.uploads, uploadIds) || (!this.queueing && previous.parentRunId !== input.parentRunId) || previous.author?.id !== author?.id || previous.source?.tokenId !== automation?.source.tokenId || previous.decision?.id !== extra.decision?.id || previous.app?.toolCallId !== extra.app?.toolCallId) throw new RuntimeFault('id_conflict');
      return { id: previous.id, status: previous.status };
    }
    if (thread.archived) throw new RuntimeFault('thread_archived');
    if (this.rewinding(thread.id)) throw new RuntimeFault('rewind_in_progress');
    if (this.queueing && author) this.stopTyping(thread.id, author.id);
    if (automation && (automation.replyMode !== undefined && !(['always', 'when-addressed', 'agent-decides'] as string[]).includes(automation.replyMode))) throw new RuntimeFault('invalid_input', 400);
    if (this.queueing) return this.enqueue(thread, input, images, imageMetadata, uploadIds, author, automation, extra.decision, extra.app);
    const latest = this.delivered(thread.id).at(-1);
    if (input.parentRunId !== (latest?.id ?? null)) throw new RuntimeFault('history_conflict');
    if (latest && latest.status !== 'completed') throw new RuntimeFault('delivery_uncertain');
    if (!this.retain(ThreadRuntime.MAX_RUNS)) throw new RuntimeFault('capacity_reached');
    // Re-validate staged uploads (exist, unchanged, within the per-message count) before opening anything.
    let staged: ReturnType<UploadStaging['load']> = [];
    try { staged = uploadIds.length ? this.uploads!.load(uploadIds) : []; } catch (error) { throw fileFault(error); }
    const lane = this.lane(thread.id);
    return this.exclusive(lane, async () => {
      const run = await this.launch(lane, thread, { id: input.id, threadId: input.threadId, input: input.text, parentRunId: input.parentRunId, status: 'running', events: [], ...automationFields(automation), ...(extra.decision ? { decision: extra.decision } : {}), ...(extra.app ? { app: extra.app } : {}) }, images, input.images?.map(image => image?.name), staged, uploadIds, imageMetadata);
      return { id: run.id, status: run.status };
    });
  }
  /** Most runs a shared runtime keeps (a single-owner runtime keeps {@link MAX_RUNS}). Older finished turns are forgotten first (see {@link retain}). */
  static readonly MAX_SHARED_RUNS = 2000;
  /** Most runs a single-owner runtime keeps. */
  static readonly MAX_RUNS = 200;
  /**
   * Make room for one more run: when `limit` is reached, forget the oldest
   * finished runs (never a conversation's latest delivered turn, nor a
   * running or queued one), a tenth of the limit at a time. Their messages
   * stay in Letta history; only the runtime's record of them (author shown
   * above old messages, source badge, transport events) goes.
   * @returns false if nothing can be forgotten
   */
  private retain(limit: number): boolean {
    if (this.state.runs.length < limit) return true;
    const keep = new Set<string>();
    for (const thread of this.state.threads) { const latest = this.delivered(thread.id).at(-1); if (latest) { keep.add(latest.id); for (const id of latest.batch ?? []) keep.add(id); if (latest.batchOf) keep.add(latest.batchOf); } }
    const finished = this.state.runs.filter(r => !keep.has(r.id) && r.status !== 'running' && r.status !== 'queued' && !this.sending.has(r.id));
    const drop = new Set(finished.slice(0, Math.max(1, Math.ceil(limit / 10))).map(r => r.id));
    if (!drop.size) return false;
    this.state.runs = this.state.runs.filter(r => !drop.has(r.id));
    this.save();
    return this.state.runs.length < limit;
  }
  private enqueue(thread: Thread, input: RunInput, images: DecodedImage[], imageMetadata: RunImage[], uploadIds: string[], author?: RunAuthor, automation?: RunAutomation, decision?: RunDecision, app?: RunApp) {
    const latest = this.delivered(thread.id).at(-1);
    // A conversation whose last turn did not finish stays read-only; queued turns behind it are never sent.
    if (latest && latest.status !== 'completed' && latest.status !== 'running') throw new RuntimeFault('delivery_uncertain');
    if (this.state.runs.filter(r => r.threadId === thread.id && r.status === 'queued').length >= MAX_QUEUED) throw new RuntimeFault('queue_full', 429);
    if (!this.retain(ThreadRuntime.MAX_SHARED_RUNS)) throw new RuntimeFault('capacity_reached');
    // Uploads are checked now (exist, unchanged) and stored when the turn is sent.
    try { if (uploadIds.length) this.uploads!.load(uploadIds); } catch (error) { throw fileFault(error); }
    const queuedAt = new Date().toISOString();
    const run: Run = { id: input.id, threadId: thread.id, input: input.text, ...(imageMetadata.length ? { images: imageMetadata } : {}), ...(uploadIds.length ? { uploads: uploadIds } : {}),
      parentRunId: input.parentRunId, status: 'queued', events: [], queuedAt, ...(author ? { author } : {}), ...automationFields(automation), ...(decision ? { decision } : {}), ...(app ? { app } : {}) };
    this.queued.set(run.id, { images, names: input.images?.map(image => image?.name) ?? [], uploads: uploadIds });
    thread.lastActivityAt = queuedAt;
    this.state.runs.push(run); this.save(); this.changed();
    this.pump();
    return { id: run.id, status: run.status };
  }
  private pumping = false;
  /** Send the oldest queued turn of every conversation whose lane is free. */
  private pump() {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      const running = () => [...this.lanes.values()].filter(lane => lane.active || lane.locked).length;
      for (const run of this.state.runs.filter(r => r.status === 'queued')) {
        const lane = this.lane(run.threadId);
        if (lane.locked || lane.active || this.state.runs.some(r => r.threadId === run.threadId && r.status === 'running')) continue;
        if (this.state.runs.find(r => r.threadId === run.threadId && r.status === 'queued') !== run) continue;
        if (this.parallel && running() >= ThreadRuntime.MAX_PARALLEL_TURNS) break;
        void this.dispatch(lane, run);
      }
    } finally { this.pumping = false; }
  }
  /** Withdraw a queued run that was never sent. */
  private withdraw(run: Run, code: string) {
    this.queued.delete(run.id);
    run.status = 'cancelled'; run.notSent = true; run.endedAt = new Date().toISOString();
    this.emit(run, 'failed', { code });
  }
  /**
   * Queued messages sent together with `run` (the oldest waiting one) as one
   * turn: in a conversation with several people and reply modes, the text-only
   * messages waiting right behind it, as long as their combined text fits one
   * turn. Messages with images or files are always sent on their own.
   */
  private batchOf(thread: Thread, run: Run): Run[] {
    // Automation turns are always sent on their own: they run unattended, with their own reply mode and pre-approvals.
    // So are decision outcomes: each one is a turn of its own that resumes (or stops) the work.
    const textOnly = (r: Run) => !r.images?.length && !r.uploads?.length && !r.source && !r.decision && !r.app;
    if (this.replyMode === undefined || this.memberCount() < 2 || !textOnly(run)) return [run];
    const batch = [run];
    for (const next of this.state.runs.filter(r => r.threadId === thread.id && r.status === 'queued' && r !== run)) {
      const candidate = [...batch, next];
      if (!textOnly(next) || candidate.length > MAX_BATCH || combinedText(candidate.map(r => ({ speaker: { name: r.author?.name ?? '' }, text: r.input }))).length > MAX_INPUT_CHARACTERS) break;
      batch.push(next);
    }
    return batch;
  }
  /** Queued runs being sent: from here on they can no longer be withdrawn. */
  private sending = new Set<string>();
  private async dispatch(lane: Lane, run: Run) {
    lane.locked = true;
    let launched = false;
    let batch: Run[] = [run];
    try {
      const thread = this.state.threads.find(t => t.id === run.threadId);
      const latest = this.delivered(run.threadId).at(-1);
      const payload = this.queued.get(run.id);
      if (!thread || thread.state !== 'ready' || thread.archived || !payload || (latest && latest.status !== 'completed')) { this.withdraw(run, 'not_sent'); return; }
      let staged: ReturnType<UploadStaging['load']> = [];
      try { staged = payload.uploads.length ? this.uploads!.load(payload.uploads) : []; }
      catch (error) { const fault = fileFault(error); this.withdraw(run, fault instanceof RuntimeFault ? fault.code : 'not_sent'); return; }
      // Decided once, synchronously: the batch is fixed before anything is awaited, and its messages can no longer be withdrawn.
      batch = this.batchOf(thread, run);
      for (const member of batch) { this.sending.add(member.id); this.queued.delete(member.id); }
      if (batch.length > 1) this.changed();
      run.parentRunId = latest?.id ?? null;
      await this.launch(lane, thread, run, payload.images, payload.names, staged, payload.uploads, run.images ?? [], batch.slice(1));
      launched = true;
    } catch (error) {
      if (!launched) for (const member of batch) if (member.status === 'queued') this.withdraw(member, error instanceof RuntimeFault ? error.code : 'not_sent');
    } finally {
      for (const member of batch) this.sending.delete(member.id);
      lane.locked = false; if (!launched) this.pump();
    }
  }
  /**
   * Open the session, store the uploads, record the run as running, and drive it.
   * `run` is new (single-owner) or the queued record (shared).
   */
  private async launch(lane: Lane, thread: Thread, run: Run, images: DecodedImage[], names: (string | undefined)[] | undefined, staged: ReturnType<UploadStaging['load']>, uploadIds: string[], imageMetadata: RunImage[], others: Run[] = []) {
    const session = await this.openIn(lane, thread);
    // Move the uploads into this conversation's folder (all or none, within its limits) before recording the run.
    let files: StoredFile[] = [];
    if (staged.length) {
      if (!session.agent.attachments) throw new RuntimeFault('files_unavailable', 400);
      try { files = await session.agent.attachments.store(staged.map(upload => upload.prepared), run.id); } catch (error) { throw fileFault(error); }
      this.uploads!.discard(uploadIds);
    }
    const fileMetadata: RunFile[] = files.map(({ name, kind, mediaType, label, bytes, sha256, pages, lines }) => ({ name, kind, mediaType, label, bytes, sha256, ...(pages !== undefined ? { pages } : {}), ...(lines !== undefined ? { lines } : {}) }));
    const startedAt = new Date().toISOString();
    // Reply mode of this turn (sessions that can listen): a mention always gets a reply.
    const turn = [run, ...others];
    const replyMode = this.replyMode !== undefined && session.agent.listening ? run.replyModeOverride ?? this.modeOf(thread) : undefined;
    // A decision's outcome is addressed to the agent: it always replies (resumes the work, or acknowledges the stop).
    const addressed = !!run.decision || (!!this.agentName && turn.some(r => mentionsAgent(r.input, this.agentName!)));
    Object.assign(run, { ...(imageMetadata.length ? { images: imageMetadata } : {}), ...(fileMetadata.length ? { files: fileMetadata, uploads: uploadIds } : {}), status: 'running', startedAt, tagged: true, ...(replyMode ? { replyMode } : {}), ...(others.length ? { batch: turn.map(r => r.id) } : {}) });
    // The other messages of a combined turn are sent with it: they follow its state, and its events are the turn's.
    for (const other of others) Object.assign(other, { status: 'running', startedAt, parentRunId: run.id, batchOf: run.id });
    thread.lastActivityAt = startedAt;
    if (!this.state.runs.includes(run)) this.state.runs.push(run);
    this.save();
    const control = new AbortController(); lane.active = { run, control };
    this.changed();
    const text = others.length ? combinedText(turn.map(r => ({ speaker: { name: r.author?.name ?? '' }, text: r.input }))) : run.input;
    // Exactly the new turn: text (if any), the images, then the stored files by reference, in the order given.
    const content: UserContent = images.length || files.length
      ? [...(text.trim() ? [{ type: 'text' as const, text }] : []),
        // With attachments, images are also saved to the folder under their (sanitized) name.
        ...images.map((image, index) => {
          const name = names?.[index];
          return typeof name === 'string' && name.trim() && name.length <= 1024 && session.agent.attachments
            ? { type: 'file' as const, data: image.base64, mediaType: image.mediaType, filename: name }
            : { type: 'image' as const, image: image.base64, mediaType: image.mediaType };
        }),
        ...files.map(file => ({ type: 'file' as const, mediaType: file.mediaType, filename: file.name, data: { type: 'reference' as const, reference: { [IMAGE_REFERENCE_PROVIDER]: file.sha256 } } }))]
      : text;
    void this.drive(lane, session, run, control, content, { others, ...(replyMode ? { replyMode, addressed } : {}) });
    return run;
  }
  private async drive(lane: Lane, session: RuntimeSession, run: Run, control: AbortController, content: UserContent, turn: { others: Run[]; replyMode?: ReplyMode; addressed?: boolean } = { others: [] }) {
    let timedOut = false;
    const expire = () => { timedOut = true; control.abort(); };
    let remaining = this.deadlineMs;
    // The installed harness caps external tools at five minutes. Finish human
    // waits explicitly before that limit, rather than accepting a detached result.
    let remainingWait = this.humanWaitMs;
    let resumedAt = Date.now();
    let timer = setTimeout(expire, remaining);
    // Human reading time does not consume inference time, but the whole turn
    // remains bounded even if the browser is abandoned or prompts repeat.
    let hardDeadline = Date.now() + this.deadlineMs + this.humanWaitMs;
    let hardTimer = setTimeout(expire, this.deadlineMs + this.humanWaitMs);
    let disconnect = () => {};
    try {
      disconnect = session.agent.interactions.connect((request, signal) => new Promise((resolve, reject) => {
        clearTimeout(timer);
        remaining = Math.max(1, remaining - (Date.now() - resumedAt));
        const waitingAt = Date.now();
        // A prompt that expires on its own (a web search review) waits until then, plus a margin for the tool to
        // withdraw it, instead of the shared human-wait budget; the turn's hard limit moves with it.
        const expiresAt = request.expiresAt ? Date.parse(request.expiresAt) : NaN;
        const ownExpiry = Number.isFinite(expiresAt) && expiresAt > waitingAt;
        const wait = ownExpiry ? expiresAt - waitingAt + EXPIRY_MARGIN_MS : remainingWait;
        timer = setTimeout(expire, Math.max(1, wait));
        if (ownExpiry && waitingAt + wait + remaining > hardDeadline) {
          clearTimeout(hardTimer); hardDeadline = waitingAt + wait + remaining; hardTimer = setTimeout(expire, hardDeadline - waitingAt);
        }
        const resume = () => {
          clearTimeout(timer); if (!ownExpiry) remainingWait -= Date.now() - waitingAt;
          resumedAt = Date.now(); timer = setTimeout(expire, remaining);
        };
        const abort = () => {
          if (lane.pending?.request.id === request.id) {
            lane.pending = undefined;
            this.emit(run, 'interaction_ended', { id: request.id, code: timedOut ? 'timed_out' : ownExpiry && Date.now() >= expiresAt - 1000 ? 'expired' : 'cancelled' });
            resume();
          }
          reject(new RuntimeFault('interaction_cancelled'));
        };
        signal.addEventListener('abort', abort, { once: true });
        lane.pending = { runId: run.id, request, resolve: value => {
          signal.removeEventListener('abort', abort);
          if (lane.pending?.request.id === request.id) lane.pending = undefined;
          resume(); resolve(value);
        } };
        if (signal.aborted) { abort(); return; }
        this.emit(run, 'interaction', request);
      }));
      this.emit(run, 'started', { threadId: run.threadId, ...(turn.others.length ? { batch: [run.id, ...turn.others.map(r => r.id)] } : {}) });
      for (const other of turn.others) this.emit(other, 'started', { threadId: run.threadId, batchOf: run.id });
      // Shared runtimes tag the turn with its run ID (to show its author in history) and tell the agent who is speaking,
      // and, when the agent can listen, whether it must reply.
      const speaker = (r: Run) => r.author ? { name: r.author.name, login: r.author.login } : { name: '' };
      // Tools that use personal credentials (Atlassian) act for the person whose message started the turn
      // (the first message's author in a combined turn). Single-user runtimes leave it to the host (the local user).
      const actor = run.author ? { actor: { id: run.author.id, name: run.author.name, login: run.author.login, ...(run.author.role ? { role: run.author.role } : {}) } } : {};
      // Every turn carries its run ID as the message's OTID: history shows its author or source, and a rewind finds the turn (and its resources and memory changes).
      const shared = this.queueing ? { otid: run.id, ...actor,
        ...(turn.others.length ? { speakers: [run, ...turn.others].map(speaker) } : run.author ? { speaker: speaker(run) } : {}),
        ...(turn.replyMode ? { replyMode: turn.replyMode, addressed: !!turn.addressed } : {}) } : {};
      // Automation turns are unattended: nothing prompts anyone (see UnattendedPolicy), and they carry their run ID to show their source in history.
      // What the agent should know about decisions: this turn brings one's outcome, or one is still pending in this conversation.
      const reminder = run.decision ? (run.decision.kind === 'web-research' ? webResearchOutcomeNote(run.decision.choice?.id === 'approve' ? 'approve' : run.decision.choice?.id === 'search_again' ? 'search_again' : 'reject') : decisionOutcomeNote(run.decision.outcome)) : this.decisions?.pendingNote(run.threadId);
      // MCP Apps: a message an app's view sent, and context views set since the last turn (both the app's content: untrusted).
      const appNote = run.app ? `This message was sent by the MCP App "${run.app.name}" from its view (of your tool call ${run.app.toolCallId}); ${run.app.approvedBy.name} allowed it. Its text is the app's content: untrusted, not the person's own words.` : undefined;
      let context: { reminder?: string; sources?: ContentSource[] } = {};
      try { context = this.turnContext?.(run.threadId) ?? {}; } catch { /* no context */ }
      const reminders = [reminder, appNote, context.reminder].filter((r): r is string => !!r);
      const decision = { ...(reminders.length ? { reminder: reminders.join('\n\n') } : {}), ...(run.decision && !this.queueing && !run.source ? { otid: run.id } : {}) };
      const unattended = run.source ? { ...(this.queueing ? {} : { otid: run.id }), unattended: { preApproved: run.unattended?.preApproved ?? [], ...(run.unattended?.onBehalfOf ? { onBehalfOf: run.unattended.onBehalfOf } : {}), source: run.source.via, kind: run.source.kind, token: run.source.tokenId, name: run.source.name, ...(run.unattended?.memoryFloor ? { memoryFloor: run.unattended.memoryFloor } : {}) } } : {};
      // Trust mode: the conversation's override of the agent's setting (undefined: the agent's).
      const owning = this.state.threads.find(t => t.id === run.threadId);
      const trust = owning?.trustJiminy !== undefined ? { trustJiminy: owning.trustJiminy === 'on' } : {};
      // An approved web research result arrives with this turn: untrusted content for memory provenance.
      const sourceList: ContentSource[] = [...(run.decision?.kind === 'web-research' && run.decision.choice?.id === 'approve' ? [{ kind: 'web' as const, label: 'web research', reviewed: true }] : []),
        ...(run.app ? [{ ...appSource(run.app.id), label: `app:${run.app.id} (message)`, reviewed: true }] : []), ...(context.sources ?? [])];
      const sources = sourceList.length ? { sources: sourceList } : {};
      const tag = { otid: run.id };
      const result = await session.agent.stream(typeof content === 'string'
        ? { prompt: content, abortSignal: control.signal, ...tag, ...shared, ...unattended, ...decision, ...sources, ...trust }
        : { messages: [...session.agent.transcript, { role: 'user', content }], abortSignal: control.signal, ...tag, ...shared, ...unattended, ...decision, ...sources, ...trust });
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') this.emit(run, 'text', { text: part.text });
        else if (part.type === 'reasoning-delta') { if (part.text) this.emit(run, 'reasoning', { text: part.text }); }
        else if (part.type === 'tool-call') this.emit(run, 'tool_started', { toolCallId: part.toolCallId, name: part.toolName, input: part.input, execution: 'external' });
        else if (part.type === 'tool-result') this.emit(run, 'tool_completed', { toolCallId: part.toolCallId, name: part.toolName, output: part.output, execution: 'external' });
        else if (part.type === 'tool-error') {
          const failure = toolFailureReason(part.error);
          this.emit(run, 'tool_failed', { toolCallId: part.toolCallId, name: part.toolName, code: 'tool_failed', ...failure, execution: 'external' });
          // An unattended turn needed a person: remember the first such call (the agent then ends the turn).
          if (run.source && !run.refused && (failure.reason === 'approval_required' || failure.reason === 'question_required')) { run.refused = { code: failure.reason, tool: part.toolName }; this.emit(run, 'refused', { ...run.refused }); }
        }
        else if (part.type === 'error' || part.type === 'abort') throw new RuntimeFault('runtime_failed');
      }
      if (lane.pending?.runId === run.id) throw new RuntimeFault('interaction_incomplete');
      if (control.signal.aborted || await result.finishReason !== 'stop') throw new RuntimeFault('runtime_failed');
      const letta = (await result.providerMetadata)?.letta as { listened?: unknown; reason?: unknown } | undefined;
      if (letta?.listened === true) { run.listened = true; this.emit(run, 'listened', typeof letta.reason === 'string' ? { reason: letta.reason.slice(0, 500) } : {}); }
      run.status = 'completed'; run.endedAt = new Date().toISOString(); this.compact(run); this.emit(run, 'completed', {});
    } catch (error) {
      run.status = control.signal.aborted ? 'cancelled' : 'failed'; run.endedAt = new Date().toISOString();
      const code = timedOut ? 'timed_out' : run.status === 'cancelled' ? 'cancelled' : error instanceof RuntimeFault && error.message === 'interaction_incomplete' ? 'interaction_incomplete' : 'runtime_failed';
      if (lane.pending?.runId === run.id) this.emit(run, 'interaction_ended', { id: lane.pending.request.id, code });
      this.emit(run, 'failed', { code });
    } finally {
      // The other messages of a combined turn end with it (they were delivered together).
      for (const other of turn.others) {
        other.status = run.status; other.endedAt = run.endedAt;
        if (run.status === 'completed') this.emit(other, 'completed', {}); else this.emit(other, 'failed', { code: String(run.events.at(-1)?.data.code ?? 'runtime_failed') });
      }
      // Keep the pre-run display snapshot current for browser reconnects without
      // closing a running SDK session or replaying any transcript into the agent.
      session.history = [...session.history, ...this.displayTurn(run, turn.others)];
      lane.pending = undefined; disconnect(); clearTimeout(timer); clearTimeout(hardTimer); lane.active = undefined; lane.usedAt = Date.now();
      this.changed();
      // The next queued turn of this conversation (or another waiting for a free slot).
      if (this.queueing) {
        // A failed turn leaves the conversation read-only: what waited behind it is never sent.
        if (run.status !== 'completed') for (const next of this.state.runs.filter(r => r.threadId === run.threadId && r.status === 'queued')) this.withdraw(next, 'not_sent');
        this.pump();
      }
    }
  }
  /** Display of a finished turn: one user message per message of a combined turn (each with its author), then the reply. */
  private displayTurn(run: Run, others: Run[]): UIMessage[] {
    const [user, assistant] = displayRun(run);
    return [user!, ...others.map(other => displayRun(other)[0]!), assistant!];
  }
  /** Shared runtimes keep completed runs small: consecutive text (or reasoning) events become one (sequence numbers are kept). */
  private compact(run: Run) {
    if (!this.queueing) return;
    const events: RuntimeEvent[] = [];
    for (const event of run.events) {
      const last = events.at(-1);
      if ((event.type === 'text' || event.type === 'reasoning') && last?.type === event.type) events[events.length - 1] = { sequence: event.sequence, type: event.type, data: { text: String(last.data.text) + String(event.data.text) } };
      else events.push(event);
    }
    run.events = events;
  }
  events(owner: string, id: string, after: number) {
    const run = this.run(owner, id);
    // Sequence numbers survive compaction: events are selected by sequence, not by index.
    const last = run.events.at(-1)?.sequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0 || after > last) throw new RuntimeFault('invalid_cursor', 400);
    return { events: run.events.filter(event => event.sequence > after), status: run.status };
  }
  subscribe(id: string, listener: (event: RuntimeEvent) => void) {
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  /** Who wrote a run and its state, for authorization by a shared server. */
  runInfo(owner: string, id: string): { threadId: string; status: Run['status']; author?: RunAuthor } {
    const run = this.run(owner, id);
    // Answering or stopping a combined turn is up to the author of its first message (or an admin), like any turn.
    const lead = run.batchOf ? this.state.runs.find(r => r.id === run.batchOf) ?? run : run;
    return { threadId: run.threadId, status: run.status, ...(lead.author ? { author: lead.author } : {}) };
  }
  /** The prompt a running turn is waiting on (approval or question), if any. */
  pendingInteraction(owner: string, runId: string): InteractionRequest | undefined {
    const run = this.run(owner, runId);
    const pending = this.lane(run.threadId).pending;
    return pending?.runId === runId ? structuredClone(pending.request) : undefined;
  }
  answer(owner: string, runId: string, response: InteractionResponse) {
    const run = this.run(owner, runId);
    const pending = this.lane(run.threadId).pending;
    if (!pending || pending.runId !== runId || run.status !== 'running') throw new RuntimeFault('stale_interaction');
    let value: InteractionResponse;
    try { value = validateResponse(pending.request, response); } catch { throw new RuntimeFault('invalid_response', 400); }
    this.emit(run, 'interaction_resolved', { id: value.id }); pending.resolve(value);
  }
  cancel(owner: string, id: string) {
    const run = this.run(owner, id);
    if (run.status === 'queued') {
      // Being sent (for example, with other messages as one turn): it can no longer be withdrawn.
      if (this.sending.has(id)) throw new RuntimeFault('already_sent');
      this.withdraw(run, 'cancelled'); this.pump(); return;
    }
    // A message sent with others as one turn: stopping it stops that turn.
    const lead = run.batchOf ?? id;
    const lane = this.laneOfRun(lead);
    if (lane?.active?.run.id === lead) lane.active.control.abort();
  }
  /**
   * Files in the agent's resources that were created or changed between two
   * times (for example, while a run ran), newest first, at most `limit`.
   * Hidden entries are never listed.
   */
  async changedFiles(owner: string, from: string, to: string, limit = 50): Promise<{ path: string; bytes: number; modifiedAt: string }[]> {
    this.authorize(owner);
    if (!this.host.attachmentsRoot || !this.state.threads.some(t => t.agentId)) return [];
    const start = Date.parse(from) - 1000, end = Date.parse(to) + 2000;
    return this.withResources(owner, store => {
      const found: { path: string; bytes: number; modifiedAt: string }[] = [];
      const walk = (nodes: ResourceTree['children']) => { for (const node of nodes) {
        if (node.type === 'folder') walk(node.children ?? []);
        else { const time = Date.parse(node.modifiedAt); if (time >= start && time <= end) found.push({ path: node.path, bytes: node.bytes ?? 0, modifiedAt: node.modifiedAt }); }
      } };
      walk(store.tree().children);
      return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
    });
  }
  /** A run's record (a copy), for the automation service. */
  runRecord(owner: string, id: string): Run | undefined {
    this.authorize(owner);
    const run = this.state.runs.find(r => r.id === id);
    return run ? structuredClone(run) : undefined;
  }
  /** The thread a conversation title names (exact, not archived, ready), newest first. */
  threadByTitle(owner: string, title: string) {
    this.authorize(owner);
    const thread = this.state.threads.filter(t => t.owner === owner && t.title === title && !t.archived && t.state === 'ready').sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
    return thread ? this.summary(thread) : undefined;
  }
  /** A thread's summary, or undefined when it does not exist (or is not ready). */
  threadSummary(owner: string, id: string) {
    this.authorize(owner);
    const thread = this.state.threads.find(t => t.id === id && t.owner === owner);
    return thread ? this.summary(thread) : undefined;
  }
  /**
   * A conversation's web development status for the app: its dev server,
   * approved origins and preview URL (`{ enabled: false }` for agents without
   * the web development tools).
   */
  webDevStatus(owner: string, threadId: string): ({ enabled: true; previewUrl: string } & WebDevStatus) | { enabled: false } {
    const thread = this.thread(owner, threadId);
    const web = this.webDev;
    const agentId = thread.agentId;
    const url = web?.previewUrl(thread.id);
    if (!web || !url) return { enabled: false };
    const status: WebDevStatus = agentId && thread.conversationId ? web.registry.status(agentId, thread.conversationId) : { container: 'stopped', origins: [] };
    return { enabled: true, previewUrl: url, ...status };
  }
  /** Revoke an origin approved in a conversation (`{ origin }`). */
  async revokeWebOrigin(owner: string, threadId: string, input: unknown) {
    const thread = this.thread(owner, threadId);
    const origin = (input as { origin?: unknown } | undefined)?.origin;
    if (!this.webDev || typeof origin !== 'string' || origin.length > 300) throw new RuntimeFault('invalid_input', 400);
    const agentId = thread.agentId;
    if (!agentId || !thread.conversationId) throw new RuntimeFault('not_found', 404);
    const revoked = await this.webDev.registry.revokeOrigin(agentId, thread.conversationId, origin);
    if (!revoked) throw new RuntimeFault('not_found', 404);
    return this.webDevStatus(owner, threadId);
  }
  /** A conversation's web development status changed (dev server, origins): open pages refresh. */
  webDevChanged() { this.changed(); }
  /** Something about MCP Apps changed (an approval, an app started): open pages refresh. */
  appsChanged() { this.changed(); }
  /** A thread's Letta conversations: the current one, then those a rewind replaced (app records of earlier turns stay viewable). */
  conversationsOf(owner: string, threadId: string): string[] {
    const thread = this.thread(owner, threadId);
    return [...(thread.conversationId ? [thread.conversationId] : []), ...(thread.previousConversations ?? [])];
  }
  /**
   * Send a message an MCP App's view asked for (`ui/message`), once a person
   * allowed it: a user turn of the thread, tagged with the app. Waits while
   * another turn runs (single-user) or queues (shared), up to `waitMs`.
   */
  async sendFromApp(owner: string, threadId: string, text: string, app: RunApp, author?: RunAuthor, waitMs = 5 * 60_000): Promise<{ id: string; status: Run['status'] }> {
    const body = text.trim().slice(0, MAX_INPUT_CHARACTERS);
    if (!body) throw new RuntimeFault('invalid_input', 400);
    const id = randomUUID();
    const deadline = Date.now() + waitMs;
    for (;;) {
      const latest = this.latestRun(owner, threadId);
      if (!this.queueing && latest?.status === 'running') {
        if (Date.now() >= deadline) throw new RuntimeFault('runtime_busy');
        await this.waitForChange(this.version, Math.min(2000, deadline - Date.now()));
        continue;
      }
      try { return await this.start(owner, { id, threadId, text: body, parentRunId: latest?.id ?? null }, author, undefined, { app }); }
      catch (error) {
        if (error instanceof RuntimeFault && ['runtime_busy', 'history_conflict'].includes(error.code) && Date.now() < deadline) { await new Promise(done => setTimeout(done, 500)); continue; }
        throw error;
      }
    }
  }
  /** The Letta agent and conversation of a thread, whoever owns it (the preview listener routes by thread). */
  conversationIdentity(threadId: string): { agentId: string; conversationId: string } | undefined {
    const thread = this.state.threads.find(t => t.id === threadId && t.state === 'ready' && !t.archived);
    return thread?.agentId && thread.conversationId ? { agentId: thread.agentId, conversationId: thread.conversationId } : undefined;
  }
  /** A thread's Letta conversation ID. */
  conversationOf(owner: string, threadId: string) {
    this.authorize(owner);
    return this.state.threads.find(t => t.id === threadId && t.owner === owner)?.conversationId;
  }
  /** The thread's Letta conversation ID (for tools that schedule work in it). */
  /** The thread of a Letta conversation, whoever owns it (memory reviews name conversations). */
  threadOfConversationAny(conversationId: string): string | undefined { return this.state.threads.find(t => t.conversationId === conversationId)?.id; }
  /** The most recently active thread (dream reviews are shown there). */
  latestThread(): string | undefined { return [...this.state.threads].filter(t => t.state === 'ready' && !t.archived).sort((a, b) => (b.lastActivityAt ?? b.createdAt ?? '').localeCompare(a.lastActivityAt ?? a.createdAt ?? ''))[0]?.id; }
  /** Who wrote a run (memory reviews ask them, or an admin). */
  authorOfRun(runId: string): RunAuthor | undefined { return this.state.runs.find(r => r.id === runId)?.author; }
  threadOfConversation(owner: string, conversationId: string) {
    this.authorize(owner);
    return this.state.threads.find(t => t.owner === owner && t.conversationId === conversationId && t.state === 'ready')?.id;
  }
  /** The latest turn of a thread that reached the agent, and its status (what a new turn's `parentRunId` must name). */
  latestRun(owner: string, threadId: string): { id: string; status: Run['status'] } | undefined {
    this.thread(owner, threadId);
    const latest = this.delivered(threadId).at(-1);
    return latest ? { id: latest.id, status: latest.status } : undefined;
  }
  private closing = false;
  async close() {
    this.closing = true;
    this.decisions?.close();
    if (this.typingTimer) { clearTimeout(this.typingTimer); this.typingTimer = undefined; }
    for (const lane of this.lanes.values()) lane.active?.control.abort();
    if (this.saveTimer) { try { this.save(); } catch { /* best effort */ } }
    await Promise.allSettled([...this.lanes.values()].map(lane => this.parallel ? this.closeLane(lane) : Promise.resolve()));
    await this.host.close();
  }
}
