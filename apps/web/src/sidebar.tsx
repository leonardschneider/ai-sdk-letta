import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ThreadListPrimitive, ThreadListItemPrimitive, ThreadListItemMorePrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { DropdownMenu } from 'radix-ui';
import { Archive, ArchiveRestore, Check, ChevronDown, ChevronRight, Ellipsis, Eye, PanelLeftClose, Pencil, Plus, Search, Signpost, SquarePen, X } from 'lucide-react';
import type { ActivityCounts } from './activity-model.js';
import { AgentActionsMenu, agentModel, type AgentActions } from './agents-nav.js';
import type { AgentInfo } from './api.js';
import { groupByTimeThenAgent, NAV_KEY, readSections, type NavSections } from './nav-model.js';
import { titleText } from 'ai-sdk-letta/title';
import { latexChoices } from './latex-menu.js';
import type { LatexOverride } from './latex.js';
import { groupByDate, matchesSearch, TITLE_LIMIT, validTitle, type ThreadSummary } from './thread-model.js';
import { TitleView } from './title.js';
import { VersionInfo } from './version-info.js';
import type { Versions } from './versions.js';

/** Row-level UI state shared by every ThreadListItem (the primitives render items by index). */
type RowContext = { editingId?: string; setEditingId(id?: string): void; busy: boolean; runningId?: string; archivingIds: ReadonlySet<string>; latex: ReadonlyMap<string, LatexOverride>; agentLatex: boolean; onLatex(id: string, value: LatexOverride): void };
const Rows = createContext<RowContext>({ setEditingId: () => {}, busy: false, archivingIds: new Set(), latex: new Map(), agentLatex: true, onLatex: () => {} });

export type SidebarProps = {
  active: ThreadSummary[]; archived: ThreadSummary[]; times: Map<string, number | undefined>;
  query: string; onQuery(value: string): void; searchRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean; runningId?: string; archivingIds: ReadonlySet<string>; isDraft: boolean;
  /** View-only agents: no New chat. */
  newHidden?: boolean;
  onClose?(): void; onCollapse?(): void; agent: { id: string; name: string };
  /** Installed package versions from the server (About section). */
  versions?: Versions;
  /** The agent's LaTeX setting, and changing a conversation's override (⋯ menu). */
  agentLatex: boolean; onLatex(id: string, value: LatexOverride): void;
  /** Team servers: the agent switcher in place of the name, and the signed-in person at the foot. */
  brand?: React.ReactNode; footer?: React.ReactNode;
  /** Next to the agent's name: the notification bell. */
  actions?: React.ReactNode;
  /** Several agents (adopted agents, team servers): the accordion with every agent's conversations and the Agents section. */
  nav?: Nav;
};

/** The accordion's data: every agent, their conversations (the current agent's come from the runtime), activity and actions. */
export type Nav = {
  agents: readonly AgentInfo[];
  /** Conversations of the other agents, by agent ID (fetched from each agent's API). */
  lists: ReadonlyMap<string, readonly ThreadSummary[]>;
  activity: readonly ActivityCounts[];
  /** Open a conversation (or a new chat, no thread) of an agent: in place, or by switching agents. */
  onOpen(agentId: string, threadId?: string): void;
  /** The ⋯ menu of an agent; undefined: no menu. */
  actionsFor(agent: AgentInfo): AgentActions | undefined;
  /** Open an agent's settings page (clicking it in the Agents section). */
  onSettings?(agentId: string): void;
  /** The agent whose settings page is open. */
  settingsOf?: string;
  onAdd?(): void;
};

const readNav = (): NavSections => { try { return readSections(localStorage.getItem(NAV_KEY)); } catch { return readSections(null); } };

