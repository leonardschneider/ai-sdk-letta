import express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { FILE_LIMITS, IMAGE_LIMITS, IMAGE_MEDIA_TYPES, TEXT_EXTENSIONS } from 'ai-sdk-letta';
import type { RunAuthor, RuntimeEvent, ThreadRuntime } from './runtime.js';
import { RuntimeFault, ThreadRuntime as Runtime } from './runtime.js';
import { runtimeVersions } from './versions.js';
import { authorOf, servedOrigin, tailscaleIdentity, type TailscaleIdentity, type TeamDirectory, type TeamUser } from './team.js';
import { atlassianMediaRoute, integrationError, integrationRoutes } from './integrations.js';
import { LOCAL_USER_ID, type CredentialStore } from 'ai-sdk-letta';
import { automationAdminRoutes, type AutomationEndpoint, type AutomationService } from './automation.js';
import { DecisionConflict, type DecisionBoard, type PublicDecision } from './decisions.js';

/** The automation API of a server, for the app's Automations dialog. */
export type AppAutomation = { service: AutomationService; endpoint: AutomationEndpoint };

/**
 * Server-to-server API: bearer token (256-bit hex) plus an owner header, on
 * 127.0.0.1 only. Browser origins and cross-site requests are never accepted.
 */
export function tokenApiApp(runtime: ThreadRuntime, token: string, owner: string, port: number, shutdown?: () => Promise<void>) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('A private 256-bit token is required');
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const supplied = req.headers.authorization?.replace(/^Bearer /, '');
    if (req.headers.host !== `127.0.0.1:${port || req.socket.localPort}` || req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site' || !supplied || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return res.status(401).json({ error: 'unauthorized' });
    if (req.headers['x-runtime-owner'] !== owner) return res.status(403).json({ error: 'forbidden' });
    next();
  });
  return runtimeRoutes(app, runtime, owner, shutdown);
}

/** JSON body limit for every route except `POST /v1/runs`. */
export const BODY_LIMIT_BYTES = 24 * 1024;
/**
 * JSON body limit for `POST /v1/runs` only: base64 of the largest allowed
 * image payload plus room for text and JSON. Still bounded; image limits are
 * enforced again on the decoded bytes.
 */
export const RUN_BODY_LIMIT_BYTES = Math.ceil(IMAGE_LIMITS.maxTotalBytes / 3) * 4 + 64 * 1024;
/**
 * Body limit for `POST /v1/uploads` only: one file's raw bytes
 * (`application/octet-stream`, not base64), at most `FILE_LIMITS.maxFileBytes`.
 */
export const UPLOAD_BODY_LIMIT_BYTES = FILE_LIMITS.maxFileBytes;

/**
 * `Content-Disposition` for a download: always `attachment`, with an ASCII
 * fallback name and the exact UTF-8 name (RFC 6266 / 5987). Quotes, control
 * characters and path separators never reach the header.
 */
export function contentDisposition(name: string): string {
  const fallback = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\/;%]/g, '_').trim() || 'download';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
/** Content type for a download: text is always served as plain text, never as HTML or script. */
const downloadType = (file: { kind: string; mediaType: string }) => file.kind === 'pdf' ? 'application/pdf' : file.kind === 'image' ? file.mediaType : file.kind === 'other' ? 'application/octet-stream' : file.mediaType === 'text/csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8';

/** Largest file shown by a preview (downloads are not limited by this). */
export const PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024;
/**
 * Content-Security-Policy of previews: nothing may load, run, or reach the
 * network. With `sandbox` (no `allow-scripts`, no `allow-same-origin`) the
 * document is also an opaque origin: no scripts, forms, popups or cookies.
 */
export const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";
/**
 * PDFs are drawn by the browser's own viewer, which does not run in a
 * sandboxed document; their policy keeps everything else closed. Only bytes
 * that are a PDF by content get it.
 */
export const PDF_PREVIEW_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; object-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
/** Media type of a preview, by content and name: HTML only inside the sandbox policy; anything else as text, image or PDF. */
export function previewType(file: { name: string; kind: string; mediaType: string }): string | undefined {
  if (file.kind === 'pdf') return 'application/pdf';
  if (file.kind === 'image') return file.mediaType;
  if (file.kind !== 'text') return undefined;
  return /\.html?$/i.test(file.name) ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
}

/**
 * Per-request access of a shared (team) server: who is asking (recorded as the
 * author of the threads and turns they start), and whether they may act on a
 * run someone started (answer its approvals and questions, stop it).
 */
export interface RouteAccess {
  author(req: express.Request): RunAuthor;
  mayAct(req: express.Request, run: { author?: RunAuthor }): boolean;
}

/**
 * Per-person integration accounts (Atlassian): where they are stored and who
 * the caller is. See {@link integrationRoutes}.
 */
export interface RouteIntegrations { store: CredentialStore; userOf(req: express.Request): string; options?: { fetch?: typeof fetch } }

