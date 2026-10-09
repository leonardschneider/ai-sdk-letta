import React from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { setCsrfHeader } from './api.js';
import { ReportLimiter, clientErrorReport, errorMessage, type ErrorWhere } from './error-model.js';

/**
 * Error boundaries: a render error in one part of the app (an app view, a
 * side-panel tab, a message) shows an inline error card there, and the rest
 * keeps working; one that reaches the top shows a small recoverable panel,
 * never a blank page. Every caught error goes to the console and, rate
 * limited, to the local server's log (`POST /api/client-errors`).
 */

const limiter = new ReportLimiter();
/** Report a caught error: the console, and the server log (best effort, never throws). */
export function reportClientError(where: ErrorWhere, error: unknown, componentStack?: string | null) {
  console.error(`[ai-sdk-letta] ${where}: render error`, error, componentStack ?? '');
  const report = clientErrorReport(where, error, componentStack);
  if (!limiter.allow(report)) return;
  try {
    void fetch('/api/client-errors', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', ...setCsrfHeader() }, body: JSON.stringify(report) }).catch(() => {});
  } catch { /* reporting never fails the app */ }
}

export type FallbackProps = { error: unknown; reset(): void };
type Props = { where: ErrorWhere; children: React.ReactNode; fallback(props: FallbackProps): React.ReactNode; resetKey?: unknown };
type State = { error?: { value: unknown }; key?: unknown };

/** Catches render errors below it; "Try again" (or a new `resetKey`: another call, message or conversation) renders the children again. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { key: this.props.resetKey };
  static getDerivedStateFromError(error: unknown): Partial<State> { return { error: { value: error } }; }
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.key) ? null : { key: props.resetKey, error: undefined };
  }
  componentDidCatch(error: unknown, info: React.ErrorInfo) { reportClientError(this.props.where, error, info.componentStack); }
  reset = () => this.setState({ error: undefined });
  render() { return this.state.error ? this.props.fallback({ error: this.state.error.value, reset: this.reset }) : this.props.children; }
}

/** The inline card of a part that failed: what failed, Try again, and the error (collapsed). */
export function ErrorCard({ error, reset, label }: FallbackProps & { label: string }) {
  return <div className="error-card" role="alert">
    <TriangleAlert size={14} className="line-icon" aria-hidden="true"/>
    <span className="error-card-text">{label}</span>
    <button type="button" className="link-btn" onClick={reset}>Try again</button>
    <details className="error-details"><summary>Details</summary><pre>{errorMessage(error)}</pre></details>
  </div>;
}

/** The whole app failed to render: Reload (the page) or Try again (render it again, state reset). The error is collapsed. */
export function AppErrorPanel({ error, reset }: FallbackProps) {
  const stack = error instanceof Error && error.stack ? error.stack : '';
  return <div className="app-error" role="alert">
    <div className="app-error-box">
      <TriangleAlert size={20} aria-hidden="true"/>
      <h1>Something went wrong</h1>
      <p className="muted">The app hit an error and stopped showing this page. Nothing was sent or changed. Try again, or reload the page.</p>
      <div className="app-error-actions">
        <button type="button" className="btn ghost" onClick={reset}>Try again</button>
        <button type="button" className="btn primary" onClick={() => location.reload()}><RotateCcw size={14} aria-hidden="true"/>Reload</button>
      </div>
      <details className="error-details"><summary>Error details</summary><pre>{errorMessage(error)}{stack ? `\n\n${stack}` : ''}</pre></details>
    </div>
  </div>;
}

/**
 * Test hook (browser checks only): `sessionStorage['ai-sdk-letta-crash'] = '<where>'`
 * makes the component under that boundary throw while rendering, to show its
 * fallback. Nothing happens without the key.
 */
export function CrashProbe({ where }: { where: ErrorWhere }) {
  let wanted: string | null = null;
  try { wanted = sessionStorage.getItem('ai-sdk-letta-crash'); } catch { /* storage unavailable */ }
  if (wanted === where) throw new Error(`Test crash (${where})`);
  return null;
}
