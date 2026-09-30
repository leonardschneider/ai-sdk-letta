import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UIMessage } from 'ai';
import { validateResponse, type InteractionRequest, type InteractionResponse, type LettaAgent } from 'ai-sdk-letta';

/** One NDJSON event of a run. The application, never the HTTP consumer, owns tools. */
export type RuntimeEvent = { sequence: number; type: string; data: Record<string, unknown> };
// createdAt/lastActivityAt are optional: threads recorded before they existed stay valid.
type Thread = { id: string; owner: string; conversationId?: string; agentId?: string; title: string; archived: boolean; state: 'creating' | 'ready'; createdAt?: string; lastActivityAt?: string };
/** A single user turn and the events observed while it ran. */
export type Run = { id: string; threadId: string; input: string; parentRunId: string | null; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; events: RuntimeEvent[]; startedAt?: string };
type State = { version: 1; threads: Thread[]; runs: Run[] };
/** An opened agent conversation as seen by the runtime. */
export interface RuntimeSession {
  agentId: string;
  conversationId: string;
  history: UIMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: Pick<LettaAgent<any>, 'stream' | 'interactions'>;
}
/** Opens and closes the single agent session the runtime drives. */
export interface RuntimeHost {
  open(options: { conversationId: string } | { newTitle: string }): Promise<RuntimeSession>;
  close(): Promise<void>;
}
/** A client-visible failure with a fixed code and HTTP status. */
export class RuntimeFault extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Only app-defined, fixed failure codes (e.g. user_denied) are surfaced; never free-form error text. */
const failureReasons = new Set(['user_denied', 'approval_cancelled', 'tool_denied', 'tool_cancelled', 'tool_timeout', 'tool_failed', 'invalid_arguments', 'interaction_unavailable', 'permission_denied', 'duplicate_or_limit', 'tool_output_limit']);
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
    } else if (event.type === 'tool_started') parts.push({ type: 'dynamic-tool', toolName: String(data.name), toolCallId: String(data.toolCallId), state: 'input-available', input: data.input });
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
  const metadata = run.startedAt ? { metadata: { createdAt: run.startedAt } } : {};
  return [{ id: `${run.id}-user`, role: 'user', parts: [{ type: 'text', text: run.input }], ...metadata }, { id: `${run.id}-assistant`, role: 'assistant', parts }];
}

/**
 * Single-owner, single-turn thread service over one agent.
 *
 * Runs are recorded durably before delivery; a run that was in flight when the
 * process stopped is marked `interrupted` and blocks further turns on that
 * thread (uncertain delivery is never replayed). Human answers are validated
 * and accepted exactly once.
 */
