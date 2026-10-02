import React, { useEffect, useRef } from 'react';

/** A modal dialog: focus moves in and is trapped, Escape or a click outside closes it, focus returns to the opener. */
export function Modal({ label, onClose, children, className }: { label: string; onClose(): void; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    const el = ref.current;
    (el?.querySelector('[data-autofocus]') as HTMLElement | null ?? el)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>('button, a[href], input, iframe, [tabindex]:not([tabindex="-1"])')].filter(item => !item.hasAttribute('disabled'));
      if (!items.length) return;
      const first = items[0]!; const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); (opener.current as HTMLElement | null)?.focus?.({ preventScroll: true }); };
  }, [onClose]);
  return <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>{children}</div>
  </div>;
}