/** Shared routes; the caller must install its transport-specific authentication first. */
export function runtimeRoutes(app: express.Express, runtime: ThreadRuntime, owner: string, shutdown?: () => Promise<void>, access?: RouteAccess, integrations?: RouteIntegrations) {
  const author = (req: express.Request) => access?.author(req);
  /**
   * Only the person who started a run, or an admin, may answer or stop it. An
   * approval that uses someone's own account (their Atlassian token) can only
   * be answered by that person, admin or not.
   */
  const mayAct = (req: express.Request, runId: string, answering = false) => {
    if (!access) return;
    if (!access.mayAct(req, runtime.runInfo(owner, runId))) throw new RuntimeFault('not_your_turn', 403);
    const onBehalfOf = answering ? runtime.pendingInteraction(owner, runId)?.onBehalfOf : undefined;
    if (onBehalfOf && access.author(req).id !== onBehalfOf) throw new RuntimeFault('not_your_account', 403);
  };
  const small = express.json({ limit: BODY_LIMIT_BYTES });
  const runs = express.json({ limit: RUN_BODY_LIMIT_BYTES });
  // Raw bytes, only on the upload route, only as application/octet-stream, bounded by the per-file limit.
  const upload = express.raw({ limit: UPLOAD_BODY_LIMIT_BYTES, type: 'application/octet-stream' });
  app.use((req, res, next) => (req.method === 'POST' && req.path === '/v1/runs' ? runs : req.method === 'POST' && (req.path === '/v1/uploads' || req.path === '/v1/resources/upload') ? upload : small)(req, res, next));
  app.get('/v1/capabilities', (_req, res) => res.json({ version: 1, stateful: true, tools: 'observed-only', interactions: ['approval', 'question'], history: true, replay: true, concurrency: runtime.parallel ? Runtime.MAX_PARALLEL_TURNS : 1, queue: runtime.queueing, edits: false, rewind: true,
    ...(runtime.replyMode !== undefined ? { replyModes: { agent: runtime.replyMode, batching: true } } : {}),
    images: { mediaTypes: [...IMAGE_MEDIA_TYPES], maxImageBytes: IMAGE_LIMITS.maxImageBytes, maxImages: IMAGE_LIMITS.maxImages, maxTotalBytes: IMAGE_LIMITS.maxTotalBytes },
    files: runtime.uploads ? { types: ['text', 'pdf', 'image'], textExtensions: [...TEXT_EXTENSIONS], maxFileBytes: FILE_LIMITS.maxFileBytes, maxFilesPerMessage: FILE_LIMITS.maxFilesPerMessage, maxConversationFiles: FILE_LIMITS.maxConversationFiles, maxConversationBytes: FILE_LIMITS.maxConversationBytes } : null }));
  /**
   * Stage one file for the next run: raw bytes as `application/octet-stream`,
   * the name URL-encoded in `X-File-Name`. Validated by content (type, size,
   * PDF text) before anything is kept. Returns `{ id, name, kind, ... }`.
   */
  app.post('/v1/uploads', async (req, res) => {
    if (!req.is('application/octet-stream') || !Buffer.isBuffer(req.body)) throw new RuntimeFault('invalid_input', 415);
    let name: string;
    try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')); } catch { throw new RuntimeFault('file_name_invalid', 400); }
    const control = new AbortController();
    res.on('close', () => { if (!res.writableEnded) control.abort(); });
    res.status(201).json(await runtime.upload(owner, name, req.body, control.signal));
  });
  app.get('/v1/threads/:id/files', (req, res) => res.json(runtime.files(owner, req.params.id)));
  /** Download one attached file. Always as an attachment, never rendered by the app's origin. */
  app.get('/v1/threads/:id/files/:name', (req, res) => {
    const { file, bytes } = runtime.file(owner, req.params.id, req.params.name);
    res.set({ 'Content-Type': downloadType(file), 'Content-Disposition': contentDisposition(file.name), 'Content-Length': String(bytes.byteLength),
      'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' });
    res.end(bytes);
  });
  /* ---------------- resources ---------------- */
  /** The tree: `{ children, truncated, version, threads, changes }`. */
  app.get('/v1/resources', async (_req, res) => res.json(await runtime.resourceTree(owner)));
  /** The newest commits. */
  app.get('/v1/resources/history', async (req, res) => res.json(await runtime.resourceHistory(owner, Math.min(200, Math.max(1, Number(req.query.limit) || 50)))));
  /** Upload raw bytes into `?folder=` (path from the root), the name URL-encoded in `X-File-Name`. One commit. */
  app.post('/v1/resources/upload', async (req, res) => {
    if (!req.is('application/octet-stream') || !Buffer.isBuffer(req.body)) throw new RuntimeFault('invalid_input', 415);
    let name: string;
    try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')); } catch { throw new RuntimeFault('file_name_invalid', 400); }
    res.status(201).json(await runtime.resourceUpload(owner, String(req.query.folder ?? ''), name, req.body));
  });
  app.post('/v1/resources/folders', async (req, res) => res.status(201).json(await runtime.resourceFolder(owner, req.body)));
  app.post('/v1/resources/move', async (req, res) => res.json(await runtime.resourceMove(owner, req.body)));
  app.post('/v1/resources/delete', async (req, res) => res.json(await runtime.resourceDelete(owner, req.body)));
  app.post('/v1/resources/restore', async (req, res) => res.json(await runtime.resourceRestore(owner, req.body)));
  /** Images of a saved Jira issue or Confluence page (`.adf.json`), fetched with the viewer's own Atlassian account. */
  if (integrations) app.get('/v1/resources/atlassian-media', atlassianMediaRoute(runtime, owner, integrations.store, integrations.userOf, integrations.options));
  /** Download one file (`?path=`), always as an attachment. */
  app.get('/v1/resources/file', async (req, res) => {
    const file = await runtime.resourceFile(owner, req.query.path, FILE_LIMITS.maxFileBytes);
    res.set({ 'Content-Type': downloadType(file), 'Content-Disposition': contentDisposition(file.name), 'Content-Length': String(file.bytes.byteLength),
      'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' });
    res.end(file.bytes);
  });
  /**
   * Show one file (`?path=`) in a frame of the app: inline, under a policy
   * that allows no script, no network and no same-origin access
   * ({@link PREVIEW_CSP}; PDFs {@link PDF_PREVIEW_CSP}). Text other than HTML
   * is served as plain text; types without a preview are refused (415).
   */
  app.get('/v1/resources/preview', async (req, res) => {
    const file = await runtime.resourceFile(owner, req.query.path, PREVIEW_LIMIT_BYTES);
    const type = previewType(file);
    if (!type) throw new RuntimeFault('preview_unavailable', 415);
    res.set({ 'Content-Type': type, 'Content-Disposition': contentDisposition(file.name).replace(/^attachment/, 'inline'), 'Content-Length': String(file.bytes.byteLength),
      'Content-Security-Policy': file.kind === 'pdf' ? PDF_PREVIEW_CSP : PREVIEW_CSP, 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(file.bytes);
  });
  app.get('/v1/threads', (_req, res) => res.json(runtime.list(owner)));
  app.post('/v1/threads', async (req, res) => res.status(201).json(await runtime.create(owner, req.body?.id, req.body?.title, author(req))));
  /** Shared runtimes: you are typing in this conversation (`{ typing: true }`, a heartbeat) or stopped (`{ typing: false }`). Nothing else is accepted, never text. */
  app.post('/v1/threads/:id/typing', (req, res) => res.json(runtime.typing(owner, req.params.id, author(req), req.body)));
  // Body: any of { title, archived, latex: 'inherit' | 'on' | 'off', replyMode: 'inherit' | 'always' | 'when-addressed' | 'agent-decides' (shared runtimes) }. A rename also renames the conversation's folder; answer once that is done, so a refresh shows it.
  app.patch('/v1/threads/:id', async (req, res) => {
    // Trust mode loosens the protected-file rule: on a team server, only admins change it.
    // Members may only make it stricter (Strict); turning trust on, or back to the agent's setting, is for admins.
    if (access && req.body && typeof req.body === 'object' && 'trustJiminy' in req.body && (req.body as { trustJiminy?: unknown }).trustJiminy !== 'off' && !access.mayAct(req, {})) throw new RuntimeFault('admin_required', 403);
    const summary = runtime.updateMetadata(owner, req.params.id, req.body); await runtime.folderRenamed(); res.json(summary);
  });
  app.get('/v1/threads/:id/history', async (req, res) => res.json(await runtime.history(owner, req.params.id)));
  /* ---------------- web app development: the preview ---------------- */
  /** The conversation's dev server, approved origins and preview URL (`{ enabled: false }` without web development). */
  app.get('/v1/threads/:id/preview', (req, res) => res.json(runtime.webDevStatus(owner, req.params.id)));
  /** Revoke an origin approved in the conversation: `{ origin }`. Only ever makes it stricter. */
  app.post('/v1/threads/:id/preview/revoke', async (req, res) => res.json(await runtime.revokeWebOrigin(owner, req.params.id, req.body)));
  app.get('/v1/threads/:id/view', async (req, res) => res.json(await runtime.view(owner, req.params.id)));
  app.post('/v1/runs', async (req, res) => res.status(202).json(await runtime.start(owner, req.body, author(req))));
  /* ---------------- rewind ---------------- */
  /** Which of your messages you can edit in this conversation (`{ runIds, refusal? }`; `refusal: 'rewind_not_solo'` when others wrote in it). */
  app.get('/v1/threads/:id/rewind', (req, res) => res.json({ ...runtime.editable(owner, req.params.id, author(req)), rewinds: runtime.rewinds(owner, req.params.id) }));
  /** What editing the message of `{ runId }` would do (nothing changes): turns removed, files and memory reverted, conflicts, effects that stay, what is withdrawn. */
  app.post('/v1/threads/:id/rewind/preview', async (req, res) => {
    const runId = (req.body as { runId?: unknown } | undefined)?.runId;
    if (typeof runId !== 'string') throw new RuntimeFault('invalid_input', 400);
    res.json(await runtime.rewindPreview(owner, req.params.id, runId, author(req)));
  });
  /** Edit and rewind: `{ rewindId, runId, text, newRunId }` (UUIDs; the same body again returns the same result). The edited text is sent as run `newRunId`. */
  app.post('/v1/threads/:id/rewind', async (req, res) => res.json(await runtime.rewind(owner, req.params.id, req.body, author(req))));
  app.post('/v1/runs/:id/answer', (req, res) => { mayAct(req, req.params.id, true); runtime.answer(owner, req.params.id, req.body); res.json({ accepted: true }); });
  app.post('/v1/runs/:id/cancel', (req, res) => { mayAct(req, req.params.id); runtime.cancel(owner, req.params.id); res.json({ accepted: true }); });
  /* ---------------- memory: provenance and reviews ---------------- */
  /** Memory reviews (newest first) and the reviewer's model setting. */
  app.get('/v1/memory/reviews', async (req, res) => res.json(await runtime.memoryReviews(owner, Math.min(200, Math.max(1, Number(req.query.limit) || 50)))));
  /** Who changed each section of a memory file (`?path=human.md`), and how it was reviewed. */
  app.get('/v1/memory/provenance', async (req, res) => res.json(await runtime.memoryProvenance(owner, req.query.path)));
  /** Changes the memory guard reverted or held since `?since=` (an ISO time), for a toast. */
  app.get('/v1/memory/reverts', (req, res) => res.json({ reverts: runtime.memoryReverts(owner, typeof req.query.since === 'string' ? req.query.since : undefined), version: runtime.memoryVersion }));
  /** Dream now (operators): `{ instruction? }` starts a reflection of the thread's conversation; its merge is reviewed like any dream (team servers: admins only). */
  app.post('/v1/threads/:id/dream', async (req, res) => { if (access && !access.mayAct(req, {})) throw new RuntimeFault('admin_required', 403); res.json(await runtime.dreamNow(owner, req.params.id, req.body)); });
  /** Change the reviewer's model: `{ model: 'auto' | '<provider>/<model>' }` (team servers: admins only). */
  app.put('/v1/memory/reviewer', (req, res) => { if (access && !access.mayAct(req, {})) throw new RuntimeFault('admin_required', 403); res.json(runtime.setReviewerModel(owner, req.body)); });
  /* ---------------- decisions ---------------- */
  const board = () => { if (!runtime.decisions) throw new RuntimeFault('not_found', 404); return runtime.decisions; };
  /** Decisions: `?thread=<id>` that conversation's (newest 50, any status), otherwise the pending ones. */
  app.get('/v1/decisions', (req, res) => {
    if (!runtime.decisions) return res.json({ decisions: [] });
    const thread = typeof req.query.thread === 'string' ? req.query.thread : undefined;
    if (thread) runtime.threadSummary(owner, thread) ?? (() => { throw new RuntimeFault('not_found', 404); })();
    res.json({ decisions: thread ? board().forThread(thread) : board().pending() });
  });
  app.get('/v1/decisions/:id', (req, res) => res.json(board().get(req.params.id)));
  /**
   * Decide: `{ choice, comment? }` or `{ stop: true, comment? }`. Any member of
   * the agent may decide (web research reviews: only the person whose turn
   * searched, or an admin), once: the first decider wins, later attempts get 409
   * `already_decided` with the decision as decided (who, what, when).
   */
  app.post('/v1/decisions/:id/decide', (req, res) => {
    const who = access ? access.author(req) : { id: LOCAL_USER_ID, name: 'You' };
    // Web research and memory reviews keep their rule: the person whose turn it was, or an admin (protected memory: admins only; 403 otherwise).
    const admin = access ? access.mayAct(req, {}) : true;
    if (access && !board().mayDecide(req.params.id, who, admin)) throw new RuntimeFault('not_your_review', 403);
    // A claim is confirmed only by the person it names (single-user app: claims never name anyone but you).
    try { res.json(board().decide(req.params.id, who, req.body, { admin: access ? admin : false })); }
    catch (error) { if (error instanceof DecisionConflict) return res.status(409).json({ error: error.code, decision: error.decision }); throw error; }
  });
  /**
   * Long poll: answers `{ version }` as soon as threads or runs change after
   * `?since=` (or after about 25 seconds), so other people's turns show up.
   */
  app.get('/v1/changes', async (req, res) => {
    const since = Number(req.query.since ?? -1);
    if (!Number.isSafeInteger(since)) throw new RuntimeFault('invalid_cursor', 400);
    const control = new AbortController();
    res.on('close', () => control.abort());
    const version = await runtime.waitForChange(since, 25_000, control.signal);
    if (!res.writableEnded && !res.destroyed) res.json({ version });
  });
  app.get('/v1/runs/:id/events', (req, res) => {
    const snapshot = runtime.events(owner, req.params.id, Number(req.query.after ?? 0));
    res.set({ 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    const write = (event: RuntimeEvent) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); if (event.type === 'completed' || event.type === 'failed') res.end(); };
    for (const event of snapshot.events) write(event);
    // A queued turn streams too: from 'started' when it is sent, or 'failed' if it never is.
    if (snapshot.status !== 'running' && snapshot.status !== 'queued') { res.end(); return; }
    const unsubscribe = runtime.subscribe(req.params.id, write);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n'); }, 15_000);
    res.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });
  if (shutdown) app.post('/v1/shutdown', async (_req, res) => { await shutdown(); res.json({ stopped: true }); });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return res.end();
    if (integrationError(error, res)) return;
    // Body parser rejections: fixed codes, never parser messages.
    if ((error as { type?: unknown } | undefined)?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if ((error as { type?: unknown } | undefined)?.type === 'request.aborted') return res.end();
    res.status(error instanceof RuntimeFault ? error.status : error instanceof SyntaxError ? 400 : 503).json({ error: error instanceof RuntimeFault ? error.code : 'runtime_unavailable' });
  });
  return app;
}

/** What the browser may know about the agent. */
export interface GuiAgentInfo {
  id: string;
  name: string;
  /** Tools whose calls always ask for approval (used for display only). */
  approvalTools?: readonly string[];
  /** Whether the agent accepts file attachments (it has the file tools). */
  files?: boolean;
  /** The agent has resources (a Resources panel) without accepting attachments (for example, only the Atlassian tools). */
  resources?: boolean;
  /** The definition's `ui` settings: whether replies render LaTeX unless a conversation overrides it. @default { latex: true } */
  ui?: { latex: boolean };
  /** Team servers: the agent's reply mode setting (see `AgentDefinition.replyMode`). */
  replyMode?: string;
  /** Integrations the agent uses, whose accounts each person connects (`['atlassian']`). */
  integrations?: readonly string[];
  /** The server serves the automation API: admins manage its tokens (Automations). */
  automations?: boolean;
  /** The agent can request decisions (it has `request_decision`): members see and decide them. */
  decisions?: boolean;
  /** The agent's memory is reviewed (Jiminy): the app shows the Memory view and memory review decisions. */
  memory?: boolean;
  /** The agent trusts Jiminy by default (`memory.trustJiminy`); each conversation can override it. */
  trustJiminy?: boolean;
  /** The agent develops web apps (`webDevTools`): the app shows the Preview pane. */
  webDev?: boolean;
}

/* ------------------------------------------------------------------ */
/* Decisions: the notification feed                                    */
/* ------------------------------------------------------------------ */

/** One agent's decisions, for {@link DecisionFeed}. */
export type FeedAgent = { agent: { id: string; name: string }; board: DecisionBoard; runtime: ThreadRuntime; owner: string };
/** A pending decision in the notification feed: with its agent and conversation title. */
export type FeedDecision = PublicDecision & { agent: { id: string; name: string }; thread: { id: string; title: string } };

/**
 * Pending decisions across several agents, with one change counter, for the
 * notification bell (`GET /api/decisions?since=`).
 */
export class DecisionFeed {
  private changes = 0;
  private waiting = new Set<() => void>();
  constructor(readonly agents: readonly FeedAgent[]) {
    // Any change of a runtime (a decision, a conversation renamed or archived) may change what the bell lists:
    // the version moves only when the list does.
    for (const entry of agents) entry.runtime.observe(() => this.check());
    this.key = this.signature();
  }
  private key: string;
  private signature() { return JSON.stringify(this.agents.map(entry => this.pending(id => id === entry.agent.id).map(d => [d.id, d.status, d.thread.title]))); }
  private check() { const key = this.signature(); if (key !== this.key) { this.key = key; this.changed(); } }
  private changed() { this.changes++; const waiting = [...this.waiting]; this.waiting.clear(); for (const wake of waiting) wake(); }
  get version() { return this.changes; }
  waitForChange(since: number, timeoutMs: number, signal?: AbortSignal): Promise<number> {
    if (since !== this.changes || signal?.aborted) return Promise.resolve(this.changes);
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiting.delete(done); signal?.removeEventListener('abort', done); resolve(this.changes); };
      const timer = setTimeout(done, timeoutMs);
      this.waiting.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  /**
   * Pending decisions of the agents `visible` allows, oldest first. Decisions
   * of archived conversations never show; web research reviews show only to
   * the people `mayReview` allows (the searcher and admins).
   */
  pending(visible: (agentId: string) => boolean, mayReview: (agentId: string, decision: PublicDecision) => boolean = () => true): FeedDecision[] {
    return this.agents.filter(entry => visible(entry.agent.id)).flatMap(entry => entry.board.pending().filter(decision => !decision.kind || mayReview(entry.agent.id, decision)).flatMap(decision => {
      const thread = entry.runtime.threadSummary(entry.owner, decision.threadId);
      return thread && !thread.archived ? [{ ...decision, agent: { ...entry.agent }, thread: { id: thread.id, title: thread.title } }] : [];
    })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
/** `GET .../decisions?since=<version>`: `{ version, decisions }`, at once or when they change (about 25 seconds at most). */
export function decisionFeedRoute(feed: DecisionFeed, visible: (req: express.Request) => (agentId: string) => boolean, mayReview?: (req: express.Request) => (agentId: string, decision: PublicDecision) => boolean): express.RequestHandler {
  return async (req, res) => {
    const since = req.query.since === undefined ? -1 : Number(req.query.since);
    if (!Number.isSafeInteger(since)) throw new RuntimeFault('invalid_cursor', 400);
    const control = new AbortController();
    res.on('close', () => control.abort());
    const version = since === feed.version ? await feed.waitForChange(since, 25_000, control.signal) : feed.version;
    if (!res.writableEnded && !res.destroyed) res.json({ version, decisions: feed.pending(visible(req), mayReview?.(req)) });
  };
}

/** The app's Content-Security-Policy; `frameSrc` adds the preview listener (`http://*.localhost:<port>`) to `frame-src`. */
export function appCsp(options: { frameSrc?: string } = {}): string {
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'${options.frameSrc ? ` ${options.frameSrc}` : ''}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}

/**
 * Loopback-only, same-origin browser transport. No bearer token enters the
 * browser: a random HttpOnly SameSite=Strict session cookie authenticates
 * reads, and every mutation also needs the exact Origin and an in-memory CSRF
 * token. Requests with a foreign Host, Origin or cross-site fetch metadata are
 * rejected. Static assets are served with a strict CSP.
 *
 * `GET /api/session` also returns `versions`: the installed `ai-sdk-letta`,
 * `@ai-sdk-letta/server` and Letta SDK versions, read once here from their
 * `package.json` ({@link runtimeVersions}).
 */
export function guiApp(runtime: ThreadRuntime, owner: string, port: number, assets: string, agent: GuiAgentInfo, credentials?: CredentialStore, integrationOptions?: { fetch?: typeof fetch }, automation?: AppAutomation,
  /** Web app previews: their listener's origin pattern, for `frame-src` (see `startPreviewServer`). */
  preview?: { frameSrc: string }) {
  const app = express();
  const versions = runtimeVersions();
  const session = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = `127.0.0.1:${port || req.socket.localPort}`;
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      // Previews load in frames of this origin (their own responses set a stricter policy); nothing else may frame the app.
      // Fonts (KaTeX's, for maths) are files of the app itself: 'self' only, never data: or a CDN.
      // Web app previews come from their own listener and origin (never this one): only frame-src names it.
      'Content-Security-Policy': appCsp(preview ? { frameSrc: preview.frameSrc } : {}) });
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) return res.status(403).json({ error: 'invalid_origin' });
    next();
  });
  app.get('/api/session', (_req, res) => {
    res.cookie('ai_sdk_letta_session', session, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.json({ csrf, agent: { id: agent.id, name: agent.name, approvalTools: [...(agent.approvalTools ?? [])], files: !!agent.files, ...(agent.resources ? { resources: true } : {}), ui: { latex: agent.ui?.latex ?? true }, ...(agent.integrations?.length ? { integrations: [...agent.integrations] } : {}), ...(automation ? { automations: true } : {}), ...(runtime.decisions ? { decisions: true } : {}), ...(agent.memory ? { memory: true } : {}), ...(agent.trustJiminy ? { trustJiminy: true } : {}), ...(agent.webDev && preview ? { webDev: true } : {}) }, versions });
  });
  // The single-user app has one person: the local user.
  const local = () => LOCAL_USER_ID;
  const feed = runtime.decisions ? new DecisionFeed([{ agent: { id: agent.id, name: agent.name }, board: runtime.decisions, runtime, owner }]) : undefined;
  const integrations = credentials ? { store: credentials, userOf: local, ...(integrationOptions ? { options: integrationOptions } : {}) } : undefined;
  app.use('/api', (req, res, next) => {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('ai_sdk_letta_session='))?.slice('ai_sdk_letta_session='.length);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(session))) return res.status(401).json({ error: 'session_required' });
    if (!['GET', 'HEAD'].includes(req.method) && (req.headers.origin !== `http://127.0.0.1:${port || req.socket.localPort}` || req.headers['x-csrf-token'] !== csrf)) return res.status(403).json({ error: 'csrf_required' });
    next();
  }, ...(integrations ? [integrationsApp(integrations)] : []),
  // The local user owns the single-user app: they manage its automation tokens.
  ...(automation ? [express.Router().use('/automations', automationAdminRoutes(automation.service, () => agent.id, { actor: () => ({ id: LOCAL_USER_ID, name: 'You' }), isAdmin: () => true }, automation.endpoint))] : []),
  // Pending decisions (the notification bell): `?since=<version>` waits until they change.
  ...(feed ? [express.Router().get('/decisions', decisionFeedRoute(feed, () => () => true))] : []),
  runtimeRoutes(express(), runtime, owner, undefined, undefined, integrations));
  app.use(express.static(assets, { index: 'index.html', dotfiles: 'deny' }));
  return app;
}

