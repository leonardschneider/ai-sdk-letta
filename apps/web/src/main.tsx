import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantRuntimeProvider, ComposerPrimitive, type AssistantRuntime, MessageNotSentError, ThreadPrimitive, useAuiEvent, useExternalStoreRuntime, type AppendMessage, type ExternalStoreThreadData, type ThreadMessageLike } from '@assistant-ui/react';
import { AppWindow, ArchiveRestore, ArrowDown, ArrowUp, Blocks, FolderTree, Menu, PanelLeftOpen, Paperclip, Square, SquarePen, TriangleAlert, X } from 'lucide-react';
import { AgentSwitcher, CurrentUser, MembersDialog, NoAccess, QueueList, TypingLine, type QueuedTurn } from './team.js';
import { ReplyModeMenu } from './reply-mode-menu.js';
import { AddAgentDialog, InstructionsDialog, LocalAgentSwitcher, ProjectDialog, RemoveAgentDialog, ToolsDialog } from './adoption.js';
import { insertMention, mentionMatches, mentionName, mentionQuery } from './mentions.js';
import type { ReplyModeOverride } from 'ai-sdk-letta/listening';
import type { UIMessage } from 'ai';
import type { RuntimeEvent } from '@ai-sdk-letta/server';
import type { InteractionRequest, InteractionResponse } from 'ai-sdk-letta';
import { historyMessages, markListened, observedParts, userContent, withAuthor, withDecision, withRun, withSource, withoutListened, withTime, type FileChip, type MessageSource } from './messages.js';
import { ClaimCard, DecisionBell, DecisionsContext, MemoryReviewCard, NoticeCard, PendingDecisionBar, useDecisionFeed, type DecisionsState } from './decisions.js';
import { MemoryDialog, MemoryRow, useMemoryToasts } from './memory.js';
import { decideError, mayReview, type DecisionOutcome, type DecisionView, type FeedDecision } from './decisions-model.js';
import { AutomationsDialog, AutomationsRow } from './automations.js';
import { api, apiPath, errorCode, metadataError, setAgentBase, setCsrf, setCsrfHeader, uploadFile, uuid, type AgentInfo, type Person, type Session } from './api.js';
import { activityTimes, DEFAULT_TITLE, deriveTitle, isDefaultTitle, nextAfterArchive, sortThreads, type ThreadSummary } from './thread-model.js';
import { Sidebar } from './sidebar.js';
import type { Versions } from './versions.js';
import { TitleView } from './title.js';
import { titleText } from 'ai-sdk-letta/title';
import { AuthorContext, InteractionContext, InteractionDock, Message } from './chat.js';
import { RewindContext, RewindDialog, type RewindState } from './rewind.js';
import { rewindError, type RewindSummary } from './rewind-model.js';
import { LatexContext } from './markdown.js';
import { resolveLatex, type LatexOverride } from './latex.js';
import { LatexMenu } from './latex-menu.js';
import { TrustMenu } from './trust-menu.js';
import { checkSummary, isLocked, lockedNotice, stoppedLine, type CheckResult } from './turn-state.js';
import type { TrustOverride } from './memory-model.js';
import { ToastProvider, useToast } from './toasts.js';
import { Starters } from './starters.js';
import { ResourcesPanel } from './resources.js';
import { PreviewPanel, usePreviewStatus } from './preview.js';
import { PREVIEW_LAYOUT_KEY, devServerRunning, readPreviewLayout, type PreviewLayout } from './preview-model.js';
import { AtlassianDialog, AtlassianRow, useAtlassianStatus } from './integrations.js';
import { LAYOUT_KEY, readLayout, type Layout } from './resources-model.js';
import { SIDE_PANEL_KEY, SIDE_WIDTH, activeTab, announce, appTab, appTabId, appsOf, clampSideWidth, closeApp, close as closeSide, hasApp, isShown, openApp, readSidePanel, select as selectSide, tabKey, toggle as toggleSide, visibleTabs, type Announced, type SidePanel, type SideTab } from './side-panel-model.js';
import { AttachmentError, FILE_LIMITS, FileAttachmentAdapter, IMAGE_LIMITS, base64Bytes, checkBudget, dataUrlToImage, fileDetail, fileMessage, fileMessages, messages as attachmentMessages, pasteAttaches, type FileInfo } from './attachments.js';
import { ComposerImages, FileLinkContext, LightboxProvider } from './images.js';
import { AppApprovalCards, AppOverlay, AppPanel, AppsContext, AppsDialog, AppsRow, useAppApprovals, useViewTools, type AppsState } from './apps.js';
import { appToolLabel } from './apps-model.js';
import './style.css';
import './markdown.css';

type LiveFile = { name: string; label: string; bytes: number; kind: FileInfo['kind']; pages?: number; lines?: number };
type Author = Person & { id: string };
/** Other messages delivered with a live turn (queued messages sent together), in order. */
type BatchMember = { id: string; input: string; author?: Author };
type View = { messages: UIMessage[]; lastRunId: string | null; live: null | { id: string; input: string; images?: number; files?: LiveFile[]; author?: Author; source?: MessageSource; startedAt?: string; batch?: BatchMember[]; decision?: DecisionOutcome }; status: string | null; queue?: QueuedTurn[]; stopped?: { runId: string; code: string }; code?: string; usable?: boolean };
/** Whether the quiet "Listened" lines are shown (kept per browser). */
const SHOW_LISTENED = 'ai-sdk-letta-show-listened';
/** How often the browser repeats "I am typing" while you type (the server forgets it after about 5 seconds). */
const TYPING_HEARTBEAT_MS = 1500;
/** Team mode: who you are, your role in this agent, and the other agents you can switch to. */
type Team = { user: Author; agents: AgentInfo[]; onSwitch(id: string): void };
const chip = (file: Pick<FileInfo, 'name' | 'kind' | 'label' | 'bytes' | 'pages' | 'lines'>): FileChip => ({ name: file.name, kind: file.kind, detail: fileDetail(file) });
type Current = { id: string; draft: boolean };
const SAVED = 'ai-sdk-letta-thread';
const newDraft = (): Current => ({ id: uuid(), draft: true });

/**
 * Loads the session, then shows the app for one agent: the only one of the
 * single-user app, or the one chosen in a team server (switching agents
 * remounts the app, so nothing of one agent leaks into another).
 */