export class ThreadRuntime {
  private state: State;
  private locked = false;
  private current?: RuntimeSession;
  private active?: { run: Run; control: AbortController };
  private pending?: { runId: string; request: InteractionRequest; resolve(value: InteractionResponse): void };
  private listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  constructor(private readonly host: RuntimeHost, private readonly filename: string, private readonly owner: string, private readonly deadlineMs = 180_000, private readonly humanWaitMs = 4 * 60_000) {
    this.state = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) as State : { version: 1, threads: [], runs: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.threads) || !Array.isArray(this.state.runs)) throw new Error('Invalid runtime state');
    for (const thread of this.state.threads) thread.archived ??= false;
    for (const run of this.state.runs) if (run.status === 'running') {
      run.status = 'interrupted';
      run.events.push({ sequence: run.events.length + 1, type: 'failed', data: { code: 'delivery_uncertain' } });
    }
    this.save();
  }
  private save() {
    // A leftover temporary file is an uncertain write, not permission to overwrite it.
    const fd = openSync(`${this.filename}.tmp`, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${this.filename}.tmp`, this.filename);
    const directory = openSync(dirname(this.filename), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
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
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.locked || this.active) throw new RuntimeFault('runtime_busy');
    this.locked = true;
    try { return await fn(); } finally { this.locked = false; }
  }
  private async open(thread: Thread) {
    if (this.current && this.current.conversationId === thread.conversationId) return this.current;
    await this.host.close(); this.current = undefined;
    const session = await this.host.open(thread.conversationId ? { conversationId: thread.conversationId } : { newTitle: thread.title });
    const identity = this.state.threads.find(t => t.agentId)?.agentId;
    if (identity && session.agentId !== identity) { await this.host.close(); throw new RuntimeFault('identity_mismatch'); }
    this.current = session;
    return session;
  }
  /** Display metadata only; timestamps are omitted for legacy threads that never recorded them. */
  private summary({ id, title, state, archived, createdAt, lastActivityAt }: Thread) {
    return { id, title, state, archived, ...(createdAt ? { createdAt } : {}), ...(lastActivityAt ? { lastActivityAt } : {}) };
  }
  list(owner: string) {
    this.authorize(owner);
    return this.state.threads.filter(t => t.owner === owner).map(t => this.summary(t));
  }
  /** Local display metadata only: never opens a session or edits backend history. */
  updateMetadata(owner: string, id: string, input: unknown) {
    const thread = this.thread(owner, id);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeFault('invalid_input', 400);
    const fields = Object.keys(input);
    if (!fields.length || fields.some(key => key !== 'title' && key !== 'archived')) throw new RuntimeFault('invalid_input', 400);
    const patch = input as { title?: unknown; archived?: unknown };
    let title = thread.title;
    if (fields.includes('title')) {
      // Reject terminal controls and invisible formatting/bidi controls before trimming.
      if (typeof patch.title !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(patch.title)) throw new RuntimeFault('invalid_input', 400);
      title = patch.title.trim();
      if (!title || title.length > 120) throw new RuntimeFault('invalid_input', 400);
    }
    if (fields.includes('archived') && typeof patch.archived !== 'boolean') throw new RuntimeFault('invalid_input', 400);
    // locked covers session opening before start() has installed its active run.
    if (patch.archived === true && (this.locked || this.active?.run.threadId === id)) throw new RuntimeFault('runtime_busy');
    thread.title = title;
    if (typeof patch.archived === 'boolean') thread.archived = patch.archived;
    this.save();
    return this.summary(thread);
  }
  async create(owner: string, id: string, title: string) {
    this.authorize(owner);
    if (!uuid.test(id) || typeof title !== 'string' || !title.trim() || title.length > 120) throw new RuntimeFault('invalid_input', 400);
    const previous = this.state.threads.find(t => t.id === id);
    if (previous) {
      if (previous.owner !== owner || previous.title !== title) throw new RuntimeFault('id_conflict');
      this.thread(owner, id); return { id, title };
    }
    if (this.state.threads.length >= 200) throw new RuntimeFault('capacity_reached');
    return this.exclusive(async () => {
      const now = new Date().toISOString();
      const thread: Thread = { id, owner, title, archived: false, state: 'creating', createdAt: now, lastActivityAt: now };
      this.state.threads.push(thread); this.save();
      const session = await this.open(thread);
      thread.agentId = session.agentId; thread.conversationId = session.conversationId; thread.state = 'ready'; this.save();
      return { id, title };
    });
  }
  async history(owner: string, id: string) {
    const thread = this.thread(owner, id);
    return this.exclusive(async () => {
      // Refresh through backend history, not a display transcript replay into the agent.
      await this.host.close(); this.current = undefined;
      const session = await this.open(thread);
      return { messages: session.history.filter(m => m.id !== 'session-status'), lastRunId: this.state.runs.filter(r => r.threadId === id).at(-1)?.id ?? null };
    });
  }
  async view(owner: string, id: string) {
    this.thread(owner, id);
    const latest = this.state.runs.filter(r => r.threadId === id).at(-1);
    if (this.active?.run.threadId === id && this.current) return {
      messages: this.current.history.filter(m => m.id !== 'session-status'),
      lastRunId: latest?.id ?? null,
      live: { id: this.active.run.id, input: this.active.run.input },
      status: 'running',
    };
    if (latest && !['running', 'completed'].includes(latest.status)) return {
      messages: this.state.runs.filter(r => r.threadId === id).flatMap(displayRun),
      lastRunId: latest.id, live: null, status: latest.status, source: 'transport-observations',
    };
    return { ...await this.history(owner, id), live: null, status: latest?.status ?? null, source: 'backend-history' };
  }
  private emit(run: Run, type: string, data: Record<string, unknown>) {
    const event = { sequence: run.events.length + 1, type, data };
    run.events.push(event); this.save();
    for (const listener of this.listeners.get(run.id) ?? []) listener(event);
  }
  async start(owner: string, input: { id: string; threadId: string; text: string; parentRunId: string | null }) {
    this.authorize(owner);
    if (!input || !uuid.test(input.id) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000 || (input.parentRunId !== null && !uuid.test(input.parentRunId))) throw new RuntimeFault('invalid_input', 400);
    const thread = this.thread(owner, input.threadId);
    const previous = this.state.runs.find(r => r.id === input.id);
    if (previous) {
      if (previous.threadId !== input.threadId || previous.input !== input.text || previous.parentRunId !== input.parentRunId) throw new RuntimeFault('id_conflict');
      return { id: previous.id, status: previous.status };
    }
    if (thread.archived) throw new RuntimeFault('thread_archived');
    const latest = this.state.runs.filter(r => r.threadId === thread.id).at(-1);
    if (input.parentRunId !== (latest?.id ?? null)) throw new RuntimeFault('history_conflict');
    if (latest && latest.status !== 'completed') throw new RuntimeFault('delivery_uncertain');
    if (this.state.runs.length >= 200) throw new RuntimeFault('capacity_reached');
    return this.exclusive(async () => {
      const session = await this.open(thread);
      const startedAt = new Date().toISOString();
      const run: Run = { id: input.id, threadId: input.threadId, input: input.text, parentRunId: input.parentRunId, status: 'running', events: [], startedAt };
      thread.lastActivityAt = startedAt;
      this.state.runs.push(run); this.save();
      const control = new AbortController(); this.active = { run, control };
      void this.drive(session, run, control);
      return { id: run.id, status: run.status };
    });
  }
  private async drive(session: RuntimeSession, run: Run, control: AbortController) {
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
    const hardTimer = setTimeout(expire, this.deadlineMs + this.humanWaitMs);
    let disconnect = () => {};
    try {
      disconnect = session.agent.interactions.connect((request, signal) => new Promise((resolve, reject) => {
        clearTimeout(timer);
        remaining = Math.max(1, remaining - (Date.now() - resumedAt));
        const waitingAt = Date.now();
        timer = setTimeout(expire, Math.max(1, remainingWait));
        const resume = () => {
          clearTimeout(timer); remainingWait -= Date.now() - waitingAt;
          resumedAt = Date.now(); timer = setTimeout(expire, remaining);
        };
        const abort = () => {
          if (this.pending?.request.id === request.id) {
            this.pending = undefined;
            this.emit(run, 'interaction_ended', { id: request.id, code: timedOut ? 'timed_out' : 'cancelled' });
            resume();
          }
          reject(new RuntimeFault('interaction_cancelled'));
        };
        signal.addEventListener('abort', abort, { once: true });
        this.pending = { runId: run.id, request, resolve: value => {
          signal.removeEventListener('abort', abort);
          if (this.pending?.request.id === request.id) this.pending = undefined;
          resume(); resolve(value);
        } };
        if (signal.aborted) { abort(); return; }
        this.emit(run, 'interaction', request);
      }));
      this.emit(run, 'started', { threadId: run.threadId });
      const result = await session.agent.stream({ prompt: run.input, abortSignal: control.signal });
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') this.emit(run, 'text', { text: part.text });
        else if (part.type === 'tool-call') this.emit(run, 'tool_started', { toolCallId: part.toolCallId, name: part.toolName, input: part.input, execution: 'external' });
        else if (part.type === 'tool-result') this.emit(run, 'tool_completed', { toolCallId: part.toolCallId, name: part.toolName, output: part.output, execution: 'external' });
        else if (part.type === 'tool-error') this.emit(run, 'tool_failed', { toolCallId: part.toolCallId, name: part.toolName, code: 'tool_failed', ...toolFailureReason(part.error), execution: 'external' });
        else if (part.type === 'error' || part.type === 'abort') throw new RuntimeFault('runtime_failed');
      }
      if (this.pending?.runId === run.id) throw new RuntimeFault('interaction_incomplete');
      if (control.signal.aborted || await result.finishReason !== 'stop') throw new RuntimeFault('runtime_failed');
      run.status = 'completed'; this.emit(run, 'completed', {});
    } catch (error) {
      run.status = control.signal.aborted ? 'cancelled' : 'failed';
      const code = timedOut ? 'timed_out' : run.status === 'cancelled' ? 'cancelled' : error instanceof RuntimeFault && error.message === 'interaction_incomplete' ? 'interaction_incomplete' : 'runtime_failed';
      if (this.pending?.runId === run.id) this.emit(run, 'interaction_ended', { id: this.pending.request.id, code });
      this.emit(run, 'failed', { code });
    } finally {
      // Keep the pre-run display snapshot current for browser reconnects without
      // closing a running SDK session or replaying any transcript into the agent.
      session.history = [...session.history, ...displayRun(run)];
      this.pending = undefined; disconnect(); clearTimeout(timer); clearTimeout(hardTimer); this.active = undefined;
    }
  }
  events(owner: string, id: string, after: number) {
    const run = this.run(owner, id);
    if (!Number.isSafeInteger(after) || after < 0 || after > run.events.length) throw new RuntimeFault('invalid_cursor', 400);
    return { events: run.events.slice(after), status: run.status };
  }
  subscribe(id: string, listener: (event: RuntimeEvent) => void) {
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  answer(owner: string, runId: string, response: InteractionResponse) {
    const run = this.run(owner, runId);
    const pending = this.pending;
    if (!pending || pending.runId !== runId || run.status !== 'running') throw new RuntimeFault('stale_interaction');
    let value: InteractionResponse;
    try { value = validateResponse(pending.request, response); } catch { throw new RuntimeFault('invalid_response', 400); }
    this.emit(run, 'interaction_resolved', { id: value.id }); pending.resolve(value);
  }
  cancel(owner: string, id: string) {
    this.run(owner, id);
    if (this.active?.run.id === id) this.active.control.abort();
  }
  async close() { this.active?.control.abort(); await this.host.close(); }
}