/* ------------------------------------------------------------------ */
/* Team (multi-user) browser app                                       */
/* ------------------------------------------------------------------ */

/** One agent of a team server: what the browser may know about it, and its runtime. */
export interface TeamAgent { info: GuiAgentInfo; runtime: ThreadRuntime }

/** Options of {@link teamApp}. */
export interface TeamAppOptions {
  /** The loopback port the app listens on (`tailscale serve` proxies to it). */
  port: number;
  /** Built web app. */
  assets: string;
  /** Hosted agents, by definition ID (also the path segment: `/api/agents/<id>/v1/...`). */
  agents: ReadonlyMap<string, TeamAgent>;
  directory: TeamDirectory;
  /** Per-person integration accounts (Atlassian), when an agent uses them: `/api/integrations/...`. */
  credentials?: CredentialStore;
  /** Tests: the `fetch` used to reach Atlassian. */
  integrationOptions?: { fetch?: typeof fetch };
  /** The automation API: each agent's admins manage its tokens at `/api/agents/<id>/automations`. */
  automation?: AppAutomation;
  /**
   * Origins the app is served under by `tailscale serve`, for example
   * `https://machine.tailnet.ts.net` (or `http://machine.tailnet.ts.net:8443`
   * when serving plain HTTP inside the tailnet). Requests for any other host
   * are refused, and mutations must come from the same origin. The loopback
   * address (`http://127.0.0.1:<port>`) is always accepted too.
   */
  origins: readonly string[];
}