export function Sidebar(props: SidebarProps) {
  const { times, query, onQuery, searchRef, busy, isDraft, newHidden } = props;
  // Indices must come from the runtime's own lists: the adapter is applied after
  // this render, so indexing our React state directly can briefly point past the end.
  const runtimeIds = useAuiState(s => s.threads.threadIds);
  const runtimeArchivedIds = useAuiState(s => s.threads.archivedThreadIds);
  const byId = useMemo(() => new Map([...props.active, ...props.archived].map(t => [t.id, t])), [props.active, props.archived]);
  const active = useMemo(() => runtimeIds.map(id => byId.get(id)).filter((t): t is ThreadSummary => !!t && !t.archived), [runtimeIds, byId]);
  const archived = useMemo(() => runtimeArchivedIds.map(id => byId.get(id)).filter((t): t is ThreadSummary => !!t), [runtimeArchivedIds, byId]);
  const activeIndex = useMemo(() => new Map(runtimeIds.map((id, i) => [id, i])), [runtimeIds]);
  const archivedIndex = useMemo(() => new Map(runtimeArchivedIds.map((id, i) => [id, i])), [runtimeArchivedIds]);
  const [editingId, setEditingId] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const now = new Date();
  const include = (t: ThreadSummary) => matchesSearch(t.title, query);
  const groups = groupByDate(active, times, now, include).map(group => ({ ...group, items: group.items.map(({ thread }) => ({ thread, index: activeIndex.get(thread.id)! })) }));
  const archivedMatches = archived.filter(include).map(thread => ({ thread, index: archivedIndex.get(thread.id)! }));
  const searching = !!query.trim();
  const archivedOpen = showArchived || (searching && archivedMatches.length > 0);
  const latex = useMemo(() => new Map([...props.active, ...props.archived].map(t => [t.id, t.latex ?? 'inherit'] as const)), [props.active, props.archived]);
  const rows = useMemo(() => ({ editingId, setEditingId, busy, runningId: props.runningId, archivingIds: props.archivingIds, latex, agentLatex: props.agentLatex, onLatex: props.onLatex }), [editingId, busy, props.runningId, props.archivingIds, latex, props.agentLatex, props.onLatex]);
  const nav = props.nav;
  const [sections, setSectionsState] = useState<NavSections>(readNav);
  const setSections = (update: (previous: NavSections) => NavSections) => setSectionsState(previous => { const next = update(previous); try { localStorage.setItem(NAV_KEY, JSON.stringify(next)); } catch { /* private mode */ } return next; });
  const head = <div className="sidebar-head">
    {nav ? <div className="brand app-title"><span className="brand-mark" aria-hidden="true">✳︎</span><span className="app-title-text">ai-sdk-letta</span></div>
      : props.brand ?? <div className="brand"><span className="brand-mark" aria-hidden="true">✳︎</span><span>{props.agent.name}</span></div>}
    {props.actions && <div className="sidebar-actions">{props.actions}</div>}
    {props.onCollapse && <button type="button" className="icon-btn small collapse-btn" aria-label="Hide sidebar" aria-controls="sidebar" aria-expanded="true" title="Hide sidebar (⌘B)" onClick={props.onCollapse}><PanelLeftClose size={17}/></button>}
    {props.onClose && <button type="button" className="icon-btn drawer-close" aria-label="Close sidebar" onClick={props.onClose}><X size={18}/></button>}
  </div>;
  const newChat = !newHidden && <ThreadListPrimitive.New className="new-chat" disabled={busy} data-current={isDraft || undefined} title="New chat (⌘K)">
    <SquarePen size={16} aria-hidden="true"/><span>New chat</span><kbd aria-hidden="true">⌘K</kbd>
  </ThreadListPrimitive.New>;
  const search = <label className="search">
    <Search size={15} aria-hidden="true"/>
    <input ref={searchRef} type="search" placeholder={nav && nav.agents.length > 1 ? 'Search all chats' : 'Search chats'} aria-label="Search conversations by title" value={query} onChange={e => onQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); onQuery(''); } }}/>
    {!query && <kbd aria-hidden="true">⌘/</kbd>}
  </label>;
  const archivedSection = (count: number, list: React.ReactNode, empty: boolean) => <section className="thread-group archived-group">
    <button type="button" className="archived-toggle" aria-expanded={archivedOpen} aria-controls="archived-list" onClick={() => setShowArchived(open => !open)}>
      <ChevronRight size={14} className="chev" aria-hidden="true"/><span>Archived</span><span className="count">{count}</span>
    </button>
    <div id="archived-list" hidden={!archivedOpen}>
      {list}
      {archivedOpen && empty && <p className="list-empty">No archived chats match.</p>}
    </div>
  </section>;
  const about = <details className="about"><summary>About this space</summary><p>Built with assistant-ui and ai-sdk-letta. Letta runs the agent; its tools run in the local server process.</p><p className="mono">{props.agent.id}</p><VersionInfo versions={props.versions}/></details>;

  if (!nav) return <Rows.Provider value={rows}>
    {head}
    <ThreadListPrimitive.Root className="thread-list" aria-label="Conversations">
      {newChat}
      {search}
      <nav className="thread-scroll" aria-label="Conversation history">
        {groups.map(group => <section key={group.key} className="thread-group" aria-labelledby={`group-${group.key}`}>
          <h2 id={`group-${group.key}`} className="group-label">{group.label}</h2>
          {group.items.map(({ thread, index }) => <ThreadListPrimitive.ItemByIndex key={thread.id} index={index} components={{ ThreadListItem }}/>)}
        </section>)}
        {!groups.length && <p className="list-empty">{searching ? `No chats match “${query.trim()}”.` : 'No conversations yet. Start a new chat to begin.'}</p>}
        {!!archived.length && archivedSection(searching ? archivedMatches.length : archived.length,
          archivedMatches.map(({ thread, index }) => <ThreadListPrimitive.ItemByIndex key={thread.id} index={index} archived components={{ ThreadListItem }}/>), !archivedMatches.length)}
      </nav>
    </ThreadListPrimitive.Root>
    {props.footer}
    {about}
  </Rows.Provider>;

  // Several agents: conversations grouped by time, then agent; the current agent's rows are the runtime's (rename, archive, menu), the others open by switching.
  const many = nav.agents.length > 1;
  const current = props.agent.id;
  const lists = nav.agents.map(a => ({ agentId: a.id, agentName: a.name, threads: a.id === current ? [...props.active, ...props.archived] : nav.lists.get(a.id) ?? [] }));
  const timeGroups = groupByTimeThenAgent(lists, now, query);
  const activityOf = (id: string) => nav.activity.find(a => a.id === id);
  const otherArchived = nav.agents.filter(a => a.id !== current).flatMap(a => (nav.lists.get(a.id) ?? []).filter(t => t.archived && include(t)).map(thread => ({ agent: a, thread })));
  const archivedCount = (searching ? archivedMatches.length : archived.length) + otherArchived.length;
  const viewOnlyIds = new Set(nav.agents.filter(a => a.viewOnly).map(a => a.id));
  const row = (agentId: string, thread: ThreadSummary, archivedRow = false) => agentId === current
    ? <ThreadListPrimitive.ItemByIndex key={thread.id} index={(archivedRow ? archivedIndex : activeIndex).get(thread.id) ?? -1} {...(archivedRow ? { archived: true } : {})} components={{ ThreadListItem }}/>
    : <OtherThreadRow key={`${agentId}:${thread.id}`} thread={thread} archived={archivedRow} running={!!activityOf(agentId)?.running.includes(thread.id)} disabled={busy} onOpen={() => nav.onOpen(agentId, thread.id)}/>;
  const known = (agentId: string, thread: ThreadSummary, archivedRow = false) => agentId !== current || (archivedRow ? archivedIndex : activeIndex).has(thread.id);
  const startable = nav.agents.filter(a => !a.viewOnly);
  return <Rows.Provider value={rows}>
    {head}
    <ThreadListPrimitive.Root className="thread-list nav-accordion" aria-label="Conversations">
      {(newChat || startable.length > 0) && <div className="new-chat-row">
        {newChat || <button type="button" className="new-chat" disabled={busy} onClick={() => startable[0] && nav.onOpen(startable[0].id)}><SquarePen size={16} aria-hidden="true"/><span>New chat</span></button>}
        {many && startable.length > 0 && <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><button type="button" className="icon-btn small new-chat-pick" aria-label="New chat with another agent" title="New chat with…" disabled={busy}><ChevronDown size={15}/></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu agent-menu" align="end" side="bottom" sideOffset={4} collisionPadding={8}>
              <DropdownMenu.Label className="menu-label">New chat with</DropdownMenu.Label>
              {startable.map(a => <DropdownMenu.Item key={a.id} className="menu-item" onSelect={() => nav.onOpen(a.id)}>
                <span className="menu-check" aria-hidden="true">{a.id === current && <Check size={15}/>}</span><span className="agent-menu-name">{a.name}</span>
              </DropdownMenu.Item>)}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>}
      </div>}
      <section className="nav-section conversations-section" data-open={sections.conversations || undefined}>
        <h2 className="nav-heading"><button type="button" className="nav-toggle" aria-expanded={sections.conversations} aria-controls="nav-conversations" onClick={() => setSections(s => ({ ...s, conversations: !s.conversations }))}>
          <ChevronRight size={14} className="chev" aria-hidden="true"/><span>Conversations</span>
        </button></h2>
        <div id="nav-conversations" className="nav-body" hidden={!sections.conversations}>
          {search}
          <nav className="thread-scroll" aria-label="Conversation history">
            {timeGroups.map(group => <section key={group.key} className="thread-group" aria-labelledby={`group-${group.key}`}>
              <h3 id={`group-${group.key}`} className="group-label">{group.label}</h3>
              {group.agents.map(agentGroup => <div key={agentGroup.agentId} className="agent-group" data-current={agentGroup.agentId === current || undefined}>
                {many && <h4 className="agent-subhead"><span className="agent-subhead-name">{agentGroup.agentName}</span>{viewOnlyIds.has(agentGroup.agentId) && <Eye size={12} aria-label="view only"/>}</h4>}
                {agentGroup.items.filter(item => known(item.agentId, item.thread)).map(item => row(item.agentId, item.thread))}
              </div>)}
            </section>)}
            {!timeGroups.length && <p className="list-empty">{searching ? `No chats match “${query.trim()}”.` : 'No conversations yet. Start a new chat to begin.'}</p>}
            {archivedCount > 0 && archivedSection(archivedCount, <>
              {archivedMatches.map(({ thread }) => row(current, thread, true))}
              {otherArchived.map(({ agent, thread }) => <OtherThreadRow key={`${agent.id}:${thread.id}`} thread={thread} archived agentName={agent.name} running={false} disabled={busy} onOpen={() => nav.onOpen(agent.id, thread.id)}/>)}
            </>, !archivedMatches.length && !otherArchived.length)}
          </nav>
        </div>
      </section>
      <section className="nav-section agents-section" data-open={sections.agents || undefined}>
        <h2 className="nav-heading"><button type="button" className="nav-toggle" aria-expanded={sections.agents} aria-controls="nav-agents" onClick={() => setSections(s => ({ ...s, agents: !s.agents }))}>
          <ChevronRight size={14} className="chev" aria-hidden="true"/><span>Agents</span><span className="count">{nav.agents.length}</span>
        </button></h2>
        <div id="nav-agents" className="nav-body agents-list" hidden={!sections.agents}>
          {nav.agents.map(a => <AgentRow key={a.id} agent={a} current={a.id === current} settings={nav.settingsOf === a.id} state={activityOf(a.id)?.state} actions={nav.actionsFor(a)} disabled={busy} onOpen={() => { if (nav.onSettings) nav.onSettings(a.id); else if (a.id !== current) nav.onOpen(a.id, undefined); }}/>)}
          {nav.onAdd && <button type="button" className="agent-add" onClick={nav.onAdd}><Plus size={15} aria-hidden="true"/>Add agent…</button>}
        </div>
      </section>
    </ThreadListPrimitive.Root>
    {props.footer}
    {about}
  </Rows.Provider>;
}

