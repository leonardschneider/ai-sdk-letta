import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, ExternalLink, Globe, LoaderCircle, Monitor, RotateCw, Smartphone, X } from 'lucide-react';
import { api, errorCode } from './api.js';
import { useToast } from './toasts.js';
import { addressOf, devServerRunning, folderLabel, frameUrl, originLabel, PHONE_WIDTH, statusLine, type PreviewDevice, type PreviewStatus } from './preview-model.js';

/** How often the pane refreshes the status while it is open (the long poll also refreshes it). */
const POLL_MS = 4000;

/** The conversation's web development status; refreshed when `refreshKey` changes, and every few seconds while `active`. Never another conversation's. */
export function usePreviewStatus(threadId: string | undefined, enabled: boolean, refreshKey: number, active: boolean): [PreviewStatus | undefined, () => Promise<void>] {
  const [state, setState] = useState<{ threadId: string; status: PreviewStatus }>();
  const current = useRef(threadId);
  current.current = threadId;
  const load = useCallback(async () => {
    const id = current.current;
    if (!enabled || !id) { setState(undefined); return; }
    try { const status = await api<PreviewStatus>(`/v1/threads/${encodeURIComponent(id)}/preview`); if (current.current === id) setState({ threadId: id, status }); }
    catch { /* keep the last status; the next refresh retries */ }
  }, [enabled]);
  useEffect(() => { void load(); }, [threadId, refreshKey, load]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);
  return [state && state.threadId === threadId ? state.status : undefined, load];
}

/**
 * The Preview pane: the conversation's dev server in a frame of its own
 * origin (`p-<token>.localhost`, never the app's), with an address bar,
 * reload, open in a new tab, a desktop / phone width toggle, and the
 * outside origins approved in this conversation (revocable).
 *
 * The frame may run scripts, keep its own storage, submit forms and open
 * dialogs; it cannot navigate the app or open pop-ups. HMR updates it in
 * place: the frame is only reloaded when you ask, or when a dev server
 * (re)starts.
 */
export function PreviewPanel({ threadId, status, device, onDevice, onClose, onChanged }: {
  threadId: string; status: PreviewStatus | undefined; device: PreviewDevice; onDevice(device: PreviewDevice): void; onClose(): void; onChanged(): void;
}) {
  const toast = useToast();
  const live = devServerRunning(status);
  const base = status?.enabled ? status.previewUrl : undefined;
  const [src, setSrc] = useState<string>();
  const [address, setAddress] = useState('/');
  const [nonce, setNonce] = useState(0);
  const [revoking, setRevoking] = useState<string>();
  // A new conversation, or a dev server that (re)started: load the app from its root.
  const startedAt = live ? status.devServer.startedAt : undefined;
  useEffect(() => { if (base) { setSrc(base); setAddress('/'); setNonce(n => n + 1); } }, [base, startedAt]);
  const go = (event: React.FormEvent) => {
    event.preventDefault();
    if (!base) return;
    const url = frameUrl(address, base);
    if (!url) { toast('The preview only shows this conversation’s app. Type a path such as /about.', { tone: 'error' }); return; }
    setSrc(url); setAddress(addressOf(url, base)); setNonce(n => n + 1);
  };
  const revoke = async (origin: string) => {
    setRevoking(origin);
    try { await api(`/v1/threads/${encodeURIComponent(threadId)}/preview/revoke`, { origin }); toast(`${originLabel(origin)} is no longer allowed in this conversation.`); onChanged(); }
    catch (error) { toast(errorCode(error) === 'not_found' ? 'That origin was already revoked.' : 'Couldn’t revoke it. Try again.', { tone: 'error' }); onChanged(); }
    finally { setRevoking(undefined); }
  };
  const origins = status?.enabled ? status.origins : [];
  return <div className="webprev" data-device={device}>
    <div className="res-head webprev-head">
      <h2 className="res-title">Preview</h2>
      <span className="webprev-state" data-live={live || undefined}>{status?.enabled && status.container === 'starting' && <LoaderCircle size={12} className="spin" aria-hidden="true"/>}{statusLine(status)}</span>
      <div className="res-tools">
        <div className="webprev-seg" role="group" aria-label="Preview width">
          <button type="button" className="icon-btn small" aria-label="Desktop width" aria-pressed={device === 'desktop'} title="Desktop width" onClick={() => onDevice('desktop')}><Monitor size={15}/></button>
          <button type="button" className="icon-btn small" aria-label={`Phone width (${PHONE_WIDTH} px)`} aria-pressed={device === 'phone'} title={`Phone width (${PHONE_WIDTH} px)`} onClick={() => onDevice('phone')}><Smartphone size={15}/></button>
        </div>
        <button type="button" className="icon-btn small" aria-label="Close preview" title="Close preview" onClick={onClose}><X size={16}/></button>
      </div>
    </div>
    {live && base && <form className="webprev-bar" onSubmit={go}>
      <button type="button" className="icon-btn small" aria-label="Reload preview" title="Reload" onClick={() => setNonce(n => n + 1)}><RotateCw size={14}/></button>
      <input className="webprev-address" aria-label="Preview address" value={address} spellCheck={false} autoComplete="off" onChange={event => setAddress(event.target.value)} onFocus={event => event.currentTarget.select()}/>
      <a className="icon-btn small" href={src ?? base} target="_blank" rel="noopener noreferrer" aria-label="Open preview in a new tab" title="Open in a new tab"><ExternalLink size={14}/></a>
    </form>}
    <div className="webprev-stage">
      {live && src
        ? <div className="webprev-frame-wrap">
            <iframe key={nonce} className="webprev-frame" title="App preview" src={src}
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals" referrerPolicy="no-referrer" allow="clipboard-write"/>
          </div>
        : <div className="webprev-empty">
            <AppWindow size={28} aria-hidden="true"/>
            <p>{status?.enabled && status.container === 'starting' ? 'Starting the web development container…' : 'No dev server is running in this conversation.'}</p>
            <p className="muted">Ask the agent to build a web app, or to start its dev server. It shows up here live.</p>
          </div>}
    </div>
    {live && <p className="res-foot webprev-foot" title={status.devServer.command}>Folder: {folderLabel(status.devServer.folder)}</p>}
    {origins.length > 0 && <div className="webprev-origins">
      <p className="webprev-origins-title"><Globe size={13} aria-hidden="true"/>Allowed outside origins</p>
      <ul>{origins.map(origin => <li key={origin}>
        <span className="webprev-origin" title={origin}>{originLabel(origin)}</span>
        <button type="button" className="btn small ghost" disabled={revoking === origin} onClick={() => void revoke(origin)}>Revoke</button>
      </li>)}</ul>
    </div>}
  </div>;
}