const SESSION_COOKIE = 'ai_sdk_letta_team';
/** The CSRF token of a person: derived from the server secret, so it survives page reloads but never server restarts. */
const csrfFor = (secret: Buffer, userId: string) => createHmac('sha256', secret).update(`csrf:${userId}`).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The browser app for a team, behind `tailscale serve`.
 *
 * Identity: every request is identified by the Tailscale identity headers that
 * `tailscale serve` adds (believed only on loopback connections; see
 * {@link tailscaleIdentity}). There is no password and no cookie session;
 * requests without an identity get 401. A mutation also needs an exact
 * same-origin `Origin` and the person's CSRF token from `GET /api/session`.
 *
 * Authorization: a person sees only the agents they are a member of
 * (`/api/agents/<id>/...` answers 404 otherwise, the same as an unknown agent).
 * Inside an agent everything is shared. Approvals and questions can be
 * answered (and turns stopped) only by the person who sent the turn or an
 * admin. Admins manage members at `/api/agents/<id>/members`.
 */
export function teamApp(options: TeamAppOptions) {
  const { port, assets, agents, directory } = options;
  const app = express();
  const versions = runtimeVersions();
  const secret = randomBytes(32);
  // Served origins by Host header, e.g. 'machine.ts.net' → 'https://machine.ts.net'.
  const served = new Map(options.origins.map(origin => { const parsed = servedOrigin(origin); return [parsed.host, parsed.origin] as const; }));
  app.disable('x-powered-by');
  type Who = { identity: TailscaleIdentity; user?: TeamUser };
  const who = (req: express.Request): Who | undefined => (req as unknown as { who?: Who }).who;
  app.use((req, res, next) => {
    const local = `127.0.0.1:${port || req.socket.localPort}`;
    const host = String(req.headers.host ?? '').toLowerCase();
    const servedOriginOf = served.get(host);
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      // Avatars come from the identity provider (https only); nothing else leaves the app.
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    const origin = req.headers.origin;
    const allowedOrigin = servedOriginOf ?? `http://${local}`;
    if ((host !== local && !servedOriginOf) || (origin && origin !== allowedOrigin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) return res.status(403).json({ error: 'invalid_origin' });
    const identity = tailscaleIdentity(req.headers, req.socket.remoteAddress);
    if (identity) (req as unknown as { who?: Who }).who = { identity, user: directory.signIn(identity) };
    if (req.path.startsWith('/api/')) {
      if (!identity) return res.status(401).json({ error: 'identity_required' });
      const user = who(req)!.user;
      if (!['GET', 'HEAD'].includes(req.method) && (origin !== allowedOrigin || !user || !equal(String(req.headers['x-csrf-token'] ?? ''), csrfFor(secret, user.id)))) return res.status(403).json({ error: 'csrf_required' });
    }
    next();
  });
  const ids = [...agents.keys()];
  const agentSummary = (id: string, role: string) => { const { info, runtime } = agents.get(id)!; return { id, name: info.name, role, approvalTools: [...(info.approvalTools ?? [])], files: !!info.files, ...(info.resources ? { resources: true } : {}), ui: { latex: info.ui?.latex ?? true }, ...(info.replyMode ? { replyMode: info.replyMode } : {}), ...(info.integrations?.length ? { integrations: [...info.integrations] } : {}), ...(info.automations ? { automations: true } : {}), ...(runtime.decisions ? { decisions: true } : {}), ...(info.memory ? { memory: true } : {}), ...(info.trustJiminy ? { trustJiminy: true } : {}) }; };
  // Pending decisions of every agent you belong to (the notification bell).
  const feed = new DecisionFeed([...agents].flatMap(([id, { info, runtime }]) => runtime.decisions ? [{ agent: { id, name: info.name }, board: runtime.decisions, runtime, owner: 'team' }] : []));
  /** Who you are and which agents you belong to. A person with no agent gets `agents: []` (the app shows "no access"). */
  app.get('/api/session', (req, res) => {
    const { identity, user } = who(req)!;
    const mine = user ? directory.agentsOf(user.id, ids) : [];
    res.json({ mode: 'team', ...(user ? { csrf: csrfFor(secret, user.id) } : {}),
      user: user ? { id: user.id, login: user.login, name: user.name, ...(user.avatar ? { avatar: user.avatar } : {}) } : { login: identity.login, name: identity.name, ...(identity.avatar ? { avatar: identity.avatar } : {}) },
      agents: mine.map(({ agentId, role }) => agentSummary(agentId, role)), versions });
  });
  // Everything below needs membership of the agent in the path.
  const member = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = who(req)?.user;
    const role = user && agents.has(String(req.params.agent)) ? directory.role(String(req.params.agent), user.id) : undefined;
    // Unknown agent and not a member look the same: nobody learns which agents exist.
    if (!role) return res.status(404).json({ error: 'not_found' });
    (req as unknown as { role?: string }).role = role;
    next();
  };
  const actor = (req: express.Request) => who(req)!.user!;
  const isAdmin = (req: express.Request) => (req as unknown as { role?: string }).role === 'admin';
  const json = express.json({ limit: BODY_LIMIT_BYTES });
  // Each person's own integration accounts: only signed-in people with a user record (members of some agent).
  const integrations = options.credentials ? { store: options.credentials, userOf: (req: express.Request) => actor(req).id, ...(options.integrationOptions ? { options: options.integrationOptions } : {}) } : undefined;
  if (integrations) app.use('/api', (req, res, next) => { if (req.path.startsWith('/integrations/') && !who(req)?.user) return res.status(404).json({ error: 'not_found' }); next(); }, integrationsApp(integrations));
  if (options.automation) {
    const automation = options.automation;
    const AGENT = Symbol('automation agent');
    const routes = automationAdminRoutes(automation.service, r => (r as unknown as Record<symbol, string>)[AGENT]!, {
      actor: r => { const user = actor(r); return { id: user.id, name: user.name, login: user.login }; }, isAdmin: r => isAdmin(r),
    }, automation.endpoint);
    app.use('/api/agents/:agent/automations', member, (req, res, next) => { (req as unknown as Record<symbol, string>)[AGENT] = String(req.params.agent); routes(req, res, next); });
  }
  app.get('/api/decisions', decisionFeedRoute(feed, req => { const user = who(req)?.user; return agentId => !!user && !!directory.role(agentId, user.id); },
    req => { const user = who(req)?.user; return (agentId, decision) => !!user && (directory.role(agentId, user.id) === 'admin' || (!decision.memory?.adminOnly && decision.reviewer?.id === user.id)); }));
  app.get('/api/agents/:agent/members', member, (req, res) => res.json({ members: directory.members(String(req.params.agent), actor(req).id), you: { role: (req as unknown as { role: string }).role } }));
  // Membership changes can change the reply mode in effect ("auto" depends on how many people share the agent): tell open pages.
  const membersChanged = (agentId: string) => agents.get(agentId)?.runtime.membersChanged();
  app.post('/api/agents/:agent/members', member, json, (req, res) => { const added = directory.addMember(String(req.params.agent), actor(req), req.body); membersChanged(String(req.params.agent)); res.status(201).json(added); });
  app.patch('/api/agents/:agent/members/:user', member, json, (req, res) => res.json(directory.setRole(String(req.params.agent), actor(req), String(req.params.user), req.body)));
  app.delete('/api/agents/:agent/members/:user', member, (req, res) => { directory.removeMember(String(req.params.agent), actor(req), String(req.params.user)); membersChanged(String(req.params.agent)); res.json({ removed: true }); });
  const routers = new Map([...agents].map(([id, agent]) => [id, runtimeRoutes(express(), agent.runtime, 'team', undefined, {
    // The author carries their role in this agent: memory provenance records it, and only an admin's turn may change protected memory.
    author: req => { const role = (req as unknown as { role?: string }).role; return { ...authorOf(actor(req)), ...(role === 'admin' || role === 'member' ? { role } : {}) }; },
    mayAct: (req, run) => isAdmin(req) || run.author?.id === actor(req).id,
  }, integrations)]));
  app.use('/api/agents/:agent', member, (req, res, next) => routers.get(String(req.params.agent))!(req, res, next));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(express.static(assets, { index: 'index.html', dotfiles: 'deny' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return res.end();
    if (integrationError(error, res)) return;
    if ((error as { type?: unknown } | undefined)?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    res.status(error instanceof RuntimeFault ? error.status : error instanceof SyntaxError ? 400 : 503).json({ error: error instanceof RuntimeFault ? error.code : 'runtime_unavailable' });
  });
  return app;
}

/** `/integrations/...` (see {@link integrationRoutes}) with its own error handler. */
function integrationsApp(integrations: RouteIntegrations): express.Express {
  const app = express();
  app.use('/integrations', integrationRoutes(integrations.store, integrations.userOf, integrations.options));
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return res.end();
    if (integrationError(error, res)) return;
    if ((error as { type?: unknown } | undefined)?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (error instanceof RuntimeFault || error instanceof SyntaxError) return res.status(error instanceof RuntimeFault ? error.status : 400).json({ error: error instanceof RuntimeFault ? error.code : 'invalid_input' });
    next(error);
  });
  return app;
}
