import { AttachmentError, fileMessage, type FileInfo } from './attachments.js';
/** Same-origin JSON client. The CSRF token lives in memory only; the session is an HttpOnly cookie (single-user) or Tailscale (team). */
let csrf = '';
export function setCsrf(value: string) { csrf = value; }
/** The CSRF header for a same-origin fetch outside {@link api}. */
export function setCsrfHeader(): Record<string, string> { return { 'X-CSRF-Token': csrf }; }
/**
 * Where the agent's API lives: `/api` for the single-user app, and
 * `/api/agents/<id>` for the agent selected in a team server.
 */
let base = '/api';
export function setAgentBase(agentId: string | undefined) { base = agentId ? `/api/agents/${encodeURIComponent(agentId)}` : '/api'; }
/** The URL of an agent API path (`/v1/...`), for links and fetches outside {@link api}. */
export const apiPath = (path: string) => `${base}${path}`;
/** JSON call to a server path outside the agent (`/api/session`, members). */
export async function serverApi<T>(path: string, body?: unknown, method = 'POST'): Promise<T> { return request<T>(`/api${path}`, body, method); }
export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  // '/session' is the server's, not the agent's.
  return request<T>(path === '/session' ? '/api/session' : apiPath(path), body, method);
}
async function request<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...(body !== undefined ? { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) } : {}) });
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
  if (code === 'not_found') return 'You no longer have access to this agent, or the conversation is gone. Nothing was changed.';
  if (code === 'invalid_input') return 'Titles need 1–120 visible characters. Nothing was changed.';
  return 'Couldn’t save that change. Nothing was changed.';
}

/**
 * Upload one file's raw bytes to `POST /api/v1/uploads` (validated by the
 * server before it is kept). Throws {@link AttachmentError} with toast text.
 */
export async function uploadFile(file: File, signal?: AbortSignal): Promise<FileInfo> {
  let response: Response;
  try {
    response = await fetch(apiPath('/v1/uploads'), { method: 'POST', credentials: 'same-origin', signal, body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf, 'X-File-Name': encodeURIComponent(file.name || 'file') } });
  } catch { throw new AttachmentError('Couldn’t upload that file. Check that the local server is running.'); }
  let data: { error?: string } & Partial<FileInfo> = {};
  try { data = await response.json(); } catch { /* no body */ }
  if (!response.ok) throw new AttachmentError(['session_required', 'csrf_required'].includes(data.error ?? '') ? 'The local server restarted. Refresh the page, then attach the file again.' : fileMessage(data.error ?? `http_${response.status}`));
  return data as FileInfo;
}

/** Upload one file into a resources folder (`POST /api/v1/resources/upload`). One commit on the server. */
export async function uploadResource(folder: string, file: File): Promise<{ path: string }> {
  let response: Response;
  try {
    response = await fetch(apiPath(`/v1/resources/upload?folder=${encodeURIComponent(folder)}`), { method: 'POST', credentials: 'same-origin', body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf, 'X-File-Name': encodeURIComponent(file.name || 'file') } });
  } catch { throw new ApiError('network', 0); }
  let data: { error?: string; path?: string } = {};
  try { data = await response.json(); } catch { /* no body */ }
  if (!response.ok) throw new ApiError(data.error ?? (response.status === 413 ? 'payload_too_large' : `http_${response.status}`), response.status);
  return data as { path: string };
}

/** A person as the team server shows them. */
export type Person = { id?: string; login: string; name: string; avatar?: string };
/** An agent as the browser knows it (team servers add the viewer's role). */
export type AgentInfo = { id: string; name: string; approvalTools: string[]; files?: boolean; ui?: { latex?: boolean }; role?: 'admin' | 'member';
  /** The agent has resources (a Resources panel) without accepting attachments. */
  resources?: boolean;
  /** Integrations whose accounts each person connects (`'atlassian'`). */
  integrations?: string[];
  /** The server serves the automation API (admins manage its tokens). */
  automations?: boolean;
  /** The agent can ask for decisions: members see and decide them (the bell). */
  decisions?: boolean;
  /** Team servers: when the agent replies unless a conversation overrides it. */
  replyMode?: import('ai-sdk-letta/listening').ReplyModeSetting };
/** `GET /api/session`: the single-user app (one agent) or a team server (the agents you belong to). */
export type Session =
  | { mode?: undefined; csrf: string; agent: AgentInfo; versions?: import('./versions.js').Versions }
  | { mode: 'team'; csrf?: string; user: Person; agents: AgentInfo[]; versions?: import('./versions.js').Versions };
/** A member of an agent (`GET /api/agents/<id>/members`). */
export type Member = Person & { id: string; role: 'admin' | 'member'; pending: boolean; you?: boolean };

export { uuid } from './uuid.js';

/** `GET /api/integrations/atlassian`: your own connection (never the token). */
export type AtlassianStatus = { connected: false } | { connected: true; site: string; email: string; accountName?: string; savedAt: string; checkedAt?: string; status: 'ok' | 'rejected'; rejectedAt?: string };
/** A JSON call to `/api/integrations/...` (the server's, not an agent's), with the server's message on failure. */
export async function integrationApi<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/integrations${path}`, { method, credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new IntegrationError('network', 'Couldn’t reach the local server. Check that it is running.'); }
  let data: { error?: string; message?: string } = {};
  try { data = await response.json(); } catch { /* no body */ }
  if (!response.ok) throw new IntegrationError(data.error ?? `http_${response.status}`, data.message ?? integrationMessage(data.error ?? ''));
  return data as T;
}
export class IntegrationError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const integrationMessage = (code: string) => ({
  session_required: 'The local server restarted. Refresh the page.', csrf_required: 'The local server restarted. Refresh the page.',
  integration_busy: 'Still checking the previous attempt. Try again in a moment.', payload_too_large: 'That is too long.', invalid_input: 'Check the site, email and token.',
} as Record<string, string>)[code] ?? 'That didn’t work. Nothing was changed.';
