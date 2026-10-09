import React, { createContext, Suspense, lazy, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Blocks, ChevronRight, LoaderCircle, ShieldAlert, X } from 'lucide-react';
import { api, errorCode } from './api.js';
import { Modal } from './modal.js';
import { CrashProbe, ErrorBoundary, ErrorCard } from './error-boundary.js';
import { useToast } from './toasts.js';
import { appToolLabel, approvalTitle, type AppApprovalView, type AppStatusView, type DevGenerations, type DisplayMode, type ViewPolicy, type ViewTool, devGenerationsKey, viewGeneration } from './apps-model.js';

/** The view frame carries the MCP SDK: loaded only when a view shows. */
const AppFrame = lazy(() => import('./app-view.js'));

/** MCP Apps of the open conversation: which tools show views, the panel, approvals. */
export type AppsState = {
  enabled: boolean; threadId?: string;
  viewTools: Readonly<Record<string, ViewTool>>;
  /** Running dev apps' generations: a reload remounts their open views. */
  generations?: DevGenerations;
  /** The calls with a tab in the side panel (this conversation). */
  panel?: readonly string[];
  openPanel(toolCallId: string, toolName: string): void;
  closePanel(toolCallId: string): void;
  /** The call shown full screen or in picture-in-picture, if any. */
  overlay?: { toolCallId: string; mode: Exclude<DisplayMode, 'inline'> };
  setOverlay(value: AppsState['overlay']): void;
  refreshApprovals(): void;
  onSent(): void;
  /** The live call of `toolCallId`'s view (one live view per app view); itself when every call shows its own view. */
  liveCall?(toolName: string, toolCallId: string): string;
  /** A call's place among the conversation's view calls (earlier calls say "below"). */
  callOrder?(toolCallId: string): number;
  /** "Show this one": an earlier call becomes its view's live one. */
  showCall?(toolName: string, toolCallId: string): void;
  /** A call's phase in the conversation (running until its result arrives): the panel and full screen follow it like the inline view does. */
  phaseOf?(toolCallId: string): 'running' | 'done' | undefined;
};
export const AppsContext = createContext<AppsState>({ enabled: false, viewTools: {}, openPanel: () => {}, closePanel: () => {}, setOverlay: () => {}, refreshApprovals: () => {}, onSent: () => {} });

/**
 * `GET /v1/apps` (tools with views, dev apps' generations), refreshed with
 * the conversation and with every server change (a dev app reload notifies).
 */
export function useViewTools(enabled: boolean, refreshKey: number): { viewTools: Record<string, ViewTool>; generations: DevGenerations } {
  const [state, setState] = useState<{ viewTools: Record<string, ViewTool>; generations: DevGenerations }>({ viewTools: {}, generations: {} });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api<{ viewTools: Record<string, ViewTool>; devGenerations?: Record<string, number> }>('/v1/apps').then(data => { if (live) setState({ viewTools: data.viewTools ?? {}, generations: data.devGenerations ?? {} }); }).catch(() => {});
    return () => { live = false; };
  }, [enabled, refreshKey]);
  return state;
}
/** The remount key of a view: its call, and its dev app's generation. */
const viewKey = (apps: AppsState, prefix: string, toolCallId: string, toolName: string | undefined) => `${prefix}-${toolCallId}-${viewGeneration(apps.viewTools, apps.generations ?? {}, toolName)}`;
/** Pending approvals of app actions in a thread, and context waiting for the next turn. */
export function useAppApprovals(threadId: string | undefined, enabled: boolean, refreshKey: number): [AppApprovalView[], () => void] {
  const [list, setList] = useState<{ threadId: string; approvals: AppApprovalView[] }>();
  const current = useRef(threadId); current.current = threadId;
  const load = useCallback(() => {
    const id = current.current;
    if (!enabled || !id) return;
    api<{ approvals: AppApprovalView[] }>(`/v1/threads/${encodeURIComponent(id)}/apps/approvals`).then(data => { if (current.current === id) setList({ threadId: id, approvals: data.approvals }); }).catch(() => {});
  }, [enabled]);
  useEffect(() => { load(); }, [threadId, refreshKey, load]);
  return [list && list.threadId === threadId ? list.approvals : [], load];
}

/**
 * The tool line of an app tool with a view: the usual summary line, and the
 * view itself under it (inline), with "open in panel" and full screen.
 */
