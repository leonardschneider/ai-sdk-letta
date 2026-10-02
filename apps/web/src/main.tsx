import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantRuntimeProvider, ComposerPrimitive, type AssistantRuntime, MessageNotSentError, ThreadPrimitive, useAuiEvent, useExternalStoreRuntime, type AppendMessage, type ExternalStoreThreadData, type ThreadMessageLike } from '@assistant-ui/react';
import { ArchiveRestore, ArrowDown, ArrowUp, FolderTree, Menu, PanelLeftOpen, Paperclip, Square, SquarePen, TriangleAlert } from 'lucide-react';
import { AgentSwitcher, CurrentUser, MembersDialog, NoAccess, QueueList, type QueuedTurn } from './team.js';
import type { UIMessage } from 'ai';
import type { RuntimeEvent } from '@ai-sdk-letta/server';
import type { InteractionRequest, InteractionResponse } from 'ai-sdk-letta';
import { historyMessages, observedParts, userContent, withAuthor, withTime, type FileChip } from './messages.js';
import { api, apiPath, errorCode, metadataError, setAgentBase, setCsrf, uploadFile, uuid, type AgentInfo, type Person, type Session } from './api.js';
import { activityTimes, DEFAULT_TITLE, deriveTitle, isDefaultTitle, nextAfterArchive, sortThreads, type ThreadSummary } from './thread-model.js';
import { Sidebar } from './sidebar.js';
import type { Versions } from './versions.js';
import { TitleView } from './title.js';
import { titleText } from 'ai-sdk-letta/title';
import { AuthorContext, InteractionContext, InteractionDock, Message } from './chat.js';
import { LatexContext } from './markdown.js';
import { resolveLatex, type LatexOverride } from './latex.js';
import { LatexMenu } from './latex-menu.js';
import { ToastProvider, useToast } from './toasts.js';
import { Starters } from './starters.js';
import { ResourcesPanel } from './resources.js';
import { LAYOUT_KEY, RESOURCES_WIDTH, clampWidth, readLayout, type Layout } from './resources-model.js';
import { AttachmentError, FILE_LIMITS, FileAttachmentAdapter, IMAGE_LIMITS, base64Bytes, checkBudget, dataUrlToImage, fileDetail, fileMessage, fileMessages, messages as attachmentMessages, pasteAttaches, type FileInfo } from './attachments.js';
import { ComposerImages, FileLinkContext, LightboxProvider } from './images.js';
import './style.css';
import './markdown.css';

type LiveFile = { name: string; label: string; bytes: number; kind: FileInfo['kind']; pages?: number; lines?: number };
type Author = Person & { id: string };
type View = { messages: UIMessage[]; lastRunId: string | null; live: null | { id: string; input: string; images?: number; files?: LiveFile[]; author?: Author; startedAt?: string }; status: string | null; queue?: QueuedTurn[] };
/** Team mode: who you are, your role in this agent, and the other agents you can switch to. */
type Team = { user: Author; agents: AgentInfo[]; onSwitch(id: string): void };
const chip = (file: Pick<FileInfo, 'name' | 'kind' | 'label' | 'bytes' | 'pages' | 'lines'>): FileChip => ({ name: file.name, kind: file.kind, detail: fileDetail(file) });
type Current = { id: string; draft: boolean };
const SAVED = 'ai-sdk-letta-thread';
const newDraft = (): Current => ({ id: uuid(), draft: true });
const blockedNotice = 'This conversation has an unfinished or uncertain turn, so it’s read-only. Nothing is replayed automatically — start a new chat to continue.';

/**
 * Loads the session, then shows the app for one agent: the only one of the
 * single-user app, or the one chosen in a team server (switching agents
 * remounts the app, so nothing of one agent leaks into another).
 */
function Root() {
  const [session, setSession] = useState<Session>();
  const [failed, setFailed] = useState(false);
  const [agentId, setAgentId] = useState<string>();
  useEffect(() => {
    void (async () => {
      try {
        const loaded = await api<Session>('/session');
        if (loaded.csrf) setCsrf(loaded.csrf);
        if (loaded.mode === 'team') {
          const saved = localStorage.getItem(AGENT_SAVED);
          const chosen = loaded.agents.find(a => a.id === saved) ?? loaded.agents[0];
          setAgentBase(chosen?.id); setAgentId(chosen?.id);
        }
        setSession(loaded);
      } catch { setFailed(true); }
    })();
  }, []);
  const onSwitch = useCallback((id: string) => { localStorage.setItem(AGENT_SAVED, id); setAgentBase(id); setAgentId(id); }, []);
  if (failed) return <App agent={{ id: '', name: 'ai-sdk-letta', approvalTools: [] }} unreachable/>;
  if (!session) return <App agent={{ id: '', name: 'Connecting…', approvalTools: [] }} connecting/>;
  if (session.mode !== 'team') return <App agent={session.agent} versions={session.versions}/>;
  const agent = session.agents.find(a => a.id === agentId);
  if (!agent || !session.user.id) return <NoAccess user={session.user}/>;
  return <App key={agent.id} agent={agent} versions={session.versions} team={{ user: session.user as Author, agents: session.agents, onSwitch }}/>;
}
const AGENT_SAVED = 'ai-sdk-letta-agent';

