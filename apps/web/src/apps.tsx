import React, { createContext, Suspense, lazy, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Blocks, ChevronRight, LoaderCircle, ShieldAlert, X } from 'lucide-react';
import { api, errorCode } from './api.js';
import { Modal } from './modal.js';
import { useToast } from './toasts.js';
import { appToolLabel, approvalTitle, type AppApprovalView, type AppStatusView, type DisplayMode, type ViewTool } from './apps-model.js';

/** The view frame carries the MCP SDK: loaded only when a view shows. */
const AppFrame = lazy(() => import('./app-view.js'));

/** MCP Apps of the open conversation: which tools show views, the panel, approvals. */
export type AppsState = {
  enabled: boolean; threadId?: string;
  viewTools: Readonly<Record<string, ViewTool>>;
  /** The calls with a tab in the side panel (this conversation). */
  panel?: readonly string[];
  openPanel(toolCallId: string, toolName: string): void;
  closePanel(toolCallId: string): void;
  /** The call shown full screen or in picture-in-picture, if any. */
  overlay?: { toolCallId: string; mode: Exclude<DisplayMode, 'inline'> };
  setOverlay(value: AppsState['overlay']): void;
  refreshApprovals(): void;
  onSent(): void;
};
export const AppsContext = createContext<AppsState>({ enabled: false, viewTools: {}, openPanel: () => {}, closePanel: () => {}, setOverlay: () => {}, refreshApprovals: () => {}, onSent: () => {} });

/** `GET /v1/apps` (tools with views), refreshed with the conversation. */
export function useViewTools(enabled: boolean, refreshKey: number): Record<string, ViewTool> {
  const [tools, setTools] = useState<Record<string, ViewTool>>({});
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api<{ viewTools: Record<string, ViewTool> }>('/v1/apps').then(data => { if (live) setTools(data.viewTools ?? {}); }).catch(() => {});
    return () => { live = false; };
  }, [enabled, refreshKey]);
  return tools;
}
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
  const overlay = apps.overlay?.toolCallId === toolCallId ? apps.overlay.mode : undefined;
  const inPanel = !!apps.panel?.includes(toolCallId);
  const label = appToolLabel(view, phase);
  return <div className="line app-line" data-tone={phase} data-tool-call-id={toolCallId}>
    <button type="button" className="line-summary" aria-expanded={open} onClick={() => setOpen(o => !o)} aria-label={`${label}. ${open ? 'Hide' : 'Show'} the app`}>
      {phase === 'running' ? <LoaderCircle size={14} className="line-icon spin" aria-hidden="true"/> : <Blocks size={14} className="line-icon" aria-hidden="true"/>}
      <span className={`line-label ${phase === 'running' ? 'shimmer' : ''}`}>{label}</span>
      <span className="app-badge" aria-hidden="true">App</span>
      <ChevronRight size={14} className="chev" aria-hidden="true"/>
    </button>
    {open && <div className="app-line-body">
      {inPanel || overlay
        ? <p className="muted app-elsewhere">{inPanel ? 'Shown in the panel.' : overlay === 'pip' ? 'Shown in picture-in-picture.' : 'Shown full screen.'} <button type="button" className="link-btn" onClick={() => { if (inPanel) apps.closePanel(toolCallId); else apps.setOverlay(undefined); }}>Show here</button></p>
        : <AppSlot toolCallId={toolCallId} placement="inline" mode="inline" version={phase} name={view.appName} onMode={mode => { if (mode !== 'inline') apps.setOverlay({ toolCallId, mode }); }} onOpenPanel={() => apps.openPanel(toolCallId, toolName)}/>}
      {fallback}
    </div>}
  </div>;
}

