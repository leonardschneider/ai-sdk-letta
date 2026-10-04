import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TextMessagePartProvider } from '@assistant-ui/react';
import { ContextMenu, DropdownMenu } from 'radix-ui';
import {
  Archive, ChevronRight, Download, Ellipsis, ExternalLink, File, FileCode, FileImage, FileSpreadsheet, FileText, FileType, Folder, FolderGit2, FolderInput, FolderOpen, FolderPlus, Link2Off, LoaderCircle, MessageSquare, Pencil, RefreshCw, Trash, Upload, X,
} from 'lucide-react';
import { api, apiPath, errorCode, uploadResource } from './api.js';
import { Modal } from './modal.js';
import { Markdown } from './markdown.js';
import { useToast } from './toasts.js';
import {
  ARCHIVED_RESOURCES_KEY, PROJECT_OPEN_KEY, ancestors, appendPage, baseName, canDrop, find, footerText, iconKind, joinPath, parentPath, parseAtlassianDocument, parseDelimited, previewKind, projectError, projectOpen, projectStatusLabel, readShowArchived, resourceError, shortSize, splitArchived, validName, walk,
  type ProjectEntry, type ProjectListing, type ResourceNode, type ResourceTree,
} from './resources-model.js';

/** The Atlassian renderer is large: loaded only when an `.adf.json` preview opens. */
const AdfView = lazy(() => import('./adf-view.js'));

const DRAG_TYPE = 'application/x-ai-sdk-letta-resource';
const POLL_MS = 2500;
const PREVIEW_ROWS = 500;

const fileUrl = (path: string) => apiPath(`/v1/resources/file?path=${encodeURIComponent(path)}`);
const previewUrl = (path: string) => apiPath(`/v1/resources/preview?path=${encodeURIComponent(path)}`);
/** Where a preview reads from: the resources, or the agent's project folder (read-only). */
type Source = { file(path: string): string; preview(path: string): string; project?: string };
const RESOURCES: Source = { file: fileUrl, preview: previewUrl };
const projectSource = (name: string): Source => ({ project: name,
  file: path => apiPath(`/v1/project/file?path=${encodeURIComponent(path)}`), preview: path => apiPath(`/v1/project/preview?path=${encodeURIComponent(path)}`) });
const atlassianMediaUrl = (path: string, id: string) => apiPath(`/v1/resources/atlassian-media?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`);

/** File icon by name; folders open/closed; conversation folders get a chat badge. */
export function ResourceIcon({ node, open }: { node: Pick<ResourceNode, 'name' | 'type' | 'conversationId'>; open?: boolean }) {
  if (node.type === 'folder') {
    const Icon = open ? FolderOpen : Folder;
    return <span className="res-icon" data-kind={node.conversationId ? 'conversation' : 'folder'} aria-hidden="true"><Icon size={16}/>{node.conversationId && <MessageSquare className="res-badge" size={9}/>}</span>;
  }
  const kind = iconKind(node.name);
  const Icon = kind === 'pdf' ? FileType : kind === 'table' ? FileSpreadsheet : kind === 'image' ? FileImage : kind === 'markdown' || kind === 'text' || kind === 'atlassian' ? FileText : kind === 'code' || kind === 'html' ? FileCode : File;
  return <span className="res-icon" data-kind={kind} aria-hidden="true"><Icon size={16}/></span>;
}

type Props = {
  /** The thread shown in the chat (its folder is highlighted and expanded). */
  threadId?: string;
  /** Changes when a turn ends, to refresh at once. */
  refreshKey?: unknown;
  /** Polling only while visible. */
  visible: boolean;
  onClose(): void;
  onOpenThread?(id: string): void;
  /** A conversation was renamed with its folder (the thread as listed). */
  onThreadChanged?(thread: MovedThread): void;
  /** The name of the agent's project folder: shown read-only below the resources. */
  project?: string;
  /** The agent has a project folder but no resources of its own: only the project is shown. */
  projectOnly?: boolean;
};
/** The conversation a folder rename also renamed, as the server lists it. */
type MovedThread = { id: string; title: string };
type MoveResult = { path: string; thread?: MovedThread };

type Pending = { kind: 'rename'; path: string } | { kind: 'new-folder'; parent: string } | undefined;

/**
 * The Resources panel: one folder per conversation plus the user's folders,
 * backed by git on the server. Drag to move, drop files from the computer to
 * upload, ⋯ or right-click for actions, click a file to preview it.
 */