/** A conversation of another agent: opening it switches agents. */
function OtherThreadRow({ thread, archived, agentName, running, disabled, onOpen }: { thread: ThreadSummary; archived?: boolean; agentName?: string; running: boolean; disabled: boolean; onOpen(): void }) {
  const plain = titleText(thread.title) || 'Untitled';
  const ready = thread.state === 'ready';
  return <div className="thread-row other-thread" data-archived={archived || undefined} data-disabled={disabled || !ready || undefined}>
    <button type="button" className="thread-trigger" disabled={disabled || !ready} title={agentName ? `${plain} · ${agentName}` : plain} aria-label={ready ? plain : `${plain} (unavailable)`} onClick={onOpen}/>
    <span className="thread-label">
      <span className="thread-title"><TitleView title={thread.title} shortUrls linkTabIndex={-1}/></span>
      {agentName && <span className="thread-note">{agentName}</span>}
      {!ready && <span className="thread-note">unavailable</span>}
      {ready && thread.pendingDecision && !running && <span className="thread-waiting" title="Waiting on you"><span className="sr-only">waiting on you</span></span>}
      {ready && running && <span className="thread-activity" title="Replying"><span className="sr-only">replying</span></span>}
    </span>
  </div>;
}

/** An agent in the Agents section: its name, model and state; clicking it opens its settings page, the ⋯ menu holds quick actions. */
function AgentRow({ agent, current, settings, state, actions, disabled, onOpen }: { agent: AgentInfo; current: boolean; settings?: boolean; state?: ActivityCounts['state']; actions?: AgentActions; disabled: boolean; onOpen(): void }) {
  const [open, setOpen] = useState(false);
  const model = agentModel(agent);
  const status = agent.viewOnly ? 'view only' : state === 'waiting' ? 'needs you' : state === 'working' ? 'working' : 'idle';
  return <div className="agent-row" data-current={current || undefined} data-settings={settings || undefined} data-menu-open={open || undefined}>
    <button type="button" className="agent-row-main" aria-current={settings ? 'page' : undefined} disabled={disabled && !current} title={`${agent.name}${model ? ` · ${model}` : ''}: settings`} aria-label={`${agent.name}, ${status}: settings`} onClick={onOpen}>
      {agent.viewOnly ? <Eye size={13} className="agent-row-eye" aria-hidden="true"/> : <span className="activity-dot" data-state={state && state !== 'idle' ? state : undefined} aria-hidden="true"/>}
      <span className="agent-row-text"><span className="agent-row-name">{agent.name}</span>{model && <span className="agent-row-model">{model}</span>}</span>
    </button>
    {actions && <AgentActionsMenu agent={agent} actions={actions} open={open} onOpenChange={setOpen}>
      <button type="button" className="row-menu" aria-label={`Actions for ${agent.name}`}><Ellipsis size={16} aria-hidden="true"/></button>
    </AgentActionsMenu>}
  </div>;
}

