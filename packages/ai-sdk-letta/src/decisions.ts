import { jsonSchema, tool, type Tool } from 'ai';
import type { ToolPermission } from './definition.js';
import type { TurnActor } from './credentials.js';

/**
 * Decisions: the agent asks the people of a conversation to choose, without
 * holding the turn open. `request_decision` records the question with the
 * server (a {@link DecisionDesk}), the agent ends its turn, and the work stays
 * paused until someone decides. The outcome comes back later as a new message
 * of the conversation ("[Decision] Mia chose …"), so the agent resumes the
 * work, or stops it.
 *
 * Unlike `ask_user`, nothing waits: no harness timeout applies, people can
 * keep talking to the agent meanwhile, and a decision can wait for days.
 */

/** Name of the tool that asks for a decision. */
export const REQUEST_DECISION_TOOL = 'request_decision';
/** Name of the tool that withdraws the conversation's pending decision. */
export const CANCEL_DECISION_TOOL = 'cancel_decision';
/** The decision tools' names. */
export const DECISION_TOOL_NAMES = Object.freeze([REQUEST_DECISION_TOOL, CANCEL_DECISION_TOOL] as const);
export type DecisionToolName = typeof DECISION_TOOL_NAMES[number];
/** Key under which the runtime passes the {@link DecisionContext} to tools (`options.context[DECISIONS_CONTEXT]`). Never from the model. */
export const DECISIONS_CONTEXT = 'ai-sdk-letta.decisions';
/** Bounds of a decision. */
export const DECISION_LIMITS = Object.freeze({
  maxQuestionCharacters: 500,
  maxContextCharacters: 2000,
  minOptions: 1,
  maxOptions: 8,
  maxLabelCharacters: 120,
  maxDescriptionCharacters: 300,
  maxCommentCharacters: 1000,
});

/** One choice of a decision. `id`: letters, digits, `-` and `_` (unique within the decision). */
export type DecisionOption = { id: string; label: string; description?: string };
/** What the agent asks, validated. */
export type DecisionRequest = { question: string; options: DecisionOption[]; context?: string; allowComment: boolean };
/** A decision the desk recorded. `replaced`: the pending decision of the same conversation it superseded. */
export type RequestedDecision = { id: string; replaced?: string };

/**
 * Records decisions for the server (people see and decide them in its app).
 * Implemented by `@ai-sdk-letta/server`, bound to the conversation and the
 * person (or automation) of the running turn.
 */
export interface DecisionDesk {
  /** Record a pending decision; a pending one of the same conversation is superseded. @throws an `Error` whose message is a fixed code (`decisions_unavailable`, `decision_limit`, ...). */
  request(request: DecisionRequest, turn: { conversationId: string; toolCallId: string; actor?: TurnActor }): Promise<RequestedDecision>;
  /** Withdraw the conversation's pending decision (or the one with `id`, if it belongs to the conversation). Resolves with its ID, or `undefined` when nothing was pending. */
  cancel(turn: { conversationId: string; actor?: TurnActor }, id?: string): Promise<string | undefined>;
}
/** What the runtime binds for a turn: the desk, the conversation, who the turn acts for, and a callback that pauses the rest of the turn. */
export type DecisionContext = { desk: DecisionDesk; conversationId: string; actor?: TurnActor; requested?: (id: string) => void };

/** Arguments of `request_decision`. */
export type RequestDecisionInput = { question: string; options: DecisionOption[]; context?: string; allowComment?: boolean };
/** Result of `request_decision`, as the agent sees it. */
export type RequestDecisionOutput = { requested: true; id: string; replaced?: string; message: string } | { error: string; message: string };
/** Arguments of `cancel_decision`. */
export type CancelDecisionInput = { id?: string };
/** Result of `cancel_decision`, as the agent sees it. */
export type CancelDecisionOutput = { cancelled: true; id: string; message: string } | { cancelled: false; message: string } | { error: string; message: string };

