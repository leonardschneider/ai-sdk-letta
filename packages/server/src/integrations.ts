import express from 'express';
import { AtlassianError, CredentialStore, connectAtlassian, downloadAtlassianMedia, publicStatus, readSavedDocument, savedDocumentPath, testAtlassian } from 'ai-sdk-letta';
import { RuntimeFault, type ThreadRuntime } from './runtime.js';

/**
 * Routes for a person's own integration accounts (today: Atlassian), mounted
 * under the session's authentication (`/api/integrations/...`).
 *
 * - `GET  /atlassian`         → the caller's status: site, email, account, last check; never the token.
 * - `PUT  /atlassian`         `{ site, email, token }` → checks them with Atlassian, then saves them (0600).
 * - `POST /atlassian/test`    → checks the saved token again.
 * - `DELETE /atlassian`       → forgets them.
 *
 * `userOf(req)` names the caller (the local user in the single-user app, the
 * signed-in person on a team server); nobody can read or change another
 * person's connection.
 */
export function integrationRoutes(store: CredentialStore, userOf: (req: express.Request) => string, options: { fetch?: typeof fetch } = {}): express.Router {
  const router = express.Router();
  const json = express.json({ limit: 24 * 1024 });
  // One check per person at a time (each makes a request to Atlassian).
  const busy = new Set<string>();
  const once = async <T>(user: string, task: () => Promise<T>) => {
    if (busy.has(user)) throw new RuntimeFault('integration_busy', 429);
    busy.add(user);
    try { return await task(); } finally { busy.delete(user); }
  };
  router.get('/atlassian', (req, res) => { res.json(publicStatus(store.atlassian(userOf(req)))); });
  router.put('/atlassian', json, async (req, res) => {
    const user = userOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['site', 'email', 'token'].includes(key))) throw new RuntimeFault('invalid_input', 400);
    res.json(await once(user, () => connectAtlassian(store, user, body, options)));
  });
  router.post('/atlassian/test', async (req, res) => { const user = userOf(req); res.json(await once(user, () => testAtlassian(store, user, options))); });
  router.delete('/atlassian', (req, res) => { store.deleteAtlassian(userOf(req)); res.json({ connected: false }); });
  return router;
}

/** Fixed HTTP answers for integration errors (messages are written for the user and never hold secrets). */
export function integrationError(error: unknown, res: express.Response): boolean {
  if (!(error instanceof AtlassianError)) return false;
  const status = error.code === 'token_rejected' ? 401 : error.code === 'invalid_site' || error.code === 'invalid_input' ? 400 : error.code === 'path_not_allowed' ? 403 : 502;
  // 401 from Atlassian is the user's token, not their session with this app: report it as 400 so the app does not treat it as signed out.
  res.status(status === 401 ? 400 : status).json({ error: error.code, message: error.message });
  return true;
}

/**
 * `GET /v1/resources/atlassian-media?path=<file>&id=<media ID>`: one image of
 * a saved Jira issue or Confluence page (`.adf.json`), downloaded with the
 * viewer's own Atlassian account and served from this origin, so the browser
 * never contacts Atlassian. Only media the document lists, only images.
 */
export function atlassianMediaRoute(runtime: ThreadRuntime, owner: string, store: CredentialStore, userOf: (req: express.Request) => string, options: { fetch?: typeof fetch } = {}): express.RequestHandler {
  return async (req, res) => {
    const path = req.query.path;
    const id = req.query.id;
    if (typeof path !== 'string' || typeof id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new RuntimeFault('invalid_input', 400);
    const user = userOf(req);
    const credentials = store.atlassian(user);
    if (!credentials || credentials.status !== 'ok') throw new RuntimeFault('atlassian_not_connected', 404);
    const file = await runtime.resourceFile(owner, savedDocumentPath(path), 5 * 1024 * 1024);
    const saved = readSavedDocument(Buffer.from(file.bytes).toString('utf8'));
    if (!saved) throw new RuntimeFault('preview_unavailable', 415);
    const control = new AbortController();
    res.on('close', () => { if (!res.writableEnded) control.abort(); });
    let image: Awaited<ReturnType<typeof downloadAtlassianMedia>>;
    try { image = await downloadAtlassianMedia(credentials, saved, id, { ...options, signal: control.signal, store, userId: user }); }
    catch (error) { if (error instanceof AtlassianError) throw new RuntimeFault(`atlassian_${error.code}`, error.code === 'token_rejected' ? 403 : 404); throw error; }
    res.set({ 'Content-Type': image.mediaType, 'Content-Length': String(image.bytes.byteLength), 'Cache-Control': 'private, max-age=300', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' });
    res.end(image.bytes);
  };
}
