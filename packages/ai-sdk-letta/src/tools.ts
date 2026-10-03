import { tool, jsonSchema, asSchema, type Experimental_SandboxSession, type Tool, type ToolSet } from 'ai';
import { Ajv } from 'ajv';
import type { AgentToolResultContent, AnyAgentTool } from '@letta-ai/letta-agent-sdk';
import { appendFileSync, mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateQuestion, type ApprovalPreview, type Question, type ToolInteractions } from './interactions.js';
import type { ToolPermission } from './definition.js';

/**
 * Optional per-call preparation of a tool, attached as `tool[PREPARE_CALL]`
 * (see {@link withPreparation}). It runs after the arguments are validated
 * and before any approval, under the call's deadline, and decides:
 *
 * - `{ output }`: answer the call now (for example, a refusal the model can
 *   correct); nothing else runs and nobody is asked.
 * - `{ approval: 'required', preview }`: ask the human even if the tool's
 *   permission is `'allow'` (a tool can only make its policy stricter), and
 *   show `preview` (what the call will do) in the approval card.
 * - `state`: passed to `execute` as `options.context[PREPARED_CONTEXT]` (for
 *   example, the exact request that was approved).
 *
 * With permission `'ask'`, every call asks, with the preview when there is one.
 */
export type PrepareCall = (input: unknown, options: { toolCallId: string; abortSignal: AbortSignal; context: Readonly<Record<string, unknown>> }) => Promise<PreparedCall> | PreparedCall;
export type PreparedCall = {
  output?: unknown; approval?: 'required' | 'default'; preview?: ApprovalPreview; onBehalfOf?: string; state?: unknown;
  /**
   * What the agent is told when the person denies the call (instead of the
   * bare `user_denied`), and whether they may add a note for the agent
   * (`allowNote`, up to 1000 characters; passed on as `note`).
   */
  denied?: { message: string; allowNote?: boolean };
  /**
   * The approval expires at `at` (epoch ms): the prompt is withdrawn and
   * `onExpire()` says what the agent receives instead (for `web_search`: the
   * result moved to a decision people can take later). The request carries
   * `expiresAt`, and hosts give it that long instead of their shared
   * human-wait budget.
   */
  expires?: { at: number; onExpire: () => Promise<unknown> | unknown };
};
/** Key of a tool's {@link PrepareCall}. */
export const PREPARE_CALL: unique symbol = Symbol.for('ai-sdk-letta.prepareCall');
/** Key under which `execute` receives the prepared state (`options.context[PREPARED_CONTEXT]`). */
export const PREPARED_CONTEXT = 'ai-sdk-letta.prepared';
/**
 * Key of `execute`'s context saying whether a person approved this very call
 * (`true`), or it ran without anyone asked (`false`: an `'allow'` call, or a
 * call an unattended run pre-approved).
 */
export const REVIEWED_CONTEXT = 'ai-sdk-letta.reviewed';
/** Attach a {@link PrepareCall} to an AI SDK tool. */
export function withPreparation<T extends object>(definition: T, prepare: PrepareCall): T & { [PREPARE_CALL]: PrepareCall } {
  return Object.assign(definition, { [PREPARE_CALL]: prepare });
}

/** Name of the built-in human question tool. */
export const ASK_USER_TOOL = 'ask_user';

/**
 * Built-in tool that lets the agent ask the human a structured question
 * mid-turn. Add it to a definition's tools as `ask_user: askUserTool`.
 * The answer is supplied by the connected interaction renderer.
 */
/** Result of `ask_user`, as returned to the agent. */
export type AskUserResult = { cancelled: boolean; selected?: string[]; text?: string };

