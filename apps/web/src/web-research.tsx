import React, { useContext, useEffect, useRef, useState } from 'react';
import { ChevronRight, Clock, ExternalLink, Globe, LoaderCircle, RefreshCw, ShieldCheck, ShieldX, CircleAlert } from 'lucide-react';
import type { InteractionRequest, InteractionResponse } from 'ai-sdk-letta';
import { expiryLabel, researchFromDecision, researchFromPreview, researchOutcome, type Research, type ResearchSource } from './web-research-model.js';
import { DecisionsContext } from './decisions.js';
import { ago, decisionSummary, mayReview, type DecisionView } from './decisions-model.js';
import { useToast } from './toasts.js';

/* The web_search review card (in the dock) and its line where the search was made. */

/** Sources as links (opened in a new tab, without referrer), with their number, site and note. */
export function SourceList({ sources, compact = false }: { sources: readonly ResearchSource[]; compact?: boolean }) {
  if (!sources.length) return null;
  return <ol className={`web-sources${compact ? ' compact' : ''}`} aria-label="Sources">
    {sources.map(source => <li key={source.n}>
      <span className="web-source-n" aria-hidden="true">{source.n}</span>
      <span className="web-source-text">
        {source.href
          ? <a href={source.href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">{source.title}<ExternalLink size={11} aria-hidden="true" className="web-source-ext"/></a>
          : <span>{source.title}</span>}
        <span className="web-source-host">{source.host}{!compact && source.note ? ` · ${source.note}` : ''}</span>
      </span>
    </li>)}
  </ol>;
}

/** Summary, claims (with their source numbers) and sources. */
function ResearchBody({ research, compact = false }: { research: Research; compact?: boolean }) {
  return <div className="web-research-body">
    {research.summary && <p className="web-summary">{research.summary}</p>}
    {!!research.claims.length && <ul className="web-claims" aria-label="Claims">
      {research.claims.map((claim, i) => <li key={i}>{claim.text}{claim.sources.map(n => <sup key={n} className="web-cite">[{n}]</sup>)}</li>)}
    </ul>}
    <SourceList sources={research.sources} compact={compact}/>
  </div>;
}

type CardProps = { request: InteractionRequest; outcome?: string; answer(value: InteractionResponse): Promise<void>; onDismiss(): void };

/**
 * The review card of a web search: what was found (summary, claims,
 * sources), before the agent sees any of it. Approve, Reject, or Reject with
 * a note for the agent. The agent never sees the result if it is rejected.
 */
export function WebResearchCard({ request, outcome, answer, onDismiss }: CardProps) {
  const research = researchFromPreview(request.preview);
  const submitted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const card = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const locked = busy || !!outcome;
  useEffect(() => { card.current?.focus({ preventScroll: true }); }, []);
  const send = async (value: Omit<InteractionResponse, 'id'>) => {
    if (submitted.current || outcome) return;
    submitted.current = true; setBusy(true); setError('');
    try { await answer({ id: request.id, ...value }); }
    catch { setError('Couldn’t confirm delivery. Refresh to reconnect — don’t answer again.'); }
  };
  const reject = () => void send({ approved: false, ...(note.trim() && request.allowNote ? { text: note.trim().slice(0, 1000) } : {}) });
  if (!research) return null;
  return <section ref={card} tabIndex={-1} className="card approval-card web-research-card" aria-label={`Review web research: ${research.query}`} aria-busy={busy || undefined}
    onKeyDown={event => {
      if (locked || event.nativeEvent.isComposing || event.target !== card.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reject(); }
      else if (event.key === 'Enter') { event.preventDefault(); void send({ approved: true }); }
    }}>
    <header className="card-head"><Globe size={16} aria-hidden="true"/><span>Review web research</span></header>
    <h2 className="card-title">“{research.query}”</h2>
    <p className="card-details">The agent sees this only if you approve it, labelled as untrusted web content.{research.purpose ? <> It searched to: {research.purpose}</> : null}</p>
    <div className="web-review-scroll"><ResearchBody research={research}/></div>
    <p className="web-meta">{research.sources.length} source{research.sources.length === 1 ? '' : 's'}{research.pagesRead !== undefined ? ` · ${research.pagesRead} page${research.pagesRead === 1 ? '' : 's'} read` : ''}{research.dropped ? ` · ${research.dropped} dropped as irrelevant` : ''}{expiryLabel(request.expiresAt) ? <> · {expiryLabel(request.expiresAt)}</> : null}</p>
    {noting && <textarea ref={field} className="other-field" aria-label="Note for the agent" placeholder="Why you reject it (the agent sees this note, not the research)…" maxLength={1000} rows={2} value={note} disabled={locked}
      onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); reject(); } }}/>}
    <div className="card-actions">
      <span className="hint" aria-hidden="true">{noting ? <><kbd>Enter</kbd> reject with this note</> : <><kbd>Enter</kbd> approve · <kbd>Esc</kbd> reject</>}</span>
      {request.allowNote && !noting && <button type="button" className="btn ghost" disabled={locked} onClick={() => { setNoting(true); requestAnimationFrame(() => field.current?.focus()); }}>Reject with note…</button>}
      <button type="button" className="btn ghost" disabled={locked} onClick={reject}>Reject</button>
      <button type="button" className="btn primary" disabled={locked} onClick={() => void send({ approved: true })}>Approve</button>
    </div>
    {error ? <p className="dock-status" role="alert">{error}</p>
      : outcome ? <div className="dock-status" role="status"><span>{outcome}</span><button type="button" className="link-btn" onClick={onDismiss}>Dismiss</button></div>
      : busy ? <p className="dock-status" role="status">Sending…</p> : null}
  </section>;
}

