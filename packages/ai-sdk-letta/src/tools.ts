import { tool, jsonSchema, asSchema, type Tool, type ToolSet } from 'ai';
import { Ajv } from 'ajv';
import type { AnyAgentTool } from '@letta-ai/letta-agent-sdk';
import { appendFileSync, mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateQuestion, type Question, type ToolInteractions } from './interactions.js';
import type { ToolPermission } from './definition.js';

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
  /** Audit sink; see {@link fileTraceWriter}. @default no persistence */
  persist?: (event: ToolActivity) => void;
  /** Observer for audit events. */
  onTool?: (event: ToolActivity) => void;
}

type ToolOutput = { content: { type: 'text'; text: string }[]; isError: boolean };

/**
 * Map AI SDK tools onto Letta client-side tools with a fail-closed policy:
 * schema validation before anything else, exactly-once execution per call ID,
 * per-call approval bound to a snapshot of the arguments, deadlines,
 * cancellation, bounded output and sanitized errors.
 */
export function createToolBridge(options: ToolBridgeOptions) {
  const definitions = options.tools as Record<string, { description?: string; inputSchema: Parameters<typeof asSchema>[0]; execute?: (args: unknown, context: { toolCallId: string; messages: []; abortSignal: AbortSignal }) => unknown }>;
  const permissions = options.permissions;
  const restrict = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const allowed = new Set(Object.keys(definitions).filter(n => (!restrict || restrict.has(n)) && Object.hasOwn(permissions, n) && (permissions[n] === 'allow' || permissions[n] === 'ask') && (n === ASK_USER_TOOL || typeof definitions[n]?.execute === 'function')));
  const sessionId = randomUUID();
  const seen = new Set<string>();
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
  const execute = async (name: string, id: string, args: unknown, sdkSignal?: AbortSignal): Promise<ToolOutput> => {
    if (!allowed.has(name)) return denied(name, id, 'tool_denied');
    if (seen.has(id) || seen.size >= 100) return denied(name, id, 'duplicate_or_limit');
    seen.add(id);
    const definition = definitions[name]!;
    // Snapshot before any await; caller mutation cannot change an approved call.
    try { args = structuredClone(args); } catch { return denied(name, id, 'invalid_arguments'); }
    const control = new AbortController();
    const signal = AbortSignal.any([control.signal, ...[options.signal, sdkSignal].filter((s): s is AbortSignal => !!s)]);
    if (!await validateArguments(name, args)) return denied(name, id, 'invalid_arguments');
    const started = Date.now();
    if (permissions[name] === 'ask' || name === ASK_USER_TOOL) {
      try {
        signal.throwIfAborted();
        if (!options.interactions) return denied(name, id, 'interaction_unavailable');
        if (permissions[name] === 'ask') {
          const answer = await options.interactions.request({ kind: 'approval', toolCallId: id, tool: name, title: `Approve ${name}?`, details: JSON.stringify(args) }, signal);
          signal.throwIfAborted();
          if (answer.approved !== true) return denied(name, id, answer.cancelled ? 'approval_cancelled' : 'user_denied');
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
    emit(name, id, 'start', started, permissions[name] === 'ask' ? 'approved_once' : 'static_allow');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new Error(control.signal.aborted ? 'tool_timeout' : 'tool_cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => control.abort(), options.timeoutMs ?? 5000);
      });
      const output = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return definition.execute!(args, { toolCallId: id, messages: [], abortSignal: signal }); }), interrupted]);
      const text = JSON.stringify(output);
      if (typeof text !== 'string' || text.length > 16000) throw new Error('tool_output_limit');
      emit(name, id, 'completion', started);
      return { content: [{ type: 'text', text }], isError: false };
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
