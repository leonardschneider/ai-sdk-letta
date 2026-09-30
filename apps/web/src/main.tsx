import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage, type ExternalStoreThreadData, type ThreadMessageLike } from '@assistant-ui/react';
import { ArchiveRestore, ArrowDown, ArrowUp, Menu, Square, SquarePen, TriangleAlert } from 'lucide-react';
import type { UIMessage } from 'ai';
import type { RuntimeEvent } from '@ai-sdk-letta/server';
import type { InteractionRequest, InteractionResponse } from 'ai-sdk-letta';
import { historyMessages, observedParts, withTime } from './messages.js';
import { api, errorCode, metadataError, setCsrf } from './api.js';
import { activityTimes, DEFAULT_TITLE, deriveTitle, isDefaultTitle, nextAfterArchive, sortThreads, type ThreadSummary } from './thread-model.js';
import { Sidebar } from './sidebar.js';
import { InteractionContext, InteractionDock, Message } from './chat.js';
import { ToastProvider, useToast } from './toasts.js';
import { Starters } from './starters.js';
import './style.css';
import './markdown.css';

type View = { messages: UIMessage[]; lastRunId: string | null; live: null | { id: string; input: string }; status: string | null };
type Current = { id: string; draft: boolean };
const SAVED = 'ai-sdk-letta-thread';
const newDraft = (): Current => ({ id: crypto.randomUUID(), draft: true });
const blockedNotice = 'This conversation has an unfinished or uncertain turn, so it’s read-only. Nothing is replayed automatically — start a new chat to continue.';

