import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { CalendarClock, Check, Copy, Ellipsis, KeyRound, LoaderCircle, Plus, Trash2, Workflow, X } from 'lucide-react';
import { ApiError, apiPath, errorCode, setCsrfHeader } from './api.js';
import { Modal } from './modal.js';
import { useToast } from './toasts.js';
import { friendlyName } from './presentation.js';
import { automationError, relativeTime, scheduleState, VIA_LABEL, type AutomationsData, type ScheduleView, type TokenView, type Via } from './automations-model.js';

/** A JSON call to the agent's `/automations` routes. */
async function automationsApi<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  let response: Response;
  try { response = await fetch(apiPath(`/automations${path}`), { method, credentials: 'same-origin', headers: { ...setCsrfHeader(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new ApiError('network', 0); }
  let data: { error?: string } = {};
  try { data = await response.json(); } catch { /* no body */ }
  if (!response.ok) throw new ApiError(data.error ?? `http_${response.status}`, response.status);
  return data as T;
}

/** A row at the foot of the sidebar, for the agent's admins: opens Automations. */
export function AutomationsRow({ onOpen }: { onOpen(): void }) {
  return <button type="button" className="integration-row automations-row" onClick={onOpen} aria-label="Automations: tokens for n8n, Conductor and scripts, and scheduled tasks">
    <span className="integration-mark" aria-hidden="true"><Workflow size={13}/></span>
    <span className="integration-label">Automations</span>
  </button>;
}

/**
 * Automations of the agent (admins only): tokens that let n8n, Conductor or a
 * script start turns (create: the token is shown once; revoke), and the tasks
 * the agent scheduled (cancel).
 */
export function AutomationsDialog({ agentName, onClose, onOpenThread }: { agentName: string; onClose(): void; onOpenThread(id: string): void }) {
  const toast = useToast();
  const [data, setData] = useState<AutomationsData>();
  const [failed, setFailed] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ token: TokenView; secret: string }>();
  const load = useCallback(async () => {
    try { setData(await automationsApi<AutomationsData>('')); setFailed(''); }
    catch (error) { setFailed(automationError(errorCode(error))); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function revoke(token: TokenView) {
    try { await automationsApi(`/tokens/${encodeURIComponent(token.id)}`, undefined, 'DELETE'); toast(`Revoked “${token.name}”. It no longer works.`); await load(); }
    catch (error) { toast(automationError(errorCode(error)), { tone: 'error' }); }
  }
  async function cancel(task: ScheduleView) {
    try { await automationsApi(`/schedules/${encodeURIComponent(task.id)}/cancel`, {}); toast('Cancelled the scheduled task.'); await load(); }
    catch (error) { toast(automationError(errorCode(error)), { tone: 'error' }); }
  }
  return <Modal label={`Automations of ${agentName}`} onClose={onClose} className="automations">
    <div className="members-head">
      <div><h2 className="modal-title">Automations</h2>
        <p className="modal-text">Let n8n, Conductor or a script start conversations with {agentName}. Each token belongs to one automation and acts as you. Runs nobody watches can’t ask for approval: they stop and report it instead.</p></div>
      <button type="button" className="icon-btn small" aria-label="Close" onClick={onClose}><X size={16}/></button>
    </div>
    {created
      ? <CreatedToken created={created} endpoint={data?.endpoint} onDone={() => { setCreated(undefined); void load(); }}/>
      : creating
        ? <CreateToken tools={data?.tools ?? []} replyModes={!!data?.replyModes} onCancel={() => setCreating(false)} onCreated={value => { setCreating(false); setCreated(value); }}/>
        : <>
            <div className="automations-section-head">
              <h3 className="automations-heading"><KeyRound size={15} aria-hidden="true"/>Tokens</h3>
              <button type="button" className="btn small primary" data-autofocus onClick={() => setCreating(true)} disabled={!data}><Plus size={15} aria-hidden="true"/>New token</button>
            </div>
            <ul className="token-list" aria-label="Tokens" aria-busy={!data || undefined}>
              {failed && <li className="member-empty">{failed} <button type="button" className="link-btn" onClick={() => void load()}>Try again</button></li>}
              {!data && !failed && <li className="member-empty muted">Loading…</li>}
              {data && !data.tokens.length && <li className="member-empty muted">No tokens yet. Create one for each workflow that should talk to {agentName}.</li>}
              {data?.tokens.map(token => <li key={token.id} className="token-row" data-inactive={!token.active || undefined}>
                <span className="token-icon" aria-hidden="true">{VIA_LABEL[token.via].slice(0, 1)}</span>
                <span className="member-text">
                  <span className="member-name">{token.name}</span>
                  <span className="member-login">
                    {VIA_LABEL[token.via]} · <span className="mono">{token.hint}</span> · acts as {token.actor.name}
                    {token.preApproved.length ? ` · pre-approved: ${token.preApproved.map(friendlyName).join(', ')}` : ''}
                  </span>
                  <span className="member-login">{!token.active ? <span className="token-warning">{token.actor.login ? `Not working: ${token.actor.name} is no longer a member of this agent` : 'Not working on this server: it acts for someone who isn’t a member of this agent'}</span> : token.lastUsedAt ? <>Last used {relativeTime(token.lastUsedAt)}{token.lastRun && token.lastRun.status !== 'completed' ? <> · <span className="token-warning">{token.lastRun.error === 'approval_required' ? 'last run needed approval' : token.lastRun.error === 'question_required' ? 'last run needed an answer' : `last run ${token.lastRun.status}`}</span></> : null}</> : 'Never used'}</span>
                </span>
                {token.lastRun && <button type="button" className="btn ghost small" onClick={() => { onClose(); onOpenThread(token.lastRun!.threadId); }}>Open</button>}
                <TokenMenu token={token} onRevoke={() => void revoke(token)}/>
              </li>)}
            </ul>
            {!!data?.schedules.length && <>
              <h3 className="automations-heading"><CalendarClock size={15} aria-hidden="true"/>Scheduled by the agent</h3>
              <ul className="token-list" aria-label="Scheduled tasks">
                {data.schedules.map(task => <li key={task.id} className="token-row">
                  <span className="member-text">
                    <span className="member-name schedule-prompt" title={task.prompt}>{task.prompt}</span>
                    <span className="member-login">{scheduleState(task)} · {VIA_LABEL[task.orchestrator as Via] ?? task.orchestrator} · asked by {task.actor.name}</span>
                  </span>
                  {task.run && <button type="button" className="btn ghost small" onClick={() => { onClose(); onOpenThread(task.run!.threadId); }}>Open</button>}
                  {(task.state === 'scheduled' || task.state === 'failed') && <button type="button" className="btn ghost small" onClick={() => void cancel(task)}>Cancel</button>}
                </li>)}
              </ul>
            </>}
            {data?.endpoint && <p className="integration-note">Automation API: <span className="mono">{data.endpoint.url}</span>{data.endpoint.docker ? <> · from Docker on this machine: <span className="mono">{data.endpoint.docker}</span></> : null}. {data.endpoint.scheduler ? `The agent can schedule tasks with ${VIA_LABEL[data.endpoint.scheduler]}.` : 'Agent scheduling is off (no orchestrator configured).'}</p>}
          </>}
  </Modal>;
}

function TokenMenu({ token, onRevoke }: { token: TokenView; onRevoke(): void }) {
  const [confirm, setConfirm] = useState(false);
  return <>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button type="button" className="icon-btn small" aria-label={`Options for ${token.name}`}><Ellipsis size={16}/></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" side="bottom" collisionPadding={8}>
          <DropdownMenu.Item className="menu-item danger" onSelect={() => setConfirm(true)}><Trash2 size={15} aria-hidden="true"/>Revoke…</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {confirm && <Modal label={`Revoke ${token.name}`} onClose={() => setConfirm(false)} className="confirm">
      <h2 className="modal-title">Revoke “{token.name}”?</h2>
      <p className="modal-text">Workflows that use it stop working at once. Runs it already started finish. This can’t be undone; you can create a new token.</p>
      <div className="modal-actions">
        <button type="button" className="btn" data-autofocus onClick={() => setConfirm(false)}>Keep</button>
        <button type="button" className="btn danger" onClick={() => { setConfirm(false); onRevoke(); }}>Revoke</button>
      </div>
    </Modal>}
  </>;
}

function CreateToken({ tools, replyModes, onCancel, onCreated }: { tools: readonly string[]; replyModes: boolean; onCancel(): void; onCreated(value: { token: TokenView; secret: string }): void }) {
  const [name, setName] = useState('');
  const [via, setVia] = useState<Via>('n8n');
  const [preApproved, setPreApproved] = useState<string[]>([]);
  const [replyMode, setReplyMode] = useState('always');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) { if (!name.trim()) setProblem('Give the token a name, for example the workflow’s.'); return; }
    setSaving(true); setProblem('');
    try { onCreated(await automationsApi<{ token: TokenView; secret: string }>('/tokens', { name: name.trim(), via, preApproved, ...(replyModes ? { replyMode } : {}) })); }
    catch (error) { setProblem(automationError(errorCode(error))); }
    finally { setSaving(false); }
  }
  return <form className="integration-form token-form" onSubmit={event => void submit(event)}>
    <label className="integration-field">Name
      <input className="member-input" data-autofocus value={name} maxLength={80} placeholder="Nightly report" onChange={event => { setName(event.target.value); setProblem(''); }} aria-invalid={!!problem || undefined}/>
    </label>
    <label className="integration-field">Used by
      <select className="member-role" value={via} onChange={event => setVia(event.target.value as Via)}>
        <option value="n8n">n8n</option><option value="conductor">Conductor</option><option value="api">A script (API)</option>
      </select>
    </label>
    {replyModes && <label className="integration-field">Replies
      <select className="member-role" value={replyMode} onChange={event => setReplyMode(event.target.value)}>
        <option value="always">Always reply</option><option value="when-addressed">When mentioned or asked</option><option value="agent-decides">Agent decides</option>
      </select>
    </label>}
    <fieldset className="integration-field token-tools">
      <legend>Allowed without asking</legend>
      {tools.length
        ? tools.map(tool => <label key={tool} className="token-tool"><input type="checkbox" checked={preApproved.includes(tool)} onChange={event => setPreApproved(list => event.target.checked ? [...list, tool] : list.filter(t => t !== tool))}/>{friendlyName(tool)}<span className="mono muted">{tool}</span></label>)
        : <p className="integration-help">This agent has no tools that ask for approval.</p>}
      <p className="integration-help">Nobody watches these runs. A tool that asks for approval stops the run with “approval required”, unless you allow it here. Questions always stop the run. Tools that are off stay off.</p>
    </fieldset>
    {problem && <p className="integration-problem" role="alert">{problem}</p>}
    <div className="modal-actions">
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      <button type="submit" className="btn primary" disabled={saving}>{saving && <LoaderCircle size={15} className="spin" aria-hidden="true"/>}Create token</button>
    </div>
  </form>;
}

/** The new token, shown once. */
function CreatedToken({ created, endpoint, onDone }: { created: { token: TokenView; secret: string }; endpoint?: AutomationsData['endpoint']; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(created.secret); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { field.current?.select(); }
  }
  return <div className="token-created">
    <p className="modal-text"><strong>Copy this token now.</strong> It is shown only once; the server keeps only a fingerprint of it. Paste it into {created.token.via === 'n8n' ? 'n8n’s “ai-sdk-letta API” credential' : created.token.via === 'conductor' ? 'Conductor (as the CONDUCTOR_SECRET_… environment variable your workflow reads)' : 'your script’s secret store'}.</p>
    <div className="token-secret">
      <input ref={field} className="member-input mono" readOnly value={created.secret} aria-label="New token" onFocus={event => event.currentTarget.select()}/>
      <button type="button" className="btn primary" data-autofocus onClick={() => void copy()}>{copied ? <Check size={15} aria-hidden="true"/> : <Copy size={15} aria-hidden="true"/>}{copied ? 'Copied' : 'Copy'}</button>
    </div>
    {endpoint && <p className="integration-help">Server URL: <span className="mono">{endpoint.docker ?? endpoint.url}</span>{endpoint.docker ? ' (from Docker on this machine)' : ''}</p>}
    <div className="modal-actions"><button type="button" className="btn" onClick={onDone}>Done</button></div>
  </div>;
}
