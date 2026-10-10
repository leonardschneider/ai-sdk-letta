/** Pure navigation model: conversations of every agent grouped by time, then agent; the accordion state; opening another agent's conversation. No I/O. */
import { activityTimes, dateGroup, GROUP_LABELS, matchesSearch, type GroupKey, type ThreadSummary } from './thread-model.js';

/** A conversation with the agent it belongs to. */
export type AgentThread = { agentId: string; agentName: string; thread: ThreadSummary };
export type AgentGroup = { agentId: string; agentName: string; items: AgentThread[] };
export type TimeGroup = { key: GroupKey; label: string; agents: AgentGroup[] };

/**
 * Time groups (Today, Yesterday, Previous 7 days, Older), and in each the agents
 * with conversations in it, ordered by their most recent one there; each agent's
 * conversations newest first. `lists`: each agent's threads as its server lists them
 * (activity times are derived per agent). Archived threads and non-matches are left out.
 */
export function groupByTimeThenAgent(lists: readonly { agentId: string; agentName: string; threads: readonly ThreadSummary[] }[], now: Date, query = ''): TimeGroup[] {
  const entries: { item: AgentThread; time: number | undefined; order: number }[] = [];
  let order = 0;
  for (const list of lists) {
    const times = activityTimes(list.threads);
    list.threads.forEach(thread => {
      order++;
      if (thread.archived || !matchesSearch(thread.title, query)) return;
      entries.push({ item: { agentId: list.agentId, agentName: list.agentName, thread }, time: times.get(thread.id), order });
    });
  }
  entries.sort((a, b) => (b.time ?? -Infinity) - (a.time ?? -Infinity) || b.order - a.order);
  const groups = new Map<GroupKey, Map<string, AgentGroup>>();
  for (const { item, time } of entries) {
    const key = dateGroup(time, now);
    const agents = groups.get(key) ?? new Map<string, AgentGroup>();
    groups.set(key, agents);
    // Entries are newest first, so agents are inserted in the order of their most recent conversation.
    const agent = agents.get(item.agentId) ?? { agentId: item.agentId, agentName: item.agentName, items: [] };
    agents.set(item.agentId, agent);
    agent.items.push(item);
  }
  return (Object.keys(GROUP_LABELS) as GroupKey[]).filter(key => groups.has(key)).map(key => ({ key, label: GROUP_LABELS[key], agents: [...groups.get(key)!.values()] }));
}

/** The remembered conversation of an agent: per agent on team servers and for adopted agents, one key for the app's own agent. */
export const SAVED_THREAD = 'ai-sdk-letta-thread';
export function savedThreadKey(agentId: string, options: { team?: boolean; adopted?: boolean }): string {
  return options.team || options.adopted ? `${SAVED_THREAD}:${agentId}` : SAVED_THREAD;
}
/** Saved in place of a thread ID: the agent opens on a new chat. */
export const NEW_CHAT = 'new';

/**
 * Opening a conversation (or a new chat, `threadId` undefined) of `agentId` from `currentId`:
 * the same agent selects it in place; another agent is switched to after its saved thread
 * is set, so the remounted app opens it.
 */
export function openPlan(currentId: string, agentId: string, threadId: string | undefined, options: { team?: boolean; adopted?: boolean }):
  { kind: 'select'; threadId: string } | { kind: 'new' } | { kind: 'switch'; agentId: string; save: { key: string; value: string } } {
  if (agentId === currentId) return threadId ? { kind: 'select', threadId } : { kind: 'new' };
  return { kind: 'switch', agentId, save: { key: savedThreadKey(agentId, options), value: threadId ?? NEW_CHAT } };
}

/** Which accordion sections are open (persisted per browser). */
export type NavSections = { conversations: boolean; agents: boolean };
export const NAV_KEY = 'ai-sdk-letta-nav';
export const DEFAULT_SECTIONS: NavSections = { conversations: true, agents: false };
export function readSections(raw: string | null): NavSections {
  try {
    const value = JSON.parse(raw ?? '') as Partial<NavSections>;
    return { conversations: typeof value.conversations === 'boolean' ? value.conversations : true, agents: typeof value.agents === 'boolean' ? value.agents : false };
  } catch { return { ...DEFAULT_SECTIONS }; }
}
