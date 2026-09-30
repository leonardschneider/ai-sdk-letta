import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { ActionBarPrimitive, MessagePrimitive, groupPartByType, useAuiState, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { Check, ChevronRight, CircleAlert, Copy, CornerDownRight, LoaderCircle, MessageCircleQuestion, ShieldAlert, ShieldCheck, ShieldX, Wrench } from 'lucide-react';
import type { InteractionRequest, InteractionResponse } from 'ai-sdk-letta';
import { answerLine, describeArguments, failureReason, failureText, friendlyName, metricsLine, parseArgs, toolLabel, toolSummary, type ToolPhase } from './presentation.js';
import { Markdown } from './markdown.js';

/* ------------------------------------------------------------------ */
/* Interaction state shared between the inline lines and the dock      */
/* ------------------------------------------------------------------ */

export type InteractionState = { request?: InteractionRequest; outcome?: string; sent?: InteractionResponse; approvalTools: ReadonlySet<string>; answer(value: InteractionResponse): Promise<void> };
export const InteractionContext = createContext<InteractionState>({ approvalTools: new Set(), answer: async () => {} });
/** Outcomes that mean the answer was delivered; the dock then collapses into the inline line. */
export const deliveredOutcome = (outcome?: string) => !!outcome && outcome.startsWith('Response received');

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function formatTime(value: string) {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? timeFormat.format(date) : fullFormat.format(date);
}

/**
 * Author slot. Single-user today, so nothing is rendered; a multi-user build can
 * return a name from message metadata here without restructuring the layout.
 */
function MessageAuthor(_: { role: string }) { return null; }

export function Message() {
  const role = useAuiState(s => s.message.role);
  const time = useAuiState(s => (s.message.metadata.custom as { time?: string } | undefined)?.time);
  const hasText = useAuiState(s => s.message.parts.some(p => p.type === 'text' && p.text.trim()));
  return <MessagePrimitive.Root className="msg" data-role={role}>
    <MessageAuthor role={role}/>
    <div className="msg-body">
      {role === 'user'
        ? <div className="bubble"><MessagePrimitive.Parts>{({ part }) => part.type === 'text' ? <p className="user-text">{part.text}</p> : <></>}</MessagePrimitive.Parts></div>
        : <AssistantParts/>}
    </div>
    {(hasText || time) && <ActionBarPrimitive.Root className="msg-actions" hideWhenRunning autohide="never">
      {hasText && <ActionBarPrimitive.Copy className="icon-btn small copy-btn" aria-label="Copy message" title="Copy">
        <Copy size={14} className="when-idle" aria-hidden="true"/><Check size={14} className="when-copied" aria-hidden="true"/>
      </ActionBarPrimitive.Copy>}
      {time && <time dateTime={time} title={fullFormat.format(new Date(time))}>{formatTime(time)}</time>}
    </ActionBarPrimitive.Root>}
  </MessagePrimitive.Root>;
}

/** Questions stay ungrouped so they read as part of the conversation. */
const groupTools = groupPartByType({ 'tool-call': ['group-tools'], 'tool-call:ask_user': [] });

function AssistantParts() {
  return <MessagePrimitive.GroupedParts groupBy={groupTools} indicator="no-text">
    {({ part, children }) => {
      switch (part.type) {
        case 'group-tools': return part.indices.length > 1 ? <ToolGroup count={part.indices.length} running={part.counts.running > 0} indices={part.indices}>{children}</ToolGroup> : <>{children}</>;
        case 'text': return part.text ? <Markdown/> : <></>;
        case 'tool-call': return <ToolPart {...part}/>;
        case 'indicator': return <Thinking/>;
        default: return <></>;
      }
    }}
  </MessagePrimitive.GroupedParts>;
}

/** Shown until the first streamed content, and while the agent works between steps. */
function Thinking() {
  const waitingOnTool = useAuiState(s => { const last = s.message.parts.at(-1); return last?.type === 'tool-call' && last.result === undefined; });
  if (waitingOnTool) return <></>;
  return <div className="thinking" role="status" aria-label="Assistant is thinking"><span className="dot"/><span className="dot"/><span className="dot"/><span className="sr-only">Thinking…</span></div>;
}

/* ------------------------------------------------------------------ */
/* Tool activity                                                       */
/* ------------------------------------------------------------------ */

type ToolPartProps = Pick<ToolCallMessagePartProps, 'toolCallId' | 'toolName' | 'argsText' | 'result' | 'isError'>;
function phaseOf(result: unknown, isError?: boolean): ToolPhase { return result === undefined ? 'running' : isError ? 'error' : 'done'; }

function ToolPart(props: ToolPartProps) {
  if (props.toolName === 'ask_user') return <QuestionLine {...props}/>;
  return <ToolLine {...props}/>;
}

/** A quiet, expandable line. The expanded view is friendly first; raw data stays nested and collapsed. */
function Disclosure({ summary, children, className, tone, label }: { summary: React.ReactNode; children: React.ReactNode; className?: string; tone?: string; label: string }) {
  const [open, setOpen] = useState(false);
  const id = useRef(`d-${Math.random().toString(36).slice(2)}`).current;
  return <div className={`line ${className ?? ''}`} data-tone={tone} data-open={open || undefined}>
    <button type="button" className="line-summary" aria-expanded={open} aria-controls={id} aria-label={label} onClick={() => setOpen(o => !o)}>
      {summary}<ChevronRight size={14} className="chev" aria-hidden="true"/>
    </button>
    <div id={id} className="line-detail" hidden={!open}>{children}</div>
  </div>;
}

function Technical({ toolName, argsText, result }: { toolName: string; argsText: string; result: unknown }) {
  const [open, setOpen] = useState(false);
  return <div className="technical">
    <button type="button" className="technical-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}><ChevronRight size={12} className="chev" aria-hidden="true"/>Technical details</button>
    {open && <div className="technical-body">
      <div className="tech-row"><span>Tool</span><code>{toolName}</code></div>
      <span className="tech-label">Arguments</span><pre>{pretty(argsText)}</pre>
      {result !== undefined && <><span className="tech-label">Result</span><pre>{typeof result === 'string' ? pretty(result) : JSON.stringify(result, null, 2)}</pre></>}
    </div>}
  </div>;
}
function pretty(text: string) { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } }

