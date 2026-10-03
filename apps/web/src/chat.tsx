import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { ActionBarPrimitive, MessagePrimitive, groupPartByType, useAuiState, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { Check, ChevronRight, CircleAlert, Copy, CornerDownRight, Ear, FileText, Globe, LoaderCircle, MessageCircleQuestion, Search, ShieldAlert, ShieldCheck, ShieldX, SquareTerminal, Wrench } from 'lucide-react';
import type { InteractionRequest, InteractionResponse } from 'ai-sdk-letta';
import { COMMAND_TOOLS, lineDiff, toolErrorText, answerLine, commandOutput, commandStatus, describeArguments, failureReason, failureText, friendlyName, metricsLine, parseArgs, toolLabel, toolSummary, type ToolPhase } from './presentation.js';
import { Markdown } from './markdown.js';
import { MessageFile, MessageImage } from './images.js';
import { IMAGE_PLACEHOLDER } from './attachments.js';
import { Avatar } from './team.js';
import type { Listened, MessageAuthor as Author, MessageSource } from './messages.js';
import { sourceLabel } from './automations-model.js';
import { DecisionLine, OutcomeMessage } from './decisions.js';
import { isWebResearch, ReplySources, WebResearchCard, WebResearchLine, WebResearchWaiting } from './web-research.js';

/* ------------------------------------------------------------------ */
/* Interaction state shared between the inline lines and the dock      */
/* ------------------------------------------------------------------ */

/**
 * `waitingFor` (team servers): the request belongs to someone else's turn and
 * you are not an admin, so you see it but cannot answer; it names who can.
 */
export type InteractionState = { request?: InteractionRequest; outcome?: string; sent?: InteractionResponse; approvalTools: ReadonlySet<string>; answer(value: InteractionResponse): Promise<void>; waitingFor?: string };
/** The signed-in person's user ID on a team server (their own messages say "You"). */
export const AuthorContext = createContext<string | undefined>(undefined);
export const InteractionContext = createContext<InteractionState>({ approvalTools: new Set(), answer: async () => {} });
/** Outcomes that mean the answer was delivered; the dock then collapses into the inline line. */
export const deliveredOutcome = (outcome?: string) => !!outcome && (outcome.startsWith('Response received') || outcome.startsWith('This review expired'));

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

/** Who wrote a user turn, on a team server: avatar and name above the bubble ("You" for your own). Nothing in the single-user app. */
function MessageAuthor({ role }: { role: string }) {
  const author = useAuiState(s => (s.message.metadata.custom as { author?: Author } | undefined)?.author);
  const source = useAuiState(s => (s.message.metadata.custom as { source?: MessageSource } | undefined)?.source);
  const me = useContext(AuthorContext);
  if (role !== 'user' || (!author && !source)) return null;
  const mine = !!author && author.id === me;
  // A turn an automation started: a small "via n8n" badge (named after the automation), next to the person it acts for.
  const badge = source ? <span className="via-badge" title={source.kind === 'schedule' ? 'A task the agent scheduled, run by the orchestrator' : `Started by the automation “${source.name}”`}>{sourceLabel(source)}</span> : null;
  return <div className="msg-author" data-mine={mine || undefined} title={author?.login}>
    {badge}{author && <><span className="msg-author-name">{mine ? 'You' : author.name}</span><Avatar person={author} size={20}/></>}
  </div>;
}

export function Message() {
  const role = useAuiState(s => s.message.role);
  const time = useAuiState(s => (s.message.metadata.custom as { time?: string } | undefined)?.time);
  const hasText = useAuiState(s => s.message.parts.some(p => p.type === 'text' && p.text.trim()));
  const listened = useAuiState(s => (s.message.metadata.custom as { listened?: Listened } | undefined)?.listened);
  const outcome = useAuiState(s => !!(s.message.metadata.custom as { decision?: unknown } | undefined)?.decision);
  // A decision's outcome reached the agent here: one compact line, not a message bubble.
  if (role === 'user' && outcome) return <MessagePrimitive.Root className="msg decision-outcome-msg" data-role={role}><OutcomeMessage/></MessagePrimitive.Root>;
  if (role === 'assistant' && listened) return <MessagePrimitive.Root className="msg listened" data-role={role}><ListenedLine listened={listened} time={time}/></MessagePrimitive.Root>;
  return <MessagePrimitive.Root className="msg" data-role={role}>
    <MessageAuthor role={role}/>
    <div className="msg-body">
      {role === 'user'
        ? <UserBubble/>
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

type FilePart = { type: 'data'; name: string; data: { name: string; detail: string; kind?: string } };
const isFilePart = (part: { type: string; name?: string }): part is FilePart => part.type === 'data' && part.name === 'file';

/** Images sit above the text bubble, like the composer shows them; `[Image]` placeholders stay with the images. Files follow as chips. */
function UserBubble() {
  const images = useAuiState(s => s.message.parts.filter(p => p.type === 'image' || (p.type === 'text' && p.text === IMAGE_PLACEHOLDER)).length);
  // Saved images are also listed in the note; the thumbnail already shows them.
  const files = useAuiState(s => s.message.parts.filter(p => isFilePart(p) && !(images > 0 && p.data.kind === 'image')).length);
  const hasText = useAuiState(s => s.message.parts.some(p => p.type === 'text' && p.text !== IMAGE_PLACEHOLDER && p.text.trim()));
  return <div className="user-turn">
    {images > 0 && <div className="bubble-images">
      <MessagePrimitive.Parts>{({ part }) => part.type === 'image' ? <MessageImage src={part.image} name={part.filename}/> : part.type === 'text' && part.text === IMAGE_PLACEHOLDER ? <span className="image-placeholder">{IMAGE_PLACEHOLDER}</span> : <></>}</MessagePrimitive.Parts>
    </div>}
    {files > 0 && <div className="bubble-files">
      <MessagePrimitive.Parts>{({ part }) => isFilePart(part) && !(images > 0 && part.data.kind === 'image') ? <MessageFile {...part.data}/> : <></>}</MessagePrimitive.Parts>
    </div>}
    {hasText && <div className="bubble">
      <MessagePrimitive.Parts>{({ part }) => part.type === 'text' && part.text !== IMAGE_PLACEHOLDER ? <p className="user-text">{part.text}</p> : <></>}</MessagePrimitive.Parts>
    </div>}
  </div>;
}

/** Questions stay ungrouped so they read as part of the conversation. */
const groupTools = groupPartByType({ 'tool-call': ['group-tools'], 'tool-call:ask_user': [], 'tool-call:request_decision': [], 'tool-call:web_search': [] });

function AssistantParts() {
  return <><MessagePrimitive.GroupedParts groupBy={groupTools} indicator="no-text">
    {({ part, children }) => {
      switch (part.type) {
        case 'group-tools': return part.indices.length > 1 ? <ToolGroup count={part.indices.length} running={part.counts.running > 0} indices={part.indices}>{children}</ToolGroup> : <>{children}</>;
        case 'text': return part.text ? <Markdown/> : <></>;
        case 'tool-call': return <ToolPart {...part}/>;
        case 'indicator': return <Thinking/>;
        default: return <></>;
      }
    }}
  </MessagePrimitive.GroupedParts><WebSourcesUnderReply/></>;
}

/** The sources of approved web research, as links under the agent's reply (once it has written something after searching). */
function WebSourcesUnderReply() {
  const searches = useAuiState(s => {
    const parts = s.message.parts;
    let last = -1;
    parts.forEach((p, i) => { if (p.type === 'tool-call' && p.toolName === 'web_search') last = i; });
    if (last < 0 || !parts.slice(last + 1).some(p => p.type === 'text' && p.text.trim())) return '';
    return JSON.stringify(parts.flatMap(p => p.type === 'tool-call' && p.toolName === 'web_search' && p.result !== undefined ? [{ argsText: p.argsText, result: p.result }] : []));
  });
  if (!searches) return null;
  return <ReplySources results={JSON.parse(searches) as { argsText: string; result: unknown }[]}/>;
}

/**
 * A turn the agent listened to without replying: one quiet line ("Listened"),
 * collapsed. Expanded, it shows what the agent noted or thought and the tools
 * it used (each collapsed as usual). No bubble, no copy button.
 */
function ListenedLine({ listened, time }: { listened: Listened; time?: string }) {
  const reasoning = useAuiState(s => s.message.parts.filter(p => p.type === 'reasoning').map(p => p.type === 'reasoning' ? p.text : '').join('\n\n').trim());
  const tools = useAuiState(s => s.message.parts.filter(p => p.type === 'tool-call').length);
  const label = `Listened${time ? ` · ${formatTime(time)}` : ''}`;
  return <Disclosure className="listened-line" tone="listened" label={`${label}. Show what the agent noted`}
    summary={<><Ear size={14} className="line-icon" aria-hidden="true"/><span className="line-label">Listened</span>
      {tools > 0 && <span className="line-meta">{tools === 1 ? 'used 1 tool' : `used ${tools} tools`}</span>}
      {time && <time className="line-meta" dateTime={time} title={fullFormat.format(new Date(time))}>{formatTime(time)}</time>}</>}>
    <div className="listened-detail">
      {listened.reason && <p className="listened-note"><span className="listened-label">Note</span>{listened.reason}</p>}
      {reasoning && <div className="listened-thoughts"><span className="listened-label">Thoughts</span><p>{reasoning}</p></div>}
      {!listened.reason && !reasoning && <p className="muted">The agent read this and chose not to reply. It recorded no thoughts.</p>}
      {tools > 0 && <MessagePrimitive.GroupedParts groupBy={groupTools}>
        {({ part, children }) => part.type === 'group-tools' ? part.indices.length > 1 ? <ToolGroup count={part.indices.length} running={part.counts.running > 0} indices={part.indices}>{children}</ToolGroup> : <>{children}</> : part.type === 'tool-call' ? <ToolPart {...part}/> : <></>}
      </MessagePrimitive.GroupedParts>}
    </div>
  </Disclosure>;
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
  if (props.toolName === 'request_decision') return <DecisionLine {...props}/>;
  if (props.toolName === 'web_search') return <WebSearchPart {...props}/>;
  return <ToolLine {...props}/>;
}

function WebSearchPart({ toolCallId, argsText, result }: ToolPartProps) {
  const active = useContext(InteractionContext);
  const pending = isWebResearch(active.request) && active.request!.toolCallId === toolCallId && result === undefined;
  const decided = pending && active.sent?.id === active.request?.id ? active.sent : undefined;
  return <WebResearchLine toolCallId={toolCallId} argsText={argsText} result={result} pending={pending} {...(decided ? { decided } : {})}/>;
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

/** Output of a command: monospace, the first lines first, with "show more". */
function CommandText({ text, label }: { text: string; label: string }) {
  const [full, setFull] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > 14 || text.length > 1600;
  const shown = full || !long ? text : lines.slice(0, 14).join('\n').slice(0, 1600);
  return <div className="command-block">
    <pre className="command-output" aria-label={label}>{shown}{!full && long && '\n…'}</pre>
    {long && <button type="button" className="link-btn" onClick={() => setFull(f => !f)}>{full ? 'Show less' : `Show more (${lines.length.toLocaleString()} lines)`}</button>}
  </div>;
}

/** Expanded view of run_command: the exact command, its exit code and its output. */
function CommandDetail({ toolName, args, result, phase }: { toolName: string; args: Record<string, unknown>; result: unknown; phase: ToolPhase }) {
  const out = phase === 'done' ? commandOutput(result) : undefined;
  const command = typeof args.command === 'string' ? args.command : '';
  const cwd = typeof args.cwd === 'string' && args.cwd.trim() && args.cwd.trim() !== '.' ? args.cwd.trim() : undefined;
  return <div className="command-detail">
    <pre className="command-line" aria-label="Command"><span className="prompt" aria-hidden="true">$ </span>{command}</pre>
    {(cwd || toolName === 'run_command_online') && <p className="command-meta">{[cwd && `in ${cwd.startsWith('/') ? cwd : `/workspace/${cwd}`}`, toolName === 'run_command_online' && 'with internet access (approved)'].filter(Boolean).join(' · ')}</p>}
    {out?.error && <p className="muted">{out.error}</p>}
    {out && !out.error && <>
      <p className="command-meta">{out.timedOut ? 'Stopped: took too long' : `Exit code ${out.exitCode}`}{out.duration ? ` · ${out.duration}` : ''}{out.truncated ? ' · output truncated' : ''}</p>
      {out.output ? <CommandText text={out.output} label="Output"/> : <p className="muted">No output.</p>}
    </>}
  </div>;
}

function ToolLine({ toolCallId, toolName, argsText, result, isError }: ToolPartProps) {
  const active = useContext(InteractionContext);
  const pendingApproval = active.request?.kind === 'approval' && active.request.toolCallId === toolCallId && result === undefined;
  // Atlassian tools report refusals as text ("Error (code): …"); restored history may not flag them as errors.
  const phase = toolName.startsWith('atlassian_') && toolErrorText(toolName, result) ? 'error' : phaseOf(result, isError);
  const args = parseArgs(argsText);
  const denied = phase === 'error' && ['user_denied', 'approval_cancelled'].includes(failureReason(result) ?? '');
  const decided = pendingApproval && active.sent?.id === active.request?.id ? active.sent : undefined;
  const label = pendingApproval
    ? decided ? (decided.approved ? `Allowed: ${friendlyName(toolName)} · running…` : `Denied: ${friendlyName(toolName)}`) : active.waitingFor ? `Waiting for ${active.waitingFor} to allow: ${friendlyName(toolName)}` : `Waiting for your permission: ${friendlyName(toolName)}`
    : toolLabel(toolName, phase, result, args);
  const shell = COMMAND_TOOLS.has(toolName) && typeof args.command === 'string';
  const summary = phase === 'done' && !shell ? toolSummary(toolName, result, args) : { fields: [] };
  const approval = active.approvalTools.has(toolName) || pendingApproval;
  const fileTool = ['list_files', 'read_file', 'search_files'].includes(toolName);
  const status = shell && phase === 'done' ? commandStatus(result) : '';
  const Icon = phase === 'running' ? LoaderCircle : denied ? ShieldX : phase === 'error' || status ? CircleAlert : toolName === 'run_command_online' ? Globe : shell ? SquareTerminal : approval ? ShieldCheck : toolName === 'search_files' ? Search : fileTool ? FileText : Wrench;
  return <Disclosure className={`tool-line${shell ? ' command' : ''}`} tone={phase === 'running' ? 'running' : denied ? 'denied' : status ? 'error' : phase} label={`${label}${status ? `, ${status}` : ''}`}
    summary={<><Icon size={14} className={`line-icon ${phase === 'running' ? 'spin' : ''}`} aria-hidden="true"/><span className={`line-label ${phase === 'running' ? 'shimmer' : ''}`}>{shell ? <CommandLabel text={label}/> : label}</span>
      {phase === 'done' && summary.metrics && <span className="line-meta">{metricsLine(summary.metrics)}</span>}
      {status && <span className="line-meta">{status}</span>}</>}>
    <div data-tool-call-id={toolCallId} className="tool-detail">
      {phase === 'running' && <p className="muted">{decided ? 'Your decision was sent. Waiting for the agent…' : pendingApproval ? active.waitingFor ? `Only ${active.waitingFor} or an admin can allow or deny this.` : 'Waiting for you to allow or deny this below.' : shell ? 'Running in the sandbox…' : 'Working on it…'}</p>}
      {phase === 'error' && <p className="muted">{toolErrorText(toolName, result) ?? failureText(result)}</p>}
      {shell && <CommandDetail toolName={toolName} args={args} result={result} phase={phase}/>}
      {summary.metrics && <dl className="metrics">{summary.metrics.map(m => <div key={m.label}><dt>{m.label}</dt><dd>{m.value}</dd></div>)}</dl>}
      {!!summary.fields.length && <dl className="fields">{summary.fields.map((f, i) => <div key={i}><dt>{f.label}</dt><dd><Value value={f.value}/></dd></div>)}</dl>}
      <Technical toolName={toolName} argsText={argsText} result={result}/>
    </div>
  </Disclosure>;
}

/** "Ran `rg budget`": the part in backticks in monospace. */
function CommandLabel({ text }: { text: string }) {
  const match = /^(.*?)`([^`]*)`(.*)$/s.exec(text);
  if (!match) return <>{text}</>;
  return <>{match[1]}<code className="inline-command">{match[2]}</code>{match[3]}</>;
}

function ToolGroup({ count, running, children }: { count: number; running: boolean; indices: readonly number[]; children: React.ReactNode }) {
  const runningLabel = useAuiState(s => {
    const part = [...s.message.parts].reverse().find(p => p.type === 'tool-call' && p.result === undefined);
    return part?.type === 'tool-call' ? toolLabel(part.toolName, 'running', undefined, parseArgs(part.argsText)) : undefined;
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
        {mine && !sent && !active.outcome && <span className="line-meta">{active.waitingFor ? `Waiting for ${active.waitingFor}` : 'Answer below'}</span>}
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
  const { request, outcome, answer, waitingFor } = useContext(InteractionContext);
  if (!request) return null;
  if (deliveredOutcome(outcome)) return null;
  // Someone else's turn: say who can answer, without controls.
  if (waitingFor && !outcome && isWebResearch(request)) return <div className="dock" data-kind={request.kind}><WebResearchWaiting request={request} waitingFor={waitingFor}/></div>;
  if (waitingFor && !outcome) return <div className="dock" data-kind={request.kind}>
    <section className="card waiting-card" aria-label={request.kind === 'approval' ? 'Permission requested' : 'Question asked'}>
      <header className="card-head">{request.kind === 'approval' ? <ShieldAlert size={16} aria-hidden="true"/> : <MessageCircleQuestion size={16} aria-hidden="true"/>}<span>{request.kind === 'approval' ? 'Permission requested' : 'Question asked'}</span></header>
      <h2 className="card-title">{request.kind === 'approval' ? <>Wants to run {friendlyName(request.tool)}</> : request.title}</h2>
      <p className="card-details">Waiting for {waitingFor} to {request.kind === 'approval' ? 'allow or deny it' : 'answer'}. Only they, or an admin of this agent, can.</p>
    </section>
  </div>;
  return <div className="dock" data-kind={request.kind}>
    {isWebResearch(request)
      ? <WebResearchCard key={request.id} request={request} outcome={outcome} answer={answer} onDismiss={onDismiss}/>
      : request.kind === 'approval'
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
  const args = parseArgs(request.details);
  const atlassian = request.preview?.kind === 'atlassian-edit' || request.preview?.kind === 'atlassian-request' ? request.preview : undefined;
  const shell = COMMAND_TOOLS.has(request.tool) && typeof args.command === 'string';
  const cwd = shell && typeof args.cwd === 'string' && args.cwd.trim() && args.cwd.trim() !== '.' ? args.cwd.trim() : undefined;
  const extra = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'command' && key !== 'cwd'));
  const rows = shell ? (Object.keys(extra).length ? describeArguments(JSON.stringify(extra)) : []) : describeArguments(request.details);
  return <section ref={card} tabIndex={-1} className="card approval-card" aria-label={`Permission needed: ${friendlyName(request.tool)}`} aria-busy={busy || undefined}
    onKeyDown={event => {
      if (locked || event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void send({ approved: false }); }
      else if (event.key === 'Enter' && event.target === card.current) { event.preventDefault(); void send({ approved: true }); }
    }}>
    <header className="card-head"><ShieldAlert size={16} aria-hidden="true"/><span>Permission needed</span></header>
    <h2 className="card-title">{atlassian ? atlassianTitle(atlassian) : shell ? (request.tool === 'run_command_online' ? 'Wants to run a command with internet access' : 'Wants to run a command') : <>Wants to run {friendlyName(request.tool)}</>}</h2>
    {atlassian && <AtlassianApproval preview={atlassian}/>}
    {shell && <>
      <pre className="command-line approval-command" aria-label="Command"><span className="prompt" aria-hidden="true">$ </span>{String(args.command)}</pre>
      {cwd && <p className="command-meta approval-cwd">in {cwd.startsWith('/') ? cwd : `/workspace/${cwd}`}</p>}
      {request.tool === 'run_command_online' && <p className="card-details">It runs in a separate sandbox that can reach the internet and change this conversation’s files. Everything else stays isolated.</p>}
    </>}
    {!atlassian && !!rows.length && <dl className="approval-args">{rows.map((row, i) => <div key={i}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>}
    {atlassian && <details className="approval-raw"><summary>Exact request</summary><pre>{atlassian.text}</pre></details>}
    <div className="card-actions">
      <span className="hint" aria-hidden="true"><kbd>Enter</kbd> allow · <kbd>Esc</kbd> deny</span>
      <button type="button" className="btn ghost" disabled={locked} onClick={() => void send({ approved: false })}>Deny</button>
      <button type="button" className="btn primary" disabled={locked} onClick={() => void send({ approved: true })}>Allow</button>
    </div>
    <Outcome outcome={outcome} error={error} busy={busy} onDismiss={onDismiss}/>
  </section>;
}

/* ------------------------------------------------------------------ */
/* Atlassian approvals                                                 */
/* ------------------------------------------------------------------ */

type AtlassianPreviewData = {
  product?: 'jira' | 'confluence'; target?: string; url?: string; site?: string; account?: string; blocks?: number;
  changes?: { index: number; removed: number; added: number; before: string; after: string }[];
  method?: string; path?: string; body?: string;
};
function atlassianTitle(preview: NonNullable<InteractionRequest['preview']>): string {
  const data = (preview.data ?? {}) as AtlassianPreviewData;
  if (preview.kind === 'atlassian-edit') return data.product === 'confluence' ? 'Wants to edit a Confluence page' : 'Wants to edit a Jira issue';
  return data.method === 'DELETE' ? 'Wants to delete in Atlassian' : 'Wants to change something in Atlassian';
}
/** What an Atlassian call will do: the target, your account, and for edits a before/after of each changed block. */
function AtlassianApproval({ preview }: { preview: NonNullable<InteractionRequest['preview']> }) {
  const data = (preview.data ?? {}) as AtlassianPreviewData;
  const host = data.site ? new URL(data.site).hostname : undefined;
  return <div className="atl-approval">
    <p className="card-details atl-target">
      {/* Edits link to the issue or page; a request's URL is an API endpoint, so it is shown below instead. */}
      {preview.kind === 'atlassian-edit' && (data.url ? <><a href={data.url} target="_blank" rel="noopener noreferrer">{data.target ?? preview.title}</a> · </> : <span>{data.target ?? preview.title} · </span>)}
      {(host || data.account) && <span className="atl-account">{[host, data.account && `as ${data.account}`].filter(Boolean).join(' ')}</span>}
    </p>
    {preview.kind === 'atlassian-edit' && data.changes && <>
      <p className="atl-summary">{data.changes.length === 1 ? 'One block changes' : `${data.changes.length} blocks change`}; everything else{data.blocks ? ` (${data.blocks - data.changes.reduce((n, c) => n + c.removed, 0)} of ${data.blocks} blocks)` : ''} stays exactly as it is.</p>
      <div className="atl-changes">
        {data.changes.map((change, i) => <section key={i} className="atl-change" aria-label={`Change ${i + 1}`}>
          <header>{change.removed === 0 ? `New block after block ${change.index}` : change.added === 0 ? `Removed block ${change.index + 1}` : `Block ${change.index + 1}${change.removed > 1 ? `–${change.index + change.removed}` : ''}`}</header>
          <pre className="atl-diff">{lineDiff(change.before, change.after).map((line, k) => <span key={k} className={`atl-line ${line.kind}`}><span className="atl-sign" aria-hidden="true">{line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '}</span><span className="sr-only">{line.kind === 'removed' ? 'Removed: ' : line.kind === 'added' ? 'Added: ' : ''}</span>{line.text || ' '}{'\n'}</span>)}</pre>
        </section>)}
      </div>
    </>}
    {preview.kind === 'atlassian-request' && <>
      <p className="atl-request"><code>{data.method}</code> <code className="atl-path">{data.path}</code></p>
      {data.body && <pre className="atl-body">{data.body}</pre>}
    </>}
  </div>;
}
