import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, ChevronRight, Lock, LoaderCircle, X } from 'lucide-react';
import { api, errorCode } from './api.js';
import { Modal } from './modal.js';
import { useToast } from './toasts.js';
import { ago } from './decisions-model.js';
import { droppedCount, exposureLine, filesLine, memoryError, refusalReason, revertToast, reviewerOptions, sourceChip, trustChip, verdictChip, type MemoryData, type MemoryRevert, type MemoryReviewView, type ProvenanceSection } from './memory-model.js';

/** A row at the foot of the sidebar: opens the Memory view. */
export function MemoryRow({ onOpen, pending }: { onOpen(): void; pending: number }) {
  return <button type="button" className="integration-row memory-row" onClick={onOpen} aria-label={`Memory: who changed the agent’s memory, and how each change was reviewed${pending ? ` (${pending} reviewing)` : ''}`}>
    <span className="integration-mark" aria-hidden="true"><Brain size={13}/></span>
    <span className="integration-label">Memory</span>
    {pending > 0 && <span className="badge">{pending} reviewing</span>}
  </button>;
}

/** The chips of a review: where it came from, the verdict, and the trust Jiminy gave it. */
export function ReviewChips({ review }: { review: MemoryReviewView }) {
  const verdict = verdictChip(review);
  const trust = trustChip(review);
  return <span className="prov-chips">
    <span className="prov-chip" data-tone="neutral" title="Who asked, and what the turn had read">{sourceChip(review)}</span>
    <span className="prov-chip" data-tone={verdict.tone}>{verdict.label}</span>
    {trust && <span className="prov-chip" data-tone="neutral" title={review.jiminy?.model ? `Reviewed by ${review.jiminy.model}` : undefined}>{trust}</span>}
  </span>;
}

/** Lines the reviewer dropped from a change (kept out of memory while the rest stays). */
export function DroppedView({ dropped }: { dropped: readonly { path: string; start: number; end: number; text: string }[] }) {
  return <div className="memory-dropped" aria-label={`Dropped by the reviewer: ${droppedCount(dropped)}`}>
    <p className="memory-dropped-head">Dropped by the reviewer ({droppedCount(dropped)}); the rest was kept:</p>
    {dropped.map(drop => <pre key={`${drop.path}:${drop.start}`} className="memory-dropped-lines"><span className="mono muted">{drop.path} {drop.start === drop.end ? `line ${drop.start}` : `lines ${drop.start}–${drop.end}`}</span>{'\n'}{drop.text.split('\n').map((line, i) => <span key={i} className="diff-line" data-kind="del">{line || ' '}{'\n'}</span>)}</pre>)}
  </div>;
}

/** A diff as lines, added and removed lines marked (text only, never HTML). */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n').slice(0, 400);
  return <pre className="memory-diff" aria-label="Changes">{lines.map((line, index) => <span key={index} className="diff-line" data-kind={line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : undefined}>{line || ' '}{'\n'}</span>)}</pre>;
}