/** One view, lazily loaded. */
export function AppSlot(props: { toolCallId: string; placement: 'inline' | 'panel'; mode: DisplayMode; version?: string; name?: string; onMode(mode: DisplayMode): void; onOpenPanel?(): void; onClose?(): void }) {
  const apps = useContext(AppsContext);
  if (!apps.threadId) return null;
  return <Suspense fallback={<div className="appview-wait" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true"/>Loading the app…</div>}>
    <AppFrame threadId={apps.threadId} toolCallId={props.toolCallId} placement={props.placement} mode={props.mode} onMode={props.onMode} onApprovals={apps.refreshApprovals} onSent={apps.onSent}
      {...(props.version ? { version: props.version } : {})} {...(props.name ? { name: props.name } : {})} {...(props.onOpenPanel ? { onOpenPanel: props.onOpenPanel } : {})} {...(props.onClose ? { onClose: props.onClose } : {})}/>
  </Suspense>;
}

/** An app tab of the side panel: one app view at full height. */
export function AppPanel({ toolCallId, onClose }: { toolCallId: string; onClose(): void }) {
  const apps = useContext(AppsContext);
  return <div className="app-panel">
    <AppSlot key={`panel-${toolCallId}`} toolCallId={toolCallId} placement="panel" mode="inline" onMode={mode => { if (mode !== 'inline') apps.setOverlay({ toolCallId, mode }); }} onClose={onClose}/>
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
    <AppSlot key={`${overlay.mode}-${overlay.toolCallId}`} toolCallId={overlay.toolCallId} placement="inline" mode={overlay.mode} onMode={mode => apps.setOverlay(mode === 'inline' ? undefined : { toolCallId: overlay.toolCallId, mode })} onClose={() => apps.setOverlay(undefined)}/>
  </div>;
}

/**
 * Cards for app actions waiting for the person (outside any turn): a tool
 * the app wants to run, a message it wants to send to the agent, or context
 * it wants to give it. Allow or deny, once.
 */
export function AppApprovalCards({ approvals, onDecided }: { approvals: AppApprovalView[]; onDecided(): void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  if (!approvals.length) return null;
  const decide = async (approval: AppApprovalView, approved: boolean) => {
    setBusy(approval.id);
    try { await api(`/v1/apps/approvals/${encodeURIComponent(approval.id)}`, { approved }); }
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
export function AppsDialog({ onClose, onChanged }: { onClose(): void; onChanged(): void }) {
  const toast = useToast();
  const [apps, setApps] = useState<AppStatusView[]>();
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => { api<{ apps: AppStatusView[] }>('/v1/apps').then(data => { setApps(data.apps); setFailed(false); }).catch(() => setFailed(true)); }, []);
  useEffect(() => { load(); const timer = setInterval(load, 4000); return () => clearInterval(timer); }, [load]);
  const toggle = async (app: AppStatusView) => {
    try { await api(`/v1/apps/${encodeURIComponent(app.id)}`, { enabled: !app.enabled }, 'PATCH'); toast(`${app.name} ${app.enabled ? 'disabled: its tools refuse calls and its views don’t show' : 'enabled'}.`); load(); onChanged(); }
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
            {app.tools.map(tool => <tr key={tool.name}><td><span className="mono">{tool.name}</span>{tool.resourceUri ? <span className="app-badge small" title={tool.resourceUri}>view</span> : null}</td><td>{VISIBILITY(tool.visibility)}</td><td data-policy={tool.policy}>{POLICY[tool.policy]}</td></tr>)}
          </tbody></table>}
          {app.views?.map(view => <span key={view.uri} className="member-login app-csp">
            <span className="mono">{view.uri}</span>: {Object.values(view.declared).some(list => list?.length) ? <>declares {Object.entries(view.declared).filter(([, list]) => list?.length).map(([key, list]) => `${key.replace(/Domains$/, '')} ${list!.join(', ')}`).join('; ')} · granted {Object.values(view.granted).some(list => list.length) ? Object.entries(view.granted).filter(([, list]) => list.length).map(([key, list]) => `${key.replace(/Domains$/, '')} ${list.join(', ')}`).join('; ') : 'none'}</> : 'no outside sites'}
          </span>)}
          {!!app.origins?.length && <span className="member-login">Allowed sites: {app.origins.join(', ')}</span>}
        </span>
        <button type="button" className="btn ghost small" onClick={() => void toggle(app)} disabled={app.status !== 'running' && app.enabled}>{app.enabled ? 'Disable' : 'Enable'}</button>
      </li>)}
    </ul>
  </Modal>;
}