export function AppToolLine({ toolCallId, toolName, result, isError, fallback }: { toolCallId: string; toolName: string; result: unknown; isError?: boolean; fallback: React.ReactNode }) {
  const apps = useContext(AppsContext);
  const view = apps.viewTools[toolName];
  const [open, setOpen] = useState(true);
  if (!view || !apps.threadId) return <>{fallback}</>;
  const phase = result === undefined ? 'running' : isError ? 'error' : 'done';
  // A call that failed (refused, denied, or the app failed) reads like any failed tool: no view.
  if (phase === 'error') return <>{fallback}</>;
  const live = apps.liveCall?.(toolName, toolCallId) ?? toolCallId;
  const overlay = apps.overlay?.toolCallId === toolCallId ? apps.overlay.mode : undefined;
  const inPanel = !!apps.panel?.includes(toolCallId);
  const label = appToolLabel(view, phase);
  // An earlier call of a view that shows elsewhere (a later call, the panel, full screen): a compact line.
  const liveOverlay = apps.overlay?.toolCallId === live ? apps.overlay.mode : undefined;
  const liveWhere = apps.panel?.includes(live) ? 'in the panel' : liveOverlay === 'pip' ? 'in picture-in-picture' : liveOverlay ? 'full screen' : (apps.callOrder?.(live) ?? 0) > (apps.callOrder?.(toolCallId) ?? 0) ? 'below' : 'above';
  const elsewhere = live !== toolCallId
    ? <p className="muted app-elsewhere" data-app-collapsed="">{`${view.appName} updated ${liveWhere}.`} <button type="button" className="link-btn" onClick={() => apps.showCall?.(toolName, toolCallId)}>Show this one</button></p>
    : inPanel || overlay
      ? <p className="muted app-elsewhere">{inPanel ? 'Shown in the panel.' : overlay === 'pip' ? 'Shown in picture-in-picture.' : 'Shown full screen.'} <button type="button" className="link-btn" onClick={() => { if (inPanel) apps.closePanel(toolCallId); else apps.setOverlay(undefined); }}>Show here</button></p>
      : undefined;
  return <div className="line app-line" data-tone={phase} data-tool-call-id={toolCallId}>
    <button type="button" className="line-summary" aria-expanded={open} onClick={() => setOpen(o => !o)} aria-label={`${label}. ${open ? 'Hide' : 'Show'} the app`}>
      {phase === 'running' ? <LoaderCircle size={14} className="line-icon spin" aria-hidden="true"/> : <Blocks size={14} className="line-icon" aria-hidden="true"/>}
      <span className={`line-label ${phase === 'running' ? 'shimmer' : ''}`}>{label}</span>
      <span className="app-badge" aria-hidden="true">App</span>
      {view.dev && <span className="side-tab-dev" aria-hidden="true">Dev</span>}
      <ChevronRight size={14} className="chev" aria-hidden="true"/>
    </button>
    {open && <div className="app-line-body">
      {elsewhere ?? <AppSlot key={viewKey(apps, 'inline', toolCallId, toolName)} toolCallId={toolCallId} placement="inline" mode="inline" version={phase} name={view.appName} onMode={mode => { if (mode !== 'inline') apps.setOverlay({ toolCallId, mode }); }} onOpenPanel={() => apps.openPanel(toolCallId, toolName)}/>}
      {fallback}
    </div>}
  </div>;
}

