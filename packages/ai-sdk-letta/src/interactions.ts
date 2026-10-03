import { randomUUID } from 'node:crypto';

/** Arguments of the built-in `ask_user` tool. */
export type Question = { question: string; options?: { id: string; label: string }[]; allowFreeText?: boolean; multiSelect?: boolean };

/** A prompt the application must show to a human: approve a tool call, or answer a question. */
export type InteractionRequest = {
  /** Unique per prompt; a response must echo it. */
  id: string;
  toolCallId: string;
  tool: string;
  kind: 'approval' | 'question';
  title: string;
  /** For approvals: the exact JSON arguments that will run if approved. */
  details?: string;
  /**
   * For approvals: what the call will do, prepared by the tool for display
   * (for example, the changed blocks of a page). Display only; approval is
   * still bound to `details`.
   */
  preview?: ApprovalPreview;
  /**
   * For approvals: the user whose own account the call uses (for example,
   * their Atlassian token). Shared servers let only that person answer.
   */
  onBehalfOf?: string;
  /** For approvals: whoever denies may add a note for the agent (`InteractionResponse.text`, up to 1000 characters). */
  allowNote?: boolean;
  /**
   * For approvals that expire (ISO time): the tool withdraws the prompt then
   * and the call ends as expired. Hosts let it wait until then rather than
   * applying their own human-wait budget.
   */
  expiresAt?: string;
  options?: Question['options'];
  allowFreeText?: boolean;
  multiSelect?: boolean;
};

/**
 * A tool's readable preview of an approval: `text` for any interface (plain
 * text, for example a before/after of the changed lines), and `data` for
 * richer ones, keyed by `kind` (for example `'atlassian-edit'`).
 */
export type ApprovalPreview = { kind: string; title?: string; text: string; data?: Record<string, unknown> };

/** A human's answer. Approvals use `approved` (and `text`: a note with a denial, when the request allows one); questions use `selected` and/or `text`. */
export type InteractionResponse = { id: string; approved?: boolean; cancelled?: boolean; selected?: string[]; text?: string };

/** Renders one request and resolves with the human's response. `signal` aborts when the prompt is withdrawn. */
export type InteractionHandler = (request: InteractionRequest, signal: AbortSignal) => Promise<unknown>;

type Pending = { request: InteractionRequest; signal: AbortSignal; resolve(value: InteractionResponse): void; reject(error: Error): void; cleanup(): void; control: AbortController };

/**
 * Interaction broker: serializes human prompts (FIFO, one at a time) between
 * tool calls and a single connected renderer (TUI, GUI, or your own).
 *
 * Responses are validated against the exact request and are never interpreted
 * as chat turns. Without a connected renderer, requests fail closed.
 */
export class ToolInteractions {
  private handler?: InteractionHandler;
  private queue: Pending[] = [];
  private active?: Pending;
  private closed = false;

  /** Attach the renderer. Returns a disconnect function that cancels all pending prompts. */
  readonly connect = (handler: InteractionHandler): (() => void) => {
    if (this.closed || this.handler) throw new Error('interaction_unavailable');
    this.handler = handler;
    this.pump();
    return () => { this.handler = undefined; this.cancelAll(); };
  };

  /** Permanently close the broker and cancel every pending prompt. */
  close(): void { this.closed = true; this.handler = undefined; this.cancelAll(); }

  private cancelAll() {
    for (const pending of [...this.queue]) pending.control.abort();
  }

  /** Queue a prompt. Rejects with `interaction_unavailable` if no renderer is connected. */
  request(request: Omit<InteractionRequest, 'id'>, signal: AbortSignal): Promise<InteractionResponse> {
    if (this.closed || !this.handler) return Promise.reject(new Error('interaction_unavailable'));
    if (signal.aborted) return Promise.reject(new Error('tool_cancelled'));
    return new Promise((resolve, reject) => {
      const control = new AbortController();
      const combined = AbortSignal.any([signal, control.signal]);
      const pending: Pending = { request: structuredClone({ ...request, id: randomUUID() }), signal: combined, resolve, reject, control, cleanup: () => combined.removeEventListener('abort', abort) };
      const abort = () => { this.finish(pending, undefined, new Error('tool_cancelled')); };
      combined.addEventListener('abort', abort, { once: true });
      this.queue.push(pending);
      this.pump();
    });
  }

  private pump() {
    if (this.active || !this.handler || !this.queue.length) return;
    const pending = this.active = this.queue[0]!;
    const handler = this.handler;
    void Promise.resolve().then(() => {
      pending.signal.throwIfAborted();
      return handler(structuredClone(pending.request), pending.signal);
    }).then(value => {
      if (this.active !== pending) return;
      try { this.finish(pending, validateResponse(pending.request, value)); }
      catch { this.finish(pending, undefined, new Error('invalid_interaction_response')); }
    }, () => this.finish(pending, undefined, new Error('interaction_cancelled')));
  }

  private finish(pending: Pending, value?: InteractionResponse, error?: Error) {
    const index = this.queue.indexOf(pending);
    if (index < 0) return;
    this.queue.splice(index, 1);
    pending.cleanup();
    if (this.active === pending) this.active = undefined;
    // Close the renderer before showing another prompt, including abort races.
    pending.control.abort();
    if (error) pending.reject(error); else pending.resolve(value!);
    queueMicrotask(() => this.pump());
  }
}

/** @throws `invalid_arguments` when a question offers no way to answer or has duplicate option IDs. */
export function validateQuestion(question: Question): void {
  const options = question.options ?? [];
  if ((!options.length && !question.allowFreeText) || new Set(options.map(o => o.id)).size !== options.length) throw new Error('invalid_arguments');
}

/** Validate a human response against the exact request it answers. */
export function validateResponse(request: InteractionRequest, value: unknown): InteractionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  const response = value as InteractionResponse;
  if (response.id !== request.id) throw new Error('stale_response');
  if (response.cancelled === true) return { id: request.id, cancelled: true };
  if (request.kind === 'approval') {
    if (typeof response.approved !== 'boolean') throw new Error('invalid_response');
    if (response.text !== undefined && (typeof response.text !== 'string' || !request.allowNote || response.approved || response.text.length > 1000)) throw new Error('invalid_response');
    const note = response.text?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
    return { id: request.id, approved: response.approved, ...(note ? { text: note } : {}) };
  }
  const selected = response.selected ?? [];
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(id => typeof id !== 'string' || !request.options?.some(o => o.id === id)) || (!request.multiSelect && selected.length > 1)) throw new Error('invalid_response');
  if (response.text !== undefined && (typeof response.text !== 'string' || !request.allowFreeText || response.text.length > 2000)) throw new Error('invalid_response');
  const text = response.text?.trim();
  if (!selected.length && !text) throw new Error('empty_response');
  return { id: request.id, selected, ...(text ? { text } : {}) };
}
