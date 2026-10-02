import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tool, jsonSchema, type Tool } from 'ai';
import { adfHash, adfToMarkdown, isAdfDocument, markdownToAdf, spliceMarkdown, type AdfDocument, type AdfNode, type MarkdownOptions, type SpliceChange } from './adf.js';
import { ACTOR_CONTEXT, CredentialStore, publicStatus, type AtlassianCredentials, type AtlassianStatus, type TurnActor } from './credentials.js';
import { AttachmentStore, splitResourcePath } from './resources.js';
import { FileInputError, sanitizeFileName } from './attachments.js';
import { sniffImageType } from './images.js';
import { PREPARED_CONTEXT, withPreparation, type PreparedCall } from './tools.js';
import type { ApprovalPreview } from './interactions.js';
import type { ToolPermission } from './definition.js';

/**
 * Atlassian (Jira and Confluence Cloud) for agents, with each user's own API
 * token. See the README ("Atlassian") for the user-facing description.
 *
 * - Credentials are per user ({@link CredentialStore}); a tool call always
 *   acts as the user whose message started the turn ({@link ACTOR_CONTEXT}).
 * - `atlassian_request` reaches only the user's site, and only the Jira
 *   (`/rest/api/3/`) and Confluence (`/wiki/api/v2/`, `/wiki/rest/api/`)
 *   REST APIs. Reads run; any other method asks the user first.
 * - `atlassian_fetch` saves an issue or a page into the conversation's folder
 *   as `<name>.adf.json` (the original, with its source) and `<name>.md`.
 * - `atlassian_update` writes an edited `.md` back by block splice (see
 *   `spliceMarkdown`), after the user approved the exact change, and only if
 *   the issue or page did not change in the meantime.
 */

/** Names of the Atlassian tools. */
export const ATLASSIAN_TOOL_NAMES = ['atlassian_request', 'atlassian_fetch', 'atlassian_update'] as const;
export type AtlassianToolName = typeof ATLASSIAN_TOOL_NAMES[number];
/** Default policy: reads run, `atlassian_request` asks for any method but GET, and every update asks. */
export const ATLASSIAN_TOOL_PERMISSIONS: Readonly<Record<AtlassianToolName, ToolPermission>> = Object.freeze({ atlassian_request: 'allow', atlassian_fetch: 'allow', atlassian_update: 'ask' });
/** Deadline of one Atlassian tool call (network included; human waits excluded). */
export const ATLASSIAN_TIMEOUT_MS = 60_000;
/** Bounds of what the tools return and accept. */
export const ATLASSIAN_LIMITS = Object.freeze({
  /** Most characters of a response shown to the model. */
  maxResponseChars: 12_000,
  /** Most characters of a fetched document's Markdown included in the `atlassian_fetch` result. */
  maxInlineMarkdown: 8_000,
  /** Largest response body read from Atlassian. */
  maxResponseBytes: 8 * 1024 * 1024,
  /** Largest request body sent. */
  maxBodyChars: 200_000,
  /** Largest image served by the preview proxy. */
  maxMediaBytes: 15 * 1024 * 1024,
  /** Per-request network timeout. */
  requestTimeoutMs: 25_000,
});

/**
 * Key under which the runtime passes Atlassian's per-user credentials to
 * the tools (`options.context[ATLASSIAN_CONTEXT]`): the server's
 * {@link CredentialStore}, plus an optional `fetch` (tests).
 */
export const ATLASSIAN_CONTEXT = 'ai-sdk-letta.atlassian';
/** Key under which the runtime passes the current conversation's folder to tools that save files (`options.context[WORKSPACE_CONTEXT]`). */
export const WORKSPACE_CONTEXT = 'ai-sdk-letta.workspace';
export type AtlassianContext = { store: CredentialStore; fetch?: typeof fetch };

/** A refusal with text for the model (never a secret). */
export class AtlassianError extends Error {
  constructor(readonly code: 'not_connected' | 'token_rejected' | 'no_user' | 'path_not_allowed' | 'invalid_site' | 'invalid_input' | 'network' | 'http' | 'conflict' | 'unavailable', message: string, readonly status?: number) { super(message); }
}

/* ------------------------------------------------------------------ */
/* Sites, paths, connection                                            */
/* ------------------------------------------------------------------ */

