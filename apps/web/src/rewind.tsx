import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { CircleAlert, FileClock, History, LoaderCircle, Pencil, TriangleAlert, X } from 'lucide-react';
import { Modal } from './modal.js';
import { rewindError, rewindSections, type RewindSection, type RewindSummary } from './rewind-model.js';

/**
 * Rewind in the browser app: edit one of your earlier messages. An "Edit"
 * action on your own messages opens an inline editor; "Save & rewind" shows
 * what the rewind does (the confirmation), and confirming rewinds the
 * conversation and sends the edited message.
 */
export type RewindState = {
  /** Run IDs of the messages you can edit now. */
  editable: ReadonlySet<string>;
  /** The message being edited. */
  editing?: string;
  /** Busy previewing or rewinding (the editor's buttons wait). */
  pending?: boolean;
  /** Why earlier messages cannot be edited here (shown on hover), if some can't. */
  refusal?: string;
  start(runId: string): void;
  /** Say why a message cannot be edited (a toast). */
  explain(code: string): void;
  cancel(): void;
  submit(runId: string, text: string): void;
};
export const RewindContext = createContext<RewindState>({ editable: new Set(), start: () => {}, explain: () => {}, cancel: () => {}, submit: () => {} });

/**
 * The Edit button of a user message (in its action bar), for your own
 * messages that can be rewound. In a conversation others wrote in too, your
 * own messages show it unavailable, and it says why.
 */
export function EditAction({ runId, mine }: { runId?: string; mine: boolean }) {
  const rewind = useContext(RewindContext);
  if (!runId || rewind.editing) return null;
  if (rewind.editable.has(runId)) return <button type="button" className="icon-btn small edit-btn" aria-label="Edit message" title="Edit and rewind from here" onClick={() => rewind.start(runId)}><Pencil size={14} aria-hidden="true"/></button>;
  if (!mine || !rewind.refusal) return null;
  return <button type="button" className="icon-btn small edit-btn" aria-disabled="true" data-unavailable aria-label="Edit message (unavailable)" title={rewindError(rewind.refusal)} onClick={() => rewind.explain(rewind.refusal!)}><Pencil size={14} aria-hidden="true"/></button>;
}

/** The inline editor that replaces a user bubble while you edit it. */
export function EditBubble({ runId, text }: { runId: string; text: string }) {
  const rewind = useContext(RewindContext);
  const [value, setValue] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = ref.current; if (!el) return; el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, []);
  useEffect(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 320)}px`; }, [value]);
  const changed = value.trim() && value !== text;
  const submit = () => { if (changed && !rewind.pending) rewind.submit(runId, value); };
  return <div className="edit-bubble">
    <textarea ref={ref} className="edit-input" aria-label="Edit message" value={value} maxLength={8000} rows={2}
      onChange={event => setValue(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); rewind.cancel(); }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
      }}/>
    <div className="edit-actions">
      <span className="edit-hint"><History size={13} aria-hidden="true"/>Later turns will be removed</span>
      <button type="button" className="btn small" onClick={rewind.cancel} disabled={rewind.pending}>Cancel</button>
      <button type="button" className="btn primary small" onClick={submit} disabled={!changed || rewind.pending}>
        {rewind.pending ? <LoaderCircle size={14} className="spin" aria-hidden="true"/> : null}Save &amp; rewind
      </button>
    </div>
  </div>;
}

/** The confirmation: everything the rewind does, before it does it. */
export function RewindDialog({ summary, text, busy, error, onConfirm, onClose }: { summary: RewindSummary; text: string; busy: boolean; error?: string; onConfirm(): void; onClose(): void }) {
  const sections = rewindSections(summary);
  return <Modal label="Rewind this conversation" onClose={() => { if (!busy) onClose(); }} className="rewind">
    <div className="members-head">
      <div>
        <h2 className="modal-title">Rewind and send the edited message?</h2>
        <p className="modal-text">The conversation continues from your edited message. What came after it is removed, and what those turns changed is undone where possible.</p>
      </div>
      <button type="button" className="icon-btn small" aria-label="Close" disabled={busy} onClick={onClose}><X size={16}/></button>
    </div>
    <div className="rewind-body">
      <div className="rewind-edit"><span className="rewind-label">Your edited message</span><p className="rewind-text">{text}</p></div>
      {sections.map(section => <Section key={section.id} section={section}/>)}
      {!summary.resources?.files.length && !summary.memory?.files.length && <p className="rewind-none"><FileClock size={14} aria-hidden="true"/>No files or memory to revert.</p>}
    </div>
    {error && <p className="rewind-error" role="alert"><CircleAlert size={15} aria-hidden="true"/>{error}</p>}
    <div className="modal-actions">
      <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="btn primary" data-autofocus onClick={onConfirm} disabled={busy}>
        {busy ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : null}{busy ? 'Rewinding…' : 'Rewind & send'}
      </button>
    </div>
  </Modal>;
}

function Section({ section }: { section: RewindSection }) {
  const icon = section.id === 'external' ? <TriangleAlert size={14} aria-hidden="true"/> : section.id === 'conflicts' ? <CircleAlert size={14} aria-hidden="true"/> : null;
  return <section className="rewind-section" data-section={section.id}>
    <h3 className="rewind-heading">{icon}{section.title}</h3>
    {section.note && <p className="rewind-note">{section.note}</p>}
    <ul className="rewind-list">
      {section.lines.map(line => <li key={line.key} data-tone={line.tone}>
        <span className="rewind-item">{line.text}</span>
        {line.detail && <span className="rewind-detail">{line.detail}</span>}
        {line.chips?.length ? <span className="prov-chips rewind-chips">{line.chips.map(chip => <span key={chip} className="prov-chip" data-tone={/^(reject|ask_human)/.test(chip) ? 'reverted' : /^flag/.test(chip) ? 'flag' : /^accept/.test(chip) ? 'ok' : 'neutral'}>{chip}</span>)}</span> : null}
      </li>)}
    </ul>
  </section>;
}
