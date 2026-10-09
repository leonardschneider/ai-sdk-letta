import React, { useCallback, useEffect, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check, ChevronDown, FileDiff, FolderGit2, LoaderCircle, Plus, RotateCcw, Trash2, Wrench, X } from 'lucide-react';
import { ApiError, serverApi, type AgentInfo } from './api.js';
import { Modal } from './modal.js';
import { useToast } from './toasts.js';
import { toggleToolSet } from './tool-sets.js';

/** A local Letta agent as the "Add agent" picker lists it (`GET /api/adoption/agents`). */
export type LocalAgent = { agentId: string; name: string; model: string; lastActivity?: string; conversations: number; adoptedAs?: string; refusal?: string; inApp?: boolean; busy?: boolean };
type Picker = { agents: LocalAgent[]; tools: { available: string[]; defaults: string[] } };

const TOOL_LABELS: Record<string, string> = { files: 'Files', sandbox: 'Shell commands (sandbox)', decisions: 'Decisions', web_search: 'Web search', ask_user: 'Questions', web_dev: 'Web development (dev server, preview, browser)', mcp_app_dev: 'MCP App development' };
/** The server's message for a refusal, or a fixed text. */
export const adoptionMessage = (error: unknown) => (error instanceof AdoptionError ? error.message : undefined) ?? 'That didn’t work. Nothing was changed.';
class AdoptionError extends Error { constructor(readonly code: string, message: string) { super(message); } }
async function adoptionApi<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  // A DELETE carries an empty body, so the method is sent (serverApi sends a body-less call as GET).
  try { return await serverApi<T>(`/adoption${path}`, method === 'DELETE' && body === undefined ? {} : body, method); }
  catch (error) {
    if (!(error instanceof ApiError)) throw new AdoptionError('network', 'Couldn’t reach the local server. Check that it is running.');
    const messages: Record<string, string> = {
      letta_code_active: 'Letta Code is using this agent right now. Close its Letta Code session, then retry.', agent_claimed: 'This agent is already in the app.', agent_missing: 'This agent no longer exists.',
      agent_hidden: 'This is a hidden or temporary agent; it cannot be added.', agent_without_memfs: 'Only agents with MemFS memory can be added.', runtime_busy: 'Wait until the agent finishes replying, then try again.',
      session_required: 'The local server restarted. Refresh the page.', csrf_required: 'The local server restarted. Refresh the page.',
      sandbox_unavailable: 'This server has no sandbox (web development needs the docker or apple-container one), so it cannot do that.',
      mcp_app_dev_needs_web_dev: 'MCP App development needs web development: turn both on.', web_dev_needs_sandbox: 'Web development needs shell commands (the sandbox): turn both on.',
    };
    // A refused project folder: the server says why (no such folder, credentials in .git/config, home folder...).
    const project = (error.code === 'project_unsafe' || error.code === 'project_has_credentials') && error.detail ? error.detail : undefined;
    throw new AdoptionError(error.code, project ?? messages[error.code] ?? 'That didn’t work. Nothing was changed.');
  }
}
const when = (value?: string) => {
  if (!value) return 'no activity yet';
  const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000);
  return days < 1 ? 'active today' : days === 1 ? 'active yesterday' : days < 60 ? `active ${days} days ago` : `active ${new Date(value).toLocaleDateString()}`;
};

/**
 * The agent name at the top of the sidebar in the single-user app with
 * adopted agents: switch agents, add one, remove the current one, or update
 * its instructions.
 */