/** One view, lazily loaded. */
export function AppSlot(props: { toolCallId: string; placement: 'inline' | 'panel'; mode: DisplayMode; version?: string; name?: string; onMode(mode: DisplayMode): void; onOpenPanel?(): void; onClose?(): void }) {
  const apps = useContext(AppsContext);
  if (!apps.threadId) return null;
  // A view that fails to render (or whose frame code fails to load) shows an inline card; the conversation and other views keep working.
  return <ErrorBoundary where="app-view" resetKey={`${apps.threadId}:${props.toolCallId}`} fallback={fallback => <div className="appview" data-placement={props.placement} data-mode={props.mode} data-phase="failed"><ErrorCard {...fallback} label={`${props.name ?? 'The app'}’s view couldn’t be shown.`}/>{props.onClose && <button type="button" className="link-btn appview-error-close" onClick={props.onClose}>Close</button>}</div>}>
  <CrashProbe where="app-view"/>
  <Suspense fallback={<div className="appview-wait" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true"/>Loading the app…</div>}>
    <AppFrame threadId={apps.threadId} toolCallId={props.toolCallId} placement={props.placement} mode={props.mode} onMode={props.onMode} onApprovals={apps.refreshApprovals} onSent={apps.onSent}
      {...(props.version ? { version: props.version } : {})} {...(props.name ? { name: props.name } : {})} {...(props.onOpenPanel ? { onOpenPanel: props.onOpenPanel } : {})} {...(props.onClose ? { onClose: props.onClose } : {})}/>
  </Suspense>
  </ErrorBoundary>;
}

/** A view's `version` from its call's phase (the panel and full screen retarget to a new call while it still streams). */
const withPhase = (phase: 'running' | 'done' | undefined) => phase ? { version: phase } : {};

/** An app tab of the side panel: one app view at full height. */
export function AppPanel({ toolCallId, toolName, onClose }: { toolCallId: string; toolName?: string; onClose(): void }) {
  const apps = useContext(AppsContext);
  return <div className="app-panel">
    <AppSlot key={viewKey(apps, 'panel', toolCallId, toolName)} toolCallId={toolCallId} placement="panel" mode="inline" {...withPhase(apps.phaseOf?.(toolCallId))} onMode={mode => { if (mode !== 'inline') apps.setOverlay({ toolCallId, mode }); }} onClose={onClose}/>
  </div>;
}

/** A view full screen (over the app) or picture-in-picture (a floating corner window). Escape returns it inline. */
export function AppOverlay() {
  const apps = useContext(AppsContext);
  const overlay = apps.overlay;
  useEffect(() => {
    if (!overlay || overlay.mode !== 'fullscreen') return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); apps.setOverlay(undefined); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, apps]);
  if (!overlay) return null;
  return <div className={`app-overlay ${overlay.mode}`} role={overlay.mode === 'fullscreen' ? 'dialog' : 'complementary'} aria-label="App">
    <AppSlot key={`${overlay.mode}-${overlay.toolCallId}-${devGenerationsKey(apps.generations ?? {})}`} toolCallId={overlay.toolCallId} placement="inline" mode={overlay.mode} {...withPhase(apps.phaseOf?.(overlay.toolCallId))} onMode={mode => apps.setOverlay(mode === 'inline' ? undefined : { toolCallId: overlay.toolCallId, mode })} onClose={() => apps.setOverlay(undefined)}/>
  </div>;
}

/**
 * Cards for app actions waiting for the person (outside any turn): a tool
 * the app wants to run, a message it wants to send to the agent, or context
 * it wants to give it. Allow or deny, once; admins may also allow it
 * always (this tool, the app's messages or its context updates; or every
 * action of the app that asks), undone in the Apps dialog.
 */
