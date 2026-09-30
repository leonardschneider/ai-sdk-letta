/** Pure sidebar model: titles, activity times, date groups and search. No I/O. */
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

/** Short, readable title from a first message; undefined when nothing usable remains. */
export function deriveTitle(text: string, max = 60): string | undefined {
  const plain = text
    .replace(/```[^\n`]*\n[\s\S]*?(```|$)/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]+/g, '')
    .replace(/(^|\s)[#>|]+(?=\s)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return undefined;
  const sentence = plain.match(/^(.{8,}?[.?!])(\s|$)/u)?.[1] ?? plain;
  let title = sentence.replace(/[.!]+$/u, '');
  if (title.length > max) {
    const cut = title.slice(0, max);
    const space = cut.lastIndexOf(' ');
    title = `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/u, '')}…`;
  }
  title = title.charAt(0).toLocaleUpperCase() + title.slice(1);
  return validTitle(title) ? title : undefined;
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
/** Case- and accent-insensitive match of every search word against the title. */
export function matchesSearch(title: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const haystack = fold(title);
  return words.every(word => haystack.includes(word));
}

/** After archiving the open thread, prefer the next one below it, then the one above. */
export function nextAfterArchive(sorted: readonly ThreadSummary[], archivedId: string): string | undefined {
  const usable = (t: ThreadSummary) => t.id !== archivedId && !t.archived && t.state === 'ready';
  const index = sorted.findIndex(t => t.id === archivedId);
  return sorted.slice(index + 1).find(usable)?.id ?? sorted.slice(0, Math.max(index, 0)).reverse().find(usable)?.id ?? sorted.find(usable)?.id;
}