function ThreadListItem() {
  const aui = useAui();
  const id = useAuiState(s => s.threadListItem.id);
  const title = useAuiState(s => s.threadListItem.title) ?? 'Untitled';
  const status = useAuiState(s => s.threadListItem.status);
  const custom = useAuiState(s => s.threadListItem.custom) as { state?: string; running?: boolean; queued?: number; decision?: boolean } | undefined;
  const { editingId, setEditingId, busy, runningId, archivingIds, latex, agentLatex, onLatex } = useContext(Rows);
  const latexValue = latex.get(id) ?? 'inherit';
  const [menuOpen, setMenuOpen] = useState(false);
  const renaming = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editing = editingId === id;
  const ready = custom?.state === 'ready';
  const archived = status === 'archived';
  const lockedByRun = runningId === id;
  const plain = titleText(title) || 'Untitled';
  const disabled = busy || !ready;
  // The trigger covers the whole row; the title is drawn above it and lets clicks
  // through to it, except on links, which open in a new tab (a link cannot sit inside a button).
  return <ThreadListItemPrimitive.Root className="thread-row" data-archived={archived || undefined} data-editing={editing || undefined} data-menu-open={menuOpen || undefined} data-disabled={disabled || undefined}
    onContextMenu={event => { if (editing) return; event.preventDefault(); setMenuOpen(true); }}>
    {editing
      ? <RenameField initial={title} onDone={(value) => { setEditingId(undefined); if (value !== undefined && value !== title) aui.threadListItem.rename(value); requestAnimationFrame(() => triggerRef.current?.focus()); }}/>
      : <>
          <ThreadListItemPrimitive.Trigger ref={triggerRef} className="thread-trigger" disabled={disabled} title={plain} aria-label={ready ? plain : `${plain} (unavailable)`}/>
          <span className="thread-label">
            <span className="thread-title"><TitleView title={title} shortUrls linkTabIndex={-1}/></span>
            {!ready && <span className="thread-note">unavailable</span>}
            {ready && custom?.decision && !custom.running && <span className="thread-decision" title="A decision is waiting here"><Signpost size={13} aria-hidden="true"/><span className="sr-only">decision waiting</span></span>}
            {ready && custom?.running && <span className="thread-activity" title={custom.queued ? `Replying · ${custom.queued} waiting` : 'Replying'}><span className="sr-only">{custom.queued ? `replying, ${custom.queued} waiting` : 'replying'}</span>{!!custom.queued && <span aria-hidden="true">{custom.queued}</span>}</span>}
          </span>
        </>}
    {!editing && <ThreadListItemMorePrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <ThreadListItemMorePrimitive.Trigger className="row-menu" aria-label={`Options for ${plain}`} disabled={!ready}>
        <Ellipsis size={16} aria-hidden="true"/>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content className="menu" align="start" side="bottom" onCloseAutoFocus={event => { if (renaming.current) { event.preventDefault(); renaming.current = false; } }}>
        <ThreadListItemMorePrimitive.Item className="menu-item" onSelect={() => { renaming.current = true; setEditingId(id); }}>
          <Pencil size={15} aria-hidden="true"/>Rename
        </ThreadListItemMorePrimitive.Item>
        {archived
          ? <ThreadListItemMorePrimitive.Item className="menu-item" disabled={archivingIds.has(id)} onSelect={() => aui.threadListItem.unarchive()}><ArchiveRestore size={15} aria-hidden="true"/>Restore</ThreadListItemMorePrimitive.Item>
          : <ThreadListItemMorePrimitive.Item className="menu-item" disabled={lockedByRun || archivingIds.has(id)} onSelect={() => aui.threadListItem.archive()}><Archive size={15} aria-hidden="true"/>{lockedByRun ? 'Archive (after reply)' : 'Archive'}</ThreadListItemMorePrimitive.Item>}
        <ThreadListItemMorePrimitive.Separator className="menu-sep"/>
        <div className="menu-label" role="presentation">LaTeX in replies</div>
        {latexChoices(agentLatex).map(choice => <ThreadListItemMorePrimitive.Item key={choice.value} className="menu-item" role="menuitemradio" aria-checked={latexValue === choice.value}
          onSelect={() => { if (latexValue !== choice.value) onLatex(id, choice.value); }}>
          <span className="menu-check" aria-hidden="true">{latexValue === choice.value && <Check size={15}/>}</span>{choice.label}
        </ThreadListItemMorePrimitive.Item>)}
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>}
  </ThreadListItemPrimitive.Root>;
}

/** Inline title editor: Enter saves, Escape cancels, clicking away saves a valid change. */
function RenameField({ initial, onDone }: { initial: string; onDone(value?: string): void }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = value.trim();
    onDone(save && validTitle(value) ? next : undefined);
  };
  const invalid = !validTitle(value);
  return <input ref={input} className="rename-input" aria-label="Conversation title" aria-invalid={invalid || undefined} maxLength={TITLE_LIMIT} value={value}
    onChange={e => setValue(e.target.value)}
    onKeyDown={e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); if (!invalid) finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    }}
    onBlur={() => finish(true)}/>;
}
