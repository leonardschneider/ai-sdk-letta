import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ThreadListPrimitive, ThreadListItemPrimitive, ThreadListItemMorePrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { Archive, ArchiveRestore, Check, ChevronRight, Ellipsis, PanelLeftClose, Pencil, Search, SquarePen, X } from 'lucide-react';
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
  onClose?(): void; onCollapse?(): void; agent: { id: string; name: string };
  /** Installed package versions from the server (About section). */
  versions?: Versions;
  /** The agent's LaTeX setting, and changing a conversation's override (⋯ menu). */
  agentLatex: boolean; onLatex(id: string, value: LatexOverride): void;
};

export function Sidebar(props: SidebarProps) {
  const { times, query, onQuery, searchRef, busy, isDraft } = props;
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
  return <Rows.Provider value={rows}>
    <div className="sidebar-head">
      <div className="brand"><span className="brand-mark" aria-hidden="true">✳︎</span><span>{props.agent.name}</span></div>
      {props.onCollapse && <button type="button" className="icon-btn small collapse-btn" aria-label="Hide sidebar" aria-controls="sidebar" aria-expanded="true" title="Hide sidebar (⌘B)" onClick={props.onCollapse}><PanelLeftClose size={17}/></button>}
      {props.onClose && <button type="button" className="icon-btn drawer-close" aria-label="Close sidebar" onClick={props.onClose}><X size={18}/></button>}
    </div>
    <ThreadListPrimitive.Root className="thread-list" aria-label="Conversations">
      <ThreadListPrimitive.New className="new-chat" disabled={busy} data-current={isDraft || undefined} title="New chat (⌘K)">
        <SquarePen size={16} aria-hidden="true"/><span>New chat</span><kbd aria-hidden="true">⌘K</kbd>
      </ThreadListPrimitive.New>
      <label className="search">
        <Search size={15} aria-hidden="true"/>
        <input ref={searchRef} type="search" placeholder="Search chats" aria-label="Search conversations by title" value={query} onChange={e => onQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); onQuery(''); } }}/>
        {!query && <kbd aria-hidden="true">⌘/</kbd>}
      </label>
      <nav className="thread-scroll" aria-label="Conversation history">
        {groups.map(group => <section key={group.key} className="thread-group" aria-labelledby={`group-${group.key}`}>
          <h2 id={`group-${group.key}`} className="group-label">{group.label}</h2>
          {group.items.map(({ thread, index }) => <ThreadListPrimitive.ItemByIndex key={thread.id} index={index} components={{ ThreadListItem }}/>)}
        </section>)}
        {!groups.length && <p className="list-empty">{searching ? `No chats match “${query.trim()}”.` : 'No conversations yet. Start a new chat to begin.'}</p>}
        {!!archived.length && <section className="thread-group archived-group">
          <button type="button" className="archived-toggle" aria-expanded={archivedOpen} aria-controls="archived-list" onClick={() => setShowArchived(open => !open)}>
            <ChevronRight size={14} className="chev" aria-hidden="true"/><span>Archived</span><span className="count">{searching ? archivedMatches.length : archived.length}</span>
          </button>
          <div id="archived-list" hidden={!archivedOpen}>
            {archivedMatches.map(({ thread, index }) => <ThreadListPrimitive.ItemByIndex key={thread.id} index={index} archived components={{ ThreadListItem }}/>)}
            {archivedOpen && !archivedMatches.length && <p className="list-empty">No archived chats match.</p>}
          </div>
        </section>}
      </nav>
    </ThreadListPrimitive.Root>
    <details className="about"><summary>About this space</summary><p>Built with assistant-ui and ai-sdk-letta. Letta runs the agent; its tools run in the local server process.</p><p className="mono">{props.agent.id}</p><VersionInfo versions={props.versions}/></details>
  </Rows.Provider>;
}

function ThreadListItem() {
  const aui = useAui();
  const id = useAuiState(s => s.threadListItem.id);
  const title = useAuiState(s => s.threadListItem.title) ?? 'Untitled';
  const status = useAuiState(s => s.threadListItem.status);
  const custom = useAuiState(s => s.threadListItem.custom) as { state?: string } | undefined;
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
