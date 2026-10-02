import React, { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, ExternalLink, LoaderCircle, Plug, Unplug } from 'lucide-react';
import { integrationApi, type AtlassianStatus } from './api.js';
import { Modal } from './modal.js';
import { useToast } from './toasts.js';

/** Where people create an Atlassian API token. */
export const TOKEN_HELP_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** The status of your own Atlassian connection; refreshed when the dialog changes it. */
export function useAtlassianStatus(enabled: boolean, refreshKey?: unknown) {
  const [status, setStatus] = useState<AtlassianStatus>();
  // Again after every turn: a tool call may have found the token rejected.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    integrationApi<AtlassianStatus>('/atlassian').then(value => { if (live) setStatus(value); }, () => {});
    return () => { live = false; };
  }, [enabled, refreshKey]);
  return [status, setStatus] as const;
}

/** A row at the foot of the sidebar: "Connect Atlassian", or the connected site (and a warning when the token was rejected). */
export function AtlassianRow({ status, onOpen }: { status?: AtlassianStatus; onOpen(): void }) {
  const rejected = status?.connected && status.status === 'rejected';
  const label = !status ? 'Atlassian' : status.connected ? new URL(status.site).hostname : 'Connect Atlassian';
  return <button type="button" className="integration-row" data-state={rejected ? 'rejected' : status?.connected ? 'connected' : 'disconnected'} onClick={onOpen}
    aria-label={rejected ? 'Atlassian: the token was rejected. Replace it' : status?.connected ? `Atlassian: connected to ${label}. Manage` : 'Connect Atlassian'}>
    <AtlassianMark/>
    <span className="integration-label">{label}</span>
    {rejected ? <span className="integration-badge danger">Replace token</span> : status?.connected ? <CircleCheck size={14} className="integration-ok" aria-hidden="true"/> : <Plug size={14} aria-hidden="true"/>}
  </button>;
}

/** A small neutral mark (no Atlassian logo or remote image). */
function AtlassianMark() { return <span className="integration-mark" aria-hidden="true">A</span>; }

type Busy = 'save' | 'test' | 'disconnect' | undefined;
/**
 * The "Connect Atlassian" dialog: site, email and API token. The token is
 * sent once to this server, checked with Atlassian and stored there; it is
 * never shown again (the field stays empty after saving).
 */
