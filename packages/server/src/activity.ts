/**
 * The activity view: what an agent does now (turns, prompts waiting for a
 * person, services, background work), from objects the server already holds.
 * Cheap: no Letta call, no disk read beyond the runtime's own state.
 */
import type { ThreadRuntime } from './runtime.js';

/** One item of the activity view. `since` is when it started (ISO), `threadId` the conversation it belongs to. */
export type ActivityItem = {
  id: string;
  group: 'turns' | 'waiting' | 'services' | 'background';
  kind: 'turn' | 'queued' | 'approval' | 'question' | 'decision' | 'memory-review' | 'app-approval' | 'container' | 'dev-server' | 'browser' | 'app' | 'jiminy' | 'dream' | 'schedule';
  label: string;
  detail?: string;
  threadId?: string; title?: string;
  since?: string;
  /** Turns: the current step (`tool:<name>`, `thinking`, `writing`, `waiting`, `starting`). */
  step?: string;
  /** Services container: when it stops if idle. Schedules: when they fire. */
  until?: string;
  /** Apps: `running`, `starting`, `stopped`, `failed`. */
  status?: string;
  /** What can be done from the view: `stop` (a turn, a queued message), `stop-dev-server`, `stop-app`, `restart-app`. */
  actions?: ('stop' | 'stop-dev-server' | 'stop-app' | 'restart-app')[];
  /** Turns, queued messages and prompts: the run. Apps: the app ID. */
  ref?: string;
};

/** The activity of one agent, with its state (see {@link activityState}). */
export type AgentActivity = { state: ActivityState; working: number; waiting: number; items: ActivityItem[] };

/** `idle`: nothing runs; `working`: turns or background work run; `waiting`: something waits for a person (wins over working). */
export type ActivityState = 'idle' | 'working' | 'waiting';

/** The state of an agent from its items: anything waiting for a person, else anything working (services alone are not work). */
export function activityState(items: readonly Pick<ActivityItem, 'group' | 'kind'>[]): { state: ActivityState; working: number; waiting: number } {
  const waiting = items.filter(i => i.group === 'waiting').length;
  const working = items.filter(i => i.kind === 'turn' || i.kind === 'queued' || i.kind === 'jiminy' || i.kind === 'dream').length;
  return { state: waiting ? 'waiting' : working ? 'working' : 'idle', working, waiting };
}

/** Human label of a turn step. */
export function stepLabel(step: string | undefined): string {
  if (!step || step === 'starting') return 'Starting';
  if (step === 'waiting') return 'Waiting for you';
  if (step === 'thinking') return 'Thinking';
  if (step === 'writing') return 'Writing';
  if (step.startsWith('tool:')) { const tool = step.slice(5); return tool === 'web_search' ? 'Searching the web (summarizing)' : `Running ${tool}`; }
  return step;
}