export function ResourcesPanel(props: Props) {
  const toast = useToast();
  const [tree, setTree] = useState<ResourceTree>();
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string>();
  const [pending, setPending] = useState<Pending>();
  const [preview, setPreview] = useState<string>();
  const [confirm, setConfirm] = useState<ResourceNode>();
  const [moving, setMoving] = useState<ResourceNode>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [busy, setBusy] = useState(0);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  // Folders of archived conversations: hidden unless asked for (persisted). Nothing moves on disk.
  const [showArchived, setShowArchivedState] = useState(() => readShowArchived(localStorage.getItem(ARCHIVED_RESOURCES_KEY)));
  const setShowArchived = (value: boolean) => { setShowArchivedState(value); localStorage.setItem(ARCHIVED_RESOURCES_KEY, String(value)); };
  const [projectRefresh, setProjectRefresh] = useState(0);
  const known = useRef<Set<string> | undefined>(undefined);
  const version = useRef('');
  /** After the server restarted (session gone), stop polling until the page is refreshed. */
  const stopped = useRef(false);
  const uploadTarget = useRef('');
  const fileInput = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const split = useMemo(() => splitArchived(tree?.children ?? [], tree?.archived), [tree]);
  /** What the tree shows: the normal folders, then the archived ones when asked for. */
  const shown = useMemo(() => showArchived ? [...split.visible, ...split.archived] : split.visible, [split, showArchived]);
  const currentFolder = useMemo(() => tree ? Object.entries(tree.threads).find(([, id]) => id === props.threadId)?.[0] : undefined, [tree, props.threadId]);

  const load = useCallback(async (quiet = false) => {
    if (props.projectOnly) return undefined;
    try {
      const next = await api<ResourceTree>('/v1/resources');
      setError('');
      if (next.version === version.current) return next;
      version.current = next.version;
      const paths = new Set([...walk(next.children)].map(n => n.path));
      // Highlight what appeared since the last look (the agent's new files), briefly.
      if (known.current) {
        const added = [...paths].filter(p => !known.current!.has(p));
        if (added.length) {
          setFresh(new Set(added));
          setExpanded(open => { const copy = new Set(open); for (const p of added) for (const a of ancestors(p)) copy.add(a); return copy; });
          setTimeout(() => setFresh(new Set()), 2400);
        }
      }
      known.current = paths;
      setTree(next);
      return next;
    } catch (e) {
      const code = errorCode(e);
      if (code === 'session_required' || code === 'csrf_required') { stopped.current = true; setError(resourceError(code)); return undefined; }
      if (!quiet) setError(code === 'resources_empty' ? 'Start a conversation; its files will appear here.' : code === 'files_unavailable' ? 'This agent has no files.' : 'Couldn’t load the files.');
      if (code === 'resources_empty' || code === 'files_unavailable') setTree(undefined);
      return undefined;
    }
  }, [props.projectOnly]);

  // Live refresh: poll while visible and the tab is shown, and at once when a turn ends.
  useEffect(() => {
    if (!props.visible) return;
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !stopped.current) void load(true); }, POLL_MS);
    return () => clearInterval(timer);
  }, [props.visible, load]);
  // At the end of a turn (and after a rename), and once more shortly after: a folder rename that waited for the turn lands right after its commit.
  useEffect(() => {
    if (!props.visible || stopped.current) return;
    void load(true);
    const again = setTimeout(() => { if (!stopped.current) void load(true); }, 1200);
    return () => clearTimeout(again);
  }, [props.refreshKey, props.visible, load]);
  // Polling pauses in a background tab; catch up as soon as it is shown again.
  useEffect(() => {
    if (!props.visible) return;
    const shown = () => { if (document.visibilityState === 'visible' && !stopped.current) void load(true); };
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, [props.visible, load]);

  // The current conversation's folder is expanded and scrolled into view.
  useEffect(() => {
    if (!currentFolder) return;
    setExpanded(open => open.has(currentFolder) && ancestors(currentFolder).every(a => open.has(a)) ? open : new Set([...open, ...ancestors(currentFolder), currentFolder]));
    requestAnimationFrame(() => treeRef.current?.querySelector(`[data-path="${CSS.escape(currentFolder)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [currentFolder]);

  async function run<T>(task: () => Promise<T>, done?: (value: T) => void) {
    setBusy(n => n + 1);
    try { const value = await task(); done?.(value); await load(true); return value; }
    catch (e) { toast(resourceError(errorCode(e)), { tone: 'error' }); await load(true); return undefined; }
    finally { setBusy(n => n - 1); }
  }
  const toggle = (path: string) => setExpanded(open => { const copy = new Set(open); if (copy.has(path)) copy.delete(path); else copy.add(path); return copy; });
  const open = (path: string) => setExpanded(set => new Set([...set, ...ancestors(path), path]));

  async function move(from: string, folder: string) {
    if (!canDrop(from, folder)) return;
    const to = joinPath(folder, baseName(from));
    await run(() => api<MoveResult>('/v1/resources/move', { from, to }), result => {
      if (result.thread) props.onThreadChanged?.(result.thread);
      open(folder); setSelected(result.path);
      toast(`Moved “${baseName(from)}” to ${folder ? `“${baseName(folder)}”` : 'the top level'}`, { action: { label: 'Undo', run: () => void run(() => api<MoveResult>('/v1/resources/move', { from: result.path, to: from }), undone => { if (undone.thread) props.onThreadChanged?.(undone.thread); }) } });
      if (preview === from) setPreview(result.path);
    });
  }
  async function rename(path: string, name: string) {
    setPending(undefined);
    if (!name.trim() || name.trim() === baseName(path)) return;
    const to = joinPath(parentPath(path), name.trim());
    await run(() => api<MoveResult>('/v1/resources/move', { from: path, to }), result => {
      if (result.thread) props.onThreadChanged?.(result.thread);
      setSelected(result.path);
      if (preview === path) setPreview(result.path);
      if (expanded.has(path)) setExpanded(set => new Set([...set].map(p => p === path || p.startsWith(`${path}/`) ? result.path + p.slice(path.length) : p)));
    });
  }
  async function createFolder(parent: string, name: string) {
    setPending(undefined);
    if (!name.trim()) return;
    await run(() => api<{ path: string }>('/v1/resources/folders', { parent, name: name.trim() }), result => { open(parent); setSelected(result.path); });
  }
  async function remove(node: ResourceNode) {
    setConfirm(undefined);
    await run(() => api<{ path: string; commit?: string }>('/v1/resources/delete', { path: node.path }), result => {
      if (preview && (preview === node.path || preview.startsWith(`${node.path}/`))) setPreview(undefined);
      toast(`Deleted “${node.name}”`, result.commit ? { action: { label: 'Undo', run: () => void run(() => api('/v1/resources/restore', { path: node.path, commit: result.commit }), () => toast(`Restored “${node.name}”`)) } } : undefined);
    });
  }
  async function upload(folder: string, files: readonly File[]) {
    if (!files.length) return;
    open(folder);
    let last: string | undefined;
    for (const file of files) {
      const result = await run(() => uploadResource(folder, file));
      if (result) last = result.path;
    }
    if (last) { setSelected(last); toast(files.length === 1 ? `Uploaded “${baseName(last)}”` : `Uploaded ${files.length} files`); }
  }
  const pickFiles = (folder: string) => { uploadTarget.current = folder; fileInput.current?.click(); };

  const actions: Actions = {
    preview: path => setPreview(path),
    rename: path => setPending({ kind: 'rename', path }),
    newFolder: parent => { open(parent); setPending({ kind: 'new-folder', parent }); },
    move: node => setMoving(node),
    remove: node => setConfirm(node),
    upload: pickFiles,
    openThread: path => { const id = tree?.threads[path]; if (id) props.onOpenThread?.(id); },
  };

  // Keyboard: arrows move through visible rows, Enter opens, F2 renames, Delete asks to delete.
  const visibleRows = useMemo(() => {
    const rows: ResourceNode[] = [];
    const add = (nodes: readonly ResourceNode[]) => { for (const node of nodes) { rows.push(node); if (node.type === 'folder' && expanded.has(node.path)) add(node.children ?? []); } };
    add(shown);
    return rows;
  }, [shown, expanded]);
  function onKeyDown(event: React.KeyboardEvent) {
    if (pending || (event.target as HTMLElement).closest('input')) return;
    const index = visibleRows.findIndex(n => n.path === selected);
    const node = visibleRows[index];
    const focus = (path: string) => { setSelected(path); requestAnimationFrame(() => (treeRef.current?.querySelector(`[data-path="${CSS.escape(path)}"] .res-row`) as HTMLElement | null)?.focus()); };
    if (event.key === 'ArrowDown') { event.preventDefault(); const next = visibleRows[Math.min(visibleRows.length - 1, index + 1)]; if (next) focus(next.path); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); const next = visibleRows[Math.max(0, index - 1)]; if (next) focus(next.path); }
    else if (!node) return;
    else if (event.key === 'ArrowRight' && node.type === 'folder') { event.preventDefault(); if (!expanded.has(node.path)) toggle(node.path); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); if (node.type === 'folder' && expanded.has(node.path)) toggle(node.path); else if (parentPath(node.path)) focus(parentPath(node.path)); }
    else if (event.key === 'F2') { event.preventDefault(); actions.rename(node.path); }
    else if (event.key === 'Delete' || (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))) { event.preventDefault(); actions.remove(node); }
  }

  const empty = tree && !tree.children.length;
  const ctx: TreeContext = { expanded, toggle, selected, setSelected, pending, rename, createFolder, actions, current: currentFolder, fresh, dropTarget, setDropTarget, handleDrop, preview };
  return <div className="resources" aria-busy={busy > 0 || undefined}>
    <div className="res-head">
      <h2 className="res-title">Resources</h2>
      {busy > 0 && <LoaderCircle size={14} className="spin res-spinner" aria-label="Working"/>}
      <div className="res-tools">
        {!props.projectOnly && <button type="button" className="icon-btn small" aria-label="Upload files" title="Upload files to the current conversation’s folder" disabled={!tree} onClick={() => pickFiles(currentFolder ?? '')}><Upload size={15}/></button>}
        {!props.projectOnly && <button type="button" className="icon-btn small" aria-label="New folder" title="New folder" disabled={!tree} onClick={() => actions.newFolder(selectedFolder(tree, selected) ?? '')}><FolderPlus size={15}/></button>}
        <button type="button" className="icon-btn small" aria-label="Refresh" title="Refresh" onClick={() => { version.current = ''; void load(); setProjectRefresh(n => n + 1); }}><RefreshCw size={15}/></button>
        <button type="button" className="icon-btn small" aria-label="Close resources" title="Close (⌘⇧E)" onClick={props.onClose}><X size={16}/></button>
      </div>
    </div>
    <input ref={fileInput} type="file" multiple hidden onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(uploadTarget.current, files); }}/>
    <div ref={treeRef} className="res-tree" role="tree" aria-label="Resources" tabIndex={-1} onKeyDown={onKeyDown}
      data-drop={dropTarget === '' || undefined}
      onDragOver={event => { if (!acceptsDrag(event)) return; event.preventDefault(); if (!(event.target as Element).closest('[data-path]')) setDropTarget(''); }}
      onDragLeave={event => { if (event.currentTarget === event.target) setDropTarget(undefined); }}
      onDrop={event => { if ((event.target as Element).closest('[data-path]')) return; event.preventDefault(); setDropTarget(undefined); void handleDrop(event, ''); }}>
      {error && <p className="res-empty">{error}</p>}
      {!tree && !error && !props.projectOnly && <p className="res-empty muted">Loading…</p>}
      {empty && <p className="res-empty">No files yet. Attach files in a chat, drop files here, or ask the agent to create some.</p>}
      {pending?.kind === 'new-folder' && pending.parent === '' && <NameField depth={0} initial="New folder" folder onDone={name => void createFolder('', name ?? '')}/>}
      {tree && split.visible.map(node => <TreeNode key={node.path} node={node} depth={0} ctx={ctx}/>)}
      {tree && !empty && !split.visible.length && !showArchived && <p className="res-empty">Only archived conversations have files here.</p>}
      {!!split.archived.length && <div className="res-archived" role="none">
        <button type="button" className="res-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
          <ChevronRight size={13} className="res-chev" data-open={showArchived || undefined} aria-hidden="true"/><Archive size={13} aria-hidden="true"/>
          <span>{showArchived ? 'Hide archived' : 'Show archived'} ({split.archived.length})</span>
        </button>
        {showArchived && <div role="group" aria-label="Archived" className="res-archived-group">
          {split.archived.map(node => <TreeNode key={node.path} node={node} depth={0} ctx={ctx}/>)}
        </div>}
      </div>}
      {tree?.truncated && <p className="res-empty muted">Showing the first 5,000 entries.</p>}
      {props.project && <ProjectSection name={props.project} visible={props.visible} refreshKey={`${String(props.refreshKey)}:${projectRefresh}`} alone={!!props.projectOnly}/>}
    </div>
    {tree && <p className="res-foot">{footerText(shown, showArchived ? 0 : split.archived.length)} · versioned with git</p>}
    {preview && <Preview path={preview} node={tree ? find(tree.children, preview) : undefined} onClose={() => setPreview(undefined)}/>}
    {confirm && <ConfirmDelete node={confirm} onCancel={() => setConfirm(undefined)} onConfirm={() => void remove(confirm)}/>}
    {moving && tree && <MoveDialog node={moving} tree={{ ...tree, children: shown }} onCancel={() => setMoving(undefined)} onMove={folder => { setMoving(undefined); void move(moving.path, folder); }}/>}
  </div>;

  function acceptsDrag(event: React.DragEvent) { return event.dataTransfer.types.includes(DRAG_TYPE) || event.dataTransfer.types.includes('Files'); }
  async function handleDrop(event: React.DragEvent, folder: string) {
    const from = event.dataTransfer.getData(DRAG_TYPE);
    if (from) { await move(from, folder); return; }
    const files = Array.from(event.dataTransfer.files);
    if (files.length) await upload(folder, files);
  }
}

function selectedFolder(tree: ResourceTree | undefined, selected: string | undefined): string | undefined {
  if (!tree || !selected) return undefined;
  const node = find(tree.children, selected);
  return node?.type === 'folder' ? node.path : node ? parentPath(node.path) : undefined;
}

type Actions = {
  preview(path: string): void; rename(path: string): void; newFolder(parent: string): void; move(node: ResourceNode): void; remove(node: ResourceNode): void; upload(folder: string): void; openThread(path: string): void;
};
type TreeContext = {
  expanded: ReadonlySet<string>; toggle(path: string): void; selected?: string; setSelected(path: string): void; pending: Pending;
  rename(path: string, name: string): Promise<void>; createFolder(parent: string, name: string): Promise<void>; actions: Actions; current?: string; fresh: ReadonlySet<string>;
  dropTarget?: string; setDropTarget(path?: string): void; handleDrop(event: React.DragEvent, folder: string): Promise<void>; preview?: string;
};

function TreeNode({ node, depth, ctx }: { node: ResourceNode; depth: number; ctx: TreeContext }) {
  const folder = node.type === 'folder';
  const isOpen = folder && ctx.expanded.has(node.path);
  const renaming = ctx.pending?.kind === 'rename' && ctx.pending.path === node.path;
  const [menu, setMenu] = useState(false);
  const target = folder ? node.path : parentPath(node.path);
  const activate = () => { ctx.setSelected(node.path); if (folder) ctx.toggle(node.path); else ctx.actions.preview(node.path); };
  const row = renaming
    ? <NameField depth={depth} initial={node.name} folder={folder} onDone={name => void ctx.rename(node.path, name ?? node.name)}/>
    : <div className="res-row" role="treeitem" aria-level={depth + 1} aria-expanded={folder ? isOpen : undefined} aria-selected={ctx.selected === node.path}
        tabIndex={ctx.selected === node.path || (!ctx.selected && depth === 0) ? 0 : -1}
        data-current={node.path === ctx.current || undefined} data-fresh={ctx.fresh.has(node.path) || undefined} data-previewing={ctx.preview === node.path || undefined}
        data-drop={ctx.dropTarget === node.path || undefined} data-menu-open={menu || undefined}
        style={{ paddingLeft: 6 + depth * 14 }} title={node.path}
        draggable onDragStart={event => { event.dataTransfer.setData(DRAG_TYPE, node.path); event.dataTransfer.effectAllowed = 'move'; ctx.setSelected(node.path); }}
        onDragOver={event => {
          const internal = event.dataTransfer.types.includes(DRAG_TYPE);
          if (!internal && !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault(); event.stopPropagation();
          event.dataTransfer.dropEffect = internal ? 'move' : 'copy';
          if (ctx.dropTarget !== target) ctx.setDropTarget(target);
        }}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); ctx.setDropTarget(undefined); void ctx.handleDrop(event, target); }}
        onDragEnd={() => ctx.setDropTarget(undefined)}
        onClick={activate} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } }}>
        {folder ? <ChevronRight size={13} className="res-chev" data-open={isOpen || undefined} aria-hidden="true"/> : <span className="res-chev-space"/>}
        <ResourceIcon node={node} open={isOpen}/>
        <span className="res-name">{node.name}</span>
        {node.path === ctx.current && <span className="res-tag">this chat</span>}
        {!folder && <span className="res-size">{shortSize(node.bytes)}</span>}
        <RowMenu node={node} actions={ctx.actions} open={menu} onOpenChange={setMenu}/>
      </div>;
  return <div className="res-node" data-path={node.path} role="none" data-drop-folder={folder && ctx.dropTarget === node.path || undefined}>
    <ContextMenu.Root onOpenChange={open => { if (open) ctx.setSelected(node.path); }}>
      <ContextMenu.Trigger asChild disabled={renaming}>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu" collisionPadding={8}>
          <MenuItems node={node} actions={ctx.actions} Item={ContextMenu.Item} Separator={ContextMenu.Separator}/>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    {isOpen && <div role="group">
      {ctx.pending?.kind === 'new-folder' && ctx.pending.parent === node.path && <NameField depth={depth + 1} initial="New folder" folder onDone={name => void ctx.createFolder(node.path, name ?? '')}/>}
      {node.children?.map(child => <TreeNode key={child.path} node={child} depth={depth + 1} ctx={ctx}/>)}
      {!node.children?.length && ctx.pending?.kind !== 'new-folder' && <div className="res-row res-placeholder" style={{ paddingLeft: 26 + (depth + 1) * 14 }}>Empty</div>}
    </div>}
  </div>;
}

function RowMenu({ node, actions, open, onOpenChange }: { node: ResourceNode; actions: Actions; open: boolean; onOpenChange(open: boolean): void }) {
  return <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="res-menu" aria-label={`Actions for ${node.name}`} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><Ellipsis size={15}/></button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu" align="end" side="bottom" collisionPadding={8} onClick={event => event.stopPropagation()}>
        <MenuItems node={node} actions={actions} Item={DropdownMenu.Item} Separator={DropdownMenu.Separator}/>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

type ItemComponent = React.ComponentType<{ className?: string; onSelect?(event: Event): void; children?: React.ReactNode; disabled?: boolean; asChild?: boolean }>;
function MenuItems({ node, actions, Item, Separator }: { node: ResourceNode; actions: Actions; Item: ItemComponent; Separator: React.ComponentType<{ className?: string }> }) {
  const folder = node.type === 'folder';
  return <>
    {!folder && previewKind(node.name) !== 'none' && <Item className="menu-item" onSelect={() => actions.preview(node.path)}><FileText size={15} aria-hidden="true"/>Preview</Item>}
    {folder && node.conversationId && <Item className="menu-item" onSelect={() => actions.openThread(node.path)}><MessageSquare size={15} aria-hidden="true"/>Open conversation</Item>}
    {folder && <Item className="menu-item" onSelect={() => actions.newFolder(node.path)}><FolderPlus size={15} aria-hidden="true"/>New folder</Item>}
    {folder && <Item className="menu-item" onSelect={() => actions.upload(node.path)}><Upload size={15} aria-hidden="true"/>Upload files…</Item>}
    {!folder && <Item className="menu-item" asChild><a href={fileUrl(node.path)} download={node.name}><Download size={15} aria-hidden="true"/>Download</a></Item>}
    <Separator className="menu-sep"/>
    <Item className="menu-item" onSelect={() => setTimeout(() => actions.rename(node.path), 0)}><Pencil size={15} aria-hidden="true"/>Rename</Item>
    <Item className="menu-item" onSelect={() => actions.move(node)}><FolderInput size={15} aria-hidden="true"/>Move to…</Item>
    <Item className="menu-item danger" onSelect={() => actions.remove(node)}><Trash size={15} aria-hidden="true"/>Delete</Item>
  </>;
}

/** Inline name editor: Enter saves, Escape cancels, clicking away saves a valid change. */
function NameField({ initial, depth, folder, onDone }: { initial: string; depth: number; folder?: boolean; onDone(value?: string): void }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    const el = input.current; if (!el) return;
    el.focus();
    // Select the name without its extension, as file managers do.
    const dot = folder ? -1 : initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [folder, initial]);
  const problem = validName(value);
  const finish = (save: boolean) => { if (finished.current) return; finished.current = true; onDone(save && !problem ? value.trim() : undefined); };
  return <div className="res-row res-editing" style={{ paddingLeft: 6 + depth * 14 }}>
    <span className="res-chev-space"/>
    <ResourceIcon node={{ name: value, type: folder ? 'folder' : 'file' }}/>
    <input ref={input} className="rename-input res-input" aria-label={folder ? 'Folder name' : 'File name'} aria-invalid={!!problem || undefined} title={problem} value={value} maxLength={120}
      onChange={event => setValue(event.target.value)}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); if (!problem) finish(true); } else if (event.key === 'Escape') { event.preventDefault(); finish(false); } }}
      onBlur={() => finish(true)}/>
  </div>;
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

function ConfirmDelete({ node, onCancel, onConfirm }: { node: ResourceNode; onCancel(): void; onConfirm(): void }) {
  const count = node.type === 'folder' ? [...walk(node.children ?? [])].filter(n => n.type === 'file').length : 0;
  return <Modal label={`Delete ${node.name}`} onClose={onCancel} className="confirm">
    <h2 className="modal-title">Delete “{node.name}”?</h2>
    <p className="modal-text">{node.type === 'folder' ? `This folder${count ? ` and its ${count} file${count === 1 ? '' : 's'}` : ''} will be removed${node.conversationId ? '. The conversation itself is kept' : ''}.` : 'This file will be removed.'} You can undo it right after, and it stays in the history.</p>
    <div className="modal-actions">
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      <button type="button" className="btn danger" data-autofocus onClick={onConfirm}><Trash size={15} aria-hidden="true"/>Delete</button>
    </div>
  </Modal>;
}

function MoveDialog({ node, tree, onCancel, onMove }: { node: ResourceNode; tree: ResourceTree; onCancel(): void; onMove(folder: string): void }) {
  const folders = useMemo(() => [{ path: '', name: 'Top level', depth: 0, conversationId: undefined as string | undefined }, ...[...walk(tree.children)].filter(n => n.type === 'folder').map(n => ({ path: n.path, name: n.name, depth: n.path.split('/').length, conversationId: n.conversationId }))], [tree]);
  const [choice, setChoice] = useState<string>();
  return <Modal label={`Move ${node.name}`} onClose={onCancel} className="move">
    <h2 className="modal-title">Move “{node.name}” to…</h2>
    <div className="move-list" role="listbox" aria-label="Folders">
      {folders.map(folder => {
        const allowed = canDrop(node.path, folder.path);
        return <button key={folder.path || '/'} type="button" role="option" aria-selected={choice === folder.path} className="move-option" disabled={!allowed} style={{ paddingLeft: 10 + folder.depth * 14 }}
          onClick={() => setChoice(folder.path)} onDoubleClick={() => allowed && onMove(folder.path)}>
          <ResourceIcon node={{ name: folder.name, type: 'folder', conversationId: folder.conversationId }}/><span>{folder.name}</span>{!allowed && folder.path === parentPath(node.path) && <span className="res-tag">current</span>}
        </button>;
      })}
    </div>
    <div className="modal-actions">
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      <button type="button" className="btn primary" disabled={choice === undefined} onClick={() => choice !== undefined && onMove(choice)}><FolderInput size={15} aria-hidden="true"/>Move here</button>
    </div>
  </Modal>;
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

function Preview({ path, node, onClose, source = RESOURCES }: { path: string; node?: Pick<ResourceNode, 'bytes'>; onClose(): void; source?: Source }) {
  const name = baseName(path);
  const listed = previewKind(name);
  // Atlassian documents are the resources' own (their images come through the resources); in a project they are JSON text.
  const kind = source.project && listed === 'atlassian' ? 'text' : listed;
  const { file: fileUrl, preview: previewUrl } = source;
  const where = source.project ? [source.project, parentPath(path)].filter(Boolean).join('/') : parentPath(path) || 'Top level';
  return <Modal label={`Preview of ${name}`} onClose={onClose} className="preview">
    <div className="preview-head">
      <ResourceIcon node={{ name, type: 'file' }}/>
      <div className="preview-title"><h2>{name}</h2><span className="muted">{where}{node?.bytes !== undefined ? ` · ${shortSize(node.bytes)}` : ''}</span></div>
      {(kind === 'pdf' || kind === 'image') && <a className="icon-btn small" href={previewUrl(path)} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab"><ExternalLink size={15}/></a>}
      <a className="icon-btn small" href={fileUrl(path)} download={name} aria-label={`Download ${name}`} title="Download"><Download size={15}/></a>
      <button type="button" className="icon-btn small" data-autofocus aria-label="Close preview" onClick={onClose}><X size={16}/></button>
    </div>
    <div className="preview-body" data-kind={kind}>
      {kind === 'image' && <img src={previewUrl(path)} alt={name}/>}
      {/* The browser's own PDF viewer, served under its own strict policy. */}
      {kind === 'pdf' && <iframe title={`PDF ${name}`} src={previewUrl(path)}/>}
      {/* No allow-scripts and no allow-same-origin: the page cannot run code, reach the app or the network. */}
      {kind === 'html' && <iframe title={`HTML ${name}`} src={previewUrl(path)} sandbox="" referrerPolicy="no-referrer"/>}
      {(kind === 'table' || kind === 'markdown' || kind === 'text' || kind === 'atlassian') && <TextPreview path={path} kind={kind} name={name} source={source}/>}
      {kind === 'none' && <p className="preview-empty">No preview for this type. <a href={fileUrl(path)} download={name}>Download it</a> instead.</p>}
    </div>
  </Modal>;
}

const MAX_TEXT = 400_000;
function TextPreview({ path, kind, name, source }: { path: string; kind: 'table' | 'markdown' | 'text' | 'atlassian'; name: string; source: Source }) {
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState('');
  useEffect(() => {
    const control = new AbortController();
    setText(undefined); setFailed('');
    void (async () => {
      try {
        const response = await fetch(source.preview(path), { credentials: 'same-origin', signal: control.signal });
        if (!response.ok) { let code = ''; try { code = ((await response.json()) as { error?: string }).error ?? ''; } catch { /* none */ } setFailed(source.project ? projectError(code) : resourceError(code)); return; }
        const body = await response.text();
        setText(body);
      } catch { if (!control.signal.aborted) setFailed('Couldn’t load the preview.'); }
    })();
    return () => control.abort();
  }, [path, source]);
  if (failed) return <p className="preview-empty">{failed}</p>;
  if (text === undefined) return <p className="preview-empty muted">Loading…</p>;
  const cut = text.length > MAX_TEXT;
  const shown = cut ? text.slice(0, MAX_TEXT) : text;
  if (kind === 'atlassian') return <AtlassianPreview path={path} text={text}/>;
  if (kind === 'table') return <TablePreview text={shown} tab={/\.tsv$/i.test(name)} cut={cut}/>;
  if (kind === 'markdown') return <div className="preview-markdown"><TextMessagePartProvider text={shown}><Markdown latex={false}/></TextMessagePartProvider>{cut && <p className="preview-note">Showing the first {MAX_TEXT.toLocaleString()} characters.</p>}</div>;
  return <><pre className="preview-text">{shown}</pre>{cut && <p className="preview-note">Showing the first {MAX_TEXT.toLocaleString()} characters.</p>}</>;
}

/**
 * A Jira issue or Confluence page saved by the Atlassian tools, drawn by
 * Atlassian's own renderer (lazily loaded). Images come through this app
 * (with your Atlassian account); the browser never contacts Atlassian.
 */
function AtlassianPreview({ path, text }: { path: string; text: string }) {
  const parsed = useMemo(() => parseAtlassianDocument(text), [text]);
  const mediaSrc = useCallback((id: string) => atlassianMediaUrl(path, id), [path]);
  const media = useMemo(() => parsed?.media ?? {}, [parsed]);
  if (!parsed) return <pre className="preview-text">{text.slice(0, MAX_TEXT)}</pre>;
  const source = parsed.source;
  const raw = <pre className="preview-text">{text.slice(0, MAX_TEXT)}</pre>;
  return <div className="adf-preview">
    {source && <div className="adf-source">
      <span className="adf-source-kind">{source.product === 'jira' ? `Jira · ${source.key ?? ''}` : 'Confluence page'}</span>
      <span className="adf-source-title">{source.title}</span>
      <span className="adf-source-meta">{source.product === 'confluence' && source.version ? `version ${source.version}` : source.updated ? `updated ${new Date(source.updated).toLocaleString()}` : ''}{parsed.fetchedAt ? ` · fetched ${new Date(parsed.fetchedAt).toLocaleString()}` : ''}</span>
      <a className="btn small" href={source.url} target="_blank" rel="noopener noreferrer">Open in {source.product === 'jira' ? 'Jira' : 'Confluence'}<ExternalLink size={13} aria-hidden="true"/></a>
    </div>}
    <Suspense fallback={<p className="preview-empty muted">Loading the Atlassian renderer…</p>}>
      <AdfView document={parsed.document} media={media} mediaSrc={mediaSrc} fallback={<><p className="preview-empty">This document couldn’t be drawn. Its content:</p>{raw}</>}/>
    </Suspense>
  </div>;
}

function TablePreview({ text, tab, cut }: { text: string; tab: boolean; cut: boolean }) {
  const { rows, truncated } = useMemo(() => parseDelimited(text, tab ? '\t' : ',', PREVIEW_ROWS + 1), [text, tab]);
  const [head, ...body] = rows;
  const columns = Math.max(0, ...rows.map(r => r.length));
  if (!head) return <p className="preview-empty">This file is empty.</p>;
  const total = body.length;
  return <div className="preview-table-wrap">
    <table className="preview-table">
      <thead><tr><th className="row-num" aria-label="Row"/>{Array.from({ length: columns }, (_, i) => <th key={i} scope="col">{head[i] ?? ''}</th>)}</tr></thead>
      <tbody>{body.map((row, r) => <tr key={r}><td className="row-num">{r + 1}</td>{Array.from({ length: columns }, (_, i) => <td key={i}>{row[i] ?? ''}</td>)}</tr>)}</tbody>
    </table>
    <p className="preview-note">{truncated || cut ? `Showing the first ${Math.min(total, PREVIEW_ROWS).toLocaleString()} rows.` : `${total.toLocaleString()} row${total === 1 ? '' : 's'} · ${columns} column${columns === 1 ? '' : 's'}`}</p>
  </div>;
}

/* ------------------------------------------------------------------ */
/* Project folder (read-only)                                          */
/* ------------------------------------------------------------------ */

/**
 * The agent's project folder (mounted at `/project` in its sandbox), below
 * the resources: read-only, one directory at a time (listed when opened),
 * `.git`, `node_modules` and `.gitignore` matches hidden. Files preview and
 * download like resources; a dot marks what git sees as changed. It is
 * refreshed when a turn ends. The app never writes here: the agent edits it
 * with commands.
 */
function ProjectSection({ name, visible, refreshKey, alone }: { name: string; visible: boolean; refreshKey: string; alone: boolean }) {
  const toast = useToast();
  const source = useMemo(() => projectSource(name), [name]);
  const [listings, setListings] = useState<ReadonlyMap<string, ProjectListing>>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState('');
  const [saved, setSaved] = useState(() => localStorage.getItem(PROJECT_OPEN_KEY));
  const [preview, setPreview] = useState<ProjectEntry>();
  const [selected, setSelected] = useState<string>();
  const listingsRef = useRef(listings);
  listingsRef.current = listings;
  const sectionRef = useRef<HTMLDivElement>(null);
  const top = listings.get('');
  const open = alone || projectOpen(saved, top);
  const setOpen = (value: boolean) => { localStorage.setItem(PROJECT_OPEN_KEY, String(value)); setSaved(String(value)); };

  /** List one directory: its first page, or as many entries as are shown already (a refresh keeps "show more" pages). */
  const fetchDir = useCallback(async (path: string, offset = 0, limit?: number) => {
    const query = `path=${encodeURIComponent(path)}${offset ? `&offset=${offset}` : ''}${limit ? `&limit=${limit}` : ''}`;
    return api<ProjectListing>(`/v1/project/list?${query}`);
  }, []);
  const loadDir = useCallback(async (path: string, quiet = false) => {
    setLoading(set => new Set([...set, path]));
    try {
      const shown = listingsRef.current.get(path)?.entries.length ?? 0;
      const next = await fetchDir(path, 0, shown > 200 ? Math.min(1000, shown) : undefined);
      setListings(map => new Map(map).set(path, next));
      if (!path) setFailed('');
    } catch (e) {
      const code = errorCode(e);
      if (!path) setFailed(projectError(code));
      else {
        // Gone or now ignored: forget it and close it.
        setListings(map => { const copy = new Map(map); for (const key of copy.keys()) if (key === path || key.startsWith(`${path}/`)) copy.delete(key); return copy; });
        setExpanded(set => new Set([...set].filter(p => p !== path && !p.startsWith(`${path}/`))));
        if (!quiet) toast(projectError(code), { tone: 'error' });
      }
    } finally { setLoading(set => { const copy = new Set(set); copy.delete(path); return copy; }); }
  }, [fetchDir, toast]);
  // The top level when shown, and every listed directory again when a turn ends (the agent may have changed files).
  useEffect(() => {
    if (!visible) return;
    const paths = [...listingsRef.current.keys()];
    for (const path of paths.length ? paths : ['']) void loadDir(path, true);
  }, [visible, refreshKey, loadDir]);

  const toggle = (path: string) => {
    if (expanded.has(path)) { setExpanded(set => { const copy = new Set(set); copy.delete(path); return copy; }); return; }
    setExpanded(set => new Set([...set, path]));
    if (!listings.has(path)) void loadDir(path);
  };
  const more = async (path: string) => {
    const current = listings.get(path);
    if (!current) return;
    setLoading(set => new Set([...set, path]));
    try { const next = await fetchDir(path, current.entries.length); setListings(map => new Map(map).set(path, appendPage(map.get(path), next))); }
    catch (e) { toast(projectError(errorCode(e)), { tone: 'error' }); }
    finally { setLoading(set => { const copy = new Set(set); copy.delete(path); return copy; }); }
  };
  const activate = (entry: ProjectEntry) => {
    setSelected(entry.path);
    if (entry.link === 'outside') { toast(projectError('project_outside'), { tone: 'error' }); return; }
    if (entry.type === 'folder') toggle(entry.path); else setPreview(entry);
  };
  // Arrow keys move through the rows shown.
  const onKeyDown = (event: React.KeyboardEvent) => {
    // The resources tree's keys (rename, delete, ...) never apply here.
    event.stopPropagation();
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...(sectionRef.current?.querySelectorAll<HTMLElement>('.proj-tree .res-row[role="treeitem"]') ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1)];
    if (next) { event.preventDefault(); next.focus(); }
  };

  const changes = top?.changes ?? 0;
  const ctx: ProjectContext = { listings, expanded, loading, selected, preview: preview?.path, activate, more, source };
  return <section ref={sectionRef} className="proj" data-alone={alone || undefined} aria-label={`Project ${name}`} onKeyDown={onKeyDown}
    // Nothing can be dropped here (no upload into the project).
    onDragOver={event => event.stopPropagation()} onDrop={event => { event.preventDefault(); event.stopPropagation(); }}>
    {alone
      ? <div className="proj-head proj-head-static"><FolderGit2 size={14} aria-hidden="true"/><span className="proj-title">Project · {name}</span>{changes > 0 && <ChangesTag count={changes}/>}</div>
      : <button type="button" className="proj-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={13} className="res-chev" data-open={open || undefined} aria-hidden="true"/><FolderGit2 size={14} aria-hidden="true"/>
          <span className="proj-title">Project · {name}</span>
          {changes > 0 && <ChangesTag count={changes}/>}
          {!open && top && <span className="proj-count">{top.total}{top.more ? '+' : ''} item{top.total === 1 ? '' : 's'}</span>}
        </button>}
    {open && <>
      <p className="proj-note">Read-only here; the agent edits it with commands.</p>
      {failed && <p className="res-empty">{failed}</p>}
      {!top && !failed && <p className="res-empty muted">Loading…</p>}
      {top && <div className="proj-tree" role="tree" aria-label={`Project ${name}`}>
        {top.entries.map(entry => <ProjectNode key={entry.path} entry={entry} depth={0} ctx={ctx}/>)}
        {!top.entries.length && <p className="res-empty">Nothing to show (everything here is ignored or empty).</p>}
        <MoreRow listing={top} depth={0} ctx={ctx}/>
      </div>}
    </>}
    {preview && <Preview path={preview.path} node={preview} source={source} onClose={() => setPreview(undefined)}/>}
  </section>;
}

const ChangesTag = ({ count }: { count: number }) => <span className="proj-changes" title={`${count} uncommitted change${count === 1 ? '' : 's'} (git status)`}>{count} changed</span>;

type ProjectContext = { listings: ReadonlyMap<string, ProjectListing>; expanded: ReadonlySet<string>; loading: ReadonlySet<string>; selected?: string; preview?: string; activate(entry: ProjectEntry): void; more(path: string): Promise<void>; source: Source };

function ProjectNode({ entry, depth, ctx }: { entry: ProjectEntry; depth: number; ctx: ProjectContext }) {
  const folder = entry.type === 'folder';
  const outside = entry.link === 'outside';
  const isOpen = folder && ctx.expanded.has(entry.path);
  const listing = ctx.listings.get(entry.path);
  const status = projectStatusLabel(entry.status);
  return <div className="res-node" data-project-path={entry.path} role="none">
    <div className="res-row" role="treeitem" aria-level={depth + 1} aria-expanded={folder ? isOpen : undefined} aria-selected={ctx.selected === entry.path} aria-disabled={outside || undefined}
      tabIndex={ctx.selected === entry.path || (!ctx.selected && depth === 0) ? 0 : -1} data-previewing={ctx.preview === entry.path || undefined} data-outside={outside || undefined}
      style={{ paddingLeft: 6 + depth * 14 }} title={outside ? `${entry.name}: a link outside the project (not shown)` : status ? `${entry.path} · ${status}` : entry.path}
      onClick={() => ctx.activate(entry)} onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ctx.activate(entry); }
        else if (folder && ((event.key === 'ArrowRight' && !isOpen) || (event.key === 'ArrowLeft' && isOpen))) { event.preventDefault(); ctx.activate(entry); }
      }}>
      {folder ? <ChevronRight size={13} className="res-chev" data-open={isOpen || undefined} aria-hidden="true"/> : <span className="res-chev-space"/>}
      {outside ? <span className="res-icon" data-kind="outside" aria-hidden="true"><Link2Off size={15}/></span> : <ResourceIcon node={{ name: entry.name, type: entry.type }} open={isOpen}/>}
      <span className="res-name">{entry.name}</span>
      {entry.status && <span className="proj-dot" data-status={entry.status} role="img" aria-label={status}/>}
      {outside && <span className="res-tag proj-outside-tag">outside</span>}
      {!folder && !outside && <span className="res-size">{shortSize(entry.bytes)}</span>}
      {!folder && !outside && <a className="res-menu" href={ctx.source.file(entry.path)} download={entry.name} aria-label={`Download ${entry.name}`} title="Download" onClick={event => event.stopPropagation()} tabIndex={-1}><Download size={14}/></a>}
      {folder && ctx.loading.has(entry.path) && <LoaderCircle size={13} className="spin res-spinner" aria-label="Loading"/>}
    </div>
    {isOpen && <div role="group">
      {listing?.entries.map(child => <ProjectNode key={child.path} entry={child} depth={depth + 1} ctx={ctx}/>)}
      {listing && !listing.entries.length && <div className="res-row res-placeholder" style={{ paddingLeft: 26 + (depth + 1) * 14 }}>Empty</div>}
      {!listing && <div className="res-row res-placeholder" style={{ paddingLeft: 26 + (depth + 1) * 14 }}>Loading…</div>}
      {listing && <MoreRow listing={listing} depth={depth + 1} ctx={ctx}/>}
    </div>}
  </div>;
}

/** "Show more" when a directory has more entries than one page. */
function MoreRow({ listing, depth, ctx }: { listing: ProjectListing; depth: number; ctx: ProjectContext }) {
  if (!listing.more && !listing.truncated) return null;
  const left = listing.total - listing.entries.length;
  return <div className="proj-more" style={{ paddingLeft: 26 + depth * 14 }}>
    {listing.more && <button type="button" className="btn small ghost" disabled={ctx.loading.has(listing.path)} onClick={() => void ctx.more(listing.path)}>Show more ({left.toLocaleString()} left)</button>}
    {listing.truncated && !listing.more && <span className="muted">Only the first {listing.total.toLocaleString()} entries are listed.</span>}
  </div>;
}