const FAILURES: Record<string, string> = {
  invalid_input: 'Give a question (1–500 characters) and 1 to 8 options, each with a unique id (letters, digits, - or _) and a label (up to 120 characters).',
  decisions_unavailable: 'Decisions are not available here (no server records them). Ask in your reply instead, or with ask_user if it is available. Nothing was recorded.',
  decision_limit: 'Too many decisions are pending for this agent. Nothing was recorded.',
  conversation_unavailable: 'This conversation cannot take decisions (it is archived or not known to the server). Nothing was recorded.',
};
const failure = (code: string) => ({ error: code, message: FAILURES[code] ?? 'The decision could not be recorded. Nothing was recorded.' });
const visible = (value: string, max: number) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** Multi-line text: controls removed (newlines kept), at most `max` characters. */
const block = (value: string, max: number) => value.replace(/\r\n?/g, '\n').replace(/[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/gu, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const OPTION_ID = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * A decision as the agent asked for it, cleaned and checked: question and
 * labels on one line, context with its paragraphs, unique option IDs.
 * @returns `undefined` when it is not a valid decision
 */
export function parseDecision(input: unknown): DecisionRequest | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const { question, options, context, allowComment } = input as Partial<RequestDecisionInput>;
  if (typeof question !== 'string' || !Array.isArray(options) || (context !== undefined && typeof context !== 'string') || (allowComment !== undefined && typeof allowComment !== 'boolean')) return undefined;
  const q = visible(question, DECISION_LIMITS.maxQuestionCharacters);
  if (!q || question.length > DECISION_LIMITS.maxQuestionCharacters * 2) return undefined;
  if (options.length < DECISION_LIMITS.minOptions || options.length > DECISION_LIMITS.maxOptions) return undefined;
  const ids = new Set<string>();
  const cleaned: DecisionOption[] = [];
  for (const option of options) {
    if (!option || typeof option !== 'object' || typeof option.id !== 'string' || !OPTION_ID.test(option.id) || ids.has(option.id) || typeof option.label !== 'string') return undefined;
    const label = visible(option.label, DECISION_LIMITS.maxLabelCharacters);
    if (!label || (option.description !== undefined && typeof option.description !== 'string')) return undefined;
    const description = typeof option.description === 'string' ? visible(option.description, DECISION_LIMITS.maxDescriptionCharacters) : '';
    ids.add(option.id);
    cleaned.push({ id: option.id, label, ...(description ? { description } : {}) });
  }
  const text = typeof context === 'string' ? block(context, DECISION_LIMITS.maxContextCharacters) : '';
  return { question: q, options: cleaned, ...(text ? { context: text } : {}), allowComment: allowComment !== false };
}

const contextOf = (context: Readonly<Record<string, unknown>> | undefined) => context?.[DECISIONS_CONTEXT] as DecisionContext | undefined;
const errorCode = (error: unknown) => error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'decision_failed';

/** Description of `request_decision` as the model sees it. */
export const REQUEST_DECISION_DESCRIPTION = 'Ask the people of this conversation to decide something before you continue a piece of work (a choice that is theirs to make; not for permission to run a tool). '
  + 'It does not wait for the answer: it records the decision, every member is notified in the app, and the work is paused. After calling it, end your turn at once with one short sentence saying what you need decided; do not continue the work and do not call other tools. '
  + 'Later you receive the outcome as a new message starting with "[Decision]": then resume the work with the chosen option, or stop it if they chose to stop. People may keep talking to you meanwhile; the decision stays open until someone decides. '
  + 'A new request_decision in this conversation replaces a pending one; cancel_decision withdraws it.';

/**
 * `request_decision(question, options, context?, allowComment?)`: ask the
 * people of the conversation to decide, then end the turn. People see the
 * decision in the app (a notification and a card in the conversation); any
 * member of the agent can decide, once. Later calls of the same turn are
 * refused (`decision_pending`), so the agent stops there.
 *
 * ```ts
 * tools: { ...decisionTools }, permissions: { ...DECISION_TOOL_PERMISSIONS } // both 'allow'
 * ```
 */
export const requestDecisionTool: Tool<RequestDecisionInput, RequestDecisionOutput> = tool({
  description: REQUEST_DECISION_DESCRIPTION,
  inputSchema: jsonSchema<RequestDecisionInput>({
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: DECISION_LIMITS.maxQuestionCharacters, description: 'The decision to make, as a question people can answer by choosing an option.' },
      options: {
        type: 'array', minItems: DECISION_LIMITS.minOptions, maxItems: DECISION_LIMITS.maxOptions, description: 'The choices (people can also choose to stop the work, so do not add a "stop" option).',
        items: { type: 'object', properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$', description: 'Short unique ID, for example "a" or "markdown".' },
          label: { type: 'string', minLength: 1, maxLength: DECISION_LIMITS.maxLabelCharacters },
          description: { type: 'string', maxLength: DECISION_LIMITS.maxDescriptionCharacters, description: 'One line on what this choice means (optional).' },
        }, required: ['id', 'label'], additionalProperties: false },
      },
      context: { type: 'string', maxLength: DECISION_LIMITS.maxContextCharacters, description: 'What people need to know to decide (optional, a few sentences).' },
      allowComment: { type: 'boolean', description: 'Whether people may add a comment with their choice (default true).' },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  }),
  execute: async (input: RequestDecisionInput, options: { toolCallId: string; context?: Readonly<Record<string, unknown>> }): Promise<RequestDecisionOutput> => {
    const request = parseDecision(input);
    if (!request) return failure('invalid_input');
    const bound = contextOf(options.context);
    if (!bound) return failure('decisions_unavailable');
    try {
      const recorded = await bound.desk.request(request, { conversationId: bound.conversationId, toolCallId: options.toolCallId, ...(bound.actor ? { actor: bound.actor } : {}) });
      bound.requested?.(recorded.id);
      return { requested: true, id: recorded.id, ...(recorded.replaced ? { replaced: recorded.replaced } : {}),
        message: `Decision requested (id ${recorded.id})${recorded.replaced ? `; it replaces the pending decision ${recorded.replaced}` : ''}. The work is paused: end your turn now with one short sentence saying what you need decided. Do not continue the work and do not call other tools. You will receive the outcome as a new message starting with "[Decision]".` };
    } catch (error) { return failure(errorCode(error)); }
  },
});