function ReviewItem({ review, onOpenThread }: { review: MemoryReviewView; onOpenThread?(id: string): void }) {
  const [open, setOpen] = useState(false);
  const exposure = exposureLine(review);
  return <li className="memory-review" data-open={open || undefined}>
    <button type="button" className="memory-review-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <span className="memory-review-files">{review.files.some(f => f.protected) && <Lock size={12} aria-label="Protected file" className="memory-lock"/>}{filesLine(review) || '(no files)'}</span>
      <ReviewChips review={review}/>
      <span className="memory-review-time">{ago(review.settledAt ?? review.createdAt)}</span>
      <ChevronRight size={14} className="chev" aria-hidden="true"/>
    </button>
    {open && <div className="memory-review-detail">
      <p className="memory-review-line"><strong>From:</strong> {review.provenance}{review.threadId && onOpenThread ? <> · <button type="button" className="link-btn" onClick={() => onOpenThread(review.threadId!)}>open conversation</button></> : null}</p>
      {review.jiminy && <p className="memory-review-line"><strong>Jiminy</strong>{review.jiminy.model ? ` (${review.jiminy.model})` : ''}: {review.jiminy.reason}</p>}
      {review.rule && <p className="memory-review-line"><strong>Rule:</strong> {review.rule}</p>}
      {review.error && <p className="memory-review-line muted">The review failed ({review.error}); the safe default was applied.</p>}
      {exposure && <p className="memory-review-line">{exposure}</p>}
      {review.claims?.length ? <ul className="memory-claims" aria-label="Claims">{review.claims.map((claim, i) => <li key={i} className="memory-review-line">
        <strong>Claim:</strong> {claim.person} said “{claim.statement}” · {claim.match === 'member' ? `asked ${claim.to?.name ?? claim.person}${claim.answer ? `: answered ${claim.answer}${claim.comment ? ` (“${claim.comment}”)` : ''}` : ', waiting'}` : claim.match === 'self' ? 'their own words' : claim.match === 'ambiguous' ? 'several members match: an admin decides' : 'not a member: cannot be verified'}
      </li>)}</ul> : null}
      {review.dropped?.length ? <DroppedView dropped={review.dropped}/> : null}
      {review.diff && <DiffView diff={review.diff}/>}
    </div>}
  </li>;
}

/** Per-line provenance of one memory file. */
function FileProvenance() {
  const [path, setPath] = useState('human.md');
  const [data, setData] = useState<{ path: string; protected: boolean; sections: ProvenanceSection[] }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true); setError('');
    try { setData(await api(`/v1/memory/provenance?path=${encodeURIComponent(path.trim())}`, undefined, 'GET')); }
    catch (e) { setData(undefined); setError(memoryError(errorCode(e))); }
    finally { setBusy(false); }
  };
  return <section className="memory-section" aria-label="Who wrote a memory file">
    <h3 className="automations-heading">Who wrote a file</h3>
    <form className="memory-path" onSubmit={event => { event.preventDefault(); void load(); }}>
      <label className="sr-only" htmlFor="memory-path">Memory file</label>
      <input id="memory-path" className="member-input" value={path} onChange={event => setPath(event.target.value)} placeholder="human.md" maxLength={300} spellCheck={false}/>
      <button type="submit" className="btn small" disabled={busy || !path.trim()}>{busy ? 'Loading…' : 'Show'}</button>
    </form>
    {error && <p className="memory-empty">{error}</p>}
    {data && <ol className="memory-sections" aria-label={`Sections of ${data.path}`}>
      {data.sections.map(section => <li key={`${section.from}-${section.commit}`} className="memory-section-item">
        <span className="memory-section-meta"><span className="mono">{section.from === section.to ? `line ${section.from}` : `lines ${section.from}–${section.to}`}</span> · {section.by} · {ago(section.at)}{section.review ? ` · ${section.review}` : ''}</span>
        <pre className="memory-section-text">{section.lines}</pre>
      </li>)}
    </ol>}
  </section>;
}

/**
 * The Memory view: every reviewed change of the agent's memory (newest
 * first) with its provenance, verdict and diff; who wrote each part of a
 * file; and which model reviews (Jiminy).
 */
