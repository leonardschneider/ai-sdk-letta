import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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

/** Shared routes; the caller must install its transport-specific authentication first. */
export function runtimeRoutes(app: express.Express, runtime: ThreadRuntime, owner: string, shutdown?: () => Promise<void>) {
  app.use(express.json({ limit: '24kb' }));
  app.get('/v1/capabilities', (_req, res) => res.json({ version: 1, stateful: true, tools: 'observed-only', interactions: ['approval', 'question'], history: true, replay: true, concurrency: 1, edits: false }));
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
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) return res.status(403).json({ error: 'invalid_origin' });
    next();
  });
  app.get('/api/session', (_req, res) => {
    res.cookie('ai_sdk_letta_session', session, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.json({ csrf, agent: { id: agent.id, name: agent.name, approvalTools: [...(agent.approvalTools ?? [])] } });
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
