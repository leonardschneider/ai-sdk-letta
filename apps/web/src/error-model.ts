/**
 * Render errors caught by the app's error boundaries: what is reported to
 * the local server's log (`POST /api/client-errors`), and how often. Pure
 * functions and a small rate limiter, no I/O.
 */

/** Where an error was caught: the whole app, one app view, a side-panel tab, a message or one part of it. */
export type ErrorWhere = 'app' | 'app-view' | 'side-panel' | 'message' | 'message-part' | 'window';

/** What the server logs about a render error: its place, message and stacks, bounded. No conversation content beyond the error text. */
export type ClientErrorReport = { where: ErrorWhere; message: string; stack?: string; componentStack?: string; at: string; version?: string };

export const REPORT_LIMITS = Object.freeze({ message: 500, stack: 4000, componentStack: 2000, perMinute: 5 });

/** The message of anything thrown (an Error, a string, or another value). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message || 'Unknown error'}`;
  if (typeof error === 'string') return error || 'Unknown error';
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

/** One report: bounded strings; stacks without query strings or fragments of the app's URLs. */
export function clientErrorReport(where: ErrorWhere, error: unknown, componentStack?: string | null, now = new Date(), version?: string): ClientErrorReport {
  const clean = (text: string, max: number) => text.replace(/(https?:\/\/[^\s)?#]*)[?#][^\s)]*/g, '$1').slice(0, max);
  const stack = error instanceof Error && typeof error.stack === 'string' ? clean(error.stack, REPORT_LIMITS.stack) : undefined;
  return {
    where, message: clean(errorMessage(error), REPORT_LIMITS.message), at: now.toISOString(),
    ...(stack ? { stack } : {}), ...(componentStack ? { componentStack: clean(componentStack, REPORT_LIMITS.componentStack) } : {}), ...(version ? { version } : {}),
  };
}

/** At most `limit` reports per minute, and the same error (place and message) once per minute. */
export class ReportLimiter {
  private readonly sent: number[] = [];
  private readonly recent = new Map<string, number>();
  constructor(private readonly limit: number = REPORT_LIMITS.perMinute, private readonly windowMs = 60_000) {}
  allow(report: Pick<ClientErrorReport, 'where' | 'message'>, now = Date.now()): boolean {
    while (this.sent.length && now - this.sent[0]! >= this.windowMs) this.sent.shift();
    for (const [key, at] of this.recent) if (now - at >= this.windowMs) this.recent.delete(key);
    const key = `${report.where}\u0000${report.message}`;
    if (this.recent.has(key) || this.sent.length >= this.limit) return false;
    this.sent.push(now); this.recent.set(key, now);
    return true;
  }
}
