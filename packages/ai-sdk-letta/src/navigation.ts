import type { ListMessagesOptions, ListMessagesResult, LettaConversation } from '@letta-ai/letta-agent-sdk';
import { loadHistory, projectHistory, sanitizeText } from './history.js';
import { titleText } from './title.js';

/** One row of a conversation picker. `title` is plain text (a Markdown title shows its text). */
export type ConversationEntry = { id: string; title: string; date: string };
/** Read-only access to the current agent's conversations, used by pickers and search. */
export type NavigationSource = {
  agentId: string;
  currentId: string;
  list: (signal?: AbortSignal) => Promise<{ entries: ConversationEntry[]; limited: boolean }>;
  page: (id: string, options: ListMessagesOptions) => Promise<ListMessagesResult>;
  validate: (id: string, signal?: AbortSignal) => Promise<void>;
};
/** Newest conversations of one agent (up to 200 plus `default`), excluding archived ones. */
export async function listNavigationEntries(list: (query: { agentId: string; limit: number; order: 'desc'; orderBy: 'createdAt'; after?: string }) => Promise<LettaConversation[]>, agentId: string, signal?: AbortSignal) {
  const entries: ConversationEntry[] = [{ id: 'default', title: 'Default conversation', date: 'activity unavailable' }];
  const seen = new Set<string>(['default']);
  let after: string | undefined;
  let limited = false;
  for (let index = 0; index < 3; index++) {
    signal?.throwIfAborted();
    const page = await list({ agentId, limit: 100, order: 'desc', orderBy: 'createdAt', ...(after ? { after } : {}) });
    signal?.throwIfAborted();
    if (page.length > 100) throw new Error('Oversized conversation page');
    if (!page.length) break;
    for (const row of page) {
      if (row.agent_id !== agentId || seen.has(row.id)) throw new Error('Conversation listing escaped current agent or repeated cursor');
      seen.add(row.id);
      if (index === 2) { limited = true; continue; }
      if (!row.archived) entries.push({ id: row.id, title: titleText(sanitizeText(row.summary ?? '')) || 'Untitled conversation', date: row.last_message_at || row.updated_at || row.created_at || 'activity unavailable' });
    }
    if (limited) break;
    after = page.at(-1)!.id;
  }
  return { entries, limited };
}

export const SEARCH_CONVERSATIONS = 50;
export const SEARCH_RECORDS = 500;
export const SEARCH_TOTAL = 5000;
export const SEARCH_MATCHES = 100;
export const SEARCH_MILLISECONDS = 30_000;
const plain = (text: string) => sanitizeText(text).replace(/\s+/g, ' ').trim();
/** A short excerpt of `text` around the first match of `query`. */
export function snippet(text: string, query: string) {
  const clean = plain(text);
  const at = clean.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, at - 65);
  return `${start ? '…' : ''}${clean.slice(start, start + 220)}${clean.length > start + 220 ? '…' : ''}`;
}
export type SearchMatch = { conversation: ConversationEntry; role: string; snippet: string };
/** Literal, case-insensitive text search. Only authoritative human/assistant text
 * enters the projection: never tools, reasoning, system or memory records. */
export async function searchConversations(source: NavigationSource, entries: ConversationEntry[], query: string, signal: AbortSignal, progress: (text: string) => void = () => {}) {
  if (!query.trim() || query.length > 200) throw new Error('Search requires 1–200 characters');
  const matches: SearchMatch[] = [];
  let records = 0;
  let scanned = 0;
  let limited = entries.length > SEARCH_CONVERSATIONS;
  const deadline = Date.now() + SEARCH_MILLISECONDS;
  const check = () => { signal.throwIfAborted(); if (Date.now() >= deadline) throw new Error('Search deadline reached'); };
  for (const conversation of entries.slice(0, SEARCH_CONVERSATIONS)) {
    check();
    if (records >= SEARCH_TOTAL || matches.length >= SEARCH_MATCHES) { limited = true; break; }
    progress(`Searching ${scanned + 1}/${Math.min(entries.length, SEARCH_CONVERSATIONS)} · ${records} records · Esc cancels after current read`);
    const history = await loadHistory(async options => {
      check();
      const page = await source.page(conversation.id, options);
      check();
      records += page.messages.length;
      return page;
    }, Math.min(SEARCH_RECORDS, SEARCH_TOTAL - records));
    limited ||= history.truncated;
    scanned++;
    for (const message of projectHistory(history.messages, [], 0)) {
      const text = message.parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
      if (plain(text).toLowerCase().includes(query.toLowerCase())) {
        if (matches.length >= SEARCH_MATCHES) { limited = true; break; }
        matches.push({ conversation, role: message.role, snippet: snippet(text, query) });
      }
    }
  }
  return { matches, records, scanned, limited };
}