/** Normalize a site to `https://<name>.atlassian.net`. @throws {AtlassianError} `invalid_site` */
export function normalizeSite(input: unknown): string {
  if (typeof input !== 'string') throw new AtlassianError('invalid_site', 'Enter your site, for example https://your-team.atlassian.net');
  let value = input.trim().toLowerCase();
  if (!/^https?:\/\//.test(value)) value = `https://${value}`;
  let url: URL;
  try { url = new URL(value); } catch { throw new AtlassianError('invalid_site', 'Enter your site, for example https://your-team.atlassian.net'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(url.hostname)) throw new AtlassianError('invalid_site', 'Only Atlassian Cloud sites (https://<name>.atlassian.net) are supported');
  return `https://${url.hostname}`;
}

const ALLOWED_PREFIXES = ['/rest/api/3/', '/wiki/api/v2/', '/wiki/rest/api/'] as const;
/**
 * Check a REST path for the user's site: a path (never a URL) under the Jira
 * REST API v3 (`/rest/api/3/`) or the Confluence REST API v2 or v1
 * (`/wiki/api/v2/`, `/wiki/rest/api/`), without `..`, encoded slashes,
 * backslashes or control characters. Returns the full URL.
 * @throws {AtlassianError} `path_not_allowed`
 */
export function atlassianUrl(site: string, path: unknown): URL {
  const refuse = (why: string) => new AtlassianError('path_not_allowed', `${why}. Use a path such as /rest/api/3/issue/KEY-1 (Jira) or /wiki/api/v2/pages/123 (Confluence); other hosts and APIs are not reachable.`);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 4000) throw refuse('Not a REST path');
  if (/[\0-\x1f\x7f\\#]/.test(path) || /%2f|%5c|%00|%2e/i.test(path.split('?')[0]!)) throw refuse('The path has characters that are not allowed');
  const pathname = path.split('?')[0]!;
  if (pathname.split('/').some(part => part === '..' || part === '.')) throw refuse('The path must not contain . or ..');
  if (!ALLOWED_PREFIXES.some(prefix => pathname.startsWith(prefix))) throw refuse(`Only ${ALLOWED_PREFIXES.join(', ')} are allowed`);
  const url = new URL(path, site);
  if (url.origin !== new URL(site).origin || url.pathname !== pathname) throw refuse('The path must stay on your site');
  return url;
}

/** Basic auth header of stored credentials. Kept out of every log, error and result. */
const authorization = (credentials: Pick<AtlassianCredentials, 'email' | 'token'>) => `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`;

type Response = { status: number; json?: unknown; text: string; headers: Headers };
async function readBody(response: globalThis.Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => {}); throw new AtlassianError('http', `The response is larger than ${Math.round(limit / 1024 / 1024)} MB; narrow the request (fields=, maxResults=, limit=).`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One authenticated request to the user's site. Redirects are not followed
 * (the token is never sent anywhere else). A 401 marks the stored token as
 * rejected and throws `token_rejected`.
 */
export async function atlassianFetch(context: { credentials: AtlassianCredentials; store?: CredentialStore; userId?: string; fetch?: typeof fetch; signal?: AbortSignal }, method: string, path: string, body?: unknown): Promise<Response> {
  const url = atlassianUrl(context.credentials.site, path);
  const signal = AbortSignal.any([AbortSignal.timeout(ATLASSIAN_LIMITS.requestTimeoutMs), ...(context.signal ? [context.signal] : [])]);
  let response: globalThis.Response;
  try {
    response = await (context.fetch ?? fetch)(url, { method, redirect: 'manual', signal,
      headers: { Authorization: authorization(context.credentials), Accept: 'application/json', 'User-Agent': 'ai-sdk-letta', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        // Atlassian's XSRF check for non-browser clients on Confluence v1 mutations.
        ...(method !== 'GET' ? { 'X-Atlassian-Token': 'no-check' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (error) {
    if (context.signal?.aborted) throw error;
    throw new AtlassianError('network', `Couldn't reach ${new URL(context.credentials.site).hostname} (${(error as Error)?.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    if (context.store && context.userId) context.store.updateAtlassian(context.userId, { status: 'rejected', rejectedAt: new Date().toISOString() });
    throw new AtlassianError('token_rejected', 'Atlassian rejected the saved API token (it expired or was revoked).', 401);
  }
  const text = await readBody(response, ATLASSIAN_LIMITS.maxResponseBytes);
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: response.status, json, text, headers: response.headers };
}

/** Input of {@link connectAtlassian}. */
export type AtlassianConnectInput = { site?: unknown; email?: unknown; token?: unknown };
/**
 * Check a site, email and API token against Atlassian (`GET /rest/api/3/myself`,
 * or Confluence's current user when the site has no Jira) and save them for
 * `userId`. The token is stored only when the check succeeds. Returns the
 * public status (never the token).
 */
export async function connectAtlassian(store: CredentialStore, userId: string, input: AtlassianConnectInput, options: { fetch?: typeof fetch } = {}): Promise<AtlassianStatus> {
  const site = normalizeSite(input.site);
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!/^[^\s@]{1,128}@[^\s@]{1,128}$/.test(email)) throw new AtlassianError('invalid_input', 'Enter the email address of your Atlassian account.');
  if (!token || token.length > 1000 || /\s/.test(token)) throw new AtlassianError('invalid_input', 'Paste the API token you created at id.atlassian.com (Security → API tokens).');
  const credentials: AtlassianCredentials = { site, email, token, savedAt: new Date().toISOString(), status: 'ok' };
  let account: Awaited<ReturnType<typeof whoAmI>>;
  try { account = await whoAmI(credentials, options.fetch); }
  catch (error) {
    if (error instanceof AtlassianError && error.code === 'token_rejected') throw new AtlassianError('token_rejected', `Atlassian did not accept this email and API token for ${new URL(site).hostname}. Check both (the token is the one from id.atlassian.com, not your password). Nothing was saved.`, 401);
    throw error;
  }
  const saved: AtlassianCredentials = { ...credentials, checkedAt: new Date().toISOString(), ...account };
  store.saveAtlassian(userId, saved);
  return publicStatus(saved);
}
/** Check the saved credentials of `userId` again. A 401 marks them rejected. */
export async function testAtlassian(store: CredentialStore, userId: string, options: { fetch?: typeof fetch } = {}): Promise<AtlassianStatus> {
  const credentials = store.atlassian(userId);
  if (!credentials) return { connected: false };
  try {
    const account = await whoAmI(credentials, options.fetch);
    return publicStatus(store.updateAtlassian(userId, { status: 'ok', checkedAt: new Date().toISOString(), ...account }));
  } catch (error) {
    if (error instanceof AtlassianError && error.code === 'token_rejected') return publicStatus(store.updateAtlassian(userId, { status: 'rejected', rejectedAt: new Date().toISOString() }));
    throw error;
  }
}
async function whoAmI(credentials: AtlassianCredentials, fetcher?: typeof fetch): Promise<{ accountId?: string; accountName?: string }> {
  const jira = await atlassianFetch({ credentials, fetch: fetcher }, 'GET', '/rest/api/3/myself');
  if (jira.status === 200) { const me = jira.json as { accountId?: string; displayName?: string }; return { ...(me.accountId ? { accountId: me.accountId } : {}), ...(me.displayName ? { accountName: me.displayName } : {}) }; }
  const wiki = await atlassianFetch({ credentials, fetch: fetcher }, 'GET', '/wiki/rest/api/user/current');
  if (wiki.status === 200) { const me = wiki.json as { accountId?: string; displayName?: string; publicName?: string }; return { ...(me.accountId ? { accountId: me.accountId } : {}), ...(me.displayName ?? me.publicName ? { accountName: me.displayName ?? me.publicName } : {}) }; }
  throw new AtlassianError('http', `The site answered ${jira.status}; check the site address.`, jira.status);
}

/* ------------------------------------------------------------------ */
/* Who the tools act for                                               */
/* ------------------------------------------------------------------ */

type Context = Readonly<Record<string, unknown>> | undefined;
type Session = { actor: TurnActor; credentials: AtlassianCredentials; store: CredentialStore; fetch?: typeof fetch };
/** The calling user's session, or an error text for the model. */
function session(context: Context): Session {
  const atlassian = context?.[ATLASSIAN_CONTEXT] as AtlassianContext | undefined;
  if (!atlassian || !(atlassian.store instanceof CredentialStore)) throw new AtlassianError('unavailable', 'Atlassian is not available in this session.');
  const actor = context?.[ACTOR_CONTEXT] as TurnActor | undefined;
  if (!actor || typeof actor.id !== 'string') throw new AtlassianError('no_user', 'This turn was not started by a person (an unattended or scheduled run), so Atlassian cannot be used: the tools act only with the token of the person who sent the message.');
  const credentials = atlassian.store.atlassian(actor.id);
  const who = actor.name && actor.name !== 'You' ? actor.name : 'the user';
  if (!credentials) throw new AtlassianError('not_connected', `Atlassian is not connected for ${who}. Ask them to connect it: in the app, open the menu at the bottom of the sidebar and choose "Connect Atlassian" (site, email and an API token).`);
  if (credentials.status === 'rejected') throw new AtlassianError('token_rejected', `Atlassian rejected the saved API token of ${who} (it expired or was revoked). Ask them to replace it in "Connect Atlassian".`);
  return { actor, credentials, store: atlassian.store, ...(atlassian.fetch ? { fetch: atlassian.fetch } : {}) };
}
const call = (s: Session, method: string, path: string, body?: unknown, signal?: AbortSignal) => atlassianFetch({ credentials: s.credentials, store: s.store, userId: s.actor.id, fetch: s.fetch, signal }, method, path, body).catch(error => {
  if (error instanceof AtlassianError && error.code === 'token_rejected') {
    const who = s.actor.name && s.actor.name !== 'You' ? s.actor.name : 'the user';
    throw new AtlassianError('token_rejected', `Atlassian rejected the saved API token of ${who} (it expired or was revoked). Ask them to replace it in "Connect Atlassian".`, 401);
  }
  throw error;
});

/* ------------------------------------------------------------------ */
/* Responses for the model                                             */
/* ------------------------------------------------------------------ */

const NOISE = new Set(['avatarUrls', 'iconUrl', 'self', 'expand', '_expandable', 'avatarId', 'renderedFields']);
/**
 * A response as compact text for the model: ADF documents (Jira's rich text
 * fields, Confluence's `atlas_doc_format` bodies) become Markdown, avatar
 * and self links are dropped, and long results are cut with a notice.
 */
export function responseText(json: unknown, limit: number = ATLASSIAN_LIMITS.maxResponseChars): string {
  const simplify = (value: unknown, key?: string, parent?: Record<string, unknown>): unknown => {
    if (isAdfDocument(value)) return adfToMarkdown(value).trimEnd();
    if (typeof value === 'string' && key === 'value' && parent?.representation === 'atlas_doc_format') {
      try { const doc = JSON.parse(value) as unknown; if (isAdfDocument(doc)) return adfToMarkdown(doc).trimEnd(); } catch { /* keep */ }
    }
    if (Array.isArray(value)) return value.map(item => simplify(item));
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(object).filter(([k, v]) => !NOISE.has(k) && v !== null && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, simplify(v, k, object)]));
    }
    return value;
  };
  const text = json === undefined ? '' : JSON.stringify(simplify(json), null, 1).replace(/\n\s*/g, ' ');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[Truncated: ${(text.length - limit).toLocaleString('en-US')} more characters. Narrow the request: fields=..., maxResults=/limit=, or a smaller page.]`;
}

/* ------------------------------------------------------------------ */
/* atlassian_request                                                   */
/* ------------------------------------------------------------------ */

type RequestInput = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; body?: unknown };
/** Replace `{ "$markdown": "..." }` anywhere in a body by ADF (stringified where Confluence expects `atlas_doc_format`). */
export function expandMarkdown(body: unknown): unknown {
  const walk = (value: unknown, key?: string, parent?: Record<string, unknown>): unknown => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      if (Object.keys(object).length === 1 && typeof object.$markdown === 'string') {
        const doc = markdownToAdf(object.$markdown);
        return key === 'value' && parent?.representation === 'atlas_doc_format' ? JSON.stringify(doc) : doc;
      }
      return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, walk(v, k, object)]));
    }
    if (Array.isArray(value)) return value.map(item => walk(item));
    return value;
  };
  return walk(body);
}
/** Readable body for an approval: Markdown parts shown as Markdown. */
function readableBody(body: unknown): string {
  if (body === undefined) return '';
  const markdown: string[] = [];
  const text = JSON.stringify(body, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as { $markdown?: unknown }).$markdown === 'string') { markdown.push((value as { $markdown: string }).$markdown); return `«Markdown ${markdown.length}»`; }
    if (isAdfDocument(value)) { markdown.push(adfToMarkdown(value).trimEnd()); return `«Markdown ${markdown.length}»`; }
    return value;
  }, 2);
  return `${text}${markdown.map((md, i) => `\n\n«Markdown ${i + 1}»:\n${md}`).join('')}`;
}

const requestTool = withPreparation(tool({
  description: 'Call the Jira or Confluence Cloud REST API on the user\'s own site, with their account. path is a REST path: Jira /rest/api/3/... (search: GET /rest/api/3/search/jql?jql=...&fields=summary,status&maxResults=20; comments: /rest/api/3/issue/KEY/comment), Confluence /wiki/api/v2/... (pages, spaces) or /wiki/rest/api/... (search: /wiki/rest/api/search?cql=...). '
    + 'Rich text in responses comes back as Markdown. For rich text in a body, write {"$markdown": "..."} where the API expects an ADF document. GET runs at once; POST, PUT, PATCH and DELETE are shown to the user, who must approve. '
    + 'To read or edit an issue description or a page, prefer atlassian_fetch and atlassian_update. Ask for only the fields you need: responses are cut at about 12,000 characters.',
  inputSchema: jsonSchema<RequestInput>({ type: 'object', properties: {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    path: { type: 'string', minLength: 2, maxLength: 4000, description: 'REST path with query string, e.g. /rest/api/3/issue/KEY-1?fields=summary,status' },
    body: { description: 'JSON body for POST, PUT and PATCH.' },
  }, required: ['method', 'path'], additionalProperties: false }),
  execute: async (input, options) => {
    try {
      const s = session(options.context as Context);
      const prepared = (options.context as Context)?.[PREPARED_CONTEXT] as { body?: unknown } | undefined;
      // Fail closed: a change runs only as prepared (and approved) by the tool bridge.
      if (input.method !== 'GET' && !prepared) throw new AtlassianError('unavailable', 'Changes need the user\'s approval, which this session cannot ask for.');
      const body = input.method === 'GET' || input.method === 'DELETE' ? undefined : prepared?.body;
      const response = await call(s, input.method, input.path, body, options.abortSignal);
      const ok = response.status >= 200 && response.status < 300;
      const head = `${input.method} ${input.path} → ${response.status}${ok ? '' : ' (failed)'}`;
      const text = response.json !== undefined ? responseText(response.json) : response.text.slice(0, 2000);
      return { text: `${head}${text ? `\n${text}` : ''}`, isError: !ok };
    } catch (error) { return errorOutput(error); }
  },
  toModelOutput,
}), (input, options) => {
  const { method, path, body } = input as RequestInput;
  try {
    const s = session(options.context);
    atlassianUrl(s.credentials.site, path);
    if (method === 'GET') return {};
    if (body !== undefined && JSON.stringify(body).length > ATLASSIAN_LIMITS.maxBodyChars) return { output: { text: `Error (invalid_input): The body is larger than ${ATLASSIAN_LIMITS.maxBodyChars.toLocaleString('en-US')} characters.`, isError: true } };
    const expanded = body === undefined ? undefined : expandMarkdown(body);
    const preview: ApprovalPreview = { kind: 'atlassian-request', title: `${method} ${path}`, text: `${method} ${new URL(path, s.credentials.site).href}${body !== undefined ? `\n\n${readableBody(body)}` : ''}`,
      data: { method, path, url: new URL(path, s.credentials.site).href, site: s.credentials.site, account: s.credentials.accountName ?? s.credentials.email, ...(body !== undefined ? { body: readableBody(body) } : {}) } };
    return { approval: 'required', preview, onBehalfOf: s.actor.id, state: { body: expanded } } satisfies PreparedCall;
  } catch (error) { return { output: errorOutput(error) }; }
});

/* ------------------------------------------------------------------ */
/* Saved documents                                                     */
/* ------------------------------------------------------------------ */

/** Where a saved document came from, and the version it was fetched at. */
export type AtlassianSource =
  | { product: 'jira'; site: string; key: string; id: string; url: string; title: string; updated: string; descriptionHash: string }
  | { product: 'confluence'; site: string; id: string; url: string; title: string; version: number; spaceId?: string; status?: string };
/** A media item of a saved document: its attachment's name and where its bytes are (a path on the same site). */
export type AtlassianMedia = { name: string; mediaType?: string; bytes?: number; download?: string };
/** The `.adf.json` file: the original document and its source. */
export type SavedDocument = { format: 'ai-sdk-letta/atlassian@1'; source: AtlassianSource; fetchedAt: string; markdownHash: string; media: Record<string, AtlassianMedia>; document: AdfDocument };
/** Is `value` a saved document (`.adf.json` written by `atlassian_fetch`)? */
export function isSavedDocument(value: unknown): value is SavedDocument {
  const v = value as SavedDocument | undefined;
  return !!v && v.format === 'ai-sdk-letta/atlassian@1' && !!v.source && isAdfDocument(v.document);
}
/** Markdown options of a saved document: media named by their attachment. */
export const mediaOptions = (media: Record<string, AtlassianMedia>): MarkdownOptions => ({ mediaName: attrs => typeof attrs.id === 'string' ? media[attrs.id]?.name : undefined });
const header = (source: AtlassianSource) => `<!-- ${source.product === 'jira' ? `Jira ${source.key}` : 'Confluence page'}: ${source.title.replace(/--/g, '—')} · ${source.url} · Edit below, then call atlassian_update. Keep blocks with @mentions, [status: …], [image: …], [macro: …], tasks or panels as they are. -->`;
const stripHeader = (markdown: string) => markdown.replace(/^\uFEFF?\s*<!--[\s\S]*?-->\s*\n?/, '');

/** Atomically replace a file in a conversation's folder (no links followed). */
function writeWorkspaceFile(workspace: AttachmentStore, name: string, data: string): string {
  const path = workspace.resolvePath(name);
  const absolute = workspace.resources.resolve(path, { mustExist: false });
  try { if (lstatSync(absolute).isSymbolicLink()) throw new AtlassianError('invalid_input', `${name} is a link; it was not replaced.`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(dirname(absolute), `.tmp-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, absolute); } catch (error) { try { unlinkSync(temporary); } catch { /* gone */ } throw error; }
  return path;
}
function readWorkspaceText(workspace: AttachmentStore, name: string): string {
  const { bytes } = workspace.read(name);
  return bytes.toString('utf8');
}
function workspaceOf(context: Context): AttachmentStore {
  const store = context?.[WORKSPACE_CONTEXT];
  if (!(store instanceof AttachmentStore)) throw new AtlassianError('unavailable', 'Saving files is not available in this session (the agent has no resources).');
  return store;
}

/** A reference to an issue or page: `KEY-12`, a Jira or Confluence URL, or `page:123`. */
export function parseReference(input: string, site: string): { product: 'jira'; key: string } | { product: 'confluence'; id: string } {
  const value = input.trim();
  const key = /^([A-Z][A-Z0-9_]{0,30}-\d{1,9})$/i.exec(value)?.[1];
  if (key) return { product: 'jira', key: key.toUpperCase() };
  const page = /^(?:page:)?(\d{1,20})$/.exec(value)?.[1];
  if (page) return { product: 'confluence', id: page };
  let url: URL | undefined;
  try { url = new URL(value); } catch { /* not a URL */ }
  if (url) {
    if (url.origin !== new URL(site).origin) throw new AtlassianError('invalid_input', `That link is on ${url.hostname}, but your connected site is ${new URL(site).hostname}.`);
    const browse = /\/browse\/([A-Z][A-Z0-9_]{0,30}-\d{1,9})/i.exec(url.pathname)?.[1] ?? url.searchParams.get('selectedIssue');
    if (browse && /^[A-Z][A-Z0-9_]{0,30}-\d{1,9}$/i.test(browse)) return { product: 'jira', key: browse.toUpperCase() };
    const wiki = /\/wiki\/.*\/pages\/(\d{1,20})/.exec(url.pathname)?.[1] ?? (url.pathname.startsWith('/wiki/') ? url.searchParams.get('pageId') : undefined);
    if (wiki && /^\d{1,20}$/.test(wiki)) return { product: 'confluence', id: wiki };
  }
  throw new AtlassianError('invalid_input', `"${value.slice(0, 120)}" is not an issue key (ABC-123), a page ID or a Jira or Confluence link.`);
}

type Remote = { source: AtlassianSource; document: AdfDocument; media: Record<string, AtlassianMedia>; summary: string[] };
const EMPTY: AdfDocument = { version: 1, type: 'doc', content: [] };

/** Jira: map ADF media (file UUIDs) to attachments by following each attachment's content redirect, which names its file. */
async function jiraMedia(s: Session, attachments: { id: string; filename: string; mimeType?: string; size?: number }[], signal?: AbortSignal): Promise<Record<string, AtlassianMedia>> {
  const media: Record<string, AtlassianMedia> = {};
  const list = attachments.slice(0, 30);
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map(async attachment => {
      const path = `/rest/api/3/attachment/content/${encodeURIComponent(attachment.id)}`;
      const entry: AtlassianMedia = { name: attachment.filename, ...(attachment.mimeType ? { mediaType: attachment.mimeType } : {}), ...(attachment.size !== undefined ? { bytes: attachment.size } : {}), download: path };
      try {
        const url = atlassianUrl(s.credentials.site, path);
        const response = await (s.fetch ?? fetch)(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(ATLASSIAN_LIMITS.requestTimeoutMs), ...(signal ? [signal] : [])]), headers: { Authorization: authorization(s.credentials) } });
        await response.body?.cancel().catch(() => {});
        const fileId = /\/file\/([0-9a-f-]{36})\//i.exec(response.headers.get('location') ?? '')?.[1];
        if (fileId) media[fileId.toLowerCase()] = entry;
      } catch { /* named by its alt text instead */ }
      media[`name:${attachment.filename}`] = entry;
    }));
  }
  return media;
}
const lower = (media: Record<string, AtlassianMedia>, doc: AdfDocument) => {
  // ADF media without a mapped ID fall back to their alt text (= the attachment name in Jira).
  const walk = (node: AdfNode) => {
    if ((node.type === 'media' || node.type === 'mediaInline') && typeof node.attrs?.id === 'string') {
      const id = node.attrs.id.toLowerCase();
      if (!media[node.attrs.id] && media[id]) media[node.attrs.id] = media[id]!;
      else if (!media[node.attrs.id] && typeof node.attrs.alt === 'string' && media[`name:${node.attrs.alt}`]) media[node.attrs.id] = media[`name:${node.attrs.alt}`]!;
    }
    node.content?.forEach(walk);
  };
  doc.content.forEach(walk);
  for (const key of Object.keys(media)) if (key.startsWith('name:')) delete media[key];
  return media;
};

async function fetchRemote(s: Session, reference: ReturnType<typeof parseReference>, signal?: AbortSignal): Promise<Remote> {
  const site = s.credentials.site;
  if (reference.product === 'jira') {
    const response = await call(s, 'GET', `/rest/api/3/issue/${encodeURIComponent(reference.key)}?fields=summary,description,status,issuetype,assignee,reporter,priority,labels,updated,created,attachment,project`, undefined, signal);
    if (response.status === 404) throw new AtlassianError('http', `Issue ${reference.key} does not exist, or ${s.actor.name && s.actor.name !== 'You' ? s.actor.name : 'the user'} cannot see it.`, 404);
    if (response.status !== 200) throw new AtlassianError('http', `Jira answered ${response.status} for ${reference.key}.`, response.status);
    const issue = response.json as { id: string; key: string; fields: Record<string, unknown> };
    const f = issue.fields;
    const name = (v: unknown) => (v as { name?: string; displayName?: string } | null)?.displayName ?? (v as { name?: string } | null)?.name;
    const document = isAdfDocument(f.description) ? f.description as AdfDocument : EMPTY;
    const media = lower(await jiraMedia(s, (Array.isArray(f.attachment) ? f.attachment : []) as { id: string; filename: string; mimeType?: string; size?: number }[], signal), document);
    const source: AtlassianSource = { product: 'jira', site, key: issue.key, id: issue.id, url: `${site}/browse/${issue.key}`, title: String(f.summary ?? ''), updated: String(f.updated ?? ''), descriptionHash: adfHash(f.description ?? null) };
    const summary = [`Jira issue ${issue.key}: ${String(f.summary ?? '')}`, [name(f.issuetype), name(f.status), f.priority ? `priority ${name(f.priority)}` : '', f.assignee ? `assignee ${name(f.assignee)}` : 'unassigned', f.reporter ? `reporter ${name(f.reporter)}` : '', Array.isArray(f.labels) && f.labels.length ? `labels ${f.labels.join(', ')}` : '', `updated ${String(f.updated ?? '')}`].filter(Boolean).join(' · ')];
    return { source, document, media, summary };
  }
  const response = await call(s, 'GET', `/wiki/api/v2/pages/${encodeURIComponent(reference.id)}?body-format=atlas_doc_format`, undefined, signal);
  if (response.status === 404) throw new AtlassianError('http', `Page ${reference.id} does not exist, or ${s.actor.name && s.actor.name !== 'You' ? s.actor.name : 'the user'} cannot see it.`, 404);
  if (response.status !== 200) throw new AtlassianError('http', `Confluence answered ${response.status} for page ${reference.id}.`, response.status);
  const page = response.json as { id: string; title: string; status?: string; spaceId?: string; version?: { number?: number; createdAt?: string }; body?: { atlas_doc_format?: { value?: string } }; _links?: { webui?: string; base?: string } };
  let document = EMPTY;
  try { const parsed = JSON.parse(page.body?.atlas_doc_format?.value ?? 'null') as unknown; if (isAdfDocument(parsed)) document = { ...parsed, version: 1 } as AdfDocument; } catch { /* empty page */ }
  const media: Record<string, AtlassianMedia> = {};
  const attachments = await call(s, 'GET', `/wiki/api/v2/pages/${encodeURIComponent(page.id)}/attachments?limit=50`, undefined, signal).catch(() => undefined);
  for (const a of ((attachments?.json as { results?: { title?: string; fileId?: string; mediaType?: string; fileSize?: number; downloadLink?: string }[] } | undefined)?.results ?? [])) {
    if (!a.fileId || !a.title) continue;
    const download = a.downloadLink && a.downloadLink.startsWith('/download/') ? `/wiki${a.downloadLink}` : undefined;
    media[a.fileId] = { name: a.title, ...(a.mediaType ? { mediaType: a.mediaType } : {}), ...(a.fileSize !== undefined ? { bytes: a.fileSize } : {}), ...(download ? { download } : {}) };
  }
  const url = page._links?.webui ? `${site}/wiki${page._links.webui}` : `${site}/wiki/pages/viewpage.action?pageId=${page.id}`;
  const version = Number(page.version?.number ?? 0);
  const source: AtlassianSource = { product: 'confluence', site, id: page.id, url, title: page.title, version, ...(page.spaceId ? { spaceId: page.spaceId } : {}), ...(page.status ? { status: page.status } : {}) };
  return { source, document, media, summary: [`Confluence page ${page.id}: ${page.title}`, `version ${version}${page.version?.createdAt ? ` · updated ${page.version.createdAt}` : ''}`] };
}

const fileBase = (source: AtlassianSource) => source.product === 'jira' ? source.key : sanitizeFileName((source.title || `Page ${source.id}`).replace(/[\\/]/g, '-'), `Page ${source.id}`).replace(/\.(md|json)$/i, '').slice(0, 100).trim();
/** Save a fetched document as `<base>.adf.json` and `<base>.md`. A Confluence title already used by another page gets its ID. */
function saveDocument(workspace: AttachmentStore, remote: Remote, base?: string): { markdownPath: string; adfPath: string; markdown: string; base: string } {
  let name = base ?? fileBase(remote.source);
  if (!base && remote.source.product === 'confluence') {
    try {
      const existing = JSON.parse(readWorkspaceText(workspace, `${name}.adf.json`)) as unknown;
      if (isSavedDocument(existing) && (existing.source.product !== 'confluence' || existing.source.id !== remote.source.id)) name = `${name} (${remote.source.id})`;
    } catch { /* free */ }
  }
  const markdown = adfToMarkdown(remote.document, mediaOptions(remote.media));
  const saved: SavedDocument = { format: 'ai-sdk-letta/atlassian@1', source: remote.source, fetchedAt: new Date().toISOString(), markdownHash: adfHash(markdown), media: remote.media, document: remote.document };
  const adfPath = writeWorkspaceFile(workspace, `${name}.adf.json`, `${JSON.stringify(saved, null, 2)}\n`);
  const markdownPath = writeWorkspaceFile(workspace, `${name}.md`, `${header(remote.source)}\n\n${markdown}`);
  return { markdownPath, adfPath, markdown, base: name };
}

/* ------------------------------------------------------------------ */
/* atlassian_fetch                                                     */
/* ------------------------------------------------------------------ */

const fetchTool = tool({
  description: 'Fetch a Jira issue (key such as ABC-123, or its link) or a Confluence page (page ID or link) from the user\'s site and save it in this conversation\'s folder: <name>.md (Markdown, to read and edit) and <name>.adf.json (the original, kept for updates). Returns the issue\'s fields and its description, or the page, as Markdown. To change it, use atlassian_update.',
  inputSchema: jsonSchema<{ ref: string }>({ type: 'object', properties: { ref: { type: 'string', minLength: 1, maxLength: 2000, description: 'Issue key (ABC-123), page ID, or a Jira or Confluence link on the user\'s site.' } }, required: ['ref'], additionalProperties: false }),
  execute: async ({ ref }, options) => {
    try {
      const s = session(options.context as Context);
      const workspace = workspaceOf(options.context as Context);
      const remote = await fetchRemote(s, parseReference(ref, s.credentials.site), options.abortSignal);
      const saved = saveDocument(workspace, remote);
      const shown = saved.markdown.length > ATLASSIAN_LIMITS.maxInlineMarkdown ? `${saved.markdown.slice(0, ATLASSIAN_LIMITS.maxInlineMarkdown)}\n[Truncated: read the rest with read_file "${workspace.display(saved.markdownPath)}".]` : saved.markdown || '(empty)';
      const files = `Saved ${workspace.display(saved.markdownPath)} (Markdown) and ${workspace.display(saved.adfPath)} (original).`;
      return { text: `${remote.summary.join('\n')}\n${remote.source.url}\n${files}\n\n${shown.trimEnd()}\n\nTo change the ${remote.source.product === 'jira' ? 'description' : 'page'}, call atlassian_update with file "${workspace.display(saved.markdownPath)}" and edits (find/replace in that Markdown). Blocks with @mentions, [status: …], [date: …], [image: …], [macro: …], tasks, panels or coloured text are read-only.` };
    } catch (error) { return errorOutput(error); }
  },
  toModelOutput,
});

/* ------------------------------------------------------------------ */
/* atlassian_update                                                    */
/* ------------------------------------------------------------------ */

type UpdateInput = { file: string; edits?: { find: string; replace: string }[] };
type UpdatePlan = { base: string; saved: SavedDocument; doc: AdfDocument; changes: SpliceChange[]; markdown: string; remoteTitle: string };

/** Apply exact find/replace edits (each `find` must occur once). */
export function applyEdits(text: string, edits: readonly { find: string; replace: string }[]): string {
  let out = text;
  for (const [index, edit] of edits.entries()) {
    const at = out.indexOf(edit.find);
    if (!edit.find || at < 0) throw new AtlassianError('invalid_input', `Edit ${index + 1}: the text to find is not in the file. Copy it exactly from the Markdown (read the file again if needed).`);
    if (out.indexOf(edit.find, at + edit.find.length) >= 0) throw new AtlassianError('invalid_input', `Edit ${index + 1}: the text to find occurs more than once; include more surrounding text so it is unique.`);
    out = out.slice(0, at) + edit.replace + out.slice(at + edit.find.length);
  }
  return out;
}
const baseOf = (file: string) => file.trim().replace(/\.(adf\.json|md)$/i, '');

/** Compare the saved version with the remote one. Returns a conflict message, or the remote title. */
async function checkRemote(s: Session, saved: SavedDocument, signal?: AbortSignal): Promise<{ conflict?: string; title: string; version?: number }> {
  const source = saved.source;
  if (source.site !== s.credentials.site) throw new AtlassianError('conflict', `This file was fetched from ${new URL(source.site).hostname}, but the connected site is ${new URL(s.credentials.site).hostname}.`);
  if (source.product === 'jira') {
    const response = await call(s, 'GET', `/rest/api/3/issue/${encodeURIComponent(source.key)}?fields=summary,description,updated`, undefined, signal);
    if (response.status !== 200) throw new AtlassianError('http', `Jira answered ${response.status} for ${source.key}.`, response.status);
    const fields = (response.json as { fields: { summary?: string; description?: unknown; updated?: string } }).fields;
    // Jira has no version check on writes. Unchanged `updated`: nothing changed. Otherwise the description
    // must still be exactly what was fetched (a comment or a status change elsewhere on the issue is fine).
    const conflict = fields.updated !== source.updated && adfHash(fields.description ?? null) !== source.descriptionHash
      ? `${source.key}'s description changed in Jira since it was fetched (updated ${fields.updated}). Nothing was written. Fetch it again with atlassian_fetch, re-apply the edit, then update.`
      : undefined;
    return { ...(conflict ? { conflict } : {}), title: String(fields.summary ?? source.title) };
  }
  const response = await call(s, 'GET', `/wiki/api/v2/pages/${encodeURIComponent(source.id)}`, undefined, signal);
  if (response.status !== 200) throw new AtlassianError('http', `Confluence answered ${response.status} for page ${source.id}.`, response.status);
  const page = response.json as { title: string; version?: { number?: number; createdAt?: string } };
  const version = Number(page.version?.number ?? 0);
  return { ...(version !== source.version ? { conflict: `The page changed in Confluence since it was fetched (now version ${version}, fetched ${source.version}). Nothing was written. Fetch it again with atlassian_fetch, re-apply the edit, then update.` } : {}), title: page.title, version };
}

function plan(workspace: AttachmentStore, input: UpdateInput): Omit<UpdatePlan, 'remoteTitle'> | { error: string } | { unchanged: string } {
  const base = baseOf(input.file);
  let saved: unknown;
  try { saved = JSON.parse(readWorkspaceText(workspace, `${base}.adf.json`)); } catch { return { error: `No ${base}.adf.json next to the Markdown. Fetch the issue or page first with atlassian_fetch.` }; }
  if (!isSavedDocument(saved)) return { error: `${base}.adf.json is not a document saved by atlassian_fetch.` };
  const options = mediaOptions(saved.media);
  if (adfHash(adfToMarkdown(saved.document, options)) !== saved.markdownHash) return { error: `${base}.adf.json was saved by another version of this app. Fetch it again with atlassian_fetch.` };
  let markdown: string;
  try { markdown = readWorkspaceText(workspace, `${base}.md`); } catch { return { error: `No ${base}.md. Fetch the issue or page again with atlassian_fetch.` }; }
  if (input.edits?.length) markdown = applyEdits(markdown, input.edits);
  const result = spliceMarkdown(saved.document, stripHeader(markdown), options);
  if (!result.ok) return { error: result.message };
  if (result.unchanged) return { unchanged: `${base}.md has no changes compared with what was fetched; nothing to update.` };
  return { base, saved, doc: result.doc, changes: result.changes, markdown };
}

/** Plain-text before/after of the changed blocks (for any interface). */
function changeText(changes: readonly SpliceChange[]): string {
  const lines = (prefix: string, text: string) => text ? text.split('\n').map(line => `${prefix} ${line}`).join('\n') : `${prefix} (nothing)`;
  return changes.map((change, i) => `Change ${i + 1}${change.before.length ? '' : ' (new)'}:\n${lines('-', change.beforeMarkdown)}\n${lines('+', change.afterMarkdown)}`).join('\n\n');
}

const updateTool = withPreparation(tool({
  description: 'Write an edited issue description or page back to Jira or Confluence. file is the .md saved by atlassian_fetch. Pass edits (exact find/replace pairs on that Markdown; each find must occur once), or edit the file first another way and pass no edits. '
    + 'Only the blocks you changed are rewritten; everything else stays exactly as it is in Atlassian. The user sees the change and must approve it. Blocks with @mentions, [status: …], [date: …], [image: …], [macro: …], tasks, panels or coloured text are read-only: an edit that touches them is refused. If the issue or page changed since it was fetched, nothing is written: fetch it again.',
  inputSchema: jsonSchema<UpdateInput>({ type: 'object', properties: {
    file: { type: 'string', minLength: 1, maxLength: 1024, description: 'The .md file saved by atlassian_fetch, e.g. "ABC-123.md".' },
    edits: { type: 'array', maxItems: 50, items: { type: 'object', properties: { find: { type: 'string', minLength: 1, maxLength: 20_000 }, replace: { type: 'string', maxLength: 20_000 } }, required: ['find', 'replace'], additionalProperties: false } },
  }, required: ['file'], additionalProperties: false }),
  execute: async (input, options) => {
    try {
      const s = session(options.context as Context);
      const workspace = workspaceOf(options.context as Context);
      const approved = (options.context as Context)?.[PREPARED_CONTEXT] as UpdatePlan | undefined;
      if (!approved) throw new AtlassianError('unavailable', 'The update was not prepared.');
      // Check again right before writing: someone may have changed it while the user was deciding.
      const remote = await checkRemote(s, approved.saved, options.abortSignal);
      if (remote.conflict) return { text: `Error (conflict): ${remote.conflict}`, isError: true };
      const source = approved.saved.source;
      const response = source.product === 'jira'
        ? await call(s, 'PUT', `/rest/api/3/issue/${encodeURIComponent(source.key)}`, { fields: { description: approved.doc } }, options.abortSignal)
        : await call(s, 'PUT', `/wiki/api/v2/pages/${encodeURIComponent(source.id)}`, { id: source.id, status: source.status === 'draft' ? 'draft' : 'current', title: remote.title, body: { representation: 'atlas_doc_format', value: JSON.stringify(approved.doc) }, version: { number: (remote.version ?? source.version) + 1, message: 'Edited with ai-sdk-letta' } }, options.abortSignal);
      if (response.status === 409) return { text: `Error (conflict): ${source.product === 'jira' ? source.key : 'The page'} changed while you were deciding. Nothing was written. Fetch it again with atlassian_fetch.`, isError: true };
      if (response.status < 200 || response.status >= 300) return { text: `Error (http): ${source.product === 'jira' ? 'Jira' : 'Confluence'} refused the update (${response.status}): ${responseText(response.json ?? response.text, 600)}`, isError: true };
      // Refresh the local files to the new version, so later edits start from it.
      let refreshed = '';
      try { const latest = await fetchRemote(s, source.product === 'jira' ? { product: 'jira', key: source.key } : { product: 'confluence', id: source.id }, options.abortSignal); saveDocument(workspace, latest, approved.base); refreshed = source.product === 'confluence' && latest.source.product === 'confluence' ? ` Now version ${latest.source.version}.` : ''; }
      catch { refreshed = ' (The local copy was not refreshed; fetch it again before the next edit.)'; }
      const count = approved.changes.length;
      return { text: `Updated ${source.product === 'jira' ? `${source.key} (description)` : `page "${remote.title}"`}: ${count} changed ${count === 1 ? 'block' : 'blocks'}; everything else was kept as it was.${refreshed} ${source.url}` };
    } catch (error) { return errorOutput(error); }
  },
  toModelOutput,
}), async (input, options) => {
  try {
    const s = session(options.context);
    const workspace = workspaceOf(options.context);
    const planned = plan(workspace, input as UpdateInput);
    if ('error' in planned) return { output: { text: `Error (refused): ${planned.error}`, isError: true } };
    if ('unchanged' in planned) return { output: { text: planned.unchanged } };
    const remote = await checkRemote(s, planned.saved, options.abortSignal);
    if (remote.conflict) return { output: { text: `Error (conflict): ${remote.conflict}`, isError: true } };
    const source = planned.saved.source;
    const target = source.product === 'jira' ? `${source.key} · ${remote.title}` : remote.title;
    const preview: ApprovalPreview = {
      kind: 'atlassian-edit', title: `Update ${source.product === 'jira' ? `the description of ${source.key}` : `the page "${remote.title}"`}`,
      text: `${source.product === 'jira' ? 'Jira' : 'Confluence'}: ${target}\n${source.url}\n\n${changeText(planned.changes)}`,
      data: { product: source.product, target, url: source.url, site: source.site, account: s.credentials.accountName ?? s.credentials.email, blocks: planned.saved.document.content.length,
        changes: planned.changes.map(change => ({ index: change.from, removed: change.before.length, added: change.after.length, before: change.beforeMarkdown, after: change.afterMarkdown, beforeTypes: change.before.map(n => n.type), afterTypes: change.after.map(n => n.type) })) },
    };
    return { approval: 'required', preview, onBehalfOf: s.actor.id, state: { ...planned, remoteTitle: remote.title } satisfies UpdatePlan } satisfies PreparedCall;
  } catch (error) { return { output: errorOutput(error) }; }
});

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

type ToolOutput = { text: string; isError?: boolean };
function toModelOutput({ output }: { output: unknown }) {
  if (typeof output === 'string') return { type: 'text' as const, value: output };
  const result = output as ToolOutput;
  return result.isError ? { type: 'error-text' as const, value: result.text } : { type: 'text' as const, value: result.text };
}
function errorOutput(error: unknown): ToolOutput {
  if (error instanceof AtlassianError) return { text: `Error (${error.code}): ${error.message}`, isError: true };
  if (error instanceof FileInputError) return { text: `Error (${error.code}): ${error.message}`, isError: true };
  throw error;
}

/**
 * The Atlassian tools (Jira and Confluence Cloud, with each user's own API
 * token). Add them with their default policy:
 * ```ts
 * tools: { ...atlassianTools, ...fileTools }, permissions: { ...ATLASSIAN_TOOL_PERMISSIONS, ...FILE_TOOL_PERMISSIONS }
 * ```
 */
export const atlassianTools: {
  atlassian_request: Tool<RequestInput, ToolOutput>;
  atlassian_fetch: Tool<{ ref: string }, ToolOutput>;
  atlassian_update: Tool<UpdateInput, ToolOutput>;
} = { atlassian_request: requestTool, atlassian_fetch: fetchTool, atlassian_update: updateTool };

/** Does a definition use the Atlassian tools (at least one, not denied)? */
export function atlassianEnabled(definition: { tools: object; permissions: Readonly<Record<string, ToolPermission>> }): boolean {
  const tools = definition.tools as Record<string, unknown>;
  return ATLASSIAN_TOOL_NAMES.some(name => tools[name] === atlassianTools[name] && ['allow', 'ask'].includes(definition.permissions[name] ?? 'deny'));
}

/* ------------------------------------------------------------------ */
/* Media for previews                                                  */
/* ------------------------------------------------------------------ */

/**
 * Download one image of a saved document for a preview, with the viewer's
 * own credentials: only a path recorded by `atlassian_fetch` on the same
 * site, following Atlassian's one redirect to its media service without the
 * token. Returns the bytes and their type (PNG, JPEG, GIF or WebP by content).
 */
export async function downloadAtlassianMedia(credentials: AtlassianCredentials, saved: SavedDocument, mediaId: string, options: { fetch?: typeof fetch; signal?: AbortSignal; store?: CredentialStore; userId?: string } = {}): Promise<{ bytes: Buffer; mediaType: string; name: string }> {
  const media = saved.media[mediaId];
  if (!media?.download) throw new AtlassianError('invalid_input', 'No such image in this document.');
  if (saved.source.site !== credentials.site) throw new AtlassianError('conflict', 'This document is from another site than the one you connected.');
  if (!/^\/rest\/api\/3\/attachment\/content\/\d{1,20}$/.test(media.download) && !/^\/wiki\/download\/(attachments|thumbnails)\/\d{1,20}\/[^?#]+(\?[^#]*)?$/.test(media.download)) throw new AtlassianError('path_not_allowed', 'Not an attachment download.');
  // Only the two attachment download forms checked above, on the user's own site.
  const target = new URL(media.download, credentials.site);
  if (target.origin !== new URL(credentials.site).origin) throw new AtlassianError('path_not_allowed', 'Not an attachment download.');
  const signal = AbortSignal.any([AbortSignal.timeout(ATLASSIAN_LIMITS.requestTimeoutMs), ...(options.signal ? [options.signal] : [])]);
  const fetcher = options.fetch ?? fetch;
  let response = await fetcher(target, { redirect: 'manual', signal, headers: { Authorization: authorization(credentials) } });
  if (response.status === 401) { await response.body?.cancel().catch(() => {}); if (options.store && options.userId) options.store.updateAtlassian(options.userId, { status: 'rejected', rejectedAt: new Date().toISOString() }); throw new AtlassianError('token_rejected', 'Atlassian rejected your API token.', 401); }
  for (let hop = 0; hop < 2 && response.status >= 300 && response.status < 400; hop++) {
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) break;
    const next = new URL(location, target);
    // Same site: keep the token; Atlassian's media service: the redirect URL carries its own short-lived token, so never send ours.
    const sameSite = next.origin === new URL(credentials.site).origin;
    if (next.protocol !== 'https:' || (!sameSite && !/(^|\.)(atlassian\.com|atlassian\.net|atl-paas\.net)$/.test(next.hostname))) throw new AtlassianError('path_not_allowed', 'Unexpected redirect.');
    response = await fetcher(next, { redirect: 'manual', signal, headers: sameSite ? { Authorization: authorization(credentials) } : {} });
  }
  if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw new AtlassianError('http', `Atlassian answered ${response.status}.`, response.status); }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ATLASSIAN_LIMITS.maxMediaBytes) { await reader.cancel().catch(() => {}); throw new AtlassianError('http', 'The image is too large to preview.'); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  const mediaType = sniffImageType(bytes);
  if (!mediaType) throw new AtlassianError('invalid_input', 'Not an image that can be previewed.');
  return { bytes, mediaType, name: media.name };
}

/** Read a saved document (`.adf.json`) from the resources, or `undefined` if it is not one. */
export function readSavedDocument(text: string): SavedDocument | undefined {
  try { const value = JSON.parse(text) as unknown; return isSavedDocument(value) ? value : undefined; } catch { return undefined; }
}
/** Path of the `.adf.json` that belongs to a `.md` (or itself). */
export const savedDocumentPath = (path: string) => `${splitResourcePath(path).join('/').replace(/\.(adf\.json|md)$/i, '')}.adf.json`;