export function LocalAgentSwitcher({ agents, current, onSwitch, onAdd, onRemove, onInstructions, onProject, onTools }: { agents: readonly AgentInfo[]; current: AgentInfo; onSwitch(id: string): void; onAdd(): void; onRemove(agent: AgentInfo): void; onInstructions(agent: AgentInfo): void; onProject?(agent: AgentInfo): void; onTools?(agent: AgentInfo): void }) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="agent-switch" aria-label={`Agent: ${current.name}. Switch or add agents`}>
        <span className="brand-mark" aria-hidden="true">✳︎</span><span className="agent-switch-name">{current.name}</span><ChevronDown size={15} className="agent-switch-chev" aria-hidden="true"/>
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu agent-menu" align="start" side="bottom" sideOffset={4} collisionPadding={8}>
        <DropdownMenu.Label className="menu-label">Agents</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={current.id} onValueChange={id => { if (id !== current.id) onSwitch(id); }}>
          {agents.map(agent => <DropdownMenu.RadioItem key={agent.id} value={agent.id} className="menu-item">
            <span className="menu-check" aria-hidden="true"><DropdownMenu.ItemIndicator><Check size={15}/></DropdownMenu.ItemIndicator></span>
            <span className="agent-menu-name">{agent.name}</span>{agent.adopted && <span className="role-badge small" title="An existing Letta agent, opened in place">Letta</span>}
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator className="menu-sep"/>
        <DropdownMenu.Item className="menu-item" onSelect={onAdd}><Plus size={15} aria-hidden="true"/>Add agent…</DropdownMenu.Item>
        {current.adopted && onTools && <DropdownMenu.Item className="menu-item" onSelect={() => onTools(current)}><Wrench size={15} aria-hidden="true"/>Tools…</DropdownMenu.Item>}
        {current.adopted && onProject && <DropdownMenu.Item className="menu-item" onSelect={() => onProject(current)}><FolderGit2 size={15} aria-hidden="true"/>Project folder…</DropdownMenu.Item>}
        {current.adopted && <DropdownMenu.Item className="menu-item" onSelect={() => onInstructions(current)}><FileDiff size={15} aria-hidden="true"/>Update instructions…</DropdownMenu.Item>}
        {current.adopted && <DropdownMenu.Item className="menu-item danger" onSelect={() => onRemove(current)}><Trash2 size={15} aria-hidden="true"/>Remove from app…</DropdownMenu.Item>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

/**
 * "Add agent": local Letta agents (hidden and temporary ones excluded) with
 * their model, last activity and conversations. Adding one opens it in place:
 * the same agent, memory and conversations, never a copy.
 */
export function AddAgentDialog({ onClose, onAdded }: { onClose(): void; onAdded(definitionId: string): void }) {
  const toast = useToast();
  const [data, setData] = useState<Picker>();
  const [failed, setFailed] = useState('');
  const [chosen, setChosen] = useState<string>();
  const [tools, setTools] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const load = useCallback(async () => {
    try { const loaded = await adoptionApi<Picker>('/agents'); setData(loaded); setTools(loaded.tools.defaults); setFailed(''); } catch (error) { setFailed(adoptionMessage(error)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const agent = data?.agents.find(a => a.agentId === chosen);
  async function add() {
    if (!agent || saving) return;
    setSaving(true); setProblem('');
    try {
      const record = await adoptionApi<{ definitionId: string; name: string }>('/agents', { agentId: agent.agentId, tools });
      toast(`Added ${record.name}. Its conversations and memory are the same as in Letta Code.`);
      onAdded(record.definitionId);
    } catch (error) { setProblem(adoptionMessage(error)); if (error instanceof AdoptionError && error.code === 'letta_code_active') void load(); }
    finally { setSaving(false); }
  }
  return <Modal label="Add agent" onClose={onClose} className="automations adopt">
    <div className="members-head">
      <div><h2 className="modal-title">Add agent</h2>
        <p className="modal-text">Open one of your local Letta agents here. It stays the same agent: its memory and conversations are shared with Letta Code, nothing is copied. Use it in one place at a time.</p></div>
      <button type="button" className="icon-btn small" aria-label="Close" onClick={onClose}><X size={16}/></button>
    </div>
    <ul className="member-list adopt-list" aria-label="Local Letta agents" aria-busy={!data || undefined}>
      {failed && <li className="member-empty">{failed} <button type="button" className="link-btn" onClick={() => void load()}>Try again</button></li>}
      {!data && !failed && <li className="member-empty muted"><LoaderCircle size={14} className="spin" aria-hidden="true"/> Loading…</li>}
      {data && !data.agents.length && <li className="member-empty muted">No local Letta agents found.</li>}
      {data?.agents.map(row => {
        const disabled = !!row.adoptedAs || !!row.inApp || !!row.refusal;
        return <li key={row.agentId}>
          <label className={`member-row adopt-row${chosen === row.agentId ? ' selected' : ''}${disabled ? ' disabled' : ''}`}>
            <input type="radio" name="adopt-agent" value={row.agentId} disabled={disabled} checked={chosen === row.agentId} onChange={() => { setChosen(row.agentId); setProblem(''); }} data-autofocus={!disabled && row === data.agents.find(a => !a.adoptedAs && !a.inApp && !a.refusal) ? true : undefined}/>
            <span className="adopt-text">
              <span className="adopt-name">{row.name}{(row.adoptedAs || row.inApp) && <span className="role-badge small">In the app</span>}{row.busy && <span className="role-badge small warn" title="A Letta Code session of this agent is running">In use in Letta Code</span>}</span>
              <span className="adopt-meta">{[row.model || 'model unknown', when(row.lastActivity), `${row.conversations} conversation${row.conversations === 1 ? '' : 's'}`].join(' · ')}</span>
              {row.refusal && !row.adoptedAs && !row.inApp && <span className="adopt-meta">{row.refusal === 'agent_without_memfs' ? 'No MemFS memory: cannot be added.' : 'Cannot be added.'}</span>}
            </span>
          </label>
        </li>;
      })}
    </ul>
    {agent && data && <fieldset className="adopt-tools">
      <legend className="automations-heading">Tools it gets here</legend>
      {data.tools.available.map(set => <label key={set} className="adopt-tool"><input type="checkbox" checked={tools.includes(set)} onChange={event => setTools(list => toggleToolSet(list, set, event.target.checked))}/>{TOOL_LABELS[set] ?? set}</label>)}
      <p className="adopt-meta">Its system prompt, model and tags stay unchanged. Every tool call follows the app’s permissions.</p>
    </fieldset>}
    {problem && <p className="form-error" role="alert">{problem} {/Letta Code/.test(problem) && <button type="button" className="link-btn" onClick={() => void add()}>Retry</button>}</p>}
    <div className="modal-actions">
      <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" disabled={!agent || saving} onClick={() => void add()}>{saving ? 'Adding…' : 'Add'}</button>
    </div>
  </Modal>;
}

/**
 * The tool sets of an adopted agent (`PUT /api/adoption/agents/<id>/tools`).
 * Saving restarts its runtime; open conversations get the new tools on their
 * next message.
 */
export function ToolsDialog({ agent, onClose, onSaved }: { agent: AgentInfo; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const current = agent.adopted?.tools ?? [];
  const available = agent.adopted?.available ?? current;
  const [tools, setTools] = useState<string[]>(current);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const changed = tools.length !== current.length || tools.some(t => !current.includes(t));
  async function save() {
    setSaving(true); setProblem('');
    try {
      await adoptionApi(`/agents/${encodeURIComponent(agent.id)}/tools`, { tools }, 'PUT');
      toast(`${agent.name}’s tools changed. Open conversations get them on their next message.`);
      onSaved();
    } catch (error) { setProblem(adoptionMessage(error)); } finally { setSaving(false); }
  }
  return <Modal label={`Tools of ${agent.name}`} onClose={onClose} className="automations adopt">
    <div className="members-head">
      <div><h2 className="modal-title">Tools</h2>
        <p className="modal-text">What {agent.name} can do in this app. Every tool call follows the app’s permissions. After a change, update its instructions so it knows its tools.</p></div>
      <button type="button" className="icon-btn small" aria-label="Close" onClick={onClose}><X size={16}/></button>
    </div>
    <form onSubmit={event => { event.preventDefault(); if (changed) void save(); }}>
      <fieldset className="adopt-tools">
        <legend className="automations-heading">Tools it gets here</legend>
        {available.map(set => <label key={set} className="adopt-tool"><input type="checkbox" checked={tools.includes(set)} disabled={saving} onChange={event => { setTools(list => toggleToolSet(list, set, event.target.checked)); setProblem(''); }}/>{TOOL_LABELS[set] ?? set}</label>)}
        <p className="adopt-meta">Saving restarts {agent.name}’s sandbox and services.</p>
      </fieldset>
      {problem && <p className="form-error" role="alert">{problem}</p>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn primary" disabled={saving || !changed}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  </Modal>;
}

/** Remove an adopted agent from the app: the Letta agent, its memory and conversations stay. */
export function RemoveAgentDialog({ agent, onClose, onRemoved }: { agent: AgentInfo; onClose(): void; onRemoved(): void }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  async function remove() {
    setSaving(true); setProblem('');
    try { await adoptionApi(`/agents/${encodeURIComponent(agent.id)}`, undefined, 'DELETE'); toast(`Removed ${agent.name} from the app. The agent itself is unchanged.`); onRemoved(); }
    catch (error) { setProblem(adoptionMessage(error)); } finally { setSaving(false); }
  }
  return <Modal label={`Remove ${agent.name}`} onClose={onClose} className="confirm">
    <h2 className="modal-title">Remove {agent.name} from the app?</h2>
    <p className="modal-text">It disappears from this app only. The Letta agent, its memory and its conversations stay, and Letta Code keeps working with it. You can add it again later.</p>
    {problem && <p className="form-error" role="alert">{problem}</p>}
    <div className="modal-actions">
      <button type="button" className="btn ghost" data-autofocus onClick={onClose}>Cancel</button>
      <button type="button" className="btn danger" disabled={saving} onClick={() => void remove()}>{saving ? 'Removing…' : 'Remove'}</button>
    </div>
  </Modal>;
}

/**
 * Update instructions: the section the app would append to the agent's
 * system prompt (the tools it has here, and the memory policy), as a diff.
 * Applied only when the person approves; can be reverted.
 */
export function InstructionsDialog({ agent, onClose }: { agent: AgentInfo; onClose(): void }) {
  const toast = useToast();
  const [data, setData] = useState<{ diff: string; changed: boolean; applied: boolean; revertible: boolean }>();
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  const path = `/agents/${encodeURIComponent(agent.id)}/instructions`;
  const load = useCallback(async () => { try { setData(await adoptionApi(path)); } catch (error) { setProblem(adoptionMessage(error)); } }, [path]);
  useEffect(() => { void load(); }, [load]);
  async function run(method: 'POST' | 'DELETE') {
    setSaving(true); setProblem('');
    try { await adoptionApi(path, method === 'POST' ? {} : undefined, method); toast(method === 'POST' ? `Updated ${agent.name}’s instructions.` : `Restored ${agent.name}’s earlier instructions.`); await load(); }
    catch (error) { setProblem(adoptionMessage(error)); } finally { setSaving(false); }
  }
  return <Modal label={`Instructions of ${agent.name}`} onClose={onClose} className="automations instructions">
    <div className="members-head">
      <div><h2 className="modal-title">Update instructions</h2>
        <p className="modal-text">Appends a short section to {agent.name}’s system prompt: the tools it has in this app, and how its memory is protected here. Nothing else changes, and you can undo it.</p></div>
      <button type="button" className="icon-btn small" aria-label="Close" onClick={onClose}><X size={16}/></button>
    </div>
    {!data && !problem && <p className="muted"><LoaderCircle size={14} className="spin" aria-hidden="true"/> Loading…</p>}
    {data && (data.changed ? <pre className="instructions-diff" aria-label="Proposed change">{data.diff.split('\n').map((line, i) => <span key={i} className={line.startsWith('+ ') ? 'add' : line.startsWith('- ') ? 'del' : line.startsWith('@@') ? 'hunk' : undefined}>{line}{'\n'}</span>)}</pre>
      : <p className="modal-text">The instructions are up to date.</p>)}
    {problem && <p className="form-error" role="alert">{problem}</p>}
    <div className="modal-actions">
      {data?.revertible && <button type="button" className="btn ghost" disabled={saving} onClick={() => void run('DELETE')}><RotateCcw size={15} aria-hidden="true"/>Revert</button>}
      <button type="button" className="btn ghost" onClick={onClose}>Close</button>
      {data?.changed && <button type="button" className="btn primary" disabled={saving} data-autofocus onClick={() => void run('POST')}>{saving ? 'Applying…' : 'Apply'}</button>}
    </div>
  </Modal>;
}

/**
 * Project folder: a folder on this computer the adopted agent works on,
 * mounted read-write at `/project` in its sandbox. Shows the current one;
 * set, change or clear it. The server refuses unsafe folders (home, `/`,
 * `~/.letta`, credentials in `.git/config`) and says why.
 */
export function ProjectDialog({ agent, onClose, onSaved }: { agent: AgentInfo; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const current = agent.adopted?.project ?? '';
  const [path, setPath] = useState(current);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const sandbox = !!agent.adopted?.sandbox;
  async function save(next: string | null) {
    setSaving(true); setProblem('');
    try {
      await adoptionApi(`/agents/${encodeURIComponent(agent.id)}/project`, { path: next }, 'PUT');
      toast(next ? `${agent.name} now works on ${next} (at /project in its sandbox).` : `${agent.name} no longer has a project folder.`);
      onSaved();
    } catch (error) { setProblem(adoptionMessage(error)); } finally { setSaving(false); }
  }
  const trimmed = path.trim();
  return <Modal label={`Project folder of ${agent.name}`} onClose={onClose} className="automations project">
    <div className="members-head">
      <div><h2 className="modal-title">Project folder</h2>
        <p className="modal-text">A folder on this computer that {agent.name} works on, such as a website or a repository. Its sandbox sees it at <code>/project</code> and can change files there; conversation files stay in <code>/workspace</code>.</p></div>
      <button type="button" className="icon-btn small" aria-label="Close" onClick={onClose}><X size={16}/></button>
    </div>
    <form onSubmit={event => { event.preventDefault(); if (trimmed && trimmed !== current) void save(trimmed); }}>
      <label className="automations-heading" htmlFor="project-path">Folder</label>
      <input id="project-path" className="member-input mono" data-autofocus value={path} maxLength={1000} placeholder="/Users/you/blog" spellCheck={false} autoComplete="off" disabled={!sandbox || saving}
        onChange={event => { setPath(event.target.value); setProblem(''); }} aria-invalid={!!problem || undefined} aria-describedby="project-help"/>
      <p id="project-help" className="adopt-meta">{!sandbox ? 'This server has no sandbox, so it cannot mount a project folder.' : current ? `Current: ${current}.` : 'None yet. Paste the folder’s full path.'} Folders with credentials in <code>.git/config</code>, your home folder and <code>~/.letta</code> are refused. Changing it restarts {agent.name}’s sandbox.</p>
      {problem && <p className="form-error" role="alert">{problem}</p>}
      <div className="modal-actions">
        {current && <button type="button" className="btn ghost" disabled={saving} onClick={() => void save(null)}>Clear</button>}
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!sandbox || saving || !trimmed || trimmed === current}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
    {sandbox && <CommandTimeout agent={agent} onSaved={onSaved}/>}
  </Modal>;
}

/** The adopted agent's sandbox per-command timeout (a full site build can take minutes). */
function CommandTimeout({ agent, onSaved }: { agent: AgentInfo; onSaved(): void }) {
  const toast = useToast();
  const current = Math.round((agent.adopted?.commandTimeoutMs ?? 120_000) / 1000);
  const [seconds, setSeconds] = useState(String(current));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const value = Number(seconds);
  const valid = Number.isInteger(value) && value >= 1 && value <= 240;
  async function save() {
    setSaving(true); setProblem('');
    try {
      await adoptionApi(`/agents/${encodeURIComponent(agent.id)}/sandbox`, { commandTimeoutMs: value * 1000 }, 'PUT');
      toast(`${agent.name}’s commands may now run for up to ${value} s each.`);
      onSaved();
    } catch (error) { setProblem(adoptionMessage(error)); } finally { setSaving(false); }
  }
  return <form className="command-timeout" onSubmit={event => { event.preventDefault(); if (valid && value !== current) void save(); }}>
    <label className="automations-heading" htmlFor="command-timeout">Command time limit</label>
    <div className="command-timeout-row">
      <input id="command-timeout" className="member-input" type="number" min={1} max={240} step={1} value={seconds} disabled={saving} onChange={event => { setSeconds(event.target.value); setProblem(''); }} aria-describedby="command-timeout-help" aria-invalid={!valid || undefined}/>
      <span>seconds per command</span>
      <button type="submit" className="btn primary small" disabled={saving || !valid || value === current}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
    <p id="command-timeout-help" className="adopt-meta">A command still running then is stopped, and the agent gets its output so far. Raise it for long builds (up to 240 s: Letta ends any tool call after 5 minutes). Changing it restarts {agent.name}’s sandbox.</p>
    {problem && <p className="form-error" role="alert">{problem}</p>}
  </form>;
}