/** Everything one agent does now, grouped as the view shows it. */
export function agentActivity(runtime: ThreadRuntime, owner: string): AgentActivity {
  const now = runtime.activityNow(owner);
  const items: ActivityItem[] = [];
  const titled = (threadId: string | undefined) => threadId ? runtime.threadSummary(owner, threadId) : undefined;
  for (const turn of now.turns) items.push({ id: `turn:${turn.runId}`, group: 'turns', kind: 'turn', label: turn.source ? `${turn.source.kind === 'schedule' ? 'Scheduled task' : 'Automation'}: ${turn.source.name}` : 'Replying', detail: stepLabel(turn.step), step: turn.step,
    threadId: turn.threadId, title: turn.title, ...(turn.startedAt ? { since: turn.startedAt } : {}), actions: ['stop'], ref: turn.runId });
  for (const queued of now.queued) items.push({ id: `queued:${queued.runId}`, group: 'turns', kind: 'queued', label: 'Message waiting to be sent', threadId: queued.threadId, title: queued.title, ...(queued.since ? { since: queued.since } : {}), actions: ['stop'], ref: queued.runId });
  for (const prompt of now.prompts) items.push({ id: `prompt:${prompt.runId}`, group: 'waiting', kind: prompt.kind, label: prompt.kind === 'approval' ? `Permission: ${prompt.tool}` : 'Question', detail: prompt.prompt, threadId: prompt.threadId, title: prompt.title, ...(prompt.since ? { since: prompt.since } : {}), ref: prompt.runId });
  for (const decision of runtime.decisions?.pending() ?? []) {
    const thread = titled(decision.threadId);
    if (!thread || thread.archived) continue;
    const memory = decision.kind === 'memory-review' || decision.kind === 'claim-confirmation' || decision.kind === 'memory-notice';
    items.push({ id: `decision:${decision.id}`, group: 'waiting', kind: memory ? 'memory-review' : 'decision', label: decision.kind === 'web-research' ? 'Review web research' : memory ? 'Memory review' : 'Decision', detail: decision.question.slice(0, 200), threadId: thread.id, title: thread.title, since: decision.createdAt, ref: decision.id });
  }
  if (runtime.apps) {
    for (const approval of runtime.apps.pendingAll()) {
      const thread = titled(approval.threadId);
      items.push({ id: `app-approval:${approval.id}`, group: 'waiting', kind: 'app-approval', label: `App ${approval.appName}${approval.tool ? `: ${approval.tool}` : ''}`, detail: 'Waiting for your approval', ...(thread ? { threadId: thread.id, title: thread.title } : {}), since: approval.createdAt, ref: approval.id });
    }
    for (const app of runtime.apps.apps.status()) {
      if (app.status === 'stopped' && !app.dev) continue;
      const threadId = app.dev ? runtime.threadOfConversationAny(app.dev.conversationId) : undefined;
      const thread = titled(threadId);
      const actions: ActivityItem['actions'] = app.status === 'running' || app.status === 'starting' ? ['stop-app', 'restart-app'] : app.restartable !== false ? ['restart-app'] : [];
      items.push({ id: `app:${app.id}`, group: 'services', kind: 'app', label: `${app.dev ? 'Dev app' : 'App'} ${app.name}`, status: app.status, ...(app.error ? { detail: app.error.slice(0, 200) } : app.stopReason ? { detail: `stopped (${app.stopReason})` } : {}),
        ...(thread ? { threadId: thread.id, title: thread.title } : {}), ...(app.dev?.startedAt && app.status === 'running' ? { since: app.dev.startedAt } : {}), actions, ref: app.id });
    }
  }
  if (runtime.webDev) {
    for (const { agentId, conversationId, status } of runtime.webDev.registry.conversations()) {
      if (status.container === 'stopped') continue;
      const threadId = runtime.threadOfConversationAny(conversationId);
      const thread = titled(threadId);
      if (!thread || !runtime.agentIds().includes(agentId)) continue;
      items.push({ id: `container:${conversationId}`, group: 'services', kind: 'container', label: 'Services container', status: status.container, threadId: thread.id, title: thread.title, ...(status.idleStopsAt ? { until: status.idleStopsAt } : {}) });
      if (status.devServer) items.push({ id: `dev-server:${conversationId}`, group: 'services', kind: 'dev-server', label: 'Dev server', detail: status.devServer.command.slice(0, 120), threadId: thread.id, title: thread.title, since: status.devServer.startedAt, actions: ['stop-dev-server'] });
      if (status.browser) items.push({ id: `browser:${conversationId}`, group: 'services', kind: 'browser', label: 'Headless browser', threadId: thread.id, title: thread.title });
    }
  }
  const reviewing = runtime.memory?.reviewing() ?? [];
  if (reviewing.length) {
    const reviews = runtime.memory!.list();
    for (const id of reviewing) {
      const review = reviews.find(r => r.id === id);
      const threadId = review?.conversationId ? runtime.threadOfConversationAny(review.conversationId) : undefined;
      const thread = titled(threadId);
      items.push({ id: `jiminy:${id}`, group: 'background', kind: 'jiminy', label: review?.kind === 'dream' ? 'Jiminy reviews a dream' : 'Jiminy reviews a memory change', ...(review ? { detail: review.files.map(f => f.path).slice(0, 3).join(', '), since: review.createdAt } : {}), ...(thread ? { threadId: thread.id, title: thread.title } : {}) });
    }
  }
  if (now.dreaming) items.push({ id: 'dream', group: 'background', kind: 'dream', label: 'Dreaming (reflecting on memory)', threadId: now.dreaming.threadId, title: now.dreaming.title, since: now.dreaming.since });
  let schedules: ReturnType<NonNullable<ThreadRuntime['upcoming']>> = [];
  try { schedules = runtime.upcoming?.() ?? []; } catch { /* the automation store is unreadable: nothing listed */ }
  for (const task of schedules.slice(0, 10)) {
    const thread = titled(task.threadId);
    items.push({ id: `schedule:${task.id}`, group: 'background', kind: 'schedule', label: `Scheduled task${task.title ? `: ${task.title}` : ''}`, detail: task.prompt, until: task.at, ...(thread ? { threadId: thread.id, title: thread.title } : {}) });
  }
  return { ...activityState(items), items };
}

/** Counts of one agent, for the agent switcher and the header's "other agents" marker. */
export type ActivityCounts = { id: string; name: string; state: ActivityState; working: number; waiting: number; running: string[] };

/** Counts of several agents (the app's own and adopted ones). An agent whose activity cannot be read counts as idle. */
export function activitySummary(agents: readonly { id: string; name: string; runtime: ThreadRuntime; owner: string }[]): ActivityCounts[] {
  return agents.map(({ id, name, runtime, owner }) => {
    try {
      const { state, working, waiting, items } = agentActivity(runtime, owner);
      return { id, name, state, working, waiting, running: [...new Set(items.filter(i => i.kind === 'turn' && i.threadId).map(i => i.threadId!))] };
    } catch { return { id, name, state: 'idle' as const, working: 0, waiting: 0, running: [] }; }
  });
}