function App({ agent, versions, team, connecting, unreachable }: { agent: AgentInfo; versions?: Versions; team?: Team; connecting?: boolean; unreachable?: boolean }) {
  const toast = useToast();
  const approvalTools = useMemo(() => new Set(agent.approvalTools), [agent.approvalTools]);
  const filesEnabled = !!agent.files;
  // Team mode: the last thread is remembered per agent.
  const SAVED_THREAD = team ? `${SAVED}:${agent.id}` : SAVED;
  const isAdmin = agent.role === 'admin';
  const [queue, setQueue] = useState<QueuedTurn[]>([]);
  const [liveAuthor, setLiveAuthor] = useState<Author>();
  const [membersOpen, setMembersOpen] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [listLoading, setListLoading] = useState(!unreachable);
  const [current, setCurrent] = useState<Current>(newDraft);
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(!unreachable);
  const [blocked, setBlocked] = useState('');
  const [interaction, setInteraction] = useState<InteractionRequest>();
  const [interactionOutcome, setInteractionOutcome] = useState('');
  const [sentAnswer, setSentAnswer] = useState<InteractionResponse>();
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState(false);
  // Desktop layout (persisted): left sidebar shown or collapsed, Resources panel open or closed, its width.
  const [layout, setLayoutState] = useState<Layout>(() => readLayout(localStorage.getItem(LAYOUT_KEY)));
  const setLayout = useCallback((update: (previous: Layout) => Layout) => setLayoutState(previous => { const next = update(previous); localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); return next; }), []);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => { const query = window.matchMedia('(max-width: 760px)'); const on = () => setNarrow(query.matches); query.addEventListener('change', on); return () => query.removeEventListener('change', on); }, []);
  // On a phone, the Resources panel is a drawer like the sidebar (never persisted open).
  const [resourcesDrawer, setResourcesDrawer] = useState(false);
  const resourcesOpen = narrow ? resourcesDrawer : layout.resources;
  const toggleSidebar = useCallback(() => { if (narrow) { setResourcesDrawer(false); setDrawer(open => !open); } else setLayout(l => ({ ...l, sidebar: !l.sidebar })); }, [narrow, setLayout]);
  const toggleResources = useCallback(() => { if (narrow) { setDrawer(false); setResourcesDrawer(open => !open); } else setLayout(l => ({ ...l, resources: !l.resources })); }, [narrow, setLayout]);
  const [turns, setTurns] = useState(0);
  const [archiving, setArchiving] = useState<ReadonlySet<string>>(new Set());
  const [liveThread, setLiveThread] = useState<string>();
  const currentInteraction = useRef<{ id: string; runId: string; resolved: boolean } | undefined>(undefined);
  const lastRun = useRef<string | null>(null);
  const liveRun = useRef<string | undefined>(undefined);
  const stream = useRef<AbortController | undefined>(undefined);
  const operation = useRef(false);
  const threadsRef = useRef(threads); threadsRef.current = threads;
  const currentRef = useRef(current); currentRef.current = current;
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const focusComposer = useCallback(() => requestAnimationFrame(() => {
    if (document.querySelector('.dock .card')) return;
    const el = composerRef.current;
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }), []);

  async function refreshThreads() { setThreads(await api<ThreadSummary[]>('/v1/threads')); }

  async function watch(id: string, input: string, base: ThreadMessageLike[], startedAt?: string, images: readonly string[] = [], files: readonly FileChip[] = [], author?: Author) {
    stream.current?.abort(); const control = new AbortController(); stream.current = control;
    liveRun.current = id; setRunning(true); setLiveThread(currentRef.current.id); setLiveAuthor(author);
    const events: RuntimeEvent[] = [];
    let ended = false;
    let endedAt: string | undefined;
    const render = () => setMessages([...base,
      withAuthor(withTime({ id: `${id}-user`, role: 'user', content: userContent(input, images, files) }, startedAt), author),
      withTime({ id: `${id}-assistant`, role: 'assistant', content: observedParts(events), status: ended ? events.at(-1)?.type === 'failed' ? { type: 'incomplete', reason: events.at(-1)?.data.code === 'cancelled' ? 'cancelled' : 'error' } : { type: 'complete', reason: 'stop' } : { type: 'running' } }, endedAt)]);
    render();
    try {
      const response = await fetch(apiPath(`/v1/runs/${id}/events`), { signal: control.signal });
      if (!response.ok || !response.body) throw new Error('Event connection unavailable. Refresh to reconnect; do not resend.');
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = '';
      while (true) {
        const next = await reader.read(); if (next.done) break; buffer += next.value;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
          const event = JSON.parse(line) as RuntimeEvent;
          if (stream.current !== control || control.signal.aborted) return;
          if (event.sequence <= (events.at(-1)?.sequence ?? 0)) continue;
          events.push(event);
          if (event.type === 'interaction') {
            const request = event.data as InteractionRequest;
            currentInteraction.current = { id: request.id, runId: id, resolved: false };
            setInteraction(request); setInteractionOutcome('');
          }
          if (['interaction_resolved', 'interaction_ended'].includes(event.type) && currentInteraction.current?.runId === id && currentInteraction.current.id === event.data.id) {
            currentInteraction.current.resolved = true;
            setInteractionOutcome(event.type === 'interaction_resolved' ? 'Response received. Waiting for the agent…' : event.data.code === 'timed_out' ? 'This question timed out. Your response was not submitted.' : event.data.code === 'cancelled' ? 'This question was cancelled. Your response was not submitted.' : 'This question ended before an answer was confirmed. Do not resend this turn.');
          }
          if (event.type === 'completed' || event.type === 'failed') {
            ended = true; endedAt = new Date().toISOString(); lastRun.current = id;
            if (currentInteraction.current?.runId === id) {
              const answered = currentInteraction.current.resolved;
              setInteractionOutcome(previous => answered ? previous === 'Response received. Waiting for the agent…' ? event.type === 'completed' ? 'Response received. The agent has finished.' : 'Response received, but the agent could not finish. Do not resend.' : previous : 'This question closed before an answer was confirmed. Do not resend this turn.');
              currentInteraction.current.resolved = true;
            }
            // Team mode: the conversation's state (read-only or not) comes from the view refreshed when this ends.
            if (event.type === 'failed' && !team) {
              const code = String(event.data.code);
              setBlocked(code === 'cancelled' ? 'You stopped this reply. To keep things consistent nothing is replayed — start a new chat to continue.' : code === 'timed_out' ? 'This reply timed out. Nothing is replayed automatically — start a new chat to continue.' : `This reply didn’t finish (${code}). Nothing is replayed automatically — start a new chat to continue.`);
            }
          }
          render();
        }
      }
      if (!ended) throw new Error('Stream disconnected. Refresh to reconnect without replaying the turn.');
    } catch (e) { if (!control.signal.aborted) setBlocked(`${e instanceof Error ? e.message : String(e)}`); }
    finally {
      setTurns(n => n + 1);
      if (stream.current === control) {
        setRunning(false);
        if (ended) { liveRun.current = undefined; setLiveThread(undefined); setLiveAuthor(undefined); }
        void refreshThreads().catch(() => {});
        // Team mode: show the finished turn from history, and the next queued one if it started.
        if (team && ended) void refreshView().catch(() => {});
      }
    }
  }

  /**
   * Team mode: bring the open conversation up to date with what others did
   * (their turns, the queue, a turn that ended). A live turn being watched
   * keeps rendering; only its queue is updated.
   */
  const viewing = useRef(false);
  async function refreshView() {
    const target = currentRef.current;
    if (!team || target.draft || operation.current || viewing.current) return;
    viewing.current = true;
    try {
      const view = await api<View>(`/v1/threads/${target.id}/view`);
      if (currentRef.current.id !== target.id) return;
      setQueue(view.queue ?? []);
      if (view.live && liveRun.current === view.live.id) return;
      lastRun.current = view.lastRunId;
      const base = historyMessages(view.messages);
      if (view.live) { void watch(view.live.id, view.live.input, base, view.live.startedAt, Array.from({ length: view.live.images ?? 0 }, () => ''), (view.live.files ?? []).filter(f => !(view.live!.images && f.kind === 'image')).map(chip), view.live.author); return; }
      if (liveRun.current) return;
      setMessages(base);
      setBlocked(!!view.status && !['running', 'completed'].includes(view.status) ? blockedNotice : '');
    } finally { viewing.current = false; }
  }

  async function select(id: string) {
    // Team mode: other conversations keep running on the server while you look elsewhere.
    if (operation.current || (liveRun.current && !team)) return;
    if (team) { stream.current?.abort(); liveRun.current = undefined; setRunning(false); setLiveThread(undefined); setLiveAuthor(undefined); setQueue([]); }
    operation.current = true; setLoading(true); setBlocked(''); setInteraction(undefined); setInteractionOutcome('');
    const previous = currentRef.current;
    setCurrent({ id, draft: false }); setMessages([]); setDrawer(false);
    try {
      // Reading a view never sends input; retry briefly if another tab holds the single runtime.
      let view: View | undefined;
      for (let attempt = 0; !view; attempt++) {
        try { view = await api<View>(`/v1/threads/${id}/view`); }
        catch (e) { if (errorCode(e) !== 'runtime_busy' || attempt >= 5) throw e; await new Promise(r => setTimeout(r, 300 * (attempt + 1))); }
      }
      localStorage.setItem(SAVED_THREAD, id); lastRun.current = view.lastRunId;
      const base = historyMessages(view.messages); setMessages(base); setQueue(view.queue ?? []);
      const failed = !!view.status && !['running', 'completed'].includes(view.status);
      setBlocked(failed ? blockedNotice : '');
      // After a refresh mid-run the image bytes are only in Letta history; show placeholders until it completes.
      if (view.live) void watch(view.live.id, view.live.input, base, view.live.startedAt, Array.from({ length: view.live.images ?? 0 }, () => ''), (view.live.files ?? []).filter(f => !(view.live!.images && f.kind === 'image')).map(chip), view.live.author);
    } catch (e) {
      setCurrent(previous);
      toast(errorCode(e) === 'runtime_busy' ? 'Another reply is still running. Try again when it finishes.' : errorCode(e) === 'not_found' && team ? 'That conversation isn’t available in this agent.' : 'Couldn’t open that conversation. Check that the local server is running.', { tone: 'error' });
      if (!previous.draft && previous.id !== id) { operation.current = false; setLoading(false); return void select(previous.id); }
    } finally { operation.current = false; setLoading(false); focusComposer(); }
  }

  function startDraft() {
    if (operation.current || (liveRun.current && !team)) return;
    stream.current?.abort();
    if (team) { liveRun.current = undefined; setRunning(false); setLiveThread(undefined); setLiveAuthor(undefined); setQueue([]); }
    setCurrent(newDraft()); setMessages([]); setBlocked(''); setInteraction(undefined); setInteractionOutcome('');
    lastRun.current = null; setDrawer(false); setLoading(false);
    localStorage.removeItem(SAVED_THREAD);
    focusComposer();
  }

  useEffect(() => {
    if (connecting) return;
    if (unreachable) { setBlocked('Couldn’t reach the local server. Check that it’s running, then refresh.'); return; }
    void (async () => {
      try {
        const list = await api<ThreadSummary[]>('/v1/threads'); setThreads(list); setListLoading(false);
        const saved = localStorage.getItem(SAVED_THREAD);
        const sorted = sortThreads(list);
        const first = list.find(t => t.id === saved && t.state === 'ready') ?? sorted.find(t => t.state === 'ready' && !t.archived);
        setLoading(false);
        if (first) await select(first.id); else startDraft();
      } catch { setListLoading(false); setLoading(false); setBlocked('Couldn’t reach the local server. Check that it’s running, then refresh.'); }
    })();
    return () => stream.current?.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connecting]);

  // Team mode: follow what others do (new conversations, turns, the queue) with a long poll.
  const summaryKey = useRef('');
  useEffect(() => {
    if (!team || connecting) return;
    const control = new AbortController();
    void (async () => {
      let since = -1;
      while (!control.signal.aborted) {
        try {
          const response = await fetch(apiPath(`/v1/changes?since=${since}`), { credentials: 'same-origin', signal: control.signal });
          if (!response.ok) throw new Error(String(response.status));
          const { version } = await response.json() as { version: number };
          if (version === since) continue;
          const first = since === -1;
          since = version;
          if (first) continue;
          const list = await api<ThreadSummary[]>('/v1/threads');
          if (control.signal.aborted) return;
          setThreads(list);
          // Refresh the open conversation only when it changed (its turns, queue or title).
          const open = list.find(t => t.id === currentRef.current.id);
          const key = open ? `${open.id}|${open.running ?? ''}|${open.queued ?? 0}|${open.lastActivityAt ?? ''}` : '';
          if (key !== summaryKey.current) { summaryKey.current = key; await refreshView().catch(() => {}); }
        } catch { if (control.signal.aborted) return; await new Promise(resolve => setTimeout(resolve, 3000)); }
      }
    })();
    return () => control.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connecting]);

  const sorted = useMemo(() => sortThreads(threads), [threads]);
  const times = useMemo(() => activityTimes(threads), [threads]);
  const active = useMemo(() => sorted.filter(t => !t.archived), [sorted]);
  const archived = useMemo(() => sorted.filter(t => t.archived), [sorted]);
  const selected = threads.find(t => t.id === current.id);
  // Team mode: other conversations stay reachable while a reply runs (they run in parallel).
  const busy = team ? loading : running || loading;
  /** Team mode: you may answer or stop the live turn if you sent it or are an admin. */
  const mayAct = !team || isAdmin || !liveAuthor || liveAuthor.id === team.user.id;

  async function patch(id: string, body: { title?: string; archived?: boolean; latex?: LatexOverride }) {
    const updated = await api<ThreadSummary>(`/v1/threads/${id}`, body, 'PATCH');
    setThreads(list => list.map(t => t.id === updated.id ? { ...t, ...updated } : t));
    // The conversation's folder follows its title: refresh the Resources panel now.
    if (body.title !== undefined) setTurns(n => n + 1);
    return updated;
  }
  async function rename(id: string, title: string) {
    try { await patch(id, { title }); } catch (e) { toast(metadataError(e), { tone: 'error' }); }
  }
  async function archive(id: string) {
    if (liveRun.current && liveThread === id) { toast('Stop or finish the current reply before archiving.', { tone: 'error' }); return; }
    if (archiving.has(id)) return;
    const wasCurrent = currentRef.current.id === id;
    if (wasCurrent && operation.current) return;
    setArchiving(set => new Set(set).add(id));
    try {
      const updated = await patch(id, { archived: true });
      toast(`Archived “${titleText(updated.title)}”`, { action: { label: 'Undo', run: () => void restore(id) } });
      if (wasCurrent && currentRef.current.id === id) {
        const next = nextAfterArchive(sorted, id);
        if (next) await select(next); else startDraft();
      }
    } catch (e) { toast(metadataError(e), { tone: 'error' }); }
    finally { setArchiving(set => { const copy = new Set(set); copy.delete(id); return copy; }); }
  }
  async function restore(id: string) {
    try { const updated = await patch(id, { archived: false }); toast(`Restored “${titleText(updated.title)}”`); if (currentRef.current.id === id) focusComposer(); }
    catch (e) { toast(metadataError(e), { tone: 'error' }); }
  }

  /** A conversation's LaTeX override; the open conversation re-renders at once. */
  async function setLatex(id: string, value: LatexOverride) {
    try { await patch(id, { latex: value }); } catch (e) { toast(metadataError(e), { tone: 'error' }); }
  }

  /** Title from the first message, only while the conversation still has the default title. */
  async function autoTitle(id: string, text: string) {
    const thread = threadsRef.current.find(t => t.id === id);
    const title = deriveTitle(text);
    if (!title || (thread && !isDefaultTitle(thread.title))) return;
    try { await patch(id, { title }); } catch { /* Keep the default title; nothing else depends on it. */ }
  }

  async function send(message: AppendMessage) {
    const target = currentRef.current;
    // Anything that stops here hands text and images back to the composer (MessageNotSentError).
    if (operation.current || (liveRun.current && !team) || blocked || selected?.archived) throw new MessageNotSentError();
    // Team mode: while a reply runs, the message waits in this conversation's queue.
    const queueing = !!team && !!liveRun.current && liveThread === target.id;
    const text = message.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    const imageAttachments = (message.attachments ?? []).flatMap(a => a.content.flatMap(p => p.type === 'image' ? [{ url: p.image, name: a.name }] : []));
    const urls = imageAttachments.map(image => image.url);
    const images = urls.map(dataUrlToImage);
    if (images.some(image => !image)) { toast(attachmentMessages.unsupported, { tone: 'error' }); throw new MessageNotSentError(); }
    // Images keep their names so they are saved under them in the conversation's folder.
    const wire = (images as { mediaType: string; data: string }[]).map((image, i) => ({ ...image, ...(filesEnabled && imageAttachments[i]!.name ? { name: imageAttachments[i]!.name } : {}) }));
    const budget = checkBudget(wire.map(image => base64Bytes(image.data)));
    if (budget) { toast(budget, { tone: 'error' }); throw new MessageNotSentError(); }
    const uploads = (message.attachments ?? []).flatMap(a => a.content.flatMap(p => p.type === 'data' && p.name === 'upload' ? [p.data as FileInfo] : []));
    if (uploads.length > FILE_LIMITS.maxFilesPerMessage) { toast(fileMessages.files_too_many!, { tone: 'error' }); throw new MessageNotSentError(); }
    const files = uploads.map(chip);
    if (!text.trim() && !wire.length && !uploads.length) throw new MessageNotSentError();
    if (text.length > 8000) { toast('Messages can be up to 8,000 characters.', { tone: 'error' }); throw new MessageNotSentError(); }
    operation.current = true;
    const startedAt = new Date().toISOString();
    const base = messagesRef.current;
    const first = !base.length && !queueing;
    const optimisticId = `pending-${startedAt}`;
    const id = uuid();
    const me = team?.user;
    if (queueing) setQueue(list => [...list, { id, input: text, ...(me ? { author: me } : {}), ...(urls.length ? { images: urls.length } : {}), ...(uploads.length ? { files: uploads.length } : {}) }]);
    else { setRunning(true); setMessages([...base, withAuthor(withTime({ id: `${optimisticId}-user`, role: 'user', content: userContent(text, urls, files) }, startedAt), me), { id: `${optimisticId}-assistant`, role: 'assistant', content: [], status: { type: 'running' } }]); }
    try {
      if (target.draft) {
        try {
          await api('/v1/threads', { id: target.id, title: DEFAULT_TITLE });
          await refreshThreads();
          setCurrent({ id: target.id, draft: false }); currentRef.current = { id: target.id, draft: false };
          localStorage.setItem(SAVED_THREAD, target.id); lastRun.current = null;
        } catch (e) {
          setMessages(base); setRunning(false);
          toast(errorCode(e) === 'capacity_reached' ? 'The local server has reached its conversation limit.' : 'Couldn’t start a new conversation. Your message is back in the box — try again.', { tone: 'error' });
          // Nothing reached the agent: return the text and images to the composer.
          throw new MessageNotSentError();
        }
      }
      try { await api('/v1/runs', { id, threadId: target.id, text, parentRunId: lastRun.current, ...(wire.length ? { images: wire } : {}), ...(uploads.length ? { files: uploads.map(upload => upload.id) } : {}) }); }
      catch (e) {
        const code = errorCode(e);
        const rejected = imageRejection(code) ?? (code in fileMessages && code !== 'payload_too_large' ? fileMessage(code) : undefined);
        if (rejected || code === 'queue_full') {
          // Validated and refused before delivery: safe to hand the draft back.
          if (queueing) setQueue(list => list.filter(item => item.id !== id)); else { setMessages(base); setRunning(false); }
          toast(rejected ?? 'This conversation already has 10 messages waiting. Try again when some have been sent.', { tone: 'error' });
          throw new MessageNotSentError();
        }
        if (queueing) setQueue(list => list.filter(item => item.id !== id)); else setRunning(false);
        setBlocked(`Couldn’t confirm that your message was delivered (${code}). Refresh before doing anything else — it won’t be resent automatically.`);
        return;
      }
      if (first) void autoTitle(target.id, text.trim() ? text : uploads[0]?.name ?? 'Image');
      if (queueing) { operation.current = false; void refreshView().catch(() => {}); return; }
      if (team) operation.current = false;
      await watch(id, text, base, startedAt, urls, files, me);
    } finally { operation.current = false; }
  }
  /**
   * Paste: images attach (screenshots, copied image files); plain or rich text
   * pastes as text, as before. Handled here instead of assistant-ui's
   * default, which would also attach the snapshot image that Office-style
   * apps put next to copied text.
   */
  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const data = event.clipboardData;
    const files = Array.from(data.files);
    if (!pasteAttaches({ types: [...data.types], text: data.getData('text/plain'), files })) return;
    event.preventDefault();
    for (const file of files) void runtime.thread.composer.addAttachment(file).catch(() => { /* reported by AttachmentErrors */ });
  }
  async function cancel() {
    if (!liveRun.current || !mayAct) return;
    try { await api(`/v1/runs/${liveRun.current}/cancel`, {}); } catch (e) { toast(errorCode(e) === 'not_your_turn' ? 'Only the person who sent this message, or an admin, can stop it.' : 'Couldn’t reach the server to stop the reply.', { tone: 'error' }); }
  }
  /** Team mode: take a waiting message back before it is sent (its author or an admin). */
  async function withdraw(turn: QueuedTurn) {
    try { await api(`/v1/runs/${turn.id}/cancel`, {}); setQueue(list => list.filter(item => item.id !== turn.id)); void refreshView().catch(() => {}); }
    catch (e) { toast(errorCode(e) === 'not_your_turn' ? 'Only its author or an admin can withdraw that message.' : 'Couldn’t withdraw that message.', { tone: 'error' }); }
  }

  const adapterThreads = useMemo<ExternalStoreThreadData<'regular'>[]>(() => active.map(t => ({ status: 'regular', id: t.id, title: t.title, custom: { state: t.state, running: !!t.running, queued: t.queued ?? 0 } })), [active]);
  const adapterArchived = useMemo<ExternalStoreThreadData<'archived'>[]>(() => archived.map(t => ({ status: 'archived', id: t.id, title: t.title, custom: { state: t.state } })), [archived]);
  const readOnly = !!selected?.archived;
  const runtimeRef = useRef<AssistantRuntime | undefined>(undefined);
  const attachments = useMemo(() => new FileAttachmentAdapter(() => runtimeRef.current?.thread.composer.getState().attachments ?? [], filesEnabled ? uploadFile : undefined), [filesEnabled]);
  // Sent files download from where they are now in the resources (the server follows moves and renames).
  const fileLink = useCallback((name: string) => current.draft ? undefined : apiPath(`/v1/threads/${encodeURIComponent(current.id)}/files/${encodeURIComponent(name)}`), [current]);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    // Team mode: the composer stays usable during a reply (messages queue), so the runtime is never "running" for assistant-ui.
    messages, convertMessage: m => m, isRunning: team ? false : running, isLoading: loading,
    isDisabled: loading || !!blocked || readOnly || (!current.draft && selected?.state !== 'ready'),
    onNew: send, onCancel: cancel, unstable_enableToolInvocations: false,
    adapters: { attachments, threadList: {
      threadId: current.id, isLoading: listLoading, threads: adapterThreads, archivedThreads: adapterArchived,
      onSwitchToThread: id => select(id), onSwitchToNewThread: () => startDraft(),
      onRename: (id, title) => rename(id, title), onArchive: id => archive(id), onUnarchive: id => restore(id),
    } },
  });
  runtimeRef.current = runtime;

  // Global shortcuts: ⌘K new chat, ⌘/ search, Esc stops a reply when nothing else handles it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); startDraft(); return; }
      if (mod && !event.altKey && event.key === '/') { event.preventDefault(); if (narrow) setDrawer(true); else setLayout(l => ({ ...l, sidebar: true })); requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); }); return; }
      // ⌘B / Ctrl+B: show or hide the conversations sidebar. ⌘⇧E / Ctrl+Shift+E: the Resources panel.
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar(); return; }
      if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e') { event.preventDefault(); toggleResources(); return; }
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (document.querySelector('[role="menu"], [role="dialog"]')) return;
        if (drawer) { setDrawer(false); return; }
        if (narrow && resourcesDrawer) { setResourcesDrawer(false); return; }
        const target = event.target as HTMLElement | null;
        if (!running || !mayAct || target?.closest('.dock, input, .composer')) return;
        event.preventDefault(); void cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => { document.title = selected ? `${titleText(selected.title)} · ${agent.name}` : agent.name; }, [selected, agent.name]);
  useEffect(() => { if (!membersOpen) return; setDrawer(false); }, [membersOpen]);

  const title = current.draft ? 'New chat' : selected?.title ?? '';
  const agentLatex = agent.ui?.latex;
  const latex = resolveLatex(agentLatex, current.draft ? undefined : selected?.latex);
  const answer = async (value: InteractionResponse) => {
    // Exactly one POST per request; the card locks before this runs and never retries.
    await api(`/v1/runs/${currentInteraction.current?.runId}/answer`, value);
    setSentAnswer(value);
  };
  // Team mode: someone else's approval or question is shown, but only they (or an admin) can answer it.
  const waitingFor = team && !mayAct ? liveAuthor?.name ?? 'the person who sent it' : undefined;
  return <InteractionContext.Provider value={{ request: interaction, outcome: interactionOutcome, sent: sentAnswer, approvalTools, answer, ...(waitingFor ? { waitingFor } : {}) }}>
    <AuthorContext.Provider value={team?.user.id}>
    <FileLinkContext.Provider value={fileLink}>
    <LatexContext.Provider value={latex}>
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="layout" data-drawer={drawer || undefined} data-resources-drawer={(narrow && resourcesDrawer) || undefined} data-sidebar-collapsed={(!narrow && !layout.sidebar) || undefined} data-resources-open={(!narrow && layout.resources && filesEnabled) || undefined}
        data-loading={loading || listLoading || undefined} data-running={running || undefined} style={{ '--resources-width': `${layout.resourcesWidth}px` } as React.CSSProperties}>
        <aside id="sidebar" className="sidebar" aria-label="Sidebar" inert={!narrow && !layout.sidebar ? true : undefined}>
          <Sidebar active={active} archived={archived} times={times} query={query} onQuery={setQuery} searchRef={searchRef} busy={busy} runningId={team ? undefined : liveThread} archivingIds={archiving} isDraft={current.draft} onClose={() => setDrawer(false)} onCollapse={() => setLayout(l => ({ ...l, sidebar: false }))} agent={agent} versions={versions}
            agentLatex={resolveLatex(agentLatex, 'inherit')} onLatex={(id, value) => void setLatex(id, value)}
            {...(team ? { brand: <AgentSwitcher agents={team.agents} current={agent} onSwitch={team.onSwitch} onMembers={() => setMembersOpen(true)}/>, footer: <CurrentUser user={team.user} role={agent.role}/> } : {})}/>
        </aside>
        <div className="scrim" aria-hidden="true" onClick={() => { setDrawer(false); setResourcesDrawer(false); }}/>
        <main className="main">
          <header className="topbar">
            <button type="button" className="icon-btn menu-btn" aria-label="Open sidebar" aria-controls="sidebar" aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={18}/></button>
            {!narrow && !layout.sidebar && <>
              <button type="button" className="icon-btn" aria-label="Show sidebar" aria-controls="sidebar" aria-expanded="false" title="Show sidebar (⌘B)" onClick={toggleSidebar}><PanelLeftOpen size={18}/></button>
              <button type="button" className="icon-btn" aria-label="New chat" title="New chat (⌘K)" disabled={busy} onClick={startDraft}><SquarePen size={18}/></button>
            </>}
            <h1 className="topbar-title" title={titleText(title)}><TitleView title={title}/></h1>
            {!current.draft && selected?.state === 'ready' && <LatexMenu value={selected.latex ?? 'inherit'} agentDefault={resolveLatex(agentLatex, 'inherit')} onChange={value => void setLatex(selected.id, value)}/>}
            {filesEnabled && <button type="button" className="icon-btn resources-btn" aria-label={resourcesOpen ? 'Hide resources' : 'Show resources'} aria-controls="resources" aria-expanded={resourcesOpen} data-active={resourcesOpen || undefined} title={`Resources (${navigator.platform.startsWith('Mac') ? '⌘⇧E' : 'Ctrl+Shift+E'})`} onClick={toggleResources}><FolderTree size={18}/></button>}
            <button type="button" className="icon-btn menu-btn" aria-label="New chat" disabled={busy} onClick={startDraft}><SquarePen size={18}/></button>
          </header>
          <ThreadPrimitive.Root className="thread">
            <ThreadPrimitive.Viewport className="viewport">
              <div className="column">
                {!messages.length && (loading
                  ? <div className="welcome"><p className="muted" role="status">Loading conversation…</p></div>
                  : <div className="welcome">
                      <h2>{readOnly ? 'This archived conversation is empty' : 'What’s on your mind?'}</h2>
                      {!readOnly && !blocked && <Starters/>}
                    </div>)}
                <ThreadPrimitive.Messages components={{ Message }}/>
              </div>
              <ThreadPrimitive.ViewportFooter className="footer">
                <div className="column footer-column">
                  <ThreadPrimitive.ScrollToBottom className="jump" aria-label="Jump to latest"><ArrowDown size={14} aria-hidden="true"/>Jump to latest</ThreadPrimitive.ScrollToBottom>
                  <InteractionDock onDismiss={() => { setInteraction(undefined); setInteractionOutcome(''); focusComposer(); }}/>
                  {team && <QueueList queue={queue} me={team.user.id} canWithdraw={turn => isAdmin || turn.author?.id === team.user.id} onWithdraw={turn => void withdraw(turn)}/>}
                  {blocked && <div className="notice" role="status"><TriangleAlert size={16} aria-hidden="true"/><span>{blocked}</span><button type="button" className="btn small" disabled={running} onClick={startDraft}>New chat</button></div>}
                  {readOnly
                    ? <div className="readonly-bar"><span>This conversation is archived and read-only.</span><button type="button" className="btn primary small" onClick={() => void restore(current.id)}><ArchiveRestore size={15} aria-hidden="true"/>Restore</button></div>
                    : <ComposerPrimitive.Root className="composer" data-disabled={(!!blocked || loading) || undefined}>
                        <ComposerPrimitive.AttachmentDropzone className="dropzone" disabled={!!blocked || loading}>
                          <ComposerImages fileInfo={id => attachments.uploaded(id)}/>
                          <div className="composer-row">
                            <ComposerPrimitive.AddAttachment className="icon-btn attach-btn" aria-label={filesEnabled ? 'Attach files' : 'Attach images'} title={filesEnabled ? `Attach files: PDF, text, CSV, code (up to ${FILE_LIMITS.maxFileBytes / 1024 / 1024} MB) or images · or paste / drop` : `Attach images (up to ${IMAGE_LIMITS.maxImages}) · or paste / drop`} disabled={!!blocked || loading}><Paperclip size={18} aria-hidden="true"/></ComposerPrimitive.AddAttachment>
                            <ComposerPrimitive.Input ref={composerRef} className="composer-input" aria-label="Message" rows={1} maxRows={10} maxLength={8000} autoFocus
                              addAttachmentOnPaste={false} onPaste={onPaste}
                              onKeyDown={event => { if (!team && event.key === 'Enter' && !event.shiftKey && running && !event.nativeEvent.isComposing) event.preventDefault(); }}
                              placeholder={blocked ? 'Start a new chat to continue' : team && running ? (narrow ? 'Queue a message' : `Message ${agent.name} · sent when this reply finishes`) : `Message ${agent.name}`}/>
                            {team
                              ? <>
                                  {running && mayAct && <button type="button" className="send-btn stop" aria-label="Stop generating" title="Stop (Esc)" onClick={() => void cancel()}><Square size={14} fill="currentColor" aria-hidden="true"/></button>}
                                  <ComposerPrimitive.Send className="send-btn" aria-label={running ? 'Queue message' : 'Send message'} title={running ? 'Queue (Enter): sent when this reply finishes' : 'Send (Enter)'}><ArrowUp size={18} aria-hidden="true"/></ComposerPrimitive.Send>
                                </>
                              : running
                                ? <ComposerPrimitive.Cancel className="send-btn stop" aria-label="Stop generating" title="Stop (Esc)"><Square size={14} fill="currentColor" aria-hidden="true"/></ComposerPrimitive.Cancel>
                                : <ComposerPrimitive.Send className="send-btn" aria-label="Send message" title="Send (Enter)"><ArrowUp size={18} aria-hidden="true"/></ComposerPrimitive.Send>}
                          </div>
                          <div className="drop-overlay" aria-hidden="true">{filesEnabled ? 'Drop files to attach' : 'Drop images to attach'}</div>
                        </ComposerPrimitive.AttachmentDropzone>
                        <AttachmentErrors files={filesEnabled}/>
                      </ComposerPrimitive.Root>}
                  {!readOnly && !blocked && <p className="hint-line" aria-hidden="true">{team && running ? `Enter to queue · Shift+Enter for a new line${mayAct ? ' · Esc to stop' : ''}` : `Enter to send · Shift+Enter for a new line${running ? ' · Esc to stop' : ''}`}</p>}
                </div>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </main>
        {filesEnabled && <aside id="resources" className="resources-pane" aria-label="Resources" hidden={!resourcesOpen}>
          {!narrow && <Resizer width={layout.resourcesWidth} onWidth={width => setLayout(l => ({ ...l, resourcesWidth: width }))}/>}
          <ResourcesPanel visible={resourcesOpen} threadId={current.draft ? undefined : current.id} refreshKey={turns} onClose={() => { if (narrow) setResourcesDrawer(false); else setLayout(l => ({ ...l, resources: false })); }}
            onOpenThread={id => { if (narrow) setResourcesDrawer(false); void select(id); }}
            onThreadChanged={updated => setThreads(list => list.map(t => t.id === updated.id ? { ...t, ...updated } : t))}/>
        </aside>}
        {membersOpen && team && <MembersDialog agent={agent} onClose={() => setMembersOpen(false)}/>}
      </div>
    </AssistantRuntimeProvider>
    </LatexContext.Provider>
    </FileLinkContext.Provider>
    </AuthorContext.Provider>
  </InteractionContext.Provider>;
}