function Value({ value }: { value: string }) {
  const [full, setFull] = useState(false);
  if (value.length <= 280 || full) return <span className="value">{value}</span>;
  return <span className="value">{value.slice(0, 280)}… <button type="button" className="link-btn" onClick={() => setFull(true)}>Show all</button></span>;
}

function ToolLine({ toolCallId, toolName, argsText, result, isError }: ToolPartProps) {
  const active = useContext(InteractionContext);
  const pendingApproval = active.request?.kind === 'approval' && active.request.toolCallId === toolCallId && result === undefined;
  const phase = phaseOf(result, isError);
  const args = parseArgs(argsText);
  const denied = phase === 'error' && ['user_denied', 'approval_cancelled'].includes(failureReason(result) ?? '');
  const decided = pendingApproval && active.sent?.id === active.request?.id ? active.sent : undefined;
  const label = pendingApproval
    ? decided ? (decided.approved ? `Allowed: ${friendlyName(toolName)} · running…` : `Denied: ${friendlyName(toolName)}`) : `Waiting for your permission: ${friendlyName(toolName)}`
    : toolLabel(toolName, phase, result);
  const summary = phase === 'done' ? toolSummary(toolName, result, args) : { fields: [] };
  const approval = active.approvalTools.has(toolName) || pendingApproval;
  const Icon = phase === 'running' ? LoaderCircle : denied ? ShieldX : phase === 'error' ? CircleAlert : approval ? ShieldCheck : Wrench;
  return <Disclosure className="tool-line" tone={phase === 'running' ? 'running' : denied ? 'denied' : phase} label={label}
    summary={<><Icon size={14} className={`line-icon ${phase === 'running' ? 'spin' : ''}`} aria-hidden="true"/><span className={`line-label ${phase === 'running' ? 'shimmer' : ''}`}>{label}</span>
      {phase === 'done' && summary.metrics && <span className="line-meta">{metricsLine(summary.metrics)}</span>}</>}>
    <div data-tool-call-id={toolCallId} className="tool-detail">
      {phase === 'running' && <p className="muted">{decided ? 'Your decision was sent. Waiting for the agent…' : pendingApproval ? 'Waiting for you to allow or deny this below.' : 'Working on it…'}</p>}
      {phase === 'error' && <p className="muted">{failureText(result)}</p>}
      {summary.metrics && <dl className="metrics">{summary.metrics.map(m => <div key={m.label}><dt>{m.label}</dt><dd>{m.value}</dd></div>)}</dl>}
      {!!summary.fields.length && <dl className="fields">{summary.fields.map((f, i) => <div key={i}><dt>{f.label}</dt><dd><Value value={f.value}/></dd></div>)}</dl>}
      <Technical toolName={toolName} argsText={argsText} result={result}/>
    </div>
  </Disclosure>;
}

function ToolGroup({ count, running, children }: { count: number; running: boolean; indices: readonly number[]; children: React.ReactNode }) {
  const runningLabel = useAuiState(s => {
    const part = [...s.message.parts].reverse().find(p => p.type === 'tool-call' && p.result === undefined);
    return part?.type === 'tool-call' ? toolLabel(part.toolName, 'running') : undefined;
  });
  const label = running ? runningLabel ?? `Using ${count} tools…` : `Used ${count} tools`;
  return <Disclosure className="tool-group" tone={running ? 'running' : 'done'} label={label}
    summary={<><Wrench size={14} className="line-icon" aria-hidden="true"/><span className={`line-label ${running ? 'shimmer' : ''}`}>{label}</span></>}>
    <div className="group-body">{children}</div>
  </Disclosure>;
}