export function AppApprovalCards({ approvals, onDecided, admin = true }: { approvals: AppApprovalView[]; onDecided(): void; admin?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  if (!approvals.length) return null;
  const decide = async (approval: AppApprovalView, approved: boolean, always?: 'tool' | 'app') => {
    setBusy(approval.id);
    try { await api(`/v1/apps/approvals/${encodeURIComponent(approval.id)}`, { approved, ...(always ? { always } : {}) }); if (always) toast(always === 'app' ? `${approval.appName}: its actions run without asking from now on. Reset in Apps.` : approval.kind === 'message' ? `${approval.appName}: its messages to the agent are sent without asking from now on. Reset in Apps.` : approval.kind === 'context' ? `${approval.appName}: its context updates reach the agent without asking from now on. Reset in Apps.` : `${approval.tool} runs without asking from now on. Reset in Apps.`); }
    catch (error) { const code = errorCode(error); toast(code === 'already_decided' ? 'Already decided.' : code === 'approval_expired' ? 'That request expired; nothing was done.' : 'Couldn’t send your decision. Try again.', { tone: 'error' }); }
    finally { setBusy(undefined); onDecided(); }
  };
  return <div className="app-approvals">{approvals.map(approval => <section key={approval.id} className="card approval-card app-approval" aria-label={approvalTitle(approval)} data-kind={approval.kind}>
    <header className="card-head"><ShieldAlert size={16} aria-hidden="true"/><span>Permission needed</span><span className="app-badge">App</span></header>
    <h2 className="card-title">{approvalTitle(approval)}</h2>
    {approval.kind === 'call' && approval.arguments && Object.keys(approval.arguments).length > 0 && <pre className="command-line approval-command" aria-label="Arguments">{JSON.stringify(approval.arguments, null, 2).slice(0, 2000)}</pre>}
    {approval.kind !== 'call' && <blockquote className="app-approval-text">{approval.text}</blockquote>}
    <p className="card-details">{approval.kind === 'call' ? 'You clicked something in the app’s view; it runs on your behalf.' : approval.kind === 'message' ? 'If you allow it, it is sent to the agent as a message from you, marked as coming from the app.' : 'If you allow it, the agent sees this (and later updates from this view) at your next message, marked as the app’s content.'}</p>
    <div className="card-actions">
      <button type="button" className="btn ghost" disabled={busy === approval.id} onClick={() => void decide(approval, false)}>Deny</button>
      {admin && approval.grantable && <button type="button" className="btn ghost" disabled={busy === approval.id} onClick={() => void decide(approval, true, 'app')} title={`Every action of ${approval.appName} that asks runs without asking (reset in Apps)`}>Allow all from this app</button>}
      {admin && approval.grantable && <button type="button" className="btn ghost" disabled={busy === approval.id} onClick={() => void decide(approval, true, 'tool')} title={approval.kind === 'message' ? `Messages from ${approval.appName} are sent without asking from now on (reset in Apps)` : approval.kind === 'context' ? `Context updates from ${approval.appName} reach the agent without asking from now on (reset in Apps)` : 'This action runs without asking from now on (reset in Apps)'}>Allow always</button>}
      <button type="button" className="btn primary" disabled={busy === approval.id} onClick={() => void decide(approval, true)}>Allow</button>
    </div>
  </section>)}</div>;
}

/** Sidebar entry of the apps (single-user: you are the admin). */
export function AppsRow({ onOpen }: { onOpen(): void }) {
  return <button type="button" className="integration-row apps-row" onClick={onOpen} aria-label="Apps: the MCP Apps of this agent">
    <span className="integration-mark" aria-hidden="true"><Blocks size={13}/></span>
    <span className="integration-label">Apps</span>
  </button>;
}

const VISIBILITY = (v: readonly string[]) => v.includes('model') && v.includes('app') ? 'agent and app' : v.includes('model') ? 'agent only' : v.includes('app') ? 'app only' : 'hidden';
const POLICY: Record<string, string> = { allow: 'runs', ask: 'asks', deny: 'denied' };
/**
 * The agent's apps (admins): each app's status, tools (visibility, policy),
 * its views' declared CSP domains and those granted, and enable/disable.
 * Policies and approved origins are set in the agent's definition.
 */
export function AppsDialog({ onClose, onChanged, viewPolicy, onViewPolicy }: { onClose(): void; onChanged(): void; viewPolicy?(appId: string): ViewPolicy; onViewPolicy?(appId: string, value: ViewPolicy): void }) {
  const toast = useToast();
  const [apps, setApps] = useState<AppStatusView[]>();
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => { api<{ apps: AppStatusView[] }>('/v1/apps').then(data => { setApps(data.apps); setFailed(false); }).catch(() => setFailed(true)); }, []);
  useEffect(() => { load(); const timer = setInterval(load, 4000); return () => clearInterval(timer); }, [load]);
  const toggle = async (app: AppStatusView) => {
    try { await api(`/v1/apps/${encodeURIComponent(app.id)}`, { enabled: !app.enabled }, 'PATCH'); toast(`${app.name} ${app.enabled ? 'disabled: its tools refuse calls and its views don’t show' : 'enabled'}.`); load(); onChanged(); }
    catch { toast('Couldn’t change it. Try again.', { tone: 'error' }); }
  };
  const reset = async (app: AppStatusView, tool: string) => {
    try { await api(`/v1/apps/${encodeURIComponent(app.id)}/grants/reset`, { tool }); toast(tool === '*' ? `${app.name}: its actions ask again.` : tool === '@message' ? `${app.name}: its messages ask again.` : tool === '@context' ? `${app.name}: its context updates ask again.` : `${tool} asks again.`); load(); }
    catch { toast('Couldn’t reset it. Try again.', { tone: 'error' }); }
  };
  const devAsk = async (app: AppStatusView, ask: boolean) => {
    try { await api(`/v1/apps/${encodeURIComponent(app.id)}/dev`, { ask }, 'PATCH'); load(); }
    catch { toast('Couldn’t change it. Try again.', { tone: 'error' }); }
  };
  return <Modal label="Apps" onClose={onClose} className="apps-dialog">
    <div className="members-head">
      <div><h2 className="modal-title">Apps</h2>
        <p className="modal-text">MCP Apps installed for this agent. Each runs in its own container without network access; its views run in a sandbox on their own origin. Policies and allowed sites are set in the agent’s definition.</p></div>
      <button type="button" className="icon-btn small" aria-label="Close" onClick={onClose} data-autofocus><X size={16}/></button>
    </div>
    <ul className="token-list" aria-busy={!apps || undefined}>
      {failed && <li className="member-empty">Couldn’t load the apps. <button type="button" className="link-btn" onClick={load}>Try again</button></li>}
      {!apps && !failed && <li className="member-empty muted">Loading…</li>}
      {apps?.map(app => <li key={app.id} className="token-row app-row" data-inactive={!app.enabled || app.status !== 'running' || undefined}>
        <span className="member-text">
          <span className="member-name">{app.name}{app.version ? <span className="muted"> {app.version}</span> : null} <span className="mono muted">({app.id})</span></span>
          <span className="member-login">{app.status === 'running' ? (app.enabled ? 'Running' : 'Disabled') : app.status === 'starting' ? 'Starting…' : app.status === 'failed' ? <span className="token-warning">Failed to start: {app.error}</span> : 'Stopped'}{app.packageName ? ` · ${app.packageName}` : ''}</span>
          {!!app.tools?.length && <table className="app-tools"><thead><tr><th>Tool</th><th>Visible to</th><th>Policy</th></tr></thead><tbody>
            {app.tools.map(tool => <tr key={tool.name}><td><span className="mono">{tool.name}</span>{tool.resourceUri ? <span className="app-badge small" title={tool.resourceUri}>view</span> : null}</td><td>{VISIBILITY(tool.visibility)}</td><td data-policy={tool.policy}>{POLICY[tool.policy]}{tool.granted === 'tool' && <> (allowed always) <button type="button" className="link-btn" aria-label={`Reset ${tool.name}: ask again`} onClick={() => void reset(app, tool.name)}>Reset</button></>}{tool.granted === 'app' && ' (all allowed)'}</td></tr>)}
          </tbody></table>}
          {app.views?.map(view => <span key={view.uri} className="member-login app-csp">
            <span className="mono">{view.uri}</span>: {Object.values(view.declared).some(list => list?.length) ? <>declares {Object.entries(view.declared).filter(([, list]) => list?.length).map(([key, list]) => `${key.replace(/Domains$/, '')} ${list!.join(', ')}`).join('; ')} · granted {Object.values(view.granted).some(list => list.length) ? Object.entries(view.granted).filter(([, list]) => list.length).map(([key, list]) => `${key.replace(/Domains$/, '')} ${list.join(', ')}`).join('; ') : 'none'}</> : 'no outside sites'}
          </span>)}
          {app.grantedAll && <span className="member-login app-grant">All actions of this app that ask run without asking (allowed always). <button type="button" className="link-btn" aria-label={`Reset ${app.name}: ask again`} onClick={() => void reset(app, '*')}>Reset</button></span>}
          {app.grantedMessages && <span className="member-login app-grant">Messages to the agent: allowed always. <button type="button" className="link-btn" aria-label={`Reset ${app.name} messages: ask again`} onClick={() => void reset(app, '@message')}>Reset</button></span>}
          {app.grantedContext && <span className="member-login app-grant">Context updates for the agent: allowed always. <button type="button" className="link-btn" aria-label={`Reset ${app.name} context updates: ask again`} onClick={() => void reset(app, '@context')}>Reset</button></span>}
          {app.dev && <label className="member-login app-dev-ask" title="The agent’s own code, in its container without network; every action, message and context update is audited. Untick to be asked each time."><input type="checkbox" checked={!app.viewsAsk} onChange={event => void devAsk(app, !event.target.checked)}/> Run its views’ actions, messages and context updates without asking</label>}
          {!!app.origins?.length && <span className="member-login">Allowed sites: {app.origins.join(', ')}</span>}
          {viewPolicy && onViewPolicy && !!app.views?.length && <label className="member-login app-view-policy">Views:{' '}
            <select value={viewPolicy(app.id)} onChange={event => onViewPolicy(app.id, event.target.value === 'every' ? 'every' : 'single')} aria-label={`Views of ${app.name}`}>
              <option value="single">One live view per app (recommended)</option>
              <option value="every">Every call shows its own view</option>
            </select>
          </label>}
        </span>
        <button type="button" className="btn ghost small" onClick={() => void toggle(app)} disabled={app.status !== 'running' && app.enabled}>{app.enabled ? 'Disable' : 'Enable'}</button>
      </li>)}
    </ul>
  </Modal>;
}