/** Drag handle on the Resources panel's left edge; arrow keys resize too. The width is kept between visits. */
function Resizer({ width, onWidth }: { width: number; onWidth(width: number): void }) {
  const start = useRef<{ x: number; width: number } | undefined>(undefined);
  return <div className="resizer" role="separator" aria-orientation="vertical" aria-label="Resize resources" aria-valuemin={RESOURCES_WIDTH.min} aria-valuemax={RESOURCES_WIDTH.max} aria-valuenow={width} tabIndex={0}
    onPointerDown={event => { event.preventDefault(); (event.target as Element).setPointerCapture(event.pointerId); start.current = { x: event.clientX, width }; document.body.dataset.resizing = ''; }}
    onPointerMove={event => { if (start.current) onWidth(clampWidth(start.current.width + start.current.x - event.clientX)); }}
    onPointerUp={() => { start.current = undefined; delete document.body.dataset.resizing; }}
    onDoubleClick={() => onWidth(320)}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onWidth(clampWidth(width + (event.key === 'ArrowLeft' ? 24 : -24))); } }}/>;
}

/** Fixed server codes that mean "refused before delivery" for images, with their toast text. */
function imageRejection(code: string): string | undefined {
  return ({ image_unsupported_type: attachmentMessages.unsupported, image_invalid: attachmentMessages.unreadable, image_remote_url: attachmentMessages.unsupported,
    image_too_large: attachmentMessages.tooLarge, images_too_many: attachmentMessages.tooMany, images_too_large: attachmentMessages.totalTooLarge, payload_too_large: attachmentMessages.totalTooLarge } as Record<string, string>)[code];
}

/** Attachment problems (wrong type, too large, too many) become the usual error toasts. */
function AttachmentErrors(accepts: { files: boolean }) {
  const toast = useToast();
  useAuiEvent('composer.attachmentAddError', ({ reason, error, message }: { reason: string; error?: Error; message: string }) => {
    toast(error instanceof AttachmentError ? error.message : reason === 'not-accepted' ? (accepts.files ? fileMessages.file_unsupported_type! : attachmentMessages.unsupported) : message || attachmentMessages.unreadable, { tone: 'error' });
  });
  return null;
}

createRoot(document.getElementById('root')!).render(<ToastProvider><LightboxProvider><Root/></LightboxProvider></ToastProvider>);