export const askUserTool: Tool<Question, AskUserResult> = tool({
  description: 'Ask a structured question during this turn. Supply choices and/or allowFreeText. User can cancel. Ordinary conversational clarification can instead use normal assistant text.',
  inputSchema: jsonSchema<Question>({ type: 'object', properties: { question: { type: 'string', minLength: 1, maxLength: 1000 }, options: { type: 'array', maxItems: 12, items: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,40}$' }, label: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['id', 'label'], additionalProperties: false } }, allowFreeText: { type: 'boolean' }, multiSelect: { type: 'boolean' } }, required: ['question'], additionalProperties: false }),
  // The bridge answers this tool through the interaction broker; this handler never runs.
  execute: async (_question: Question): Promise<AskUserResult> => { throw new Error('interaction_unavailable'); },
});

/** Metadata-only audit event. Never contains arguments, outputs or raw call IDs. */
export type ToolActivity = { type: 'tool'; sessionId: string; callId: string; tool: string; status: 'start' | 'completion' | 'error' | 'denied' | 'approved' | 'cancelled'; durationMs: number; code?: string; at: string };

/** Append-only, private (0600) daily NDJSON trace writer. */
export function fileTraceWriter(directory: string): (event: ToolActivity) => void {
  return event => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('unsafe_trace_directory');
    chmodSync(directory, 0o700);
    const file = join(directory, `${event.at.slice(0, 10)}.ndjson`);
    try { if (lstatSync(file).isSymbolicLink()) throw new Error('unsafe_trace_file'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  };
}

/** Options for {@link createToolBridge}. */
export interface ToolBridgeOptions {
  /** AI SDK tools available to the agent. */
  tools: ToolSet;
  /** Permission per tool. Tools without an entry, or with `'deny'`, are never exposed. */
  permissions: Readonly<Record<string, ToolPermission>>;
  /** Further restrict exposure to these names (intersection). Defaults to every permitted tool. */
  allowedTools?: readonly string[];
  /** Aborts every in-flight call (for example, when the turn is cancelled). */
  signal?: AbortSignal;
  /** Human interaction broker. Without it, `ask` tools and `ask_user` fail closed. */
  interactions?: ToolInteractions;
  /** Per-call execution deadline in ms, excluding human waits. @default 5000 */
  timeoutMs?: number;
  /** Deadlines for specific tools, overriding `timeoutMs` (for example, shell commands). */
  toolTimeouts?: Readonly<Record<string, number>>;
  /**
   * AI SDK sandbox passed to every tool as `options.experimental_sandbox`,
   * read at call time. The runtime binds the conversation's sandbox.
   */
  sandbox?: () => Experimental_SandboxSession | undefined;
  /** Audit sink; see {@link fileTraceWriter}. @default no persistence */
  persist?: (event: ToolActivity) => void;
  /** Observer for audit events. */
  onTool?: (event: ToolActivity) => void;
  /**
   * Context passed to every tool as `options.context`, read at call time.
   * The runtime uses it to bind the active conversation's attachment folder;
   * it never comes from the model.
   */
  context?: () => Readonly<Record<string, unknown>> | undefined;
  /**
   * Tools whose calls do not count towards the per-session limit of 100 calls
   * (each call ID still runs at most once). The runtime uses it for
   * `stay_silent`, which a long-lived shared conversation calls on many turns.
   */
  uncounted?: readonly string[];
  /**
   * The running turn is unattended (started by an automation, nobody is
   * watching), read at call time. Its calls never prompt anyone: a call that
   * needs approval is refused with `approval_required`, unless its tool is
   * pre-approved; an `ask_user` question is refused with `question_required`.
   * The tool is never executed, and every later call of the same turn is
   * refused with `unattended_stopped`, so the agent ends the turn.
   */
  unattended?: () => UnattendedPolicy | undefined;
  /**
   * The running turn requested a decision (`request_decision`), read at call
   * time: the work is paused until people decide, so every later call of the
   * turn is refused with `decision_pending` (the tool never runs) and the
   * agent ends the turn. The decision tools themselves stay callable.
   */
  paused?: () => boolean;
}

/**
 * How an unattended turn treats approvals (see {@link ToolBridgeOptions.unattended}).
 * Pass the same object for the whole turn: the bridge remembers a refusal per object.
 *
 * - `preApproved`: tools whose `'ask'` calls run without asking. `'deny'`
 *   tools stay denied, and questions (`ask_user`) can never be pre-approved.
 * - `onBehalfOf`: the person who pre-approved them. A call that uses
 *   someone's own account (`PreparedCall.onBehalfOf`, for example their
 *   Atlassian token) runs without asking only when it is that same person.
 * - `source`: what started the turn (for example `n8n`), told to the agent.
 */
/**
 * How an unattended turn runs (see {@link ToolBridgeOptions.unattended}).
 * `source`: what started it (`n8n`, `conductor`, `api`); `kind`, `token`
 * and `name`: the automation token or scheduled task, for memory provenance.
 */
export type UnattendedPolicy = { readonly preApproved: readonly string[]; readonly onBehalfOf?: string; readonly source?: string; readonly kind?: 'automation' | 'schedule'; readonly token?: string; readonly name?: string;
  /** The verdict floor of this automation's untrusted memory writes (see `reviewFloor`). @default 'flag' */
  readonly memoryFloor?: 'accept' | 'flag' | 'ask_human' };
/** Fixed codes of calls refused in an unattended turn. */
export const UNATTENDED_CODES = Object.freeze(['approval_required', 'question_required', 'unattended_stopped'] as const);
export type UnattendedCode = typeof UNATTENDED_CODES[number];
const UNATTENDED_TEXT: Record<UnattendedCode, string> = {
  approval_required: 'Not run: this turn is unattended (started by an automation) and nobody can approve this call. Do not retry and do not call other tools. End the turn now with one short sentence saying which action needs approval.',
  question_required: 'Not asked: this turn is unattended (started by an automation) and nobody can answer questions. Do not call other tools. End the turn now with one short sentence saying what you would need to know.',
  unattended_stopped: 'Not run: an earlier call of this unattended turn needed a person. End the turn now.',
};

/** Tools a turn may still call after it requested a decision (see {@link ToolBridgeOptions.paused}). */
const PAUSE_EXEMPT = new Set(['request_decision', 'cancel_decision', 'stay_silent']);
const DECISION_PENDING_TEXT = 'Not run: you requested a decision in this turn, so the work is paused until people decide. Do not call other tools. End the turn now with one short sentence saying what you need decided.';

/** One item of a tool result as sent to Letta (the Agent SDK's `AgentToolResultContent`): text, or a base64 image. */
type ToolOutput = { content: AgentToolResultContent[]; isError: boolean };
/** Most characters of text a tool may return. */
export const TOOL_OUTPUT_LIMIT = 16_000;
/** Most images (and their combined base64 size) a tool may return. */
export const TOOL_IMAGE_LIMITS = Object.freeze({ maxImages: 4, maxTotalBase64: 12 * 1024 * 1024 });
const TOOL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Letta tool-result content for a tool's output. Tools with `toModelOutput`
 * decide what the model sees (text, or text and images); others are sent as
 * JSON. Images must be base64 PNG, JPEG, GIF or WebP.
 */
async function modelContent(definition: { toModelOutput?: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown }, id: string, input: unknown, output: unknown): Promise<ToolOutput> {
  const converted = definition.toModelOutput ? await definition.toModelOutput({ toolCallId: id, input, output }) as { type: string; value: unknown } : undefined;
  const text = (value: string, isError = false): ToolOutput => {
    if (typeof value !== 'string' || value.length > TOOL_OUTPUT_LIMIT) throw new Error('tool_output_limit');
    return { content: [{ type: 'text', text: value }], isError };
  };
  if (!converted) return text(JSON.stringify(output));
  if (converted.type === 'text') return text(converted.value as string);
  if (converted.type === 'json') return text(JSON.stringify(converted.value));
  if (converted.type === 'error-text') return text(converted.value as string, true);
  if (converted.type === 'error-json') return text(JSON.stringify(converted.value), true);
  if (converted.type !== 'content' || !Array.isArray(converted.value)) throw new Error('tool_output_limit');
  const content: AgentToolResultContent[] = [];
  let chars = 0; let images = 0; let base64 = 0;
  for (const part of converted.value as { type: string; text?: string; mediaType?: string; data?: unknown }[]) {
    if (part.type === 'text' && typeof part.text === 'string') { chars += part.text.length; content.push({ type: 'text', text: part.text }); continue; }
    const data = part.type === 'file' && part.data && typeof part.data === 'object' && (part.data as { type?: unknown }).type === 'data' ? (part.data as { data?: unknown }).data : part.type === 'image-data' || part.type === 'file-data' ? part.data : undefined;
    if (typeof data !== 'string' || !TOOL_IMAGE_TYPES.has(String(part.mediaType)) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('tool_output_limit');
    images++; base64 += data.length;
    content.push({ type: 'image', data, mimeType: part.mediaType! });
  }
  if (chars > TOOL_OUTPUT_LIMIT || images > TOOL_IMAGE_LIMITS.maxImages || base64 > TOOL_IMAGE_LIMITS.maxTotalBase64) throw new Error('tool_output_limit');
  return { content, isError: false };
}

/**
 * Map AI SDK tools onto Letta client-side tools with a fail-closed policy:
 * schema validation before anything else, exactly-once execution per call ID,
 * per-call approval bound to a snapshot of the arguments, deadlines,
 * cancellation, bounded output and sanitized errors.
 */
export function createToolBridge(options: ToolBridgeOptions) {
  const definitions = options.tools as Record<string, { description?: string; inputSchema: Parameters<typeof asSchema>[0]; execute?: (args: unknown, context: { toolCallId: string; messages: []; abortSignal: AbortSignal; context: Readonly<Record<string, unknown>>; experimental_sandbox?: Experimental_SandboxSession }) => unknown; toModelOutput?: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown }>;
  const permissions = options.permissions;
  const restrict = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const allowed = new Set(Object.keys(definitions).filter(n => (!restrict || restrict.has(n)) && Object.hasOwn(permissions, n) && (permissions[n] === 'allow' || permissions[n] === 'ask') && (n === ASK_USER_TOOL || typeof definitions[n]?.execute === 'function')));
  const sessionId = randomUUID();
  const seen = new Set<string>();
  const uncountedSeen = new Set<string>();
  const validators = new Map<string, ReturnType<Ajv['compile']>>();
  const ajv = new Ajv({ strict: false, allErrors: false });
  const validateArguments = async (name: string, args: unknown) => {
    try {
      let validate = validators.get(name);
      if (!validate) { validate = ajv.compile(await asSchema(definitions[name]!.inputSchema).jsonSchema); validators.set(name, validate); }
      if (!validate(args)) return false;
      if (name === ASK_USER_TOOL) validateQuestion(args as Question);
      return true;
    } catch { return false; }
  };
  const emit = (name: string, id: string, status: ToolActivity['status'], started: number, code?: string) => {
    const event: ToolActivity = { type: 'tool', sessionId, callId: createHash('sha256').update(id).digest('hex').slice(0, 24), tool: Object.hasOwn(definitions, name) ? name : 'unknown', status, durationMs: Math.max(0, Date.now() - started), at: new Date().toISOString(), ...(code ? { code } : {}) };
    options.persist?.(event);
    options.onTool?.(event);
  };
  const denied = (name: string, id: string, code: string): ToolOutput => { emit(name, id, 'denied', Date.now(), code); return { content: [{ type: 'text', text: JSON.stringify({ error: code }) }], isError: true }; };
  // Unattended turns whose calls were already refused once (by policy object, so per turn).
  const stopped = new WeakSet<UnattendedPolicy>();
  const refuse = (policy: UnattendedPolicy, name: string, id: string, code: UnattendedCode): ToolOutput => {
    stopped.add(policy);
    emit(name, id, 'denied', Date.now(), code);
    return { content: [{ type: 'text', text: JSON.stringify({ error: code, tool: name, message: UNATTENDED_TEXT[code] }) }], isError: true };
  };
  const execute = async (name: string, id: string, args: unknown, sdkSignal?: AbortSignal): Promise<ToolOutput> => {
    if (!allowed.has(name)) return denied(name, id, 'tool_denied');
    if (options.paused?.() && !PAUSE_EXEMPT.has(name)) {
      emit(name, id, 'denied', Date.now(), 'decision_pending');
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'decision_pending', message: DECISION_PENDING_TEXT }) }], isError: true };
    }
    const unattended = options.unattended?.();
    if (unattended && stopped.has(unattended)) return refuse(unattended, name, id, 'unattended_stopped');
    const counted = !options.uncounted?.includes(name);
    if (seen.has(id) || uncountedSeen.has(id) || (counted && seen.size >= 100) || uncountedSeen.size >= 100_000) return denied(name, id, 'duplicate_or_limit');
    (counted ? seen : uncountedSeen).add(id);
    const definition = definitions[name]!;
    // Snapshot before any await; caller mutation cannot change an approved call.
    try { args = structuredClone(args); } catch { return denied(name, id, 'invalid_arguments'); }
    const control = new AbortController();
    const signal = AbortSignal.any([control.signal, ...[options.signal, sdkSignal].filter((s): s is AbortSignal => !!s)]);
    if (!await validateArguments(name, args)) return denied(name, id, 'invalid_arguments');
    const started = Date.now();
    const deadline = (Object.hasOwn(options.toolTimeouts ?? {}, name) ? options.toolTimeouts![name] : undefined) ?? options.timeoutMs ?? 5000;
    // An unattended turn never prepares an 'ask' call nobody pre-approved: it is refused before anything runs.
    if (unattended && permissions[name] === 'ask' && !unattended.preApproved.includes(name)) return refuse(unattended, name, id, 'approval_required');
    // Optional preparation (see PrepareCall): may answer now, or require approval with a preview.
    const prepare = (definition as { [PREPARE_CALL]?: PrepareCall })[PREPARE_CALL];
    let prepared: PreparedCall = {};
    if (typeof prepare === 'function') {
      const control = new AbortController();
      const timer = setTimeout(() => control.abort(), deadline);
      const prepareSignal = AbortSignal.any([signal, control.signal]);
      try {
        prepared = await Promise.race([Promise.resolve().then(() => prepare(args, { toolCallId: id, abortSignal: prepareSignal, context: options.context?.() ?? {} })),
          new Promise<never>((_, reject) => prepareSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))]) ?? {};
      } catch {
        const code = signal.aborted ? 'tool_cancelled' : control.signal.aborted ? 'tool_timeout' : 'tool_failed';
        emit(name, id, 'error', started, code);
        return { content: [{ type: 'text', text: JSON.stringify({ error: code }) }], isError: true };
      } finally { clearTimeout(timer); }
      if (prepared.output !== undefined) {
        try {
          const result = await modelContent(definition, id, args, prepared.output);
          emit(name, id, result.isError ? 'error' : 'completion', started, result.isError ? 'tool_reported_error' : 'prepared');
          return result;
        } catch { emit(name, id, 'error', started, 'tool_failed'); return { content: [{ type: 'text', text: JSON.stringify({ error: 'tool_failed' }) }], isError: true }; }
      }
    }
    const asks = permissions[name] === 'ask' || prepared.approval === 'required';
    let preApproved = false;
    let approvedByPerson = false;
    if (unattended && (asks || name === ASK_USER_TOOL)) {
      // Nobody can answer: never prompt. A pre-approved tool runs, unless the call uses someone else's account.
      if (name === ASK_USER_TOOL) return refuse(unattended, name, id, 'question_required');
      if (!unattended.preApproved.includes(name) || (prepared.onBehalfOf !== undefined && prepared.onBehalfOf !== unattended.onBehalfOf)) return refuse(unattended, name, id, 'approval_required');
      emit(name, id, 'approved', started, 'pre_approved');
      preApproved = true;
    }
    if ((asks || name === ASK_USER_TOOL) && !preApproved) {
      try {
        signal.throwIfAborted();
        if (!options.interactions) return denied(name, id, 'interaction_unavailable');
        if (asks) {
          // A prompt with an expiry is withdrawn at that time; the call then ends as expired, not as a failure.
          const expiry = prepared.expires ? AbortSignal.timeout(Math.max(1, prepared.expires.at - Date.now())) : undefined;
          let answer: Awaited<ReturnType<ToolInteractions['request']>>;
          try {
            answer = await options.interactions.request({ kind: 'approval', toolCallId: id, tool: name, title: `Approve ${name}?`, details: JSON.stringify(args), ...(prepared.preview ? { preview: prepared.preview } : {}), ...(prepared.onBehalfOf ? { onBehalfOf: prepared.onBehalfOf } : {}), ...(prepared.denied?.allowNote ? { allowNote: true } : {}), ...(prepared.expires ? { expiresAt: new Date(prepared.expires.at).toISOString() } : {}) }, expiry ? AbortSignal.any([signal, expiry]) : signal);
          } catch (error) {
            if (expiry?.aborted && !signal.aborted) {
              // Not answered in time: the tool decides what happens to the call (it never runs as approved).
              try {
                const output = await prepared.expires!.onExpire();
                const result = await modelContent(definition, id, args, output);
                // An output naming an error (for example `review_expired`) is reported as one.
                const failed = result.isError || (!!output && typeof output === 'object' && typeof (output as { error?: unknown }).error === 'string');
                emit(name, id, failed ? 'denied' : 'completion', started, 'approval_expired');
                return { ...result, isError: failed };
              } catch { emit(name, id, 'error', started, 'tool_failed'); return { content: [{ type: 'text', text: JSON.stringify({ error: 'tool_failed' }) }], isError: true }; }
            }
            throw error;
          }
          signal.throwIfAborted();
          if (answer.approved !== true) {
            if (answer.cancelled || !prepared.denied) return denied(name, id, answer.cancelled ? 'approval_cancelled' : 'user_denied');
            // The tool says what a denial means to the agent, with the person's note if they wrote one.
            emit(name, id, 'denied', Date.now(), 'user_denied');
            const note = prepared.denied.allowNote && answer.text ? answer.text : undefined;
            return { content: [{ type: 'text', text: JSON.stringify({ error: 'user_denied', message: prepared.denied.message, ...(note ? { note } : {}) }) }], isError: true };
          }
          approvedByPerson = true;
          emit(name, id, 'approved', started, 'approved_once');
        }
        if (name === ASK_USER_TOOL) {
          const question = args as Question;
          const answer = await options.interactions.request({ kind: 'question', toolCallId: id, tool: name, title: question.question, options: question.options, allowFreeText: question.allowFreeText, multiSelect: question.multiSelect }, signal);
          signal.throwIfAborted();
          const output = answer.cancelled ? { cancelled: true } : { cancelled: false, selected: answer.selected ?? [], ...(answer.text ? { text: answer.text } : {}) };
          emit(name, id, answer.cancelled ? 'cancelled' : 'completion', started, answer.cancelled ? 'user_cancelled' : 'answered');
          return { content: [{ type: 'text', text: JSON.stringify(output) }], isError: false };
        }
      } catch { return denied(name, id, signal.aborted ? 'tool_cancelled' : 'interaction_unavailable'); }
    }
    emit(name, id, 'start', started, preApproved ? 'pre_approved' : asks ? 'approved_once' : 'static_allow');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new Error(control.signal.aborted ? 'tool_timeout' : 'tool_cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => control.abort(), deadline);
      });
      const base = options.context?.() ?? {};
      const context = Object.freeze({ ...base, ...(prepared.state !== undefined ? { [PREPARED_CONTEXT]: prepared.state } : {}), [REVIEWED_CONTEXT]: approvedByPerson });
      const sandbox = options.sandbox?.();
      const output = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return definition.execute!(args, { toolCallId: id, messages: [], abortSignal: signal, context, ...(sandbox ? { experimental_sandbox: sandbox } : {}) }); }), interrupted]);
      const result = await modelContent(definition, id, args, output);
      emit(name, id, result.isError ? 'error' : 'completion', started, result.isError ? 'tool_reported_error' : undefined);
      return result;
    } catch {
      const code = signal.aborted ? (control.signal.aborted ? 'tool_timeout' : 'tool_cancelled') : 'tool_failed';
      emit(name, id, 'error', started, code);
      return { content: [{ type: 'text', text: JSON.stringify({ error: code }) }], isError: true };
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  };
  const tools: AnyAgentTool[] = [...allowed].map(name => ({ name, label: name, description: definitions[name]!.description ?? name, parameters: asSchema(definitions[name]!.inputSchema).jsonSchema as AnyAgentTool['parameters'], execute: (id: string, args: unknown, signal?: AbortSignal) => execute(name, id, args, signal) }) as AnyAgentTool);
  return {
    /** Letta client-tool descriptors. */
    tools,
    /** Names exposed to the agent. */
    allowedTools: [...allowed],
    /** Execute one call through the full policy. */
    execute,
    /** Letta `canUseTool` hook: allow only exposed tools with valid arguments. */
    canUseTool: async (name: string, input?: Record<string, unknown>, _context?: unknown) => {
      if (allowed.has(name) && (input === undefined || await validateArguments(name, input))) return { behavior: 'allow' as const };
      denied(name, randomUUID(), 'permission_denied');
      return { behavior: 'deny' as const, message: 'Tool not allowed by this session.' };
    },
  };
}

/** Return type of {@link createToolBridge}. */
export type ToolBridge = ReturnType<typeof createToolBridge>;
