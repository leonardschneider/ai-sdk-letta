import React, { useCallback, useEffect, useState } from 'react';
import { Dialog, Popover } from 'radix-ui';
import { AppWindow, Bot, Brain, CalendarClock, Clock, Container, Globe, LoaderCircle, MessageCircleQuestion, MoonStar, RotateCcw, ShieldAlert, Signpost, Square, X } from 'lucide-react';
import { api, apiPath, errorCode } from './api.js';
import { useToast } from './toasts.js';
import { actionLabel, actionPath, grouped, pill, timing, type ActivityAction, type ActivityCounts, type ActivityItem, type AgentActivity } from './activity-model.js';

/**
 * Counts of every agent (`GET /api/activity?since=`): a long poll on the
 * server's change channel. Single-user app only (team servers have no summary).
 */
export function useActivitySummary(enabled: boolean): { agents: ActivityCounts[]; version: number } {
  const [state, setState] = useState<{ agents: ActivityCounts[]; version: number }>({ agents: [], version: -1 });
  useEffect(() => {
    if (!enabled) return;
    const control = new AbortController();
    void (async () => {
      let since = -1;
      while (!control.signal.aborted) {
        try {
          const response = await fetch(`/api/activity?since=${since}`, { credentials: 'same-origin', signal: control.signal });
          if (!response.ok) throw new Error(String(response.status));
          const data = await response.json() as { version: number; agents: ActivityCounts[] };
          since = data.version;
          setState({ agents: data.agents, version: data.version });
        } catch { if (control.signal.aborted) return; await new Promise(resolve => setTimeout(resolve, 3000)); }
      }
    })();
    return () => control.abort();
  }, [enabled]);
  return state;
}

/** The current agent's activity (`GET <agent>/v1/activity`), read again whenever `trigger` changes, and every 3 s while `live`. */
export function useAgentActivity(enabled: boolean, trigger: unknown, live: boolean): [AgentActivity | undefined, () => void] {
  const [activity, setActivity] = useState<AgentActivity>();
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce(n => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    api<AgentActivity>('/v1/activity', undefined, 'GET').then(a => { if (!stale) setActivity(a); }, () => {});
    return () => { stale = true; };
  }, [enabled, trigger, nonce]);
  useEffect(() => {
    if (!enabled || !live) return;
    const timer = setInterval(() => setNonce(n => n + 1), 3000);
    return () => clearInterval(timer);
  }, [enabled, live]);
  return [activity, reload];
}

function useSecondTick(on: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => { if (!on) return; const timer = setInterval(() => setTick(n => n + 1), 1000); return () => clearInterval(timer); }, [on]);
}

const ICONS: Record<string, React.ReactNode> = {
  turn: <LoaderCircle size={14} className="spin"/>, queued: <Clock size={14}/>, approval: <ShieldAlert size={14}/>, question: <MessageCircleQuestion size={14}/>,
  decision: <Signpost size={14}/>, 'memory-review': <Brain size={14}/>, 'app-approval': <ShieldAlert size={14}/>, container: <Container size={14}/>, 'dev-server': <AppWindow size={14}/>,
  browser: <Globe size={14}/>, app: <Bot size={14}/>, jiminy: <Brain size={14}/>, dream: <MoonStar size={14}/>, schedule: <CalendarClock size={14}/>,
};

/**
 * The header's status pill (always visible: the top bar is never hidden) and
 * its Activity popover, a bottom sheet on phones. The pill shows the current
 * agent; a small marker tells when other agents are busy.
 */
