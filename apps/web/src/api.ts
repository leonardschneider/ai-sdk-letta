/** Same-origin JSON client. The CSRF token lives in memory only; the session is an HttpOnly cookie. */
let csrf = '';
export function setCsrf(value: string) { csrf = value; }
export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...(body !== undefined ? { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) } : {}) });
  let data: { error?: string } | undefined;
  try { data = await response.json(); } catch { data = undefined; }
  if (!response.ok) throw new ApiError(data?.error ?? `http_${response.status}`, response.status);
  return data as T;
}
export const errorCode = (error: unknown) => error instanceof ApiError ? error.code : error instanceof Error ? error.message : String(error);
/** Human wording for metadata edits (rename/archive/restore). */
export function metadataError(error: unknown): string {
  const code = errorCode(error);
  if (code === 'runtime_busy') return 'Stop or finish the current reply first. Nothing was changed.';
  if (['session_required', 'invalid_csrf', 'csrf_required'].includes(code)) return 'The local server restarted. Refresh the page; nothing was changed.';
  if (code === 'invalid_input') return 'Titles need 1–120 visible characters. Nothing was changed.';
  return 'Couldn’t save that change. Nothing was changed.';
}