/** An answered question collapses to one line where it was asked. */
function QuestionLine({ toolCallId, toolName, argsText, result, isError }: ToolPartProps) {
  const active = useContext(InteractionContext);
  const args = parseArgs(argsText);
  const question = String(args.question ?? 'Question');
  if (result === undefined) {
    const mine = active.request?.toolCallId === toolCallId;
    const sent = mine && deliveredOutcome(active.outcome);
    return <div className="line question-line" data-tone="pending" data-tool-call-id={toolCallId} data-conversation-part="question-pending">
      <span className="line-summary static"><MessageCircleQuestion size={14} className="line-icon" aria-hidden="true"/>
        <span className="line-label">{sent ? 'Answer sent · waiting for the agent…' : `Asked: ${question}`}</span>
        {mine && !sent && !active.outcome && <span className="line-meta">Answer below</span>}
      </span>
    </div>;
  }
  const line = answerLine(result, args, isError);
  const options = Array.isArray(args.options) ? args.options as { id: string; label: string }[] : [];
  let selected: string[] = [];
  try { const data = typeof result === 'string' ? JSON.parse(result) : result; if (Array.isArray(data?.selected)) selected = data.selected; } catch { /* no selection */ }
  return <Disclosure className="question-line" tone={line.state} label={line.text}
    summary={<><CornerDownRight size={14} className="line-icon" aria-hidden="true"/><span className="line-label" data-conversation-part="answer">{line.text}</span></>}>
    <div data-tool-call-id={toolCallId} data-conversation-part="question-answer" className="tool-detail">
      <p className="question-text">{question}</p>
      {line.detail && <p className="muted">{line.detail}</p>}
      {!!options.length && <ul className="answer-options">{options.map(o => <li key={o.id} data-selected={selected.includes(o.id) || undefined}>{selected.includes(o.id) ? <Check size={13} aria-label="Selected"/> : <span className="bullet" aria-hidden="true"/>}{o.label}</li>)}</ul>}
      <Technical toolName={toolName} argsText={argsText} result={result}/>
    </div>
  </Disclosure>;
}

/* ------------------------------------------------------------------ */
/* Docked question / approval                                           */
/* ------------------------------------------------------------------ */

const editable = (el: Element | null) => !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(el.type)) || (el as HTMLElement).isContentEditable);

export function InteractionDock({ onDismiss }: { onDismiss(): void }) {
  const { request, outcome, answer } = useContext(InteractionContext);
  if (!request) return null;
  if (deliveredOutcome(outcome)) return null;
  return <div className="dock" data-kind={request.kind}>
    {request.kind === 'approval'
      ? <ApprovalCard key={request.id} request={request} outcome={outcome} answer={answer} onDismiss={onDismiss}/>
      : <QuestionCard key={request.id} request={request} outcome={outcome} answer={answer} onDismiss={onDismiss}/>}
  </div>;
}

type CardProps = { request: InteractionRequest; outcome?: string; answer(value: InteractionResponse): Promise<void>; onDismiss(): void };

/** Submits exactly once per request; a failed delivery is never retried automatically. */
function useSubmitOnce(request: InteractionRequest, answer: CardProps['answer'], outcome?: string) {
  const submitted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (value: Omit<InteractionResponse, 'id'>) => {
    if (submitted.current || outcome) return;
    submitted.current = true; setBusy(true); setError('');
    try { await answer({ id: request.id, ...value }); }
    catch { setError('Couldn’t confirm delivery. Refresh to reconnect — don’t answer again.'); }
  };
  return { send, busy, error, locked: busy || !!outcome };
}

/** Moves focus into a newly shown card unless the person is typing somewhere. */
function useClaimFocus(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const active = document.activeElement;
    if (editable(active) && (active as HTMLInputElement | HTMLTextAreaElement).value?.trim()) return;
    ref.current?.focus({ preventScroll: true });
  }, [ref]);
}

function Outcome({ outcome, error, busy, onDismiss }: { outcome?: string; error: string; busy: boolean; onDismiss(): void }) {
  if (error) return <p className="dock-status" role="alert">{error}</p>;
  if (outcome) return <div className="dock-status" role="status"><span>{outcome}</span><button type="button" className="link-btn" onClick={onDismiss}>Dismiss</button></div>;
  if (busy) return <p className="dock-status" role="status">Sending…</p>;
  return null;
}