function Root() {
  const [session, setSession] = useState<Session>();
  const [failed, setFailed] = useState(false);
  const [agentId, setAgentId] = useState<string>();
  const load = useCallback(async (prefer?: string) => {
    try {
      const loaded = await api<Session>('/session');
      if (loaded.csrf) setCsrf(loaded.csrf);
      if (loaded.mode === 'team') {
        const saved = localStorage.getItem(AGENT_SAVED);
        const chosen = loaded.agents.find(a => a.id === saved) ?? loaded.agents[0];
        setAgentBase(chosen?.id); setAgentId(chosen?.id);
      } else if (loaded.adoption) {
        // Single-user app with adopted agents: the app's own agent lives at /api, adopted ones at /api/agents/<id>.
        const wanted = prefer ?? localStorage.getItem(AGENT_SAVED);
        const chosen = loaded.agents?.find(a => a.id === wanted);
        if (prefer) localStorage.setItem(AGENT_SAVED, prefer);
        setAgentBase(chosen?.id); setAgentId(chosen?.id ?? loaded.agent.id);
      }
      setSession(loaded);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const onSwitch = useCallback((id: string) => { localStorage.setItem(AGENT_SAVED, id); setAgentBase(id); setAgentId(id); }, []);
  if (failed) return <App agent={{ id: '', name: 'ai-sdk-letta', approvalTools: [] }} unreachable/>;
  if (!session) return <App agent={{ id: '', name: 'Connecting…', approvalTools: [] }} connecting/>;
  if (session.mode !== 'team' && session.adoption) {
    const agents = [session.agent, ...(session.agents ?? [])];
    const agent = agents.find(a => a.id === agentId) ?? session.agent;
    const local: Local = { agents, onSwitch: id => { setAgentBase(id === session.agent.id ? undefined : id); localStorage.setItem(AGENT_SAVED, id); setAgentId(id); }, reload: id => void load(id ?? session.agent.id) };
    return <App key={agent.id} agent={agent} versions={session.versions} local={local}/>;
  }
  if (session.mode !== 'team') return <App agent={session.agent} versions={session.versions}/>;
  const agent = session.agents.find(a => a.id === agentId);
  if (!agent || !session.user.id) return <NoAccess user={session.user}/>;
  return <App key={agent.id} agent={agent} versions={session.versions} team={{ user: session.user as Author, agents: session.agents, onSwitch }}/>;
}
const AGENT_SAVED = 'ai-sdk-letta-agent';
/** Single-user app with adopted agents: the agents to switch between, and reloading the session after one is added or removed. */
type Local = { agents: AgentInfo[]; onSwitch(id: string): void; reload(select?: string): void };

function App({ agent, versions, team, local, connecting, unreachable }: { agent: AgentInfo; versions?: Versions; team?: Team; local?: Local; connecting?: boolean; unreachable?: boolean }) {
  const toast = useToast();
  const approvalTools = useMemo(() => new Set(agent.approvalTools), [agent.approvalTools]);
  const filesEnabled = !!agent.files;
  // The Resources panel: files, or documents saved by integrations (Atlassian) without attachments.
  // An agent with a project folder (mounted at /project) shows it there too, read-only.
  const resourcesEnabled = filesEnabled || !!agent.resources || !!agent.project;
  const atlassianEnabled = !!agent.integrations?.includes('atlassian');
  const [atlassianOpen, setAtlassianOpen] = useState(false);
  // Team mode: the last thread is remembered per agent.
  const SAVED_THREAD = team || agent.adopted ? `${SAVED}:${agent.id}` : SAVED;
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [removing, setRemoving] = useState<AgentInfo>();
  const [instructionsOf, setInstructionsOf] = useState<AgentInfo>();
  const [projectOf, setProjectOf] = useState<AgentInfo>();
  const [toolsOf, setToolsOf] = useState<AgentInfo>();
  const isAdmin = agent.role === 'admin';
  const [queue, setQueue] = useState<QueuedTurn[]>([]);
  const [liveAuthor, setLiveAuthor] = useState<Author>();
  const [membersOpen, setMembersOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  // Automations (n8n, Conductor, scripts) start turns too: the app follows changes it did not make, also when one person uses it.
  // Decisions: their outcomes start turns too (someone decides, the work resumes).
  const decisionsEnabled = team ? team.agents.some(a => a.decisions) : local ? local.agents.some(a => a.decisions) : !!agent.decisions;
  // Memory review (Jiminy): the Memory view, toasts when a change is reverted, and held changes as decisions.
  const memoryEnabled = !!agent.memory;
  const [memoryOpen, setMemoryOpen] = useState(false);
  const follow = !!team || !!agent.automations || !!agent.decisions || memoryEnabled || !!agent.apps;
  const mayManageAutomations = !!agent.automations && (!team || agent.role === 'admin');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [listLoading, setListLoading] = useState(!unreachable);
  const [current, setCurrent] = useState<Current>(newDraft);
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(!unreachable);
  const [blocked, setBlocked] = useState('');
  // The read-only notice offers "Check and unlock" (the last turn's outcome is uncertain, not a local error).
  const [checkable, setCheckable] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState('');
  // A stopped reply (Stop or a turn limit): marked under the reply; the conversation stays usable.
  const [stoppedNote, setStoppedNote] = useState<{ runId: string; text: string }>();
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
  // The right side panel: one column with tabs (Resources, Preview, the conversation's app views). One width and open state (persisted);
  // on a phone it is a drawer like the sidebar (never persisted open).
  const webDevEnabled = !!agent.webDev;
  const appsEnabled = !!agent.apps;
  const [side, setSideState] = useState<SidePanel>(() => readSidePanel(localStorage.getItem(SIDE_PANEL_KEY), { layout: localStorage.getItem(LAYOUT_KEY), preview: localStorage.getItem(PREVIEW_LAYOUT_KEY) }));
  const setSide = useCallback((update: (previous: SidePanel) => SidePanel) => setSideState(previous => { const next = update(previous); if (next !== previous) localStorage.setItem(SIDE_PANEL_KEY, JSON.stringify(next)); return next; }), []);
  const [sideDrawer, setSideDrawer] = useState(false);
  const sideContext = { ...(current.draft ? {} : { threadId: current.id }), resources: resourcesEnabled, preview: webDevEnabled, apps: appsEnabled };
  const sideView: SidePanel = narrow ? { ...side, open: sideDrawer } : side;
  const sideTabs = visibleTabs(sideView, sideContext);
  const sideTab = activeTab(sideView, sideContext);
  const sideOpen = isShown(sideView, sideContext);
  const resourcesOpen = sideOpen && sideTab === 'resources';
  const previewOpen = sideOpen && sideTab === 'preview';
  // Every change goes through the model; on a phone "open" is the drawer (and opening it closes the sidebar drawer).
  const updateSide = (update: (previous: SidePanel) => SidePanel) => {
    if (!narrow) { setSide(update); return; }
    const next = update(sideView);
    setSide(previous => ({ ...next, open: previous.open }));
    setSideDrawer(next.open);
    if (next.open) setDrawer(false);
  };
  const toggleSidebar = useCallback(() => { if (narrow) { setSideDrawer(false); setDrawer(open => !open); } else setLayout(l => ({ ...l, sidebar: !l.sidebar })); }, [narrow, setLayout]);
  const toggleTab = (tab: SideTab) => updateSide(s => toggleSide(s, tab, sideContext));
  const toggleResources = () => toggleTab('resources');
  // Web app development: the Preview tab. It opens by itself when a dev server starts. Its device toggle is kept here.
  const [previewLayout, setPreviewLayoutState] = useState<PreviewLayout>(() => readPreviewLayout(localStorage.getItem(PREVIEW_LAYOUT_KEY)));
  const setPreviewLayout = useCallback((update: (previous: PreviewLayout) => PreviewLayout) => setPreviewLayoutState(previous => { const next = update(previous); localStorage.setItem(PREVIEW_LAYOUT_KEY, JSON.stringify(next)); return next; }), []);
  const [turns, setTurns] = useState(0);
  const [archives, setArchives] = useState(0);
  // Bumped whenever the server reports a change (long poll): memory reviews and toasts follow it.
  const [serverChanges, setServerChanges] = useState(0);
  const memoryPending = useMemoryToasts(memoryEnabled && !connecting && !unreachable, serverChanges + turns);
  // While a turn runs (or the pane is open) the status is polled, so a dev server started mid-turn shows up.
  const [previewStatus, reloadPreview] = usePreviewStatus(current.draft ? undefined : current.id, webDevEnabled && !connecting && !unreachable, serverChanges + turns, webDevEnabled && (previewOpen || running));
  // A dev server that starts (or restarts) in the open conversation opens the Preview tab, once per start; closing it again is respected.
  // The first status of a conversation is only remembered: opening a conversation whose server still runs does not pop the panel open.
  const announced = useRef<Announced>({});
  useEffect(() => {
    if (!previewStatus || current.draft) return;
    const { next, open } = announce(announced.current, current.id, devServerRunning(previewStatus) ? previewStatus.devServer.startedAt : undefined);
    announced.current = next;
    if (open) updateSide(s => selectSide(s, 'preview'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewStatus]);
  const [atlassianStatus, setAtlassianStatus] = useAtlassianStatus(atlassianEnabled, turns);
  // MCP Apps: tool lines of app tools show their views; one can open in the right panel, or full screen / picture-in-picture.
  const [appsOpen, setAppsOpen] = useState(false);
  const [appOverlay, setAppOverlay] = useState<AppsState['overlay']>();
  const appTabs = appsEnabled ? appsOf(side, current.draft ? undefined : current.id) : [];
  const [appsVersion, setAppsVersion] = useState(0);
  const { viewTools, generations: devGenerations } = useViewTools(appsEnabled && !connecting && !unreachable, serverChanges + turns + appsVersion);
  const [appApprovals, refreshAppApprovals] = useAppApprovals(current.draft ? undefined : current.id, appsEnabled && !connecting && !unreachable, serverChanges + turns);
  useEffect(() => { setAppOverlay(undefined); }, [current.id]);
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

  async function watch(id: string, input: string, base: ThreadMessageLike[], startedAt?: string, images: readonly string[] = [], files: readonly FileChip[] = [], author?: Author, batch: readonly BatchMember[] = [], source?: MessageSource, decision?: DecisionOutcome) {
    stream.current?.abort(); const control = new AbortController(); stream.current = control;
    liveRun.current = id; setRunning(true); setLiveThread(currentRef.current.id); setLiveAuthor(author);
    const events: RuntimeEvent[] = [];
    let ended = false;
    let endedAt: string | undefined;
    let members = [...batch];
    // A combined turn shows each of its messages as its own bubble, with its author, then the one reply.
    const render = () => setMessages([...base,
      withRun(withDecision(withSource(withAuthor(withTime({ id: `${id}-user`, role: 'user', content: userContent(input, images, files) }, startedAt), author), source), decision), id),
      ...members.map(member => withAuthor(withTime({ id: `${member.id}-user`, role: 'user', content: userContent(member.input) }, startedAt), member.author)),
      markListened(withTime({ id: `${id}-assistant`, role: 'assistant', content: observedParts(events), status: ended ? events.at(-1)?.type === 'failed' ? { type: 'incomplete', reason: events.at(-1)?.data.code === 'cancelled' ? 'cancelled' : 'error' } : events.at(-1)?.type === 'stopped' ? { type: 'incomplete', reason: 'cancelled' } : { type: 'complete', reason: 'stop' } : { type: 'running' } }, endedAt))]);
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
          // This message was sent together with others as one turn: show that turn instead.
          if (team && event.type === 'started' && typeof event.data.batchOf === 'string') { control.abort(); liveRun.current = undefined; void refreshView().catch(() => {}); return; }
          // This message leads a combined turn: fetch the other messages sent with it, to show them as their own bubbles.
          if (team && event.type === 'started' && Array.isArray(event.data.batch) && event.data.batch.length > 1 && !members.length) {
            void api<View>(`/v1/threads/${currentRef.current.id}/view`).then(view => { if (view.live?.id === id && view.live.batch && stream.current === control) { members = view.live.batch; render(); } }).catch(() => {});
          }
          events.push(event);
          if (event.type === 'interaction') {
            const request = event.data as InteractionRequest;
            currentInteraction.current = { id: request.id, runId: id, resolved: false };
            setInteraction(request); setInteractionOutcome('');
          }
          if (['interaction_resolved', 'interaction_ended'].includes(event.type) && currentInteraction.current?.runId === id && currentInteraction.current.id === event.data.id) {
            currentInteraction.current.resolved = true;
            setInteractionOutcome(event.type === 'interaction_resolved' ? 'Response received. Waiting for the agent…' : event.data.code === 'expired' ? 'Not reviewed in time: it now waits for review in this conversation (and the bell).' : event.data.code === 'timed_out' ? 'This question timed out. Your response was not submitted.' : event.data.code === 'cancelled' ? 'This question was cancelled. Your response was not submitted.' : 'This question ended before an answer was confirmed. Do not resend this turn.');
          }
          if (event.type === 'completed' || event.type === 'failed' || event.type === 'stopped') {
            ended = true; endedAt = new Date().toISOString(); lastRun.current = id;
            if (currentInteraction.current?.runId === id) {
              const answered = currentInteraction.current.resolved;
              setInteractionOutcome(previous => answered ? previous === 'Response received. Waiting for the agent…' ? event.type === 'completed' ? 'Response received. The agent has finished.' : event.type === 'stopped' ? 'Response received; the reply was then stopped.' : 'Response received, but the agent could not finish. Do not resend.' : previous : event.type === 'stopped' ? 'The reply was stopped before this was answered.' : 'This question closed before an answer was confirmed. Do not resend this turn.');
              currentInteraction.current.resolved = true;
            }
            // A stopped reply (Stop, or a turn limit) with a known outcome: marked as stopped; the conversation stays usable.
            if (event.type === 'stopped') setStoppedNote({ runId: id, text: stoppedLine(event.data.code) });
            // Team mode: the conversation's state (read-only or not) comes from the view refreshed when this ends.
            if (event.type === 'failed' && !team) { setBlocked(lockedNotice(String(event.data.code))); setCheckable(true); }
          }
          render();
        }
      }
      if (!ended) throw new Error('Stream disconnected. Refresh to reconnect without replaying the turn.');
    } catch (e) { if (!control.signal.aborted) { setBlocked(`${e instanceof Error ? e.message : String(e)}`); setCheckable(false); } }
    finally {
      setTurns(n => n + 1);
      if (stream.current === control) {
        setRunning(false);
        if (ended) { liveRun.current = undefined; setLiveThread(undefined); setLiveAuthor(undefined); }
        void refreshThreads().catch(() => {});
        // Team mode (and automations): show the finished turn from history, and the next queued one if it started.
        if (follow && ended) void refreshView().catch(() => {});
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
    if (!follow || target.draft || operation.current || viewing.current) return;
    viewing.current = true;
    try {
      // A single-user server reads one conversation at a time: wait briefly if another read holds it (never an error to show).
      let view: View | undefined;
      for (let attempt = 0; !view; attempt++) {
        try { view = await api<View>(`/v1/threads/${target.id}/view`); }
        catch (e) { if (errorCode(e) !== 'runtime_busy' || attempt >= 5) throw e; await new Promise(r => setTimeout(r, 300 * (attempt + 1))); }
      }
      if (currentRef.current.id !== target.id) return;
      void loadDecisions(target.id);
      setQueue(view.queue ?? []);
      if (view.live && liveRun.current === view.live.id) return;
      lastRun.current = view.lastRunId;
      const base = historyMessages(view.messages);
      if (view.live) { void watch(view.live.id, view.live.input, base, view.live.startedAt, Array.from({ length: view.live.images ?? 0 }, () => ''), (view.live.files ?? []).filter(f => !(view.live!.images && f.kind === 'image')).map(chip), view.live.author, view.live.batch, view.live.source, view.live.decision); return; }
      if (liveRun.current) return;
      setMessages(base);
      showState(view);
    } finally { viewing.current = false; }
  }

  /** The conversation's state from its view: read-only (with Check and unlock) after an uncertain turn; a stopped reply marked as such. */
  function showState(view: View) {
    // The server says whether the conversation takes new turns (a checked turn keeps its status but is usable); older servers: by status.
    const locked = view.usable === undefined ? isLocked(view.status) : !view.usable && !view.live;
    setBlocked(locked ? lockedNotice(view.code) : '');
    setCheckable(locked); setCheckNote('');
    setStoppedNote(view.stopped ? { runId: view.stopped.runId, text: stoppedLine(view.stopped.code) } : undefined);
  }
  /** Check and unlock: ask Letta (read-only) whether the uncertain turn ended; unlock when it did. Never resends anything. */
  async function checkAndUnlock() {
    const target = currentRef.current;
    if (target.draft || checking) return;
    setChecking(true); setCheckNote('');
    try {
      const result = await api<CheckResult>(`/v1/threads/${encodeURIComponent(target.id)}/check`, {});
      if (currentRef.current.id !== target.id) return;
      if (!result.unlocked) { setCheckNote(checkSummary(result)); return; }
      const view = await api<View>(`/v1/threads/${target.id}/view`, undefined, 'GET');
      if (currentRef.current.id !== target.id) return;
      lastRun.current = view.lastRunId;
      setMessages(historyMessages(view.messages)); setQueue(view.queue ?? []);
      showState(view);
      toast(checkSummary(result));
      focusComposer();
    } catch (e) {
      setCheckNote(errorCode(e) === 'runtime_busy' ? 'The agent is busy right now; try again in a moment.' : errorCode(e) === 'not_locked' ? 'This conversation is already usable.' : 'Couldn’t check with Letta. Nothing was changed.');
      if (errorCode(e) === 'not_locked') void refreshView().catch(() => {});
    } finally { setChecking(false); }
  }

  async function select(id: string) {
    // Team mode: other conversations keep running on the server while you look elsewhere.
    if (operation.current || (liveRun.current && !team)) return;
    if (team) { stream.current?.abort(); liveRun.current = undefined; setRunning(false); setLiveThread(undefined); setLiveAuthor(undefined); setQueue([]); }
    operation.current = true; setLoading(true); setBlocked(''); setCheckable(false); setCheckNote(''); setStoppedNote(undefined); setInteraction(undefined); setInteractionOutcome('');
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
      void loadDecisions(id);
      const base = historyMessages(view.messages); setMessages(base); setQueue(view.queue ?? []);
      showState(view);
      // After a refresh mid-run the image bytes are only in Letta history; show placeholders until it completes.
      if (view.live) void watch(view.live.id, view.live.input, base, view.live.startedAt, Array.from({ length: view.live.images ?? 0 }, () => ''), (view.live.files ?? []).filter(f => !(view.live!.images && f.kind === 'image')).map(chip), view.live.author, view.live.batch, view.live.source, view.live.decision);
    } catch (e) {
      setCurrent(previous);
      toast(errorCode(e) === 'runtime_busy' ? 'The agent is replying in another conversation. Try again when it finishes.' : errorCode(e) === 'not_found' && team ? 'That conversation isn’t available in this agent.' : 'Couldn’t open that conversation. Check that the local server is running.', { tone: 'error' });
      if (!previous.draft && previous.id !== id) { operation.current = false; setLoading(false); return void select(previous.id); }
    } finally { operation.current = false; setLoading(false); focusComposer(); }
  }

  function startDraft() {
    if (operation.current || (liveRun.current && !team)) return;
    stream.current?.abort();
    if (team) { liveRun.current = undefined; setRunning(false); setLiveThread(undefined); setLiveAuthor(undefined); setQueue([]); }
    setCurrent(newDraft()); setMessages([]); setBlocked(''); setCheckable(false); setCheckNote(''); setStoppedNote(undefined); setInteraction(undefined); setInteractionOutcome('');
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

  // Team mode, and automations: follow what others do (new conversations, turns, the queue) with a long poll.
  // The last seen state of every conversation: the open one is refreshed only when it changed (never for another's turn).
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    if (!follow || connecting) return;
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
          setServerChanges(n => n + 1);
          const list = await api<ThreadSummary[]>('/v1/threads');
          if (control.signal.aborted) return;
          const keyOf = (t: ThreadSummary) => `${t.running ?? ''}|${t.queued ?? 0}|${t.lastActivityAt ?? ''}|${t.title}|${t.pendingDecision ?? ''}`;
          const previous = seen.current;
          seen.current = new Map(list.map(t => [t.id, keyOf(t)]));
          if (first) continue;
          setThreads(list);
          // Refresh the open conversation only when it changed (its turns, queue or title).
          const open = list.find(t => t.id === currentRef.current.id);
          if (open && previous.get(open.id) !== keyOf(open)) await refreshView().catch(() => {});
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

  async function patch(id: string, body: { title?: string; archived?: boolean; latex?: LatexOverride; replyMode?: ReplyModeOverride; trustJiminy?: TrustOverride }) {
    const updated = await api<ThreadSummary>(`/v1/threads/${id}`, body, 'PATCH');
    setThreads(list => list.map(t => t.id === updated.id ? { ...t, ...updated } : t));
    // The conversation's folder follows its title: refresh the Resources panel now.
    if (body.title !== undefined) setTurns(n => n + 1);
    // Archived conversations' folders are hidden there: refresh it too.
    if (body.archived !== undefined) setArchives(n => n + 1);
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

  /** A conversation's trust mode override (memory review); admins only on a team server. */
  async function setTrust(id: string, value: TrustOverride) {
    try { await patch(id, { trustJiminy: value }); toast(value === 'on' ? 'This conversation now trusts Jiminy with protected memory.' : value === 'off' ? 'Protected memory is strict in this conversation.' : 'This conversation follows the agent’s setting.'); }
    catch (e) { toast(errorCode(e) === 'admin_required' ? 'Only an admin can change how protected memory is handled.' : metadataError(e), { tone: 'error' }); }
  }
  /** A conversation's LaTeX override; the open conversation re-renders at once. */
  async function setLatex(id: string, value: LatexOverride) {
    try { await patch(id, { latex: value }); } catch (e) { toast(metadataError(e), { tone: 'error' }); }
  }

  /** Team mode: a conversation's reply mode (agent default, always, when mentioned or asked, agent decides). */
  async function setReplyMode(id: string, value: ReplyModeOverride) {
    try { await patch(id, { replyMode: value }); } catch (e) { toast(metadataError(e), { tone: 'error' }); }
  }
  const [showListened, setShowListenedState] = useState(() => localStorage.getItem(SHOW_LISTENED) !== 'false');
  const setShowListened = useCallback((show: boolean) => { localStorage.setItem(SHOW_LISTENED, String(show)); setShowListenedState(show); }, []);

  /**
   * Team mode: tell the others you are typing in this conversation. Only
   * presence, never the text: a small heartbeat while you type (the server
   * forgets it about 5 seconds after the last one), and "stopped" when the
   * box is emptied or you switch conversations. Sending ends it on the server.
   */
  const typingState = useRef<{ thread?: string; at: number }>({ at: 0 });
  const signalTyping = useCallback((typing: boolean) => {
    const target = currentRef.current;
    if (!team || target.draft) return;
    const state = typingState.current;
    if (typing) {
      if (state.thread === target.id && Date.now() - state.at < TYPING_HEARTBEAT_MS) return;
      state.thread = target.id; state.at = Date.now();
      void api(`/v1/threads/${target.id}/typing`, { typing: true }).catch(() => {});
    } else if (state.thread) {
      const thread = state.thread; state.thread = undefined; state.at = 0;
      void api(`/v1/threads/${thread}/typing`, { typing: false }).catch(() => {});
    }
  }, [team]);
  // Switching conversations ends your typing in the one you left.
  useEffect(() => { if (typingState.current.thread && typingState.current.thread !== current.id) signalTyping(false); }, [current.id, signalTyping]);

  /** Team mode: `@` in the composer suggests the agent's name. */
  const [mention, setMention] = useState<{ start: number; caret: number } | undefined>();
  const updateMention = useCallback((el: HTMLTextAreaElement) => {
    if (!team) return;
    const found = el.selectionStart === el.selectionEnd ? mentionQuery(el.value, el.selectionStart) : undefined;
    setMention(found && mentionMatches(found.query, agent.name) ? { start: found.start, caret: el.selectionStart } : undefined);
  }, [team, agent.name]);
  const chooseMention = useCallback(() => {
    const el = composerRef.current;
    if (!mention || !el) return;
    const next = insertMention(el.value, mention.start, mention.caret, mentionName(agent.name));
    runtime.thread.composer.setText(next.text);
    setMention(undefined);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(next.caret, next.caret); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention, agent.name]);

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
    operation.current = true; setStoppedNote(undefined);
    // Sending ends your typing (the server clears it too).
    typingState.current = { at: 0 }; setMention(undefined);
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
        if (rejected || code === 'queue_full' || code === 'runtime_busy' || code === 'history_conflict') {
          // Validated and refused before delivery: safe to hand the draft back.
          if (queueing) setQueue(list => list.filter(item => item.id !== id)); else { setMessages(base); setRunning(false); }
          // Busy or behind: an automation is replying (here or in another conversation), or just did.
          toast(rejected ?? (code === 'runtime_busy' ? 'The agent is replying in another conversation. Your message is back in the box; send it when that finishes.'
            : code === 'history_conflict' ? 'New messages arrived in this conversation. Your message is back in the box; check them, then send it.'
            : 'This conversation already has 10 messages waiting. Try again when some have been sent.'), { tone: 'error' });
          if (code === 'history_conflict') { operation.current = false; void refreshView().catch(() => {}); }
          throw new MessageNotSentError();
        }
        if (queueing) setQueue(list => list.filter(item => item.id !== id)); else setRunning(false);
        setBlocked(`Couldn’t confirm that your message was delivered (${code}). Refresh before doing anything else — it won’t be resent automatically.`); setCheckable(false);
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
    catch (e) { toast(errorCode(e) === 'not_your_turn' ? 'Only its author or an admin can withdraw that message.' : errorCode(e) === 'already_sent' ? 'Too late: that message was just sent to the agent.' : 'Couldn’t withdraw that message.', { tone: 'error' }); }
  }

  const adapterThreads = useMemo<ExternalStoreThreadData<'regular'>[]>(() => active.map(t => ({ status: 'regular', id: t.id, title: t.title, custom: { state: t.state, running: !!t.running, queued: t.queued ?? 0, decision: !!t.pendingDecision } })), [active]);
  const adapterArchived = useMemo<ExternalStoreThreadData<'archived'>[]>(() => archived.map(t => ({ status: 'archived', id: t.id, title: t.title, custom: { state: t.state } })), [archived]);
  const readOnly = !!selected?.archived;
  const readOnlyRef = useRef(readOnly); readOnlyRef.current = readOnly;
  const runtimeRef = useRef<AssistantRuntime | undefined>(undefined);
  const attachments = useMemo(() => new FileAttachmentAdapter(() => runtimeRef.current?.thread.composer.getState().attachments ?? [], filesEnabled ? uploadFile : undefined), [filesEnabled]);
  // Sent files download from where they are now in the resources (the server follows moves and renames).
  const fileLink = useCallback((name: string) => current.draft ? undefined : apiPath(`/v1/threads/${encodeURIComponent(current.id)}/files/${encodeURIComponent(name)}`), [current]);
  // The quiet "Listened" lines can be hidden (a per-browser setting); the messages themselves always stay.
  const shown = useMemo(() => showListened ? messages : withoutListened(messages), [messages, showListened]);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    // Team mode: the composer stays usable during a reply (messages queue), so the runtime is never "running" for assistant-ui.
    messages: shown, convertMessage: m => m, isRunning: team ? false : running, isLoading: loading,
    isDisabled: loading || !!blocked || readOnly || (!current.draft && selected?.state !== 'ready'),
    onNew: send, onCancel: cancel, unstable_enableToolInvocations: false,
    adapters: { attachments, threadList: {
      threadId: current.id, isLoading: listLoading, threads: adapterThreads, archivedThreads: adapterArchived,
      onSwitchToThread: id => select(id), onSwitchToNewThread: () => startDraft(),
      onRename: (id, title) => rename(id, title), onArchive: id => archive(id), onUnarchive: id => restore(id),
    } },
  });
  runtimeRef.current = runtime;

  /* ---------------- rewind: edit an earlier message ---------------- */
  const [editable, setEditable] = useState<{ thread: string; runIds: ReadonlySet<string>; refusal?: string }>();
  const [editing, setEditing] = useState<string>();
  const [rewindPending, setRewindPending] = useState(false);
  const [confirm, setConfirm] = useState<{ runId: string; text: string; summary: RewindSummary; rewindId: string; newRunId: string; error?: string }>();
  const [rewinding, setRewinding] = useState(false);
  /** Which of your messages can be edited here (refreshed after every turn and change). */
  async function loadEditable(threadId: string) {
    try {
      const result = await api<{ runIds: string[]; refusal?: string }>(`/v1/threads/${encodeURIComponent(threadId)}/rewind`, undefined, 'GET');
      if (currentRef.current.id === threadId) setEditable({ thread: threadId, runIds: new Set(result.runIds), ...(result.refusal ? { refusal: result.refusal } : {}) });
    } catch { if (currentRef.current.id === threadId) setEditable(undefined); }
  }
  useEffect(() => { setEditing(undefined); setConfirm(undefined); if (current.draft || running) { setEditable(undefined); return; } void loadEditable(current.id); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [current.id, current.draft, running, turns, messages.length]);
  async function previewRewind(runId: string, text: string) {
    const threadId = currentRef.current.id;
    setRewindPending(true);
    try {
      const summary = await api<RewindSummary>(`/v1/threads/${encodeURIComponent(threadId)}/rewind/preview`, { runId });
      setConfirm({ runId, text, summary, rewindId: uuid(), newRunId: uuid() });
    } catch (e) { toast(rewindError(errorCode(e)), { tone: 'error' }); }
    finally { setRewindPending(false); }
  }
  async function confirmRewind() {
    if (!confirm || rewinding) return;
    const threadId = currentRef.current.id;
    setRewinding(true); operation.current = true;
    try {
      // The same IDs on a retry: the server applies the rewind and sends the message once.
      const result = await api<{ rewind: { stage: string }; run?: { id: string; status: string } }>(`/v1/threads/${encodeURIComponent(threadId)}/rewind`, { rewindId: confirm.rewindId, runId: confirm.runId, text: confirm.text, newRunId: confirm.newRunId });
      setConfirm(undefined); setEditing(undefined);
      operation.current = false;
      // Show the rewound conversation, then the edited message's reply as it streams.
      const view = await api<View>(`/v1/threads/${threadId}/view`, undefined, 'GET');
      if (currentRef.current.id !== threadId) return;
      lastRun.current = view.lastRunId;
      const base = historyMessages(view.messages);
      setMessages(base); setQueue(view.queue ?? []); setBlocked(''); setCheckable(false); setStoppedNote(undefined);
      void refreshThreads().catch(() => {});
      setTurns(n => n + 1);
      if (view.live) void watch(view.live.id, view.live.input, base, view.live.startedAt, [], [], view.live.author);
      else if (!result.run) toast('Rewound. Your edited message couldn’t be sent; send it again.', { tone: 'error' });
      toast('Rewound. Your edited message was sent.');
    } catch (e) {
      const code = errorCode(e);
      setConfirm(value => value ? { ...value, error: rewindError(code) } : value);
    } finally { operation.current = false; setRewinding(false); }
  }
  const rewindState = useMemo<RewindState>(() => ({
    editable: editable && editable.thread === current.id && !running && !blocked && !readOnlyRef.current && !(team && queue.length) ? editable.runIds : new Set(),
    ...(editing ? { editing } : {}), pending: rewindPending, ...(editable?.refusal ? { refusal: editable.refusal } : {}),
    start: runId => setEditing(runId), cancel: () => { setEditing(undefined); focusComposer(); },
    explain: code => toast(rewindError(code)),
    submit: (runId, text) => void previewRewind(runId, text),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [editable, current.id, running, blocked, editing, rewindPending, queue.length]);


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
        // A full-screen view handles its own Escape (it is above everything); picture-in-picture does not hold it.
        if (appOverlay?.mode === 'fullscreen') return;
        if (narrow && sideDrawer) { setSideDrawer(false); return; }
        if (appOverlay) return;
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

  /* ---------------- decisions ---------------- */
  const feed = useDecisionFeed(decisionsEnabled && !connecting && !unreachable);
  const [threadDecisions, setThreadDecisions] = useState<ReadonlyMap<string, DecisionView>>(new Map());
  const decisionsThread = useRef<string | undefined>(undefined);
  /** The open conversation's decisions (cards and lines), refreshed when anything changes. */
  async function loadDecisions(threadId: string) {
    if (!agent.decisions) return;
    try {
      const { decisions } = await api<{ decisions: DecisionView[] }>(`/v1/decisions?thread=${encodeURIComponent(threadId)}`);
      if (currentRef.current.id !== threadId) return;
      decisionsThread.current = threadId;
      setThreadDecisions(new Map(decisions.map(d => [d.id, d])));
    } catch { /* kept as it was */ }
  }
  useEffect(() => { setThreadDecisions(new Map()); decisionsThread.current = undefined; }, [current.id]);
  // The bell changed (a decision asked, decided or withdrawn anywhere): the open conversation's cards follow.
  const feedKey = feed.decisions.map(d => d.id).join(',');
  useEffect(() => { if (!current.draft && feed.loaded) void loadDecisions(current.id); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [feedKey]);
  const loading_ = useRef(new Set<string>());
  const decisionsState = useMemo<DecisionsState>(() => ({
    byId: threadDecisions, team: !!team, admin: !team || isAdmin, ...(team ? { me: team.user.id } : {}),
    ensure: id => {
      if (loading_.current.has(id) || threadDecisions.has(id)) return;
      loading_.current.add(id);
      void api<DecisionView>(`/v1/decisions/${encodeURIComponent(id)}`).then(decision => { if (decision.threadId === currentRef.current.id) setThreadDecisions(map => new Map(map).set(decision.id, decision)); }).catch(() => {}).finally(() => loading_.current.delete(id));
    },
    decide: async (id, body) => {
      let response: Response;
      try { response = await fetch(apiPath(`/v1/decisions/${encodeURIComponent(id)}/decide`), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...setCsrfHeader() }, body: JSON.stringify(body) }); }
      catch { throw new Error('Couldn’t reach the server. Nothing was sent; try again.'); }
      const data = await response.json().catch(() => ({})) as DecisionView & { error?: string; decision?: DecisionView };
      const settled = response.ok ? data : data.decision;
      if (settled) setThreadDecisions(map => new Map(map).set(settled.id, settled));
      // Someone else decided first: their outcome turn is on its way; show it.
      if (!response.ok && data.decision) void refreshView().catch(() => {});
      if (!response.ok) throw new Error(decideError(data.error ?? `http_${response.status}`, data.decision, team?.user.id));
      // The work resumes in a new turn of this conversation: show it as it starts.
      void refreshView().catch(() => {});
      setTimeout(() => void refreshView().catch(() => {}), 600);
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [threadDecisions, team, isAdmin]);
  const pendingHere = !current.draft ? [...threadDecisions.values()].find(d => d.status === 'pending' && d.kind !== 'memory-review' && d.kind !== 'claim-confirmation' && d.kind !== 'memory-notice') : undefined;
  // Memory reviews of this conversation (held changes, and the ones decided while you watched): cards after the messages.
  const memoryReviews = !current.draft ? [...threadDecisions.values()].filter(d => (d.kind === 'memory-review' || d.kind === 'claim-confirmation' || (d.kind === 'memory-notice' && mayReview(d, team?.user.id, !team || isAdmin))) && (d.status === 'pending' || (d.decidedAt && Date.now() - Date.parse(d.decidedAt) < 10 * 60_000))) : [];
  /** Open a decision from the bell: its conversation (switching agents on a team server). */
  const openDecision = useCallback((decision: FeedDecision) => {
    setDrawer(false);
    const focus = () => setTimeout(() => document.getElementById(`decision-${decision.id}`)?.scrollIntoView({ block: 'center' }), 300);
    const switcher = team ?? local;
    if (switcher && decision.agent.id !== agent.id) { localStorage.setItem(team || local?.agents.find(a => a.id === decision.agent.id)?.adopted ? `${SAVED}:${decision.agent.id}` : SAVED, decision.thread.id); switcher.onSwitch(decision.agent.id); return; }
    if (currentRef.current.id === decision.thread.id) { focus(); return; }
    void select(decision.thread.id).then(focus);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, local, agent.id]);
  const bell = decisionsEnabled ? <DecisionBell decisions={feed.decisions} showAgent={(!!team && team.agents.length > 1) || (!!local && local.agents.length > 1)} {...(team ? { me: { id: team.user.id, name: team.user.name } } : {})} onOpen={openDecision}/> : undefined;

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
  const appsState: AppsState = {
    enabled: appsEnabled, ...(current.draft ? {} : { threadId: current.id }), viewTools, generations: devGenerations, panel: appTabs.map(t => t.id), ...(appOverlay ? { overlay: appOverlay } : {}),
    openPanel: (id, tool) => { if (current.draft) return; const thread = current.id; setAppOverlay(undefined); updateSide(s => openApp(s, thread, { id, tool })); },
    closePanel: id => { if (!current.draft) { const thread = current.id; updateSide(s => closeApp(s, thread, id)); } },
    setOverlay: value => { if (value && !current.draft && hasApp(side, current.id, value.toolCallId)) { const thread = current.id; updateSide(s => closeApp(s, thread, value.toolCallId)); } setAppOverlay(value); },
    refreshApprovals: refreshAppApprovals,
    // A message the view sent (allowed) starts a turn here: the long poll follows it (a refresh here could hold the runtime while you send).
    onSent: () => {},
  };
  return <AppsContext.Provider value={appsState}>
  <InteractionContext.Provider value={{ request: interaction, outcome: interactionOutcome, sent: sentAnswer, approvalTools, answer, ...(waitingFor ? { waitingFor } : {}) }}>
    <AuthorContext.Provider value={team?.user.id}>
    <DecisionsContext.Provider value={decisionsState}>
    <FileLinkContext.Provider value={fileLink}>
    <LatexContext.Provider value={latex}>
    <RewindContext.Provider value={rewindState}>
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="layout" data-drawer={drawer || undefined} data-side-drawer={(narrow && sideOpen) || undefined} data-sidebar-collapsed={(!narrow && !layout.sidebar) || undefined} data-side-open={(!narrow && sideOpen) || undefined}
        data-loading={loading || listLoading || undefined} data-running={running || undefined} data-editing={editing ? true : undefined} style={{ '--side-width': `${side.width}px` } as React.CSSProperties}>
        <aside id="sidebar" className="sidebar" aria-label="Sidebar" inert={!narrow && !layout.sidebar ? true : undefined}>
          <Sidebar active={active} archived={archived} times={times} query={query} onQuery={setQuery} searchRef={searchRef} busy={busy} runningId={team ? undefined : liveThread} archivingIds={archiving} isDraft={current.draft} onClose={() => setDrawer(false)} onCollapse={() => setLayout(l => ({ ...l, sidebar: false }))} agent={agent} versions={versions}
            agentLatex={resolveLatex(agentLatex, 'inherit')} onLatex={(id, value) => void setLatex(id, value)} actions={bell}
            {...(team ? { brand: <AgentSwitcher agents={team.agents} current={agent} onSwitch={team.onSwitch} onMembers={() => setMembersOpen(true)}/> } : local ? { brand: <LocalAgentSwitcher agents={local.agents} current={agent} onSwitch={local.onSwitch} onAdd={() => { if (narrow) setDrawer(false); setAdoptOpen(true); }} onRemove={setRemoving} onInstructions={setInstructionsOf} onProject={setProjectOf} onTools={setToolsOf}/> } : {})}
            footer={<>{appsEnabled && (!team || isAdmin) && <AppsRow onOpen={() => { if (narrow) setDrawer(false); setAppsOpen(true); }}/>}{memoryEnabled && <MemoryRow pending={memoryPending} onOpen={() => { if (narrow) setDrawer(false); setMemoryOpen(true); }}/>}{mayManageAutomations && <AutomationsRow onOpen={() => setAutomationsOpen(true)}/>}{atlassianEnabled && <AtlassianRow status={atlassianStatus} onOpen={() => setAtlassianOpen(true)}/>}{team && <CurrentUser user={team.user} role={agent.role}/>}</>}/>
        </aside>
        <div className="scrim" aria-hidden="true" onClick={() => { setDrawer(false); setSideDrawer(false); }}/>
        <main className="main">
          <header className="topbar">
            <button type="button" className="icon-btn menu-btn" aria-label={feed.decisions.length ? `Open sidebar (${feed.decisions.length === 1 ? '1 decision' : `${feed.decisions.length} decisions`} waiting)` : 'Open sidebar'} aria-controls="sidebar" aria-expanded={drawer} data-dot={feed.decisions.length > 0 || undefined} onClick={() => setDrawer(true)}><Menu size={18}/></button>
            {!narrow && !layout.sidebar && <>
              <button type="button" className="icon-btn" aria-label="Show sidebar" aria-controls="sidebar" aria-expanded="false" title="Show sidebar (⌘B)" onClick={toggleSidebar}><PanelLeftOpen size={18}/></button>
              <button type="button" className="icon-btn" aria-label="New chat" title="New chat (⌘K)" disabled={busy} onClick={startDraft}><SquarePen size={18}/></button>
            </>}
            <h1 className="topbar-title" title={titleText(title)}><TitleView title={title}/></h1>
            {team && !current.draft && selected?.state === 'ready' && selected.replyModeInEffect && <ReplyModeMenu value={selected.replyMode ?? 'inherit'} inEffect={selected.replyModeInEffect} agentDefault={agent.replyMode} members={selected.members}
              showListened={showListened} onShowListened={setShowListened} onChange={value => void setReplyMode(selected.id, value)}/>}
            {memoryEnabled && !current.draft && selected?.state === 'ready' && <TrustMenu value={selected.trustJiminy ?? 'inherit'} agentDefault={!!agent.trustJiminy} mayChange={!team || isAdmin} onChange={value => void setTrust(selected.id, value)}/>}
            {!current.draft && selected?.state === 'ready' && <LatexMenu value={selected.latex ?? 'inherit'} agentDefault={resolveLatex(agentLatex, 'inherit')} onChange={value => void setLatex(selected.id, value)}/>}
            {webDevEnabled && !current.draft && <button type="button" className="icon-btn preview-btn" aria-label={previewOpen ? 'Hide preview' : 'Show preview'} aria-controls="side-panel" aria-expanded={previewOpen} data-active={previewOpen || undefined} data-live={devServerRunning(previewStatus) || undefined} title={devServerRunning(previewStatus) ? 'Preview (dev server running)' : 'Preview'} onClick={() => toggleTab('preview')}><AppWindow size={18}/></button>}
            {resourcesEnabled && <button type="button" className="icon-btn resources-btn" aria-label={resourcesOpen ? 'Hide resources' : 'Show resources'} aria-controls="side-panel" aria-expanded={resourcesOpen} data-active={resourcesOpen || undefined} title={`Resources (${navigator.platform.startsWith('Mac') ? '⌘⇧E' : 'Ctrl+Shift+E'})`} onClick={toggleResources}><FolderTree size={18}/></button>}
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
                <AppApprovalCards approvals={appApprovals} onDecided={refreshAppApprovals}/>
                {memoryReviews.map(decision => decision.kind === 'claim-confirmation' ? <ClaimCard key={decision.id} decision={decision}/> : decision.kind === 'memory-notice' ? <NoticeCard key={decision.id} decision={decision}/> : <MemoryReviewCard key={decision.id} decision={decision}/>)}
              </div>
              <ThreadPrimitive.ViewportFooter className="footer">
                <div className="column footer-column">
                  <ThreadPrimitive.ScrollToBottom className="jump" aria-label="Jump to latest"><ArrowDown size={14} aria-hidden="true"/>Jump to latest</ThreadPrimitive.ScrollToBottom>
                  <InteractionDock onDismiss={() => { setInteraction(undefined); setInteractionOutcome(''); focusComposer(); }}/>
                  <PendingDecisionBar decision={pendingHere}/>
                  {team && <QueueList queue={queue} me={team.user.id} canWithdraw={turn => isAdmin || turn.author?.id === team.user.id} onWithdraw={turn => void withdraw(turn)} together={!!selected?.replyModeInEffect && (selected.members ?? 0) > 1}/>}
                  {team && !current.draft && !readOnly && <TypingLine people={selected?.typing ?? []} me={team.user.id}/>}
                  {stoppedNote && !blocked && !running && <div className="stopped-line" role="status" data-run={stoppedNote.runId}><Square size={11} aria-hidden="true"/><span>{stoppedNote.text}</span></div>}
                  {blocked && <div className="notice" role="status"><TriangleAlert size={16} aria-hidden="true"/><span>{blocked}{checkNote && <><br/><em className="check-note">{checkNote}</em></>}</span>
                    {checkable && !current.draft && <button type="button" className="btn small primary" disabled={running || checking} onClick={() => void checkAndUnlock()}>{checking ? 'Checking…' : 'Check and unlock'}</button>}
                    <button type="button" className="btn small" disabled={running} onClick={startDraft}>New chat</button></div>}
                  {readOnly
                    ? <div className="readonly-bar"><span>This conversation is archived and read-only.</span><button type="button" className="btn primary small" onClick={() => void restore(current.id)}><ArchiveRestore size={15} aria-hidden="true"/>Restore</button></div>
                    : <ComposerPrimitive.Root className="composer" data-disabled={(!!blocked || loading) || undefined}>
                        {mention && <div className="menu mentions" role="listbox" aria-label="Mention">
                          <div role="option" aria-selected="true" className="menu-item" onMouseDown={event => { event.preventDefault(); chooseMention(); }}>
                            <span className="brand-mark" aria-hidden="true">✳︎</span><span>{mentionName(agent.name)}</span><span className="mention-handle">@{mentionName(agent.name).split(' ')[0]}</span>
                          </div>
                        </div>}
                        <ComposerPrimitive.AttachmentDropzone className="dropzone" disabled={!!blocked || loading}>
                          <ComposerImages fileInfo={id => attachments.uploaded(id)}/>
                          <div className="composer-row">
                            <ComposerPrimitive.AddAttachment className="icon-btn attach-btn" aria-label={filesEnabled ? 'Attach files' : 'Attach images'} title={filesEnabled ? `Attach files: PDF, text, CSV, code (up to ${FILE_LIMITS.maxFileBytes / 1024 / 1024} MB) or images · or paste / drop` : `Attach images (up to ${IMAGE_LIMITS.maxImages}) · or paste / drop`} disabled={!!blocked || loading}><Paperclip size={18} aria-hidden="true"/></ComposerPrimitive.AddAttachment>
                            <ComposerPrimitive.Input ref={composerRef} className="composer-input" aria-label="Message" rows={1} maxRows={10} maxLength={8000} autoFocus
                              addAttachmentOnPaste={false} onPaste={onPaste}
                              onKeyDown={event => {
                                // A suggested @mention: Enter or Tab inserts it, Escape dismisses it.
                                if (mention && !event.nativeEvent.isComposing && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); chooseMention(); return; }
                                if (mention && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMention(undefined); return; }
                                if (!team && event.key === 'Enter' && !event.shiftKey && running && !event.nativeEvent.isComposing) event.preventDefault();
                              }}
                              onChange={event => { updateMention(event.currentTarget); if (team) signalTyping(!!event.currentTarget.value.trim()); }}
                              onSelect={event => updateMention(event.currentTarget)}
                              onBlur={() => setMention(undefined)}
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
        {appsEnabled && !current.draft && <AppOverlay/>}
        {sideTabs.length > 0 && <aside id="side-panel" className="side-pane" aria-label="Side panel" data-tab={sideTab && appTabId(sideTab) ? 'app' : sideTab} hidden={!sideOpen}>
          {!narrow && <Resizer label="Resize side panel" min={SIDE_WIDTH.min} max={SIDE_WIDTH.max} width={side.width} clamp={clampSideWidth} reset={SIDE_WIDTH.initial} onWidth={width => setSide(s => ({ ...s, width }))}/>}
          <SideTabs tabs={sideTabs} active={sideTab} live={devServerRunning(previewStatus)} labelOf={tab => { const id = appTabId(tab); const app = id ? appTabs.find(t => t.id === id) : undefined; const view = app ? viewTools[app.tool] : undefined; return { label: view ? appToolLabel(view, 'done') : app?.tool ?? 'App', dev: !!view?.dev }; }}
            onSelect={tab => updateSide(s => selectSide(s, tab))} onCloseApp={id => appsState.closePanel(id)}/>
          {resourcesEnabled && <div className="side-tabpanel" role="tabpanel" id={tabPanelId('resources')} aria-labelledby={tabId('resources')} hidden={sideTab !== 'resources'}>
            <ResourcesPanel visible={resourcesOpen} threadId={current.draft ? undefined : current.id} refreshKey={`${turns}:${archives}`} project={agent.project} projectOnly={!filesEnabled && !agent.resources} onClose={() => updateSide(closeSide)}
              onOpenThread={id => { if (narrow) setSideDrawer(false); void select(id); }}
              onThreadChanged={updated => setThreads(list => list.map(t => t.id === updated.id ? { ...t, ...updated } : t))}/>
          </div>}
          {previewOpen && !current.draft && <div className="side-tabpanel" role="tabpanel" id={tabPanelId('preview')} aria-labelledby={tabId('preview')}>
            <PreviewPanel threadId={current.id} status={previewStatus} device={previewLayout.device} onDevice={device => setPreviewLayout(l => ({ ...l, device }))}
              onClose={() => updateSide(closeSide)} onChanged={() => void reloadPreview()}/>
          </div>}
          {/* Like Preview, an app view runs only while its tab shows (switching back starts it again, as reopening the former panel did). */}
          {sideOpen && sideTab && appTabId(sideTab) && <div key={sideTab} className="side-tabpanel" role="tabpanel" id={tabPanelId(sideTab)} aria-labelledby={tabId(sideTab)}>
            <AppPanel toolCallId={appTabId(sideTab)!} {...(appTabs.find(t => t.id === appTabId(sideTab))?.tool ? { toolName: appTabs.find(t => t.id === appTabId(sideTab))!.tool } : {})} onClose={() => appsState.closePanel(appTabId(sideTab)!)}/>
          </div>}
        </aside>}
        {membersOpen && team && <MembersDialog agent={agent} onClose={() => setMembersOpen(false)}/>}
        {adoptOpen && local && <AddAgentDialog onClose={() => setAdoptOpen(false)} onAdded={id => { setAdoptOpen(false); local.reload(id); }}/>}
        {removing && local && <RemoveAgentDialog agent={removing} onClose={() => setRemoving(undefined)} onRemoved={() => { setRemoving(undefined); local.reload(); }}/>}
        {instructionsOf && <InstructionsDialog agent={instructionsOf} onClose={() => setInstructionsOf(undefined)}/>}
        {toolsOf && local && <ToolsDialog agent={toolsOf} onClose={() => setToolsOf(undefined)} onSaved={() => { setToolsOf(undefined); local.reload(toolsOf.id); }}/>}
        {projectOf && local && <ProjectDialog agent={projectOf} onClose={() => setProjectOf(undefined)} onSaved={() => { setProjectOf(undefined); local.reload(projectOf.id); }}/>}
        {memoryOpen && <MemoryDialog agentName={agent.name} admin={!team || isAdmin} onClose={() => setMemoryOpen(false)} onOpenThread={id => { setMemoryOpen(false); void select(id); }}/>}
        {appsOpen && <AppsDialog onClose={() => setAppsOpen(false)} onChanged={() => setAppsVersion(v => v + 1)}/>}
        {automationsOpen && <AutomationsDialog agentName={agent.name} onClose={() => setAutomationsOpen(false)} onOpenThread={id => { setDrawer(false); void select(id); }}/>}
        {confirm && <RewindDialog summary={confirm.summary} text={confirm.text} busy={rewinding} {...(confirm.error ? { error: confirm.error } : {})} onConfirm={() => void confirmRewind()} onClose={() => { if (!rewinding) setConfirm(undefined); }}/>}
        {atlassianOpen && <AtlassianDialog status={atlassianStatus} onStatus={setAtlassianStatus} team={!!team} onClose={() => setAtlassianOpen(false)}/>}
      </div>
    </AssistantRuntimeProvider>
    </RewindContext.Provider>
    </LatexContext.Provider>
    </FileLinkContext.Provider>
    </DecisionsContext.Provider>
    </AuthorContext.Provider>
  </InteractionContext.Provider>
  </AppsContext.Provider>;
}

/** DOM ids of a side panel tab and its panel (tool call ids may hold any character). */
const domId = (tab: SideTab) => tab.replace(/[^A-Za-z0-9_-]/g, '_');
const tabId = (tab: SideTab) => `side-tab-${domId(tab)}`;
const tabPanelId = (tab: SideTab) => `side-tabpanel-${domId(tab)}`;
const TAB_NAMES: Record<string, string> = { resources: 'Resources', preview: 'Preview' };

/**
 * The side panel's tab strip (a tablist: arrow keys, Home and End move and
 * select; Delete closes an app tab). App tabs carry the app's name and tool,
 * a "Dev" chip for a dev app, and a close button.
 */
function SideTabs({ tabs, active, live, labelOf, onSelect, onCloseApp }: { tabs: readonly SideTab[]; active: SideTab | undefined; live: boolean; labelOf(tab: SideTab): { label: string; dev: boolean }; onSelect(tab: SideTab): void; onCloseApp(toolCallId: string): void }) {
  const strip = useRef<HTMLDivElement>(null);
  // Overflow: the strip scrolls horizontally, with a fade on each edge that hides tabs.
  const [overflow, setOverflow] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const start = el.scrollLeft > 1, end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow(previous => previous.start === start && previous.end === end ? previous : { start, end });
  }, []);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [measure, tabs.length]);
  // The selected tab scrolls into view (clear of the fades).
  useEffect(() => {
    const el = strip.current;
    const tab = active ? el?.querySelector<HTMLElement>(`#${tabId(active)}`)?.closest<HTMLElement>('.side-tab-wrap') : undefined;
    if (!el || !tab) return;
    const fade = 24;
    const box = el.getBoundingClientRect(), rect = tab.getBoundingClientRect();
    const left = rect.left - box.left + el.scrollLeft, right = left + rect.width;
    if (left - fade < el.scrollLeft) el.scrollTo({ left: Math.max(0, left - fade), behavior: 'smooth' });
    else if (right + fade > el.scrollLeft + el.clientWidth) el.scrollTo({ left: right + fade - el.clientWidth, behavior: 'smooth' });
  }, [active, tabs.length]);
  const onKeyDown = (event: React.KeyboardEvent, tab: SideTab) => {
    const id = appTabId(tab);
    if (id && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); onCloseApp(id); return; }
    const next = tabKey(tabs, tab, event.key);
    if (!next) return;
    event.preventDefault();
    onSelect(next);
    requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`#${tabId(next)}`)?.focus());
  };
  return <div className="side-tabs" role="tablist" aria-label="Side panel" ref={strip} onScroll={measure} data-fade-start={overflow.start || undefined} data-fade-end={overflow.end || undefined}
    onWheel={event => { const el = strip.current; if (el && Math.abs(event.deltaY) > Math.abs(event.deltaX) && el.scrollWidth > el.clientWidth) el.scrollLeft += event.deltaY; }}>
    {tabs.map(tab => {
      const id = appTabId(tab);
      const { label, dev } = id ? labelOf(tab) : { label: TAB_NAMES[tab] ?? tab, dev: false };
      const selected = tab === active;
      return <div key={tab} className="side-tab-wrap" data-selected={selected || undefined} data-app={id ? true : undefined}>
        <button type="button" role="tab" id={tabId(tab)} className="side-tab" aria-selected={selected} aria-controls={tabPanelId(tab)} tabIndex={selected ? 0 : -1} title={label}
          onClick={() => onSelect(tab)} onKeyDown={event => onKeyDown(event, tab)}>
          {tab === 'resources' ? <FolderTree size={14} aria-hidden="true"/> : tab === 'preview' ? <AppWindow size={14} aria-hidden="true"/> : <Blocks size={14} aria-hidden="true"/>}
          <span className="side-tab-label">{label}</span>
          {tab === 'preview' && live && <span className="side-tab-live" role="img" aria-label="dev server running"/>}
          {dev && <span className="side-tab-dev">Dev</span>}
        </button>
        {id && <button type="button" className="side-tab-close" tabIndex={-1} aria-label={`Close ${label}`} title="Close tab" onClick={() => onCloseApp(id)}><X size={13}/></button>}
      </div>;
    })}
  </div>;
}

/** Drag handle on the side panel's left edge; arrow keys resize too. The width is kept between visits. */
function Resizer({ width, onWidth, label, min, max, clamp, reset }: { width: number; onWidth(width: number): void; label: string; min: number; max: number; clamp(width: number): number; reset: number }) {
  const start = useRef<{ x: number; width: number } | undefined>(undefined);
  return <div className="resizer" role="separator" aria-orientation="vertical" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} tabIndex={0}
    onPointerDown={event => { event.preventDefault(); (event.target as Element).setPointerCapture(event.pointerId); start.current = { x: event.clientX, width }; document.body.dataset.resizing = ''; }}
    onPointerMove={event => { if (start.current) onWidth(clamp(start.current.width + start.current.x - event.clientX)); }}
    onPointerUp={() => { start.current = undefined; delete document.body.dataset.resizing; }}
    onDoubleClick={() => onWidth(reset)}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onWidth(clamp(width + (event.key === 'ArrowLeft' ? 24 : -24))); } }}/>;
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