function App() {
  const toast = useToast();
  const [agent, setAgent] = useState<{ id: string; name: string; approvalTools: string[] }>({ id: '', name: 'Connecting…', approvalTools: [] });
  const approvalTools = useMemo(() => new Set(agent.approvalTools), [agent.approvalTools]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [current, setCurrent] = useState<Current>(newDraft);
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState('');
  const [interaction, setInteraction] = useState<InteractionRequest>();
  const [interactionOutcome, setInteractionOutcome] = useState('');
  const [sentAnswer, setSentAnswer] = useState<InteractionResponse>();
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState(false);
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

  async function watch(id: string, input: string, base: ThreadMessageLike[], startedAt?: string) {
    stream.current?.abort(); const control = new AbortController(); stream.current = control;
    liveRun.current = id; setRunning(true); setLiveThread(currentRef.current.id);
    const events: RuntimeEvent[] = [];
    let ended = false;
    let endedAt: string | undefined;
    const render = () => setMessages([...base,
      withTime({ id: `${id}-user`, role: 'user', content: input }, startedAt),
      withTime({ id: `${id}-assistant`, role: 'assistant', content: observedParts(events), status: ended ? events.at(-1)?.type === 'failed' ? { type: 'incomplete', reason: events.at(-1)?.data.code === 'cancelled' ? 'cancelled' : 'error' } : { type: 'complete', reason: 'stop' } : { type: 'running' } }, endedAt)]);
    render();
    try {
      const response = await fetch(`/api/v1/runs/${id}/events`, { signal: control.signal });
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
            if (event.type === 'failed') {
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
      if (stream.current === control) {
        setRunning(false);
        if (ended) { liveRun.current = undefined; setLiveThread(undefined); }
        void refreshThreads().catch(() => {});
      }
    }
  }

  async function select(id: string) {
    if (operation.current || liveRun.current) return;
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
      localStorage.setItem(SAVED, id); lastRun.current = view.lastRunId;
      const base = historyMessages(view.messages); setMessages(base);
      const failed = !!view.status && !['running', 'completed'].includes(view.status);
      setBlocked(failed ? blockedNotice : '');
      if (view.live) void watch(view.live.id, view.live.input, base);
    } catch (e) {
      setCurrent(previous);
      toast(errorCode(e) === 'runtime_busy' ? 'Another reply is still running. Try again when it finishes.' : 'Couldn’t open that conversation. Check that the local server is running.', { tone: 'error' });
      if (!previous.draft && previous.id !== id) { operation.current = false; setLoading(false); return void select(previous.id); }
    } finally { operation.current = false; setLoading(false); focusComposer(); }
  }

  function startDraft() {
    if (operation.current || liveRun.current) return;
    stream.current?.abort();
    setCurrent(newDraft()); setMessages([]); setBlocked(''); setInteraction(undefined); setInteractionOutcome('');
    lastRun.current = null; setDrawer(false); setLoading(false);
    localStorage.removeItem(SAVED);
    focusComposer();
  }

  useEffect(() => {
    void (async () => {
      try {
        const session = await api<{ csrf: string; agent: { id: string; name: string; approvalTools: string[] } }>('/session'); setCsrf(session.csrf); setAgent(session.agent);
        const list = await api<ThreadSummary[]>('/v1/threads'); setThreads(list); setListLoading(false);
        const saved = localStorage.getItem(SAVED);
        const sorted = sortThreads(list);
        const first = list.find(t => t.id === saved && t.state === 'ready') ?? sorted.find(t => t.state === 'ready' && !t.archived);
        setLoading(false);
        if (first) await select(first.id); else startDraft();
      } catch { setListLoading(false); setLoading(false); setBlocked('Couldn’t reach the local server. Check that it’s running, then refresh.'); }
    })();
    return () => stream.current?.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sorted = useMemo(() => sortThreads(threads), [threads]);
  const times = useMemo(() => activityTimes(threads), [threads]);
  const active = useMemo(() => sorted.filter(t => !t.archived), [sorted]);
  const archived = useMemo(() => sorted.filter(t => t.archived), [sorted]);
  const selected = threads.find(t => t.id === current.id);
  const busy = running || loading;

  async function patch(id: string, body: { title?: string; archived?: boolean }) {
    const updated = await api<ThreadSummary>(`/v1/threads/${id}`, body, 'PATCH');
    setThreads(list => list.map(t => t.id === updated.id ? { ...t, ...updated } : t));
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
      toast(`Archived “${updated.title}”`, { action: { label: 'Undo', run: () => void restore(id) } });
      if (wasCurrent && currentRef.current.id === id) {
        const next = nextAfterArchive(sorted, id);
        if (next) await select(next); else startDraft();
      }
    } catch (e) { toast(metadataError(e), { tone: 'error' }); }
    finally { setArchiving(set => { const copy = new Set(set); copy.delete(id); return copy; }); }
  }
  async function restore(id: string) {
    try { const updated = await patch(id, { archived: false }); toast(`Restored “${updated.title}”`); if (currentRef.current.id === id) focusComposer(); }
    catch (e) { toast(metadataError(e), { tone: 'error' }); }
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
    if (operation.current || liveRun.current || blocked || selected?.archived) return;
    const text = message.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (!text.trim()) return;
    if (text.length > 8000) { toast('Messages can be up to 8,000 characters.', { tone: 'error' }); return; }
    operation.current = true; setRunning(true);
    const startedAt = new Date().toISOString();
    const base = messagesRef.current;
    const first = !base.length;
    const optimisticId = `pending-${startedAt}`;
    setMessages([...base, withTime({ id: `${optimisticId}-user`, role: 'user', content: text }, startedAt), { id: `${optimisticId}-assistant`, role: 'assistant', content: [], status: { type: 'running' } }]);
    try {
      if (target.draft) {
        try {
          await api('/v1/threads', { id: target.id, title: DEFAULT_TITLE });
          await refreshThreads();
          setCurrent({ id: target.id, draft: false }); currentRef.current = { id: target.id, draft: false };
          localStorage.setItem(SAVED, target.id); lastRun.current = null;
        } catch (e) {
          setMessages(base); setRunning(false);
          runtime.thread.composer.setText(text);
          toast(errorCode(e) === 'capacity_reached' ? 'The local server has reached its conversation limit.' : 'Couldn’t start a new conversation. Your message is back in the box — try again.', { tone: 'error' });
          return;
        }
      }
      const id = crypto.randomUUID();
      try { await api('/v1/runs', { id, threadId: target.id, text, parentRunId: lastRun.current }); }
      catch (e) {
        setRunning(false);
        setBlocked(`Couldn’t confirm that your message was delivered (${errorCode(e)}). Refresh before doing anything else — it won’t be resent automatically.`);
        return;
      }
      if (first) void autoTitle(target.id, text);
      await watch(id, text, base, startedAt);
    } finally { operation.current = false; }
  }
  async function cancel() {
    if (!liveRun.current) return;
    try { await api(`/v1/runs/${liveRun.current}/cancel`, {}); } catch { toast('Couldn’t reach the server to stop the reply.', { tone: 'error' }); }
  }

  const adapterThreads = useMemo<ExternalStoreThreadData<'regular'>[]>(() => active.map(t => ({ status: 'regular', id: t.id, title: t.title, custom: { state: t.state } })), [active]);
  const adapterArchived = useMemo<ExternalStoreThreadData<'archived'>[]>(() => archived.map(t => ({ status: 'archived', id: t.id, title: t.title, custom: { state: t.state } })), [archived]);
  const readOnly = !!selected?.archived;
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages, convertMessage: m => m, isRunning: running, isLoading: loading,
    isDisabled: loading || !!blocked || readOnly || (!current.draft && selected?.state !== 'ready'),
    onNew: send, onCancel: cancel, unstable_enableToolInvocations: false,
    adapters: { threadList: {
      threadId: current.id, isLoading: listLoading, threads: adapterThreads, archivedThreads: adapterArchived,
      onSwitchToThread: id => select(id), onSwitchToNewThread: () => startDraft(),
      onRename: (id, title) => rename(id, title), onArchive: id => archive(id), onUnarchive: id => restore(id),
    } },
  });

  // Global shortcuts: ⌘K new chat, ⌘/ search, Esc stops a reply when nothing else handles it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); startDraft(); return; }
      if (mod && !event.altKey && event.key === '/') { event.preventDefault(); setDrawer(true); requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); }); return; }
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (document.querySelector('[role="menu"]')) return;
        if (drawer) { setDrawer(false); return; }
        const target = event.target as HTMLElement | null;
        if (!running || target?.closest('.dock, input, .composer')) return;
        event.preventDefault(); void cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => { document.title = selected ? `${selected.title} · ${agent.name}` : agent.name; }, [selected, agent.name]);

  const title = current.draft ? 'New chat' : selected?.title ?? '';
  const answer = async (value: InteractionResponse) => {
    // Exactly one POST per request; the card locks before this runs and never retries.
    await api(`/v1/runs/${currentInteraction.current?.runId}/answer`, value);
    setSentAnswer(value);
  };
  return <InteractionContext.Provider value={{ request: interaction, outcome: interactionOutcome, sent: sentAnswer, approvalTools, answer }}>
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="layout" data-drawer={drawer || undefined} data-loading={loading || listLoading || undefined} data-running={running || undefined}>
        <aside id="sidebar" className="sidebar" aria-label="Sidebar">
          <Sidebar active={active} archived={archived} times={times} query={query} onQuery={setQuery} searchRef={searchRef} busy={busy} runningId={liveThread} archivingIds={archiving} isDraft={current.draft} onClose={() => setDrawer(false)} agent={agent}/>
        </aside>
        <div className="scrim" aria-hidden="true" onClick={() => setDrawer(false)}/>
        <main className="main">
          <header className="topbar">
            <button type="button" className="icon-btn menu-btn" aria-label="Open sidebar" aria-controls="sidebar" aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={18}/></button>
            <h1 className="topbar-title" title={title}>{title}</h1>
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
                  {blocked && <div className="notice" role="status"><TriangleAlert size={16} aria-hidden="true"/><span>{blocked}</span><button type="button" className="btn small" disabled={running} onClick={startDraft}>New chat</button></div>}
                  {readOnly
                    ? <div className="readonly-bar"><span>This conversation is archived and read-only.</span><button type="button" className="btn primary small" onClick={() => void restore(current.id)}><ArchiveRestore size={15} aria-hidden="true"/>Restore</button></div>
                    : <ComposerPrimitive.Root className="composer" data-disabled={(!!blocked || loading) || undefined}>
                        <ComposerPrimitive.Input ref={composerRef} className="composer-input" aria-label="Message" rows={1} maxRows={10} maxLength={8000} autoFocus
                          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && running && !event.nativeEvent.isComposing) event.preventDefault(); }}
                          placeholder={blocked ? 'Start a new chat to continue' : `Message ${agent.name}`}/>
                        {running
                          ? <ComposerPrimitive.Cancel className="send-btn stop" aria-label="Stop generating" title="Stop (Esc)"><Square size={14} fill="currentColor" aria-hidden="true"/></ComposerPrimitive.Cancel>
                          : <ComposerPrimitive.Send className="send-btn" aria-label="Send message" title="Send (Enter)"><ArrowUp size={18} aria-hidden="true"/></ComposerPrimitive.Send>}
                      </ComposerPrimitive.Root>}
                  {!readOnly && !blocked && <p className="hint-line" aria-hidden="true">Enter to send · Shift+Enter for a new line{running ? ' · Esc to stop' : ''}</p>}
                </div>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </main>
      </div>
    </AssistantRuntimeProvider>
  </InteractionContext.Provider>;
}

createRoot(document.getElementById('root')!).render(<ToastProvider><App/></ToastProvider>);