/** Someone else's web research waiting for review: shown, not answerable. */
export function WebResearchWaiting({ request, waitingFor }: { request: InteractionRequest; waitingFor: string }) {
  const research = researchFromPreview(request.preview);
  return <section className="card waiting-card web-research-card" aria-label="Web research waiting for review">
    <header className="card-head"><Globe size={16} aria-hidden="true"/><span>Web research waiting for review</span></header>
    <h2 className="card-title">{research ? `“${research.query}”` : 'Web research'}</h2>
    <p className="card-details">Waiting for {waitingFor} to approve or reject it. Only they, or an admin of this agent, can.</p>
  </section>;
}

/**
 * Where the agent searched: one line ("Web research approved: …" or
 * "Web research dismissed: …"); expanded, what the agent received.
 */
export function WebResearchLine({ toolCallId, argsText, result, pending, decided }: { toolCallId: string; argsText: string; result: unknown; pending: boolean; decided?: InteractionResponse }) {
  const [open, setOpen] = useState(false);
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsText || '{}'); } catch { args = {}; }
  const query = typeof args.query === 'string' ? args.query.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (result === undefined) {
    const label = decided ? (decided.approved ? `Web research approved: ${query}` : `Web research dismissed: ${query}`) : pending ? `Web research ready for review: ${query}` : `Searching the web: ${query}…`;
    return <div className="line web-line" data-tone={pending && !decided ? 'pending' : 'running'} data-tool-call-id={toolCallId}>
      <span className="line-summary static">
        {pending && !decided ? <Globe size={14} className="line-icon" aria-hidden="true"/> : <LoaderCircle size={14} className="line-icon spin" aria-hidden="true"/>}
        <span className={`line-label${pending && !decided ? '' : ' shimmer'}`}>{label}</span>
        {pending && !decided && <span className="line-meta">Review below</span>}
      </span>
    </div>;
  }
  const outcome = researchOutcome(args, result);
  if (outcome.state === 'awaiting') return <ResearchDecision id={outcome.decision} query={query} toolCallId={toolCallId}/>;
  const Icon = outcome.state === 'approved' ? ShieldCheck : outcome.state === 'dismissed' ? ShieldX : outcome.state === 'expired' ? Clock : outcome.state === 'failed' || outcome.state === 'needed-approval' ? CircleAlert : Globe;
  const id = `web-${toolCallId}`;
  return <div className="line web-line" data-tone={outcome.state === 'approved' ? 'answered' : outcome.state === 'dismissed' || outcome.state === 'expired' ? 'denied' : outcome.state === 'failed' || outcome.state === 'needed-approval' ? 'error' : 'done'} data-open={open || undefined} data-tool-call-id={toolCallId} data-conversation-part="web-research">
    <button type="button" className="line-summary" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
      <Icon size={14} className="line-icon" aria-hidden="true"/><span className="line-label">{outcome.label}</span>
      {outcome.state === 'approved' && <span className="line-meta">{outcome.research.sources.length} source{outcome.research.sources.length === 1 ? '' : 's'}</span>}
      <ChevronRight size={14} className="chev" aria-hidden="true"/>
    </button>
    <div id={id} className="line-detail" hidden={!open}>
      <div className="tool-detail">
        {outcome.state === 'approved' && <><p className="muted">{outcome.reviewed ? 'Approved: the agent received this, labelled as untrusted web content.' : 'This automation was allowed to search without review: the agent received this, labelled as untrusted and unreviewed.'}</p><ResearchBody research={outcome.research}/></>}
        {outcome.state === 'dismissed' && <p className="muted">Rejected: the agent was told the search was dismissed and saw none of it.{outcome.note ? <> Note to the agent: “{outcome.note}”</> : null}</p>}
        {'detail' in outcome && outcome.detail && <p className="muted">{outcome.detail}</p>}
      </div>
    </div>
  </div>;
}

