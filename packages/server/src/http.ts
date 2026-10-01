import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { FILE_LIMITS, IMAGE_LIMITS, IMAGE_MEDIA_TYPES, TEXT_EXTENSIONS } from 'ai-sdk-letta';
import type { RuntimeEvent, ThreadRuntime } from './runtime.js';
import { RuntimeFault } from './runtime.js';

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

/** Shared routes; the caller must install its transport-specific authentication first. */
export function runtimeRoutes(app: express.Express, runtime: ThreadRuntime, owner: string, shutdown?: () => Promise<void>) {
  const small = express.json({ limit: BODY_LIMIT_BYTES });
  const runs = express.json({ limit: RUN_BODY_LIMIT_BYTES });
  // Raw bytes, only on the upload route, only as application/octet-stream, bounded by the per-file limit.
  const upload = express.raw({ limit: UPLOAD_BODY_LIMIT_BYTES, type: 'application/octet-stream' });
  app.use((req, res, next) => (req.method === 'POST' && req.path === '/v1/runs' ? runs : req.method === 'POST' && (req.path === '/v1/uploads' || req.path === '/v1/resources/upload') ? upload : small)(req, res, next));
  app.get('/v1/capabilities', (_req, res) => res.json({ version: 1, stateful: true, tools: 'observed-only', interactions: ['approval', 'question'], history: true, replay: true, concurrency: 1, edits: false,
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
  app.post('/v1/threads', async (req, res) => res.status(201).json(await runtime.create(owner, req.body?.id, req.body?.title)));
  app.patch('/v1/threads/:id', (req, res) => res.json(runtime.updateMetadata(owner, req.params.id, req.body)));
  app.get('/v1/threads/:id/history', async (req, res) => res.json(await runtime.history(owner, req.params.id)));
  app.get('/v1/threads/:id/view', async (req, res) => res.json(await runtime.view(owner, req.params.id)));
  app.post('/v1/runs', async (req, res) => res.status(202).json(await runtime.start(owner, req.body)));
  app.post('/v1/runs/:id/answer', (req, res) => { runtime.answer(owner, req.params.id, req.body); res.json({ accepted: true }); });
  app.post('/v1/runs/:id/cancel', (req, res) => { runtime.cancel(owner, req.params.id); res.json({ accepted: true }); });
  app.get('/v1/runs/:id/events', (req, res) => {
    const snapshot = runtime.events(owner, req.params.id, Number(req.query.after ?? 0));
    res.set({ 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    const write = (event: RuntimeEvent) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); if (event.type === 'completed' || event.type === 'failed') res.end(); };
    for (const event of snapshot.events) write(event);
    if (snapshot.status !== 'running') { res.end(); return; }
    const unsubscribe = runtime.subscribe(req.params.id, write);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n'); }, 15_000);
    res.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });
  if (shutdown) app.post('/v1/shutdown', async (_req, res) => { await shutdown(); res.json({ stopped: true }); });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return res.end();
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
}

/**
 * Loopback-only, same-origin browser transport. No bearer token enters the
 * browser: a random HttpOnly SameSite=Strict session cookie authenticates
 * reads, and every mutation also needs the exact Origin and an in-memory CSRF
 * token. Requests with a foreign Host, Origin or cross-site fetch metadata are
 * rejected. Static assets are served with a strict CSP.
 */
export function guiApp(runtime: ThreadRuntime, owner: string, port: number, assets: string, agent: GuiAgentInfo) {
  const app = express();
  const session = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = `127.0.0.1:${port || req.socket.localPort}`;
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      // Previews load in frames of this origin (their own responses set a stricter policy); nothing else may frame the app.
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) return res.status(403).json({ error: 'invalid_origin' });
    next();
  });
  app.get('/api/session', (_req, res) => {
    res.cookie('ai_sdk_letta_session', session, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.json({ csrf, agent: { id: agent.id, name: agent.name, approvalTools: [...(agent.approvalTools ?? [])], files: !!agent.files } });
  });
  app.use('/api', (req, res, next) => {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('ai_sdk_letta_session='))?.slice('ai_sdk_letta_session='.length);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(session))) return res.status(401).json({ error: 'session_required' });
    if (!['GET', 'HEAD'].includes(req.method) && (req.headers.origin !== `http://127.0.0.1:${port || req.socket.localPort}` || req.headers['x-csrf-token'] !== csrf)) return res.status(403).json({ error: 'csrf_required' });
    next();
  }, runtimeRoutes(express(), runtime, owner));
  app.use(express.static(assets, { index: 'index.html', dotfiles: 'deny' }));
  return app;
}
