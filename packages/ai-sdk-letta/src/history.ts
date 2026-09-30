import type { LettaCodeSession, ListMessagesOptions, ListMessagesResult, LettaConversation } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';

/** Maximum backend records loaded when restoring a conversation's display history. */
export const HISTORY_LIMIT = 10_000;
type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
/** Strip terminal escape sequences and control characters from untrusted text. */
export const sanitizeText = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

/** The installed SDK drops agent_id for default history. Its supported command
 * escape hatch forwards the backend's agent-scoped query, including real cursors.
 * Named conversations use the ordinary SDK API. Neither path sends input.
 */
export async function historyPage(session: Pick<LettaCodeSession, 'listMessages' | 'sendCommand'>, agentId: string, conversationId: string, options: ListMessagesOptions, timeoutMs?: number): Promise<ListMessagesResult> {
  if (conversationId !== 'default' && timeoutMs === undefined) return session.listMessages({ ...options, conversationId });
  const response = await session.sendCommand({ type: 'conversation_messages_list', conversation_id: conversationId, query: { ...options, agent_id: agentId } }, { responseType: 'conversation_messages_list_response', ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  if (response.success !== true || !Array.isArray(response.messages)) throw new Error('Unable to load authoritative default conversation history');
  return { messages: response.messages as ListMessagesResult['messages'],
    ...(typeof response.has_more === 'boolean' ? { hasMore: response.has_more } : {}),
    ...(typeof response.next_before === 'string' || response.next_before === null ? { nextBefore: response.next_before } : {}) };
}

/** Page backwards through history up to `maximum` records, validating cursors and IDs. */
export async function loadHistory(page: (options: ListMessagesOptions) => Promise<ListMessagesResult>, maximum = HISTORY_LIMIT) {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error('Invalid history bound');
  const newest: ListMessagesResult['messages'] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let before: string | undefined;
  let truncated = false;
  while (true) {
    const limit = Math.min(100, maximum - newest.length);
    const result = await page({ order: 'desc', limit, ...(before ? { before } : {}) });
    if (!Array.isArray(result.messages) || result.messages.length > limit) throw new Error('Invalid or oversized history page');
    for (const message of result.messages) {
      if (!message.id || ids.has(message.id)) throw new Error('History pagination returned duplicate or missing message IDs');
      ids.add(message.id); newest.push(message);
    }
    if (result.hasMore === false) break;
    if (!result.messages.length) {
      if (result.hasMore === true) throw new Error('History pagination reported more data but returned no messages');
      break;
    }
    if (newest.length >= maximum) { truncated = true; break; }
    const cursor = result.nextBefore ?? result.messages.at(-1)?.id;
    if (!cursor || cursors.has(cursor) || cursor === before) throw new Error('History pagination did not advance');
    cursors.add(cursor); before = cursor;
  }
  // Preserve backend order (including equal timestamps and split tool IDs).
  return { messages: newest.reverse(), truncated };
}

function textContent(content: unknown, user = false): string {
  let text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => {
    const p = record(part); return p?.type === 'text' && typeof p.text === 'string' ? p.text : '';
  }).filter(Boolean).join('\n') : '';
  if (user) {
    // Harness inserts these as ordinary user content on reconnect. Never expose
    // environment, memory, or system internals as if the user had typed them.
    text = text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '').replace(/<system-reminder\b[\s\S]*$/gi, '');
    try {
      const envelope = JSON.parse(text);
      if (envelope && typeof envelope === 'object' && typeof envelope.type === 'string') {
        if (envelope.type === 'user_message' && typeof envelope.message === 'string') text = envelope.message;
        else if (['heartbeat', 'system_message', 'system_alert', 'memory_warning'].includes(envelope.type)) return '';
      }
    } catch { /* ordinary human text */ }
  }
  return sanitizeText(text).trim();
}

/** Display-only message time from the backend record, when it is a valid date. */
function timestamp(row: Row): { metadata?: { createdAt: string } } {
  const time = typeof row.date === 'string' ? Date.parse(row.date) : NaN;
  return Number.isFinite(time) ? { metadata: { createdAt: new Date(time).toISOString() } } : {};
}