/** Sources of the web research the agent used in this reply, as links under it (when it searched). */
export function ReplySources({ results }: { results: { argsText: string; result: unknown }[] }) {
  const seen = new Set<string>();
  const sources: ResearchSource[] = [];
  for (const { argsText, result } of results) {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsText || '{}'); } catch { /* none */ }
    const outcome = researchOutcome(args, result);
    if (outcome.state !== 'approved') continue;
    for (const source of outcome.research.sources) if (source.href && !seen.has(source.href)) { seen.add(source.href); sources.push({ ...source, n: sources.length + 1 }); }
  }
  if (!sources.length) return null;
  return <div className="reply-sources"><span className="reply-sources-label">Sources (web research)</span><SourceList sources={sources.slice(0, 12)} compact/></div>;
}

/** Re-exported so the chat can tell a web research request from other approvals. */
export const isWebResearch = (request?: InteractionRequest) => request?.kind === 'approval' && request.tool === 'web_search' && request.preview?.kind === 'web-research';

/**
 * A web search result nobody reviewed in time, now a decision: the review
 * card in place (no time limit), then one line with how it ended. Only the
 * person whose message started the search, or an admin, can review it.
 */
function ResearchDecision({ id, query, toolCallId }: { id: string; query: string; toolCallId: string }) {
  const state = useContext(DecisionsContext);
  const decision = state.byId.get(id);
  useEffect(() => { if (!decision) state.ensure(id); }, [id, decision, state]);
  const [open, setOpen] = useState(false);
  if (decision?.status === 'pending') return <ResearchDecisionCard decision={decision}/>;
  const label = !decision ? `Web research waiting for review: ${query}` : decisionSummary(decision, state.me) === undefined ? `Web research: ${query}`
    : decision.status === 'cancelled' ? `Web research review closed: ${query}`
    : decision.choice?.id === 'approve' ? `Web research approved later: ${query}` : decision.choice?.id === 'search_again' ? `Web research: new search asked for: ${query}` : `Web research dismissed: ${query}`;
  const research = researchFromDecision(decision?.research);
  const Icon = decision?.choice?.id === 'approve' ? ShieldCheck : decision?.choice?.id === 'search_again' ? RefreshCw : decision ? ShieldX : Clock;
  return <div className="line web-line" data-tone={decision?.choice?.id === 'approve' ? 'answered' : decision ? 'denied' : 'pending'} data-open={open || undefined} data-tool-call-id={toolCallId} id={`decision-${id}`}>
    <button type="button" className="line-summary" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <Icon size={14} className="line-icon" aria-hidden="true"/><span className="line-label">{label}</span>
      {decision?.decidedAt && <span className="line-meta">{ago(decision.decidedAt)}</span>}
      <ChevronRight size={14} className="chev" aria-hidden="true"/>
    </button>
    {open && <div className="line-detail"><div className="tool-detail">
      <p className="muted">{decision ? `${decisionSummary(decision, state.me) ?? ''}. The outcome reached the agent as a new message.` : 'Nobody reviewed it in time, so it waits as a decision. The agent has none of it yet.'}{decision?.comment ? ` Note: “${decision.comment}”` : ''}</p>
      {research && <ResearchBody research={research}/>}
    </div></div>}
  </div>;
}