export function AtlassianDialog({ status, onStatus, onClose, team }: { status?: AtlassianStatus; onStatus(status: AtlassianStatus): void; onClose(): void; team: boolean }) {
  const toast = useToast();
  const connected = status?.connected ? status : undefined;
  const [site, setSite] = useState(connected?.site ?? '');
  const [email, setEmail] = useState(connected?.email ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<Busy>();
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string }>();
  const first = useRef<HTMLInputElement>(null);
  const replacing = !connected || connected.status === 'rejected';
  const [editing, setEditing] = useState(replacing);
  useEffect(() => { if (editing) requestAnimationFrame(() => (connected ? document.getElementById('atl-token') as HTMLInputElement | null : first.current)?.focus()); }, [editing, connected]);
  const run = async (kind: Exclude<Busy, undefined>, task: () => Promise<AtlassianStatus>) => {
    setBusy(kind); setProblem(''); setResult(undefined);
    try {
      const next = await task();
      onStatus(next);
      return next;
    } catch (error) { setProblem(error instanceof Error ? error.message : 'That didn’t work.'); return undefined; }
    finally { setBusy(undefined); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!site.trim() || !email.trim() || !token.trim()) { setProblem('Enter your site, email and API token.'); return; }
    const next = await run('save', () => integrationApi<AtlassianStatus>('/atlassian', { site, email, token }, 'PUT'));
    // The token never stays in the page once saved.
    setToken('');
    if (next?.connected) { setEditing(false); setResult({ tone: 'ok', text: `Connected as ${next.accountName ?? next.email}.` }); toast('Atlassian connected'); }
  };
  const test = async () => {
    const next = await run('test', () => integrationApi<AtlassianStatus>('/atlassian/test', {}));
    if (!next) return;
    if (next.connected && next.status === 'ok') setResult({ tone: 'ok', text: `Connection works: signed in as ${next.accountName ?? next.email}.` });
    else if (next.connected) { setResult({ tone: 'error', text: 'Atlassian rejected the token (it expired or was revoked). Paste a new one.' }); setEditing(true); }
  };
  const disconnect = async () => {
    const next = await run('disconnect', () => integrationApi<AtlassianStatus>('/atlassian', undefined, 'DELETE'));
    if (next) { setSite(''); setEmail(''); setToken(''); setEditing(true); toast('Atlassian disconnected. The token was deleted from this server.'); }
  };
  return <Modal label="Connect Atlassian" onClose={onClose} className="integration">
    <h2 className="modal-title">{connected ? 'Atlassian' : 'Connect Atlassian'}</h2>
    <p className="modal-text">Lets the agent read and, with your approval for every change, edit Jira issues and Confluence pages <strong>as you</strong>, with your own API token. {team ? 'Each person connects their own account; nobody else can see or use yours.' : ''}</p>
    {connected && <div className="integration-status" data-state={connected.status}>
      {connected.status === 'ok' ? <CircleCheck size={16} aria-hidden="true"/> : <CircleAlert size={16} aria-hidden="true"/>}
      <div>
        <div className="integration-status-main">{connected.status === 'ok' ? 'Connected' : 'Token rejected'} · <a href={connected.site} target="_blank" rel="noopener noreferrer">{new URL(connected.site).hostname}</a></div>
        <div className="integration-status-sub">{connected.accountName ? `${connected.accountName} · ` : ''}{connected.email}{connected.status === 'rejected' ? ' · Atlassian rejected the saved token (it expired or was revoked). Paste a new one below.' : connected.checkedAt ? ` · checked ${new Date(connected.checkedAt).toLocaleString()}` : ''}</div>
      </div>
    </div>}
    {editing ? <form className="integration-form" onSubmit={event => void save(event)} noValidate>
      <label className="integration-field"><span>Site</span>
        <input ref={first} className="member-input" name="site" type="url" inputMode="url" autoComplete="url" placeholder="https://your-team.atlassian.net" value={site} onChange={event => setSite(event.target.value)} disabled={!!busy} spellCheck={false}/>
      </label>
      <label className="integration-field"><span>Email</span>
        <input className="member-input" name="email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)} disabled={!!busy} spellCheck={false}/>
      </label>
      <label className="integration-field"><span>API token</span>
        <input id="atl-token" className="member-input" name="token" type="password" autoComplete="off" placeholder={connected ? 'Paste a new token' : 'Paste your API token'} value={token} onChange={event => setToken(event.target.value)} disabled={!!busy} spellCheck={false} data-1p-ignore data-lpignore="true"/>
      </label>
      <p className="integration-help">Create one at <a href={TOKEN_HELP_URL} target="_blank" rel="noopener noreferrer">id.atlassian.com → Security → API tokens<ExternalLink size={12} aria-hidden="true"/></a>. It is stored on this server only (readable by its owner account), never shown again, and never given to the agent.</p>
      {problem && <p className="integration-problem" role="alert">{problem}</p>}
      <div className="modal-actions">
        {connected && connected.status === 'ok' && <button type="button" className="btn ghost" onClick={() => { setEditing(false); setProblem(''); setToken(''); }} disabled={!!busy}>Cancel</button>}
        {!connected && <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>}
        <button type="submit" className="btn primary" disabled={!!busy}>{busy === 'save' ? <><LoaderCircle size={15} className="spin" aria-hidden="true"/>Checking…</> : connected ? 'Save new token' : 'Connect'}</button>
      </div>
    </form> : <>
      {problem && <p className="integration-problem" role="alert">{problem}</p>}
      {result && <p className={`integration-result ${result.tone}`} role="status">{result.text}</p>}
      <div className="modal-actions integration-actions">
        <button type="button" className="btn ghost danger-text" onClick={() => void disconnect()} disabled={!!busy}>{busy === 'disconnect' ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <Unplug size={15} aria-hidden="true"/>}Disconnect</button>
        <span className="spacer"/>
        <button type="button" className="btn" onClick={() => setEditing(true)} disabled={!!busy}>Replace token</button>
        <button type="button" className="btn primary" onClick={() => void test()} disabled={!!busy}>{busy === 'test' ? <><LoaderCircle size={15} className="spin" aria-hidden="true"/>Testing…</> : 'Test connection'}</button>
      </div>
    </>}
    <p className="integration-note">For your own self-hosted server: Atlassian API tokens act with your full account rights. Revoke the token at id.atlassian.com to cut access at any time.</p>
  </Modal>;
}
