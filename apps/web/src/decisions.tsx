import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { Bell, Check, ChevronRight, CircleStop, CornerDownRight, Globe, LoaderCircle, Signpost } from 'lucide-react';
import { useAuiState } from '@assistant-ui/react';
import { useToast } from './toasts.js';
import { ago, askedBy, bellCount, bellLabel, decideError, decisionSummary, outcomeSummary, requestedId, type DecisionOutcome, type DecisionView, type FeedDecision } from './decisions-model.js';

/* ------------------------------------------------------------------ */
/* State shared with the conversation                                  */
/* ------------------------------------------------------------------ */

/**
 * The open conversation's decisions (by ID), who is looking (`me`: their user
 * ID on a team server, `undefined` in the single-user app), and how to decide.
 * `ensure` loads a decision the page does not know yet (one asked live).
 */
export type DecisionsState = { byId: ReadonlyMap<string, DecisionView>; me?: string; team: boolean; admin?: boolean; decide(id: string, body: { choice?: string; stop?: true; comment?: string }): Promise<void>; ensure(id: string): void };
export const DecisionsContext = createContext<DecisionsState>({ byId: new Map(), team: false, decide: async () => {}, ensure: () => {} });

/** Re-render every 30 seconds, so "3 min ago" stays true. */
function useTick(ms = 30_000) {
  const [, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(n => n + 1), ms); return () => clearInterval(timer); }, [ms]);
}

/* ------------------------------------------------------------------ */
/* The notification bell                                               */
/* ------------------------------------------------------------------ */

/** Pending decisions of every agent you belong to, kept current by a long poll of `/api/decisions`. */
export function useDecisionFeed(enabled: boolean): { decisions: FeedDecision[]; loaded: boolean } {
  const [state, setState] = useState<{ decisions: FeedDecision[]; loaded: boolean }>({ decisions: [], loaded: false });
  useEffect(() => {
    if (!enabled) return;
    const control = new AbortController();
    void (async () => {
      let since = -1;
      while (!control.signal.aborted) {
        try {
          const response = await fetch(`/api/decisions?since=${since}`, { credentials: 'same-origin', signal: control.signal });
          if (!response.ok) throw new Error(String(response.status));
          const data = await response.json() as { version: number; decisions: FeedDecision[] };
          since = data.version;
          setState({ decisions: data.decisions, loaded: true });
        } catch { if (control.signal.aborted) return; await new Promise(resolve => setTimeout(resolve, 3000)); }
      }
    })();
    return () => control.abort();
  }, [enabled]);
  return state;
}

/**
 * The bell: how many decisions wait for you (across your agents), and a panel
 * that lists them; choosing one opens its conversation.
 */
