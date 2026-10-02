import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check, ChevronDown, Clock, Ellipsis, LoaderCircle, ShieldCheck, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { errorCode, serverApi, type AgentInfo, type Member, type Person } from './api.js';
import { Modal } from './modal.js';
import { useToast } from './toasts.js';

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

/** Initials of a name (first letters of the first two words), for avatars without a picture. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._@-]+/u).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[1]![0]! : '')).toUpperCase();
}
/** A stable hue per person, so initials avatars are told apart. */
export function hue(seed: string): number { let h = 0; for (const c of seed) h = (h * 31 + c.codePointAt(0)!) % 360; return h; }

/** Picture from the identity provider, or initials on a colour of their own. Pictures load without a referrer. */
export function Avatar({ person, size = 24 }: { person: Pick<Person, 'name' | 'login' | 'avatar'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42), '--avatar-hue': hue(person.login) } as React.CSSProperties;
  if (person.avatar && !failed) return <img className="avatar" style={style} src={person.avatar} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)}/>;
  return <span className="avatar initials" style={style} aria-hidden="true">{initials(person.name || person.login)}</span>;
}

/** The person signed in (via Tailscale), at the foot of the sidebar. */
export function CurrentUser({ user, role }: { user: Person; role?: string }) {
  return <div className="current-user" title={`Signed in through Tailscale as ${user.login}`}>
    <Avatar person={user} size={28}/>
    <span className="current-user-text"><span className="current-user-name">{user.name}</span><span className="current-user-login">{user.login}</span></span>
    {role === 'admin' && <span className="role-badge" title="You can add and remove members of this agent">Admin</span>}
  </div>;
}

/* ------------------------------------------------------------------ */
/* Agent switcher                                                      */
/* ------------------------------------------------------------------ */

