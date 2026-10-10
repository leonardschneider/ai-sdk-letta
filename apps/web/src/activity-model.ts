/** The activity view's model (pure): the header pill, groups, elapsed times. */

export type ActivityState = 'idle' | 'working' | 'waiting';
export type ActivityAction = 'stop' | 'stop-dev-server' | 'stop-app' | 'restart-app';
/** One item (see the server's `ActivityItem`). */
export type ActivityItem = {
  id: string; group: 'turns' | 'waiting' | 'services' | 'background'; kind: string; label: string; detail?: string;
  threadId?: string; title?: string; since?: string; step?: string; until?: string; status?: string; actions?: ActivityAction[]; ref?: string;
};
export type AgentActivity = { state: ActivityState; working: number; waiting: number; items: ActivityItem[] };
export type ActivityCounts = { id: string; name: string; state: ActivityState; working: number; waiting: number; running: string[] };

export const GROUPS: readonly { key: ActivityItem['group']; label: string }[] = [
  { key: 'waiting', label: 'Waiting on you' },
  { key: 'turns', label: 'Turns' },
  { key: 'services', label: 'Services' },
  { key: 'background', label: 'Background' },
];

/** Items by group, in display order, empty groups left out. */
export function grouped(items: readonly ActivityItem[]) {
  return GROUPS.map(g => ({ ...g, items: items.filter(i => i.group === g.key) })).filter(g => g.items.length);
}

/** The pill: its tone, its text (empty when idle and quiet), and its accessible label. `others`: agents other than this one that are busy. */
export function pill(current: Pick<AgentActivity, 'state' | 'working' | 'waiting'> | undefined, others: readonly Pick<ActivityCounts, 'name' | 'state'>[] = []) {
  const busyOthers = others.filter(o => o.state !== 'idle');
  const othersWaiting = busyOthers.some(o => o.state === 'waiting');
  const state = current?.state ?? 'idle';
  const text = state === 'waiting' ? `Needs you · ${current!.waiting}` : state === 'working' ? `Working · ${current!.working}` : 'Idle';
  const elsewhere = busyOthers.length ? ` Also busy: ${busyOthers.map(o => `${o.name} (${o.state === 'waiting' ? 'needs you' : 'working'})`).join(', ')}.` : '';
  return { state, text, others: busyOthers.length, othersWaiting, label: `Activity: ${state === 'idle' ? 'idle' : text.replace(' · ', ', ')}.${elsewhere} Show activity` };
}

/** "2 min", "1 h 5 min", "12 s": time between two instants (`to` after `from`). */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
/** Elapsed since `since` ("for 3 min"), or undefined. */
export const elapsed = (since: string | undefined, now = Date.now()) => since && Number.isFinite(Date.parse(since)) ? span(now - Date.parse(since)) : undefined;

/** Time line of an item: elapsed, idle countdown, or when a task fires. */
export function timing(item: Pick<ActivityItem, 'kind' | 'since' | 'until'>, now = Date.now()): string | undefined {
  if (item.kind === 'container' && item.until) { const left = Date.parse(item.until) - now; return left > 0 ? `Services stop in ${span(left)} if idle` : 'Stopping (idle)'; }
  if (item.kind === 'schedule' && item.until) { const left = Date.parse(item.until) - now; return left > 0 ? `Due in ${span(left)}` : 'Due now'; }
  const e = elapsed(item.since, now);
  return e ? `${e}` : undefined;
}

/** Wording of an action button. */
export const actionLabel = (action: ActivityAction, item: Pick<ActivityItem, 'kind'>) =>
  action === 'stop' ? (item.kind === 'queued' ? 'Withdraw' : 'Stop') : action === 'stop-dev-server' ? 'Stop' : action === 'stop-app' ? 'Stop' : 'Restart';

/** The API call of an action (path relative to the agent's API base). */
export function actionPath(action: ActivityAction, item: Pick<ActivityItem, 'ref' | 'threadId'>): string | undefined {
  if (action === 'stop') return item.ref ? `/v1/runs/${encodeURIComponent(item.ref)}/cancel` : undefined;
  if (action === 'stop-dev-server') return item.threadId ? `/v1/threads/${encodeURIComponent(item.threadId)}/preview/stop-dev-server` : undefined;
  if (action === 'stop-app') return item.ref ? `/v1/apps/${encodeURIComponent(item.ref)}/stop` : undefined;
  return item.ref ? `/v1/apps/${encodeURIComponent(item.ref)}/restart` : undefined;
}