export function DecisionBell({ decisions, showAgent, me, onOpen }: { decisions: readonly FeedDecision[]; showAgent: boolean; me?: { id: string; name: string }; onOpen(decision: FeedDecision): void }) {
  const [open, setOpen] = useState(false);
  useTick();
  const count = decisions.length;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" className="icon-btn small bell-btn" aria-label={bellLabel(count)} title={bellLabel(count)} data-count={count || undefined}>
        <Bell size={16} aria-hidden="true"/>
        {count > 0 && <span className="bell-count" aria-hidden="true">{bellCount(count)}</span>}
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="menu bell-panel" align="start" side="bottom" sideOffset={6} collisionPadding={8} aria-label="Decisions waiting">
        <header className="bell-head"><span>Decisions</span>{count > 0 && <span className="bell-head-count">{count} waiting</span>}</header>
        {!count && <p className="bell-empty">Nothing to decide. When an agent needs a decision from you or your team, it shows up here.</p>}
        {!!count && <ul className="bell-list">
          {decisions.map(decision => <li key={decision.id}>
            <button type="button" className="bell-item" onClick={() => { setOpen(false); onOpen(decision); }}>
              <span className="bell-item-icon" aria-hidden="true">{decision.kind === 'web-research' ? <Globe size={14}/> : <Signpost size={14}/>}</span>
              <span className="bell-item-body">
                <span className="bell-item-question">{decision.question}</span>
                <span className="bell-item-where">{showAgent ? `${decision.agent.name} · ` : ''}{decision.thread.title}</span>
                <span className="bell-item-meta">{askedBy(decision, me)} · {ago(decision.createdAt)}</span>
              </span>
              <ChevronRight size={14} className="bell-item-chev" aria-hidden="true"/>
            </button>
          </li>)}
        </ul>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

/* ------------------------------------------------------------------ */
/* In the conversation                                                 */
/* ------------------------------------------------------------------ */

type ToolProps = { toolCallId: string; argsText: string; result?: unknown; isError?: boolean };

/**
 * Where the agent asked (its `request_decision` call): the decision card while
 * it is pending, then one compact line with how it ended.
 */
export function DecisionLine({ toolCallId, argsText, result, isError }: ToolProps) {
  const state = useContext(DecisionsContext);
  const id = requestedId(result);
  const decision = id ? state.byId.get(id) : undefined;
  useEffect(() => { if (id && !decision) state.ensure(id); }, [id, decision, state]);
  let question = '';
  try { question = String((JSON.parse(argsText) as { question?: unknown }).question ?? ''); } catch { /* no question */ }
  if (result === undefined) return <div className="line decision-line" data-tone="running" data-tool-call-id={toolCallId}>
    <span className="line-summary static"><LoaderCircle size={14} className="line-icon spin" aria-hidden="true"/><span className="line-label">Asking for a decision{question ? `: ${question}` : '…'}</span></span>
  </div>;
  if (isError || !id) return <div className="line decision-line" data-tone="error" data-tool-call-id={toolCallId}>
    <span className="line-summary static"><Signpost size={14} className="line-icon" aria-hidden="true"/><span className="line-label">Couldn’t ask for a decision{question ? `: ${question}` : ''}</span></span>
  </div>;
  if (!decision) return <div className="line decision-line" data-tone="pending" data-tool-call-id={toolCallId}>
    <span className="line-summary static"><Signpost size={14} className="line-icon" aria-hidden="true"/><span className="line-label">Decision: {question}</span></span>
  </div>;
  if (decision.status === 'pending') return <DecisionCard decision={decision}/>;
  return <SettledDecision decision={decision}/>;
}

/** A decision that ended: one line ("Asked: … · Decided by Mia: CSV table"); expanded, the options with the choice marked. */
function SettledDecision({ decision }: { decision: DecisionView }) {
  const { me } = useContext(DecisionsContext);
  const [open, setOpen] = useState(false);
  const summary = decisionSummary(decision, me)!;
  return <div className="line decision-line" data-tone={decision.status} data-open={open || undefined} id={`decision-${decision.id}`}>
    <button type="button" className="line-summary" aria-expanded={open} onClick={() => setOpen(o => !o)} aria-label={`Decision: ${decision.question}. ${summary}`}>
      <Signpost size={14} className="line-icon" aria-hidden="true"/>
      <span className="line-label">Asked: {decision.question}</span>
      <span className="line-meta">{decision.status === 'cancelled' ? summary.toLowerCase() : decision.status === 'stopped' ? 'work stopped' : 'decided'}</span>
      <ChevronRight size={14} className="chev" aria-hidden="true"/>
    </button>
    {open && <div className="line-detail decision-detail">
      {decision.context && <p className="muted decision-context">{decision.context}</p>}
      <ul className="answer-options">{decision.options.map(option => <li key={option.id} data-selected={decision.choice?.id === option.id || undefined}>
        {decision.choice?.id === option.id ? <Check size={13} aria-label="Chosen"/> : <span className="bullet" aria-hidden="true"/>}{option.label}
      </li>)}</ul>
      <p className="decision-who">{summary}{decision.decidedAt ? ` · ${ago(decision.decidedAt)}` : decision.cancelledAt ? ` · ${ago(decision.cancelledAt)}` : ''}</p>
      {decision.comment && <blockquote className="decision-comment">{decision.comment}</blockquote>}
    </div>}
  </div>;
}

/**
 * The card of a pending decision: the question, the agent's context, the
 * options (choose one, then Decide), an optional comment, and "Stop this
 * work". Exactly one decision is accepted: if someone was faster, the card
 * says who decided what.
 */
export function DecisionCard({ decision }: { decision: DecisionView }) {
  const { decide, team } = useContext(DecisionsContext);
  const toast = useToast();
  const [choice, setChoice] = useState<string>();
  const [comment, setComment] = useState('');
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const sent = useRef(false);
  useTick();
  const submit = async (body: { choice?: string; stop?: true }) => {
    if (sent.current) return;
    sent.current = true; setBusy(true);
    try { await decide(decision.id, { ...body, ...(comment.trim() ? { comment: comment.trim() } : {}) }); }
    catch (error) { sent.current = false; toast((error as Error).message, { tone: 'error' }); }
    finally { setBusy(false); }
  };
  return <section className="card decision-card" id={`decision-${decision.id}`} aria-label={`Decision needed: ${decision.question}`} aria-busy={busy || undefined}>
    <header className="card-head"><Signpost size={16} aria-hidden="true"/><span>Decision needed</span><span className="decision-asked">{askedBy(decision)} · {ago(decision.createdAt)}</span></header>
    <h2 className="card-title">{decision.question}</h2>
    {decision.context && <p className="card-details decision-context">{decision.context}</p>}
    <div className="options" role="radiogroup" aria-label="Options">
      {decision.options.map((option, index) => <button key={option.id} type="button" role="radio" aria-checked={choice === option.id} className="option decision-option" data-selected={choice === option.id || undefined} disabled={busy}
        data-first={index === 0 || undefined} onClick={() => { setChoice(option.id); setStopping(false); }}>
        <span className="radio" aria-hidden="true"/>
        <span className="option-label">{option.label}{option.description && <span className="option-description">{option.description}</span>}</span>
      </button>)}
    </div>
    {decision.allowComment && <textarea className="other-field decision-comment-field" aria-label="Comment for the agent (optional)" placeholder="Add a comment for the agent (optional)" maxLength={1000} rows={1} value={comment} disabled={busy}
      onChange={event => setComment(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && choice) { event.preventDefault(); void submit({ choice }); } }}/>}
    {stopping
      ? <div className="decision-stop" role="group" aria-label="Stop this work?">
          <span>Stop this work? The agent will be told to stop{decision.allowComment && comment.trim() ? ', with your comment' : ''}.</span>
          <span className="decision-stop-actions">
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setStopping(false)}>Keep waiting</button>
            <button type="button" className="btn small danger" disabled={busy} onClick={() => void submit({ stop: true })}>{busy ? 'Stopping…' : 'Stop work'}</button>
          </span>
        </div>
      : <div className="card-actions">
          <button type="button" className="btn ghost stop-work" disabled={busy} onClick={() => setStopping(true)}><CircleStop size={15} aria-hidden="true"/>Stop this work</button>
          <button type="button" className="btn primary" disabled={!choice || busy} onClick={() => choice && void submit({ choice })}>{busy ? 'Sending…' : 'Decide'}</button>
        </div>}
    <p className="decision-note">{team ? 'Anyone in this agent can decide, once. ' : ''}You can keep chatting with the agent meanwhile; the work resumes when {team ? 'someone decides' : 'you decide'}.</p>
  </section>;
}