function QuestionCard({ request, outcome, answer, onDismiss }: CardProps) {
  const options = request.options ?? [];
  const multi = !!request.multiSelect;
  const textOnly = !options.length && !!request.allowFreeText;
  const [selected, setSelected] = useState<string[]>([]);
  const [otherOpen, setOtherOpen] = useState(textOnly);
  const [text, setText] = useState('');
  const { send, busy, error, locked } = useSubmitOnce(request, answer, outcome);
  const first = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLElement>(null);
  useClaimFocus(textOnly ? field : first);
  const pick = (id: string) => {
    if (locked) return;
    if (multi) setSelected(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
    else void send({ selected: [id] });
  };
  const openOther = () => { if (locked) return; setOtherOpen(true); requestAnimationFrame(() => field.current?.focus()); };
  const canSubmit = !locked && (selected.length > 0 || !!text.trim());
  // Selections are sent in the order the options were offered, not click order.
  const submit = () => { if (canSubmit) void send({ selected: multi ? options.filter(o => selected.includes(o.id)).map(o => o.id) : [], ...(text.trim() ? { text } : {}) }); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (locked || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const active = document.activeElement;
      if (editable(active) || active?.closest('[role="menu"]')) return;
      const n = Number(event.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      if (n <= options.length) { event.preventDefault(); pick(options[n - 1]!.id); }
      else if (n === options.length + 1 && request.allowFreeText && options.length) { event.preventDefault(); openOther(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return <section ref={card} className="card question-card" aria-label="Question for you" aria-busy={busy || undefined}>
    <header className="card-head"><MessageCircleQuestion size={16} aria-hidden="true"/><span>{multi ? 'Choose any that apply' : textOnly ? 'Your answer' : 'Choose one'}</span></header>
    <h2 className="card-title">{request.title}</h2>
    {request.details && <p className="card-details">{request.details}</p>}
    {!!options.length && <div className="options" role="group" aria-label="Options">
      {options.map((option, i) => {
        const on = selected.includes(option.id);
        return <button key={option.id} ref={i === 0 ? first : undefined} type="button" className="option" disabled={locked}
          {...(multi ? { role: 'checkbox', 'aria-checked': on } : {})} data-selected={on || undefined} onClick={() => pick(option.id)}>
          {i < 9 && <kbd className="option-key" aria-hidden="true">{i + 1}</kbd>}
          <span className="option-label">{option.label}</span>
          {multi && <span className="check" aria-hidden="true">{on && <Check size={14}/>}</span>}
        </button>;
      })}
      {request.allowFreeText && !otherOpen && <button type="button" className="option other" disabled={locked} onClick={openOther}>
        {options.length < 9 && <kbd className="option-key" aria-hidden="true">{options.length + 1}</kbd>}<span className="option-label">Other…</span>
      </button>}
    </div>}
    {request.allowFreeText && otherOpen && <textarea ref={field} className="other-field" aria-label={textOnly ? 'Your answer' : 'Other answer'} placeholder={textOnly ? 'Type your answer…' : 'Type another answer…'} maxLength={2000} rows={2} value={text} disabled={locked}
      onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}/>}
    <div className="card-actions">
      <button type="button" className="btn ghost" disabled={locked} onClick={() => void send({ cancelled: true })}>Cancel</button>
      {(multi || otherOpen) && <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>Submit</button>}
    </div>
    <Outcome outcome={outcome} error={error} busy={busy} onDismiss={onDismiss}/>
  </section>;
}

function ApprovalCard({ request, outcome, answer, onDismiss }: CardProps) {
  const { send, busy, error, locked } = useSubmitOnce(request, answer, outcome);
  const card = useRef<HTMLElement>(null);
  useClaimFocus(card);
  const rows = describeArguments(request.details);
  return <section ref={card} tabIndex={-1} className="card approval-card" aria-label={`Permission needed: ${friendlyName(request.tool)}`} aria-busy={busy || undefined}
    onKeyDown={event => {
      if (locked || event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void send({ approved: false }); }
      else if (event.key === 'Enter' && event.target === card.current) { event.preventDefault(); void send({ approved: true }); }
    }}>
    <header className="card-head"><ShieldAlert size={16} aria-hidden="true"/><span>Permission needed</span></header>
    <h2 className="card-title">Wants to run {friendlyName(request.tool)}</h2>
    {!!rows.length && <dl className="approval-args">{rows.map((row, i) => <div key={i}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>}
    <div className="card-actions">
      <span className="hint" aria-hidden="true"><kbd>Enter</kbd> allow · <kbd>Esc</kbd> deny</span>
      <button type="button" className="btn ghost" disabled={locked} onClick={() => void send({ approved: false })}>Deny</button>
      <button type="button" className="btn primary" disabled={locked} onClick={() => void send({ approved: true })}>Allow</button>
    </div>
    <Outcome outcome={outcome} error={error} busy={busy} onDismiss={onDismiss}/>
  </section>;
}