/**
 * `cancel_decision(id?)`: withdraw the conversation's pending decision (for
 * example, when the discussion settled it). Nobody can decide it any more and
 * no outcome message follows.
 */
export const cancelDecisionTool: Tool<CancelDecisionInput, CancelDecisionOutput> = tool({
  description: 'Withdraw the pending decision of this conversation (for example, when the discussion settled it, or it is no longer needed). Nobody can decide it any more, and no "[Decision]" message will follow.',
  inputSchema: jsonSchema<CancelDecisionInput>({
    type: 'object',
    properties: { id: { type: 'string', maxLength: 100, description: 'The decision ID (optional: the pending decision of this conversation).' } },
    additionalProperties: false,
  }),
  execute: async (input: CancelDecisionInput, options: { context?: Readonly<Record<string, unknown>> }): Promise<CancelDecisionOutput> => {
    const bound = contextOf(options.context);
    if (!bound) return failure('decisions_unavailable');
    try {
      const id = await bound.desk.cancel({ conversationId: bound.conversationId, ...(bound.actor ? { actor: bound.actor } : {}) }, typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : undefined);
      return id ? { cancelled: true, id, message: `Decision ${id} withdrawn.` } : { cancelled: false, message: 'No decision is pending in this conversation (it may have been decided already).' };
    } catch (error) { return failure(errorCode(error)); }
  },
});

/** The decision tools, to spread into a definition's `tools`. */
export const decisionTools: { readonly request_decision: typeof requestDecisionTool; readonly cancel_decision: typeof cancelDecisionTool } = Object.freeze({ [REQUEST_DECISION_TOOL]: requestDecisionTool, [CANCEL_DECISION_TOOL]: cancelDecisionTool });
/** Default permissions: asking for a decision is itself the human gate, so both run without approval. */
export const DECISION_TOOL_PERMISSIONS: Readonly<Record<DecisionToolName, ToolPermission>> = Object.freeze({ request_decision: 'allow', cancel_decision: 'allow' });
/** Does the definition include `request_decision` (with a permission other than deny)? */
export const decisionsEnabled = (definition: { tools: Record<string, unknown>; permissions: Readonly<Record<string, ToolPermission>> }) =>
  Object.hasOwn(definition.tools, REQUEST_DECISION_TOOL) && definition.permissions[REQUEST_DECISION_TOOL] === 'allow';

/* ------------------------------------------------------------------ */
/* What the agent is told                                              */
/* ------------------------------------------------------------------ */

/** Text the agent may read safely inside a note: no markup, one line. */
const quote = (value: string, max = 300) => visible(value.replace(/[<>]/g, ''), max);

/** The outcome of a decision, as delivered to the agent. */
export type DecisionOutcome = {
  id: string; question: string;
  /** `'decided'`: an option was chosen; `'stopped'`: someone chose to stop the work. */
  outcome: 'decided' | 'stopped';
  /** Who decided (their display name). */
  by: string;
  choice?: { id: string; label: string };
  comment?: string;
};

/**
 * The message that brings a decision's outcome to the agent (a new turn of
 * the conversation). Shown in the app as a compact "Decided by …" line.
 */
export function decisionMessage(decision: DecisionOutcome): string {
  const by = quote(decision.by, 120) || 'Someone';
  const comment = decision.comment ? block(decision.comment, DECISION_LIMITS.maxCommentCharacters) : '';
  const head = decision.outcome === 'stopped'
    ? `[Decision] ${by} decided to stop this work: “${quote(decision.question)}” (decision ${decision.id}).`
    : `[Decision] ${by} chose “${quote(decision.choice?.label ?? decision.choice?.id ?? '', 200)}” (option ${quote(decision.choice?.id ?? '', 40)}) for “${quote(decision.question)}” (decision ${decision.id}).`;
  return comment ? `${head}\nComment: ${comment}` : head;
}

/** The note that comes with {@link decisionMessage}: what the agent does now. */
export function decisionOutcomeNote(outcome: DecisionOutcome['outcome']): string {
  return outcome === 'stopped'
    ? 'This message is the outcome of a decision you requested: the people chose to stop that work. Do not continue it; reply in one or two sentences to acknowledge, and mention anything left half done.'
    : 'This message is the outcome of a decision you requested. Resume the paused work now, following the chosen option (and the comment, if any), and finish it in this turn when you can. Reply to the people, as always.';
}

/**
 * The note an ordinary turn carries while a decision of the conversation is
 * pending: the agent may discuss it, but keeps the work paused.
 */
export function pendingDecisionNote(decision: { id: string; question: string; options: readonly DecisionOption[] }): string {
  const options = decision.options.map(option => `${quote(option.id, 40)}: ${quote(option.label, 120)}`).join('; ');
  return `A decision you requested is still pending (decision ${decision.id}): “${quote(decision.question)}” (options: ${options}). Keep that work paused until someone decides in the app; you may discuss it. A message in the chat is not the decision. If the discussion changes the question, call request_decision again (it replaces this one), or cancel_decision when it is no longer needed.`;
}