/** A decision's outcome, where it reached the agent: "Decided by Mia: CSV table · 2 min ago", with the comment. */
export function OutcomeLine({ outcome, time }: { outcome: DecisionOutcome; time?: string }) {
  const { me } = useContext(DecisionsContext);
  useTick();
  const label = outcomeSummary(outcome, me);
  return <div className="decision-outcome" data-outcome={outcome.outcome} role="note" aria-label={`${label}${time ? `, ${ago(time)}` : ''}`}>
    <span className="decision-outcome-line">
      {outcome.outcome === 'stopped' ? <CircleStop size={14} aria-hidden="true"/> : outcome.kind === 'web-research' ? <Globe size={14} aria-hidden="true"/> : <Check size={14} aria-hidden="true"/>}
      <span className="decision-outcome-label">{label}</span>
      {time && <time dateTime={time} className="decision-outcome-time">· {ago(time)}</time>}
    </span>
    {outcome.comment && <span className="decision-outcome-comment"><CornerDownRight size={12} aria-hidden="true"/>{outcome.comment}</span>}
  </div>;
}
/** The outcome line for a message (reads it from the message). */
export function OutcomeMessage() {
  const outcome = useAuiState(s => (s.message.metadata.custom as { decision?: DecisionOutcome } | undefined)?.decision);
  const time = useAuiState(s => (s.message.metadata.custom as { time?: string } | undefined)?.time);
  return outcome ? <OutcomeLine outcome={outcome} time={time}/> : null;
}

/**
 * Above the composer while the open conversation has a pending decision and
 * its card is out of view: one line that brings you to it.
 */
export function PendingDecisionBar({ decision }: { decision?: DecisionView }) {
  const [hidden, setHidden] = useState(true);
  const id = decision?.id;
  useEffect(() => {
    if (!id) return;
    // The card's node is replaced when history reloads: look it up each time instead of observing one node.
    const check = () => {
      const card = document.getElementById(`decision-${id}`);
      const viewport = card?.closest('.viewport') ?? document.querySelector('.viewport');
      if (!card || !viewport) { setHidden(false); return; }
      const a = card.getBoundingClientRect(), b = viewport.getBoundingClientRect();
      const visible = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      setHidden(visible >= Math.min(120, a.height * 0.25));
    };
    check();
    const timer = setInterval(check, 700);
    document.addEventListener('scroll', check, true);
    window.addEventListener('resize', check);
    return () => { clearInterval(timer); document.removeEventListener('scroll', check, true); window.removeEventListener('resize', check); };
  }, [id]);
  if (!decision || hidden) return null;
  const show = () => {
    const card = document.getElementById(`decision-${decision.id}`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    (card?.querySelector('.decision-option') as HTMLElement | null)?.focus({ preventScroll: true });
  };
  return <button type="button" className="pending-decision" onClick={show}>
    <Signpost size={14} aria-hidden="true"/><span className="pending-decision-label">Decision waiting</span><span className="pending-decision-question">{decision.question}</span><span className="pending-decision-go">Decide</span>
  </button>;
}

/** The error a decide call failed with, as toast text. */
export function decideMessage(code: string, decision?: DecisionView, me?: string) { return decideError(code, decision, me); }