/** The card of a web research decision: like the review card, without a time limit; "Search again" once the result is stale. */
export function ResearchDecisionCard({ decision }: { decision: DecisionView }) {
  const { decide, me, admin } = useContext(DecisionsContext);
  const toast = useToast();
  const research = researchFromDecision(decision.research);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const sent = useRef(false);
  const allowed = mayReview(decision, me, !!admin);
  // Stale once `staleAt` passes, also while the page stays open.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const stale = decision.stale || (!!decision.staleAt && now >= Date.parse(decision.staleAt));
  const submit = async (choice: 'approve' | 'reject' | 'search_again') => {
    if (sent.current) return;
    sent.current = true; setBusy(true);
    try { await decide(decision.id, { choice, ...(choice !== 'approve' && note.trim() ? { comment: note.trim().slice(0, 1000) } : {}) }); }
    catch (error) { sent.current = false; toast((error as Error).message, { tone: 'error' }); }
    finally { setBusy(false); }
  };
  const searchedAt = typeof decision.research?.searchedAt === 'string' ? decision.research.searchedAt : decision.createdAt;
  return <section className="card approval-card web-research-card decision-card" id={`decision-${decision.id}`} aria-label={`Review web research: ${research?.query ?? ''}`} aria-busy={busy || undefined}>
    <header className="card-head"><Globe size={16} aria-hidden="true"/><span>Web research waiting for review</span><span className="decision-asked">searched {ago(searchedAt)}</span></header>
    <h2 className="card-title">“{research?.query ?? decision.question}”</h2>
    <p className="card-details">Nobody reviewed it in time, so the agent ended its turn without it. Approve it to send it to the agent (as untrusted web content, with its age); there is no time limit.{stale ? ' It is old now: you can also ask for a new search.' : ''}</p>
    {research && <div className="web-review-scroll"><ResearchBody research={research}/></div>}
    {research && <p className="web-meta">{research.sources.length} source{research.sources.length === 1 ? '' : 's'}{research.dropped ? ` · ${research.dropped} dropped as irrelevant` : ''}</p>}
    {noting && allowed && <textarea className="other-field" aria-label="Note for the agent" placeholder="A note for the agent (optional)…" maxLength={1000} rows={2} value={note} disabled={busy} onChange={e => setNote(e.target.value)}/>}
    {allowed
      ? <div className="card-actions">
          {!noting && <button type="button" className="btn ghost" disabled={busy} onClick={() => setNoting(true)}>Reject with note…</button>}
          {stale && <button type="button" className="btn ghost" disabled={busy} onClick={() => void submit('search_again')}><RefreshCw size={14} aria-hidden="true"/>Search again</button>}
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void submit('reject')}>Reject</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit('approve')}>{busy ? 'Sending…' : 'Approve'}</button>
        </div>
      : <p className="card-details">Waiting for {decision.reviewer?.name ?? 'the person who asked'} to review it. Only they, or an admin of this agent, can.</p>}
  </section>;
}