export function MemoryDialog({ agentName, admin, onClose, onOpenThread }: { agentName: string; admin: boolean; onClose(): void; onOpenThread?(id: string): void }) {
  const toast = useToast();
  const [data, setData] = useState<MemoryData>();
  const [failed, setFailed] = useState('');
  const load = useCallback(async () => {
    try { setData(await api<MemoryData>('/v1/memory/reviews?limit=50', undefined, 'GET')); setFailed(''); }
    catch (e) { setFailed(memoryError(errorCode(e))); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 4000); return () => clearInterval(timer); }, [load]);
  const setModel = async (model: string) => {
    try { await api('/v1/memory/reviewer', { model }, 'PUT'); toast(model === 'auto' ? 'Jiminy now picks its model automatically.' : `Jiminy now reviews with ${model}.`); await load(); }
    catch (e) { toast(memoryError(errorCode(e)), { tone: 'error' }); }
  };
  return <Modal label={`Memory of ${agentName}`} onClose={onClose} className="automations memory">
    <div className="members-head">
      <div><h2 className="modal-title">Memory</h2>
        <p className="modal-text">Every change to {agentName}’s memory is recorded with who asked for it and what the agent had read, and reviewed by Jiminy, a separate reviewer. Changes it doubts are reverted, or held until someone approves them in the bell.</p></div>
      <button type="button" className="icon-btn small" aria-label="Close" data-autofocus onClick={onClose}><X size={16}/></button>
    </div>
    {data?.reviewer && <section className="memory-section memory-reviewer">
      <label className="memory-reviewer-label" htmlFor="jiminy-model">Reviewer model</label>
      <select id="jiminy-model" className="member-role" value={data.reviewer.model} disabled={!admin} onChange={event => void setModel(event.target.value)}>
        {reviewerOptions(data.reviewer.available, data.reviewer.model).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {!admin && <span className="muted memory-reviewer-note">Only admins can change it.</span>}
    </section>}
    <section className="memory-section" aria-label="Reviewed changes">
      <h3 className="automations-heading">Reviewed changes</h3>
      <ul className="memory-reviews" aria-busy={!data || undefined}>
        {failed && <li className="memory-empty">{failed} <button type="button" className="link-btn" onClick={() => void load()}>Try again</button></li>}
        {!data && !failed && <li className="memory-empty muted"><LoaderCircle size={14} className="spin" aria-hidden="true"/> Loading…</li>}
        {data && !data.reviews.length && <li className="memory-empty muted">No memory changes yet.</li>}
        {data?.reviews.map(review => <ReviewItem key={review.id} review={review} {...(onOpenThread ? { onOpenThread } : {})}/>)}
      </ul>
    </section>
    {!!data?.refused?.length && <section className="memory-section" aria-label="Refused memory writes">
      <h3 className="automations-heading">Refused before they happened</h3>
      <ul className="memory-reviews">
        {data.refused.map(refusal => <li key={`${refusal.at}-${refusal.path}`} className="memory-refusal">
          <span className="memory-review-files"><Lock size={12} aria-hidden="true" className="memory-lock"/>{refusal.path}</span>
          <span className="prov-chips">{refusal.provenance && <span className="prov-chip" data-tone="neutral">{refusal.provenance}</span>}<span className="prov-chip" data-tone="reverted">Denied</span></span>
          <span className="memory-review-time">{ago(refusal.at)}</span>
          <span className="memory-refusal-reason">{refusalReason(refusal)}{refusal.threadId && onOpenThread ? <> · <button type="button" className="link-btn" onClick={() => onOpenThread(refusal.threadId!)}>open conversation</button></> : null}</span>
        </li>)}
      </ul>
    </section>}
    <FileProvenance/>
  </Modal>;
}

/**
 * Toasts for memory changes the review reverted or held, as they happen
 * (polled while the app is open; only those after the page loaded).
 */
export function useMemoryToasts(enabled: boolean, version: number) {
  const toast = useToast();
  const since = useRef(new Date().toISOString());
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const { reverts } = await api<{ reverts: MemoryRevert[] }>(`/v1/memory/reverts?since=${encodeURIComponent(since.current)}`, undefined, 'GET');
        if (cancelled) return;
        for (const revert of reverts) { toast(revertToast(revert), { tone: 'error' }); if (revert.at > since.current) since.current = revert.at; }
        const data = await api<MemoryData>('/v1/memory/reviews?limit=20', undefined, 'GET').catch(() => undefined);
        if (!cancelled && data) setPending(data.reviews.filter(r => r.status === 'pending').length);
      } catch { /* the next change retries */ }
    })();
    return () => { cancelled = true; };
  }, [enabled, version, toast]);
  return pending;
}