export function ActivityPill({ activity, others, narrow, onOpenThread, onChanged }: { activity: AgentActivity | undefined; others: readonly ActivityCounts[]; narrow: boolean; onOpenThread(threadId: string): void; onChanged(): void }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const [acting, setActing] = useState<string>();
  useSecondTick(open);
  const view = pill(activity, others);
  const groups = grouped(activity?.items ?? []);
  async function act(item: ActivityItem, action: ActivityAction) {
    const path = actionPath(action, item);
    if (!path) return;
    setActing(`${item.id}:${action}`);
    try { await api(path, {}); onChanged(); }
    catch (error) { toast(`Couldn’t ${actionLabel(action, item).toLowerCase()} that: ${errorCode(error)}`, { tone: 'error' }); }
    finally { setActing(undefined); }
  }
  const busyOthers = others.filter(o => o.state !== 'idle');
  const content = <>
    <header className="activity-head"><span>Activity</span><span className="activity-head-state" data-state={view.state}>{view.state === 'idle' ? 'Idle' : view.text}</span>
      {narrow && <Dialog.Close className="icon-btn small" aria-label="Close"><X size={16}/></Dialog.Close>}</header>
    {!groups.length && <p className="activity-empty">Nothing is running. Turns, prompts waiting for you, services and background work show up here.</p>}
    {groups.map(group => <section key={group.key} className="activity-group" data-group={group.key}>
      <h3 className="activity-group-head">{group.label}<span>{group.items.length}</span></h3>
      <ul className="activity-list">
        {group.items.map(item => {
          const when = timing(item);
          return <li key={item.id} className="activity-item" data-kind={item.kind} data-status={item.status}>
            <span className="activity-icon" aria-hidden="true">{ICONS[item.kind] ?? <Clock size={14}/>}</span>
            <span className="activity-body">
              <span className="activity-label">{item.label}{item.status && item.kind === 'app' && <span className="activity-status" data-status={item.status}>{item.status}</span>}</span>
              {item.detail && <span className="activity-detail">{item.detail}</span>}
              <span className="activity-meta">
                {item.threadId && item.title && <a href="#" className="activity-link" onClick={event => { event.preventDefault(); setOpen(false); onOpenThread(item.threadId!); }}>{item.title}</a>}
                {item.threadId && item.title && when && <span aria-hidden="true"> · </span>}
                {when && <span className="activity-time">{when}</span>}
              </span>
            </span>
            {!!item.actions?.length && <span className="activity-actions">
              {item.actions.map(action => <button key={action} type="button" className="btn small" data-action={action} disabled={acting === `${item.id}:${action}`} onClick={() => void act(item, action)}>
                {action === 'restart-app' ? <RotateCcw size={13} aria-hidden="true"/> : <Square size={11} aria-hidden="true"/>}{actionLabel(action, item)}</button>)}
            </span>}
          </li>;
        })}
      </ul>
    </section>)}
    {!!busyOthers.length && <section className="activity-group" data-group="others">
      <h3 className="activity-group-head">Other agents<span>{busyOthers.length}</span></h3>
      <ul className="activity-list">{busyOthers.map(o => <li key={o.id} className="activity-item activity-other" data-state={o.state}>
        <span className="activity-dot" data-state={o.state} aria-hidden="true"/><span className="activity-body"><span className="activity-label">{o.name}</span>
          <span className="activity-detail">{o.state === 'waiting' ? `Needs you · ${o.waiting}` : `Working · ${o.working}`}</span></span></li>)}</ul>
    </section>}
  </>;
  const trigger = <button type="button" className="activity-pill" data-activity={view.state} data-others={view.others ? (view.othersWaiting ? 'waiting' : 'working') : undefined} aria-label={view.label} title={view.label}>
    <span className="activity-dot" data-state={view.state} aria-hidden="true"/>
    <span className="activity-text">{view.text}</span>
    {!!view.others && <span className="activity-others" aria-hidden="true"/>}
  </button>;
  const onOpenChange = (value: boolean) => { setOpen(value); if (value) onChanged(); };
  // Phones: a bottom sheet (a dialog); wider screens: a popover anchored to the header.
  if (narrow) return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="activity-scrim"/>
      <Dialog.Content className="activity-panel activity-sheet" aria-describedby={undefined}><Dialog.Title className="sr-only">Activity</Dialog.Title>{content}</Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
  return <Popover.Root open={open} onOpenChange={onOpenChange}>
    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="menu activity-panel" align="end" side="bottom" sideOffset={6} collisionPadding={8} aria-label="Activity">{content}</Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