/** The agent name at the top of the sidebar; opens a menu of the agents you belong to and the members dialog. */
export function AgentSwitcher({ agents, current, onSwitch, onMembers }: { agents: readonly AgentInfo[]; current: AgentInfo; onSwitch(id: string): void; onMembers(): void }) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="agent-switch" aria-label={`Agent: ${current.name}. Switch agent or see members`}>
        <span className="brand-mark" aria-hidden="true">✳︎</span><span className="agent-switch-name">{current.name}</span><ChevronDown size={15} className="agent-switch-chev" aria-hidden="true"/>
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu agent-menu" align="start" side="bottom" sideOffset={4} collisionPadding={8}>
        <DropdownMenu.Label className="menu-label">Your agents</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={current.id} onValueChange={id => { if (id !== current.id) onSwitch(id); }}>
          {agents.map(agent => <DropdownMenu.RadioItem key={agent.id} value={agent.id} className="menu-item">
            <span className="menu-check" aria-hidden="true"><DropdownMenu.ItemIndicator><Check size={15}/></DropdownMenu.ItemIndicator></span>
            <span className="agent-menu-name">{agent.name}</span>{agent.role === 'admin' && <span className="role-badge small">Admin</span>}
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator className="menu-sep"/>
        <DropdownMenu.Item className="menu-item" onSelect={onMembers}><Users size={15} aria-hidden="true"/>{current.role === 'admin' ? 'Manage members…' : 'Members…'}</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

const memberError = (error: unknown) => ({
  admin_required: 'Only admins of this agent can do that.', owner_is_admin: 'Server owners always stay admins.', last_admin: 'An agent needs at least one admin. Make someone else admin first.',
  invalid_login: 'Enter a Tailscale login, like name@example.com or name@github.', capacity_reached: 'This agent has reached its member limit.',
} as Record<string, string>)[errorCode(error)] ?? 'Couldn’t save that change. Nothing was changed.';

/**
 * Members of the agent: everyone sees who has access; admins add people by
 * their Tailscale login, make them admins, or remove them.
 */
export function MembersDialog({ agent, onClose }: { agent: AgentInfo; onClose(): void }) {
  const toast = useToast();
  const [members, setMembers] = useState<Member[]>();
  const [failed, setFailed] = useState(false);
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const admin = agent.role === 'admin';
  const path = `/agents/${encodeURIComponent(agent.id)}/members`;
  const load = useCallback(async () => {
    try { setMembers((await serverApi<{ members: Member[] }>(path)).members); setFailed(false); } catch { setFailed(true); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  async function add(event: React.FormEvent) {
    event.preventDefault();
    const value = login.trim();
    if (!value || saving) return;
    if (!/^[^\s@]+@[^\s@]+$/.test(value)) { setProblem(memberError({ code: 'invalid_login' })); return; }
    setSaving(true); setProblem('');
    try {
      const added = await serverApi<Member>(path, { login: value, role });
      setLogin(''); setRole('member'); await load();
      toast(`${added.pending ? `Added ${added.login}. They’ll see ${agent.name} the next time they open this app.` : `Added ${added.name}.`}`);
      field.current?.focus();
    } catch (error) { setProblem(memberError(error)); }
    finally { setSaving(false); }
  }
  async function change(member: Member, next: 'member' | 'admin' | 'remove') {
    try {
      if (next === 'remove') { await serverApi(`${path}/${encodeURIComponent(member.id)}`, {}, 'DELETE'); toast(`Removed ${member.name} from ${agent.name}.`); }
      else { await serverApi(`${path}/${encodeURIComponent(member.id)}`, { role: next }, 'PATCH'); toast(next === 'admin' ? `${member.name} is now an admin.` : `${member.name} is now a member.`); }
      await load();
    } catch (error) { toast(memberError(error), { tone: 'error' }); }
  }
  const admins = members?.filter(m => m.role === 'admin').length ?? 0;
  return <Modal label={`Members of ${agent.name}`} onClose={onClose} className="members">
    <div className="members-head">
      <div><h2 className="modal-title">Members of {agent.name}</h2>
        <p className="modal-text">Members share every conversation, file and memory of this agent. {admin ? 'Add people by their Tailscale login; they must be in your tailnet.' : 'Only admins can add or remove members.'}</p></div>
      <button type="button" className="icon-btn small" aria-label="Close" data-autofocus={!admin || undefined} onClick={onClose}><X size={16}/></button>
    </div>
    {admin && <form className="member-add" onSubmit={event => void add(event)}>
      <label className="sr-only" htmlFor="member-login">Tailscale login</label>
      <input id="member-login" ref={field} data-autofocus className="member-input" type="text" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="name@example.com"
        value={login} aria-invalid={!!problem || undefined} aria-describedby={problem ? 'member-problem' : undefined} onChange={event => { setLogin(event.target.value); setProblem(''); }}/>
      <select className="member-role" aria-label="Role" value={role} onChange={event => setRole(event.target.value as 'member' | 'admin')}>
        <option value="member">Member</option><option value="admin">Admin</option>
      </select>
      <button type="submit" className="btn primary" disabled={!login.trim() || saving}>{saving ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <UserPlus size={15} aria-hidden="true"/>}Add</button>
      {problem && <p id="member-problem" className="member-problem" role="alert">{problem}</p>}
    </form>}
    <ul className="member-list" aria-label="Members" aria-busy={!members || undefined}>
      {failed && <li className="member-empty">Couldn’t load the members. <button type="button" className="link-btn" onClick={() => void load()}>Try again</button></li>}
      {!members && !failed && <li className="member-empty muted">Loading…</li>}
      {members?.map(member => <li key={member.id} className="member-row">
        <Avatar person={member} size={32}/>
        <span className="member-text">
          <span className="member-name">{member.name}{member.you && <span className="member-you"> (you)</span>}</span>
          <span className="member-login">{member.login}{member.pending && <span className="member-pending" title="Added, but hasn’t opened the app yet"> · invited</span>}</span>
        </span>
        {member.role === 'admin' && <span className="role-badge"><ShieldCheck size={12} aria-hidden="true"/>Admin</span>}
        {admin && <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><button type="button" className="icon-btn small" aria-label={`Options for ${member.name}`}><Ellipsis size={16}/></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end" side="bottom" collisionPadding={8}>
              {member.role === 'admin'
                ? <DropdownMenu.Item className="menu-item" disabled={admins <= 1} onSelect={() => void change(member, 'member')}><Users size={15} aria-hidden="true"/>Make member</DropdownMenu.Item>
                : <DropdownMenu.Item className="menu-item" onSelect={() => void change(member, 'admin')}><ShieldCheck size={15} aria-hidden="true"/>Make admin</DropdownMenu.Item>}
              <DropdownMenu.Separator className="menu-sep"/>
              <DropdownMenu.Item className="menu-item danger" disabled={member.role === 'admin' && admins <= 1} onSelect={() => void change(member, 'remove')}><UserMinus size={15} aria-hidden="true"/>{member.you ? 'Leave this agent' : 'Remove from agent'}</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>}
      </li>)}
    </ul>
  </Modal>;
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

export type QueuedTurn = { id: string; input: string; author?: Person & { id: string }; images?: number; files?: number; queuedAt?: string; sending?: boolean };

/** Turns waiting behind the running one, oldest first. Their authors (and admins) can withdraw them before they are sent. */
export function QueueList({ queue, me, canWithdraw, onWithdraw, together = false }: { queue: readonly QueuedTurn[]; me?: string; canWithdraw(turn: QueuedTurn): boolean; onWithdraw(turn: QueuedTurn): void; together?: boolean }) {
  if (!queue.length) return null;
  return <section className="queue" aria-label={`${queue.length} message${queue.length === 1 ? '' : 's'} waiting`}>
    <header className="queue-head"><Clock size={14} aria-hidden="true"/><span>{queue.length === 1 ? '1 message waiting' : `${queue.length} messages waiting`} · {together ? 'sent together when the reply finishes' : 'sent in order when the reply finishes'}</span></header>
    <ol className="queue-list">
      {queue.map(turn => <li key={turn.id} className="queue-item" data-sending={turn.sending || undefined}>
        {turn.author ? <Avatar person={turn.author} size={20}/> : <span className="avatar initials" aria-hidden="true">?</span>}
        <span className="queue-author">{turn.author && turn.author.id === me ? 'You' : turn.author?.name ?? 'Someone'}</span>
        <span className="queue-text">{turn.input.trim() || (turn.images ? 'Image' : turn.files ? 'File' : '')}{(turn.images || turn.files) && turn.input.trim() ? ` · ${[turn.images && `${turn.images} image${turn.images === 1 ? '' : 's'}`, turn.files && `${turn.files} file${turn.files === 1 ? '' : 's'}`].filter(Boolean).join(', ')}` : ''}</span>
        {turn.sending ? <span className="queue-sending">Sending…</span> : canWithdraw(turn) && <button type="button" className="icon-btn small" aria-label={`Withdraw: ${turn.input.slice(0, 60)}`} title="Withdraw (not sent yet)" onClick={() => onWithdraw(turn)}><X size={14}/></button>}
      </li>)}
    </ol>
  </section>;
}

/* ------------------------------------------------------------------ */
/* Typing                                                              */
/* ------------------------------------------------------------------ */

/** "Mia is typing…", "Mia and Otto are typing…", "Mia, Otto and 2 others are typing…". */
export function typingText(names: readonly string[]): string {
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others are typing…`;
}

/** Other members typing in this conversation, above the composer. Your own typing is never shown. */
export function TypingLine({ people, me }: { people: readonly { id: string; name: string }[]; me?: string }) {
  const names = people.filter(person => person.id !== me).map(person => person.name);
  return <div className="typing" role="status" aria-live="polite">{names.length > 0 && <span className="typing-chip"><span className="typing-dots" aria-hidden="true"><span/><span/><span/></span><span>{typingText(names)}</span></span>}</div>;
}

/* ------------------------------------------------------------------ */
/* No access                                                           */
/* ------------------------------------------------------------------ */

/** Someone in the tailnet who belongs to no agent on this server. */
export function NoAccess({ user }: { user: Person }) {
  return <main className="no-access">
    <div className="no-access-card">
      <Avatar person={user} size={48}/>
      <h1>You don’t have access yet</h1>
      <p>You’re signed in through Tailscale as <strong>{user.name}</strong> ({user.login}), but you aren’t a member of any agent on this server.</p>
      <p className="muted">Ask an admin to add <span className="mono-inline">{user.login}</span>, then reload this page.</p>
      <button type="button" className="btn primary" onClick={() => location.reload()}>Reload</button>
    </div>
  </main>;
}
