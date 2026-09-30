import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

/** Brief, non-blocking notices. Persistent or blocking states are rendered inline instead. */
export type Toast = { id: number; text: string; tone: 'info' | 'error'; action?: { label: string; run(): void } };
type Push = (text: string, options?: { tone?: Toast['tone']; action?: Toast['action'] }) => void;
const ToastContext = createContext<Push>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setToasts(list => list.filter(t => t.id !== id)), []);
  const push = useCallback<Push>((text, options) => {
    const id = ++next.current;
    setToasts(list => [...list.filter(t => t.text !== text), { id, text, tone: options?.tone ?? 'info', ...(options?.action ? { action: options.action } : {}) }].slice(-2));
  }, []);
  return <ToastContext.Provider value={push}>
    {children}
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map(toast => <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)}/>)}
    </div>
  </ToastContext.Provider>;
}
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss(): void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onDismiss, toast.action ? 7000 : 5000);
    return () => clearTimeout(timer);
  }, [paused, onDismiss, toast.action]);
  return <div className="toast" data-tone={toast.tone} role={toast.tone === 'error' ? 'alert' : 'status'} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    <span>{toast.text}</span>
    {toast.action && <button type="button" className="toast-action" onClick={() => { toast.action!.run(); onDismiss(); }}>{toast.action.label}</button>}
    <button type="button" className="icon-btn small" aria-label="Dismiss notification" onClick={onDismiss}><X size={14}/></button>
  </div>;
}