/** Display projection only. Never reconstruct the model's context from this.
 * Completed allowlisted app tools become inert output cards; everything else is
 * omitted, including pending approvals, reasoning, system, memory and events.
 */
export function projectHistory(messages: ListMessagesResult['messages'], appTools: readonly string[]): UIMessage[] {
  const returns = new Map<string, Row>();
  for (const message of messages) {
    const row = message as unknown as Row;
    if (row.message_type === 'tool_return_message' && typeof row.tool_call_id === 'string') returns.set(row.tool_call_id, row);
  }
  const shownCalls = new Set<string>();
  const projected: UIMessage[] = [];
  for (const message of messages) {
    const row = message as unknown as Row;
    if (row.message_type === 'user_message' || row.message_type === 'assistant_message') {
      const role = row.message_type === 'user_message' ? 'user' : 'assistant';
      const text = textContent(row.content, role === 'user');
      if (text) projected.push({ id: `history-${message.id}`, role, parts: [{ type: 'text', text }], ...timestamp(row) });
    } else if (row.message_type === 'tool_call_message' || row.message_type === 'approval_request_message') {
      const call = record(row.tool_call);
      const id = call?.tool_call_id;
      const name = call?.name;
      if (!call || typeof id !== 'string' || typeof name !== 'string' || !appTools.includes(name) || shownCalls.has(id)) continue;
      const output = returns.get(id);
      if (!output || !['success', 'error'].includes(String(output.status))) continue;
      let input: unknown;
      try { input = typeof call.arguments === 'string' ? JSON.parse(sanitizeText(call.arguments)) : JSON.parse(sanitizeText(JSON.stringify(call.arguments))); }
      catch { continue; }
      const text = textContent(output.tool_return);
      let value: unknown = text;
      try { value = JSON.parse(text); } catch { /* text output */ }
      shownCalls.add(id);
      projected.push({ id: `history-${message.id}`, role: 'assistant', ...timestamp(row), parts: [{
        type: 'dynamic-tool', toolName: name, toolCallId: id, input,
        providerExecuted: true,
        ...(output.status === 'error' ? { state: 'output-error', errorText: text } : { state: 'output-available', output: value }),
      }] });
    }
  }
  return projected;
}

/** @throws when the conversation ends with an unanswered user turn or an unfinished tool call. */
export function assertHistorySettled(messages: ListMessagesResult['messages']) {
  // Conservative: do not resume an abandoned prompt or half-completed tool chain.
  let pendingUser = false;
  const calls = new Set<string>();
  for (const message of messages) {
    const row = message as unknown as Row;
    if (row.message_type === 'user_message' && textContent(row.content, true)) pendingUser = true;
    if (row.message_type === 'assistant_message' && textContent(row.content)) pendingUser = false;
    if (row.message_type === 'tool_call_message' || row.message_type === 'approval_request_message') {
      const id = record(row.tool_call)?.tool_call_id;
      if (typeof id === 'string') calls.add(id);
    }
    if (row.message_type === 'tool_return_message' && typeof row.tool_call_id === 'string') calls.delete(row.tool_call_id);
  }
  if (pendingUser || calls.size) throw new Error('Conversation history has an unfinished or uncertain turn. Inspect backend; no implicit retry or repair. Select another conversation to continue.');
}

/** List every conversation of one agent, failing closed on foreign or repeated rows. */
export async function listConversations(list: (options: { agentId: string; after?: string; limit: number; order: 'asc'; orderBy: 'createdAt' }) => Promise<LettaConversation[]>, agentId: string) {
  const result: LettaConversation[] = [];
  const ids = new Set<string>();
  let after: string | undefined;
  while (true) {
    const page = await list({ agentId, limit: 100, order: 'asc', orderBy: 'createdAt', ...(after ? { after } : {}) });
    if (!page.length) break;
    for (const conversation of page) {
      if (conversation.agent_id !== agentId || ids.has(conversation.id)) throw new Error('Conversation listing returned wrong agent or non-advancing cursor');
      ids.add(conversation.id); result.push(conversation);
    }
    after = page.at(-1)!.id;
    if (result.length > 10_000) throw new Error('Conversation list exceeds 10,000; refusing to silently truncate');
  }
  return result;
}
