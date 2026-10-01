/** Pure sidebar model: titles, activity times, date groups and search. No I/O. */
import { nodesText, parseTitle, titleText } from 'ai-sdk-letta/title';

export type ThreadSummary = { id: string; title: string; state: string; archived?: boolean; createdAt?: string; lastActivityAt?: string };
export const DEFAULT_TITLE = 'New conversation';
export const TITLE_LIMIT = 120;
const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const isDefaultTitle = (title: string) => title.trim() === DEFAULT_TITLE;

/** Same rules as the backend PATCH validation, so invalid titles never reach it. */
export function validTitle(title: string): boolean {
  const trimmed = title.trim();
  return !!trimmed && trimmed.length <= TITLE_LIMIT && !hidden.test(title);
}

/**
 * Short, readable title from a first message; undefined when nothing usable remains.
 * Inline Markdown is kept as typed (a pasted URL becomes a link, `**bold**` stays bold);
 * block syntax (code blocks, headings, quotes, list markers) and images are not.
 * The first sentence and the length limit (`max` visible characters) are measured
 * on the text the title shows (a URL as shortened in the sidebar), and a cut never
 * splits a link or other construct.
 */
export function deriveTitle(text: string, max = 60): string | undefined {
  const cleaned = text
    .replace(/```[^\n`]*\n[\s\S]*?(```|$)/g, ' ')
    .replace(/`{3,}/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:[#>|]+|[-+*][ \t]|\d{1,9}[.)][ \t])[ \t]*/gm, '')
    .replace(/(^|\s)[#>|]+(?=\s)/g, '$1')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!titleText(cleaned)) return undefined;
  let title = cut(cleaned, max);
  title = title.replace(/[.!]+$/u, '');
  const first = parseTitle(title)[0];
  if (first?.type === 'text') title = title.charAt(0).toLocaleUpperCase() + title.slice(1);
  // Markdown that cannot fit the backend's limit falls back to the text it shows.
  if (title.length > TITLE_LIMIT) return deriveTitle(titleText(cleaned).replace(/[\\`*_[\]<>]/g, ''), max);
  return validTitle(title) && titleText(title) ? title : undefined;
}

/** The first sentence of `source` (inline Markdown), at most `max` visible and TITLE_LIMIT raw characters. */
function cut(source: string, max: number): string {
  let out = '';
  let visible = 0;
  for (const node of parseTitle(source)) {
    const raw = source.slice(node.start, node.end);
    if (node.type === 'text') {
      // A sentence ends at . ? or ! followed by a space, after at least 8 visible characters.
      const end = /[.?!](?=\s|$)/gu;
      let stop = -1;
      for (let m; (m = end.exec(raw));) if (visible + m.index + 1 >= 8) { stop = m.index + 1; break; }
      const piece = stop >= 0 ? raw.slice(0, stop) : raw;
      if (visible + piece.length <= max && out.length + piece.length <= TITLE_LIMIT) {
        out += piece; visible += piece.length;
        if (stop >= 0) return out.trim();
        continue;
      }
      const room = Math.min(max - visible, TITLE_LIMIT - 1 - out.length);
      const part = piece.slice(0, Math.max(0, room));
      const space = part.lastIndexOf(' ');
      out += space > room * 0.5 || (space >= 0 && visible > 0) ? part.slice(0, space) : visible > 0 ? '' : part;
      return `${out.replace(/[\s,;:–-]+$/u, '')}…`;
    }
    // A URL counts as the shortened form the sidebar shows, so a pasted link fits.
    const shown = nodesText([node], { shortUrls: true }).length;
    if (visible + shown <= max && out.length + raw.length <= TITLE_LIMIT) { out += raw; visible += shown; continue; }
    return out.trim() ? `${out.replace(/[\s,;:–-]+$/u, '')}…` : raw.length < TITLE_LIMIT ? raw : `${nodesText([node]).slice(0, max)}…`;
  }
  return out.trim();
}

/** Legacy titles look like "Conversation 9/28/2026, 9:57:54 PM" (local time). */
export function legacyTitleTime(title: string): number | undefined {
  const m = title.match(/^Conversation (\d{1,2})\/(\d{1,2})\/(\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AP]M)$/i);
  if (!m) return undefined;
  const hour = Number(m[4]) % 12 + (m[7]!.toUpperCase() === 'PM' ? 12 : 0);
  const time = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]), Number(m[6] ?? 0)).getTime();
  return Number.isFinite(time) ? time : undefined;
}

const parse = (value?: string) => { const time = value ? Date.parse(value) : NaN; return Number.isFinite(time) ? time : undefined; };

/**
 * Best-known activity time per thread. Threads are stored in creation order, so a
 * legacy thread without timestamps is at least as recent as any earlier-created one.
 */
export function activityTimes(threads: readonly ThreadSummary[]): Map<string, number | undefined> {
  const result = new Map<string, number | undefined>();
  let floor: number | undefined;
  for (const thread of threads) {
    const own = parse(thread.lastActivityAt) ?? parse(thread.createdAt) ?? legacyTitleTime(thread.title);
    const created = parse(thread.createdAt) ?? legacyTitleTime(thread.title);
    result.set(thread.id, own ?? floor);
    const bound = created ?? own;
    if (bound !== undefined) floor = Math.max(floor ?? bound, bound);
  }
  return result;
}

/** Most recent first; ties keep the most recently created first. */
export function sortThreads<T extends ThreadSummary>(threads: readonly T[], times = activityTimes(threads)): T[] {
  const order = new Map(threads.map((t, i) => [t.id, i]));
  return [...threads].sort((a, b) => (times.get(b.id) ?? -Infinity) - (times.get(a.id) ?? -Infinity) || order.get(b.id)! - order.get(a.id)!);
}

export type GroupKey = 'today' | 'yesterday' | 'week' | 'older';
export const GROUP_LABELS: Record<GroupKey, string> = { today: 'Today', yesterday: 'Yesterday', week: 'Previous 7 days', older: 'Older' };

export function dateGroup(time: number | undefined, now: Date): GroupKey {
  if (time === undefined) return 'older';
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime();
  if (time >= day(0)) return 'today';
  if (time >= day(1)) return 'yesterday';
  if (time >= day(7)) return 'week';
  return 'older';
}

/** Groups keep each thread's index in the (already sorted) input list. */
export function groupByDate<T extends ThreadSummary>(sorted: readonly T[], times: Map<string, number | undefined>, now: Date, include: (thread: T) => boolean = () => true) {
  const groups = new Map<GroupKey, { thread: T; index: number }[]>();
  sorted.forEach((thread, index) => {
    if (!include(thread)) return;
    const key = dateGroup(times.get(thread.id), now);
    groups.set(key, [...groups.get(key) ?? [], { thread, index }]);
  });
  return (Object.keys(GROUP_LABELS) as GroupKey[]).filter(key => groups.has(key)).map(key => ({ key, label: GROUP_LABELS[key], items: groups.get(key)! }));
}

const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
/**
 * Case- and accent-insensitive match of every search word against the text the
 * title shows (its Markdown syntax and link targets are not searched).
 */
export function matchesSearch(title: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const haystack = fold(titleText(title));
  return words.every(word => haystack.includes(word));
}

/** After archiving the open thread, prefer the next one below it, then the one above. */
export function nextAfterArchive(sorted: readonly ThreadSummary[], archivedId: string): string | undefined {
  const usable = (t: ThreadSummary) => t.id !== archivedId && !t.archived && t.state === 'ready';
  const index = sorted.findIndex(t => t.id === archivedId);
  return sorted.slice(index + 1).find(usable)?.id ?? sorted.slice(0, Math.max(index, 0)).reverse().find(usable)?.id ?? sorted.find(usable)?.id;
}
