import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PreviewTokens, appCsp, guiApp, previewCsp, previewToken, startPreviewServer, upstreamHeaders, ThreadRuntime } from '../src/index.js';

/** A fake dev server on a real loopback port; `connect()` opens a TCP stream to it (in place of the tunnel). */
async function devServer() {
  const seen: { url?: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Security-Policy', "default-src *");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Set-Cookie', 'leak=1');
    res.setHeader('Content-Type', 'text/html');
    res.end(`<h1>app ${req.url}</h1>`);
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', data => socket.write(data)); // echo raw frames
    sockets.add(socket);
  });
  const sockets = new Set<import('node:stream').Duplex>();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { seen, connect: () => connect(port, '127.0.0.1'), close: () => { server.close(); server.closeAllConnections(); for (const socket of sockets) socket.destroy(); } };
}
const get = (port: number, host: string, path = '/', headers: Record<string, string> = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers: { host, ...headers } }, res => { let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body })); });
  req.on('error', reject); req.end();
});

test('preview: only Host p-<token>.localhost:<port> of a known conversation; credentials stripped; preview CSP; dev server headers dropped', async () => {
  const dev = await devServer();
  const tokens = new PreviewTokens();
  const token = tokens.tokenOf('thread-1');
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(tokens.tokenOf('thread-1'), token, 'one token per conversation');
  assert.notEqual(tokens.tokenOf('thread-2'), token);
  let running = true;
  const preview = await startPreviewServer({ port: 0, ipv6: false, frameAncestors: () => ['http://127.0.0.1:4999'],
    resolve: t => tokens.threadOf(t) === 'thread-1' ? { connect: () => running ? dev.connect() : undefined, origins: ['https://cdn.jsdelivr.net'] } : undefined });
  const host = `p-${token}.localhost:${preview.port}`;
  try {
    // Wrong hosts: 404, nothing reaches the dev server.
    for (const bad of [`127.0.0.1:${preview.port}`, `localhost:${preview.port}`, `p-${token}.localhost:${preview.port + 1}`, `p-${token}.evil.com:${preview.port}`, `p-${'f'.repeat(32)}.localhost:${preview.port}`, `x.p-${token}.localhost:${preview.port}`, `p-${token.slice(1)}.localhost:${preview.port}`]) {
      const response = await get(preview.port, bad);
      assert.ok(response.status === 404 || response.status === 503, `${bad}: ${response.status}`);
      if (bad.includes('ffff')) assert.equal(response.status, 404);
    }
    assert.equal(dev.seen.length, 0);
    // The right host: proxied, Cookie/Authorization/forwarding stripped, Host and Origin rewritten.
    const ok = await get(preview.port, host, '/about?x=1', { cookie: 'ai_sdk_letta_session=SECRET', authorization: 'Bearer SECRET', 'x-forwarded-for': '1.2.3.4', 'tailscale-user-login': 'alice@example.com', origin: `http://${host}`, referer: `http://${host}/` });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, '<h1>app /about?x=1</h1>');
    const upstream = dev.seen[0]!.headers;
    assert.equal(upstream.cookie, undefined); assert.equal(upstream.authorization, undefined); assert.equal(upstream['x-forwarded-for'], undefined); assert.equal(upstream['tailscale-user-login'], undefined); assert.equal(upstream.referer, undefined);
    assert.equal(upstream.host, '127.0.0.1:5173'); assert.equal(upstream.origin, 'http://127.0.0.1:5173');
    // Response: our CSP, no X-Frame-Options, no cookies set by the dev server.
    const csp = String(ok.headers['content-security-policy']);
    assert.equal(csp, previewCsp(`http://${host}`, ['https://cdn.jsdelivr.net'], ['http://127.0.0.1:4999']));
    assert.match(csp, /default-src 'self' data: blob: https:\/\/cdn\.jsdelivr\.net/);
    assert.match(csp, /script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:/);
    assert.match(csp, new RegExp(`connect-src 'self' ws://p-${token}\\.localhost:${preview.port} https://cdn\\.jsdelivr\\.net`));
    assert.match(csp, /form-action 'self'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors http:\/\/127\.0\.0\.1:4999/);
    assert.equal(ok.headers['x-frame-options'], undefined);
    assert.equal(ok.headers['set-cookie'], undefined);
    assert.equal(ok.headers['referrer-policy'], 'no-referrer');
    // No dev server: a friendly 503 page.
    running = false;
    const down = await get(preview.port, host);
    assert.equal(down.status, 503);
    assert.match(down.body, /No dev server/);
  } finally { preview.close(); dev.close(); }
});

test('preview: WebSocket upgrades (HMR) are relayed with credentials stripped; wrong hosts are refused', async () => {
  const dev = await devServer();
  const tokens = new PreviewTokens();
  const token = tokens.tokenOf('t');
  const preview = await startPreviewServer({ port: 0, ipv6: false, frameAncestors: () => [], resolve: t => tokens.threadOf(t) ? { connect: () => dev.connect(), origins: [] } : undefined });
  const upgrade = (host: string) => new Promise<{ status: number; echoed?: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: preview.port, path: '/?token=hmr', headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', cookie: 'ai_sdk_letta_session=SECRET' } });
    req.on('upgrade', (res, socket) => { socket.write('ping-frame'); socket.once('data', data => { resolve({ status: res.statusCode!, echoed: String(data) }); socket.destroy(); }); });
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode! }); });
    req.on('error', reject); req.end();
  });
  try {
    const ok = await upgrade(`p-${token}.localhost:${preview.port}`);
    assert.equal(ok.status, 101);
    assert.equal(ok.echoed, 'ping-frame');
    const hmr = dev.seen.find(s => s.url === '/?token=hmr')!;
    assert.equal(hmr.headers.cookie, undefined);
    assert.equal(hmr.headers.host, '127.0.0.1:5173');
    const bad = await upgrade(`127.0.0.1:${preview.port}`);
    assert.equal(bad.status, 404);
  } finally { preview.close(); dev.close(); }
});

test('previewToken accepts only the exact form', () => {
  const t = 'a'.repeat(32);
  assert.equal(previewToken(`p-${t}.localhost:4500`, 4500), t);
  assert.equal(previewToken(`P-${t.toUpperCase()}.LOCALHOST:4500`, 4500), t);
  assert.equal(previewToken(`p-${t}.localhost:4501`, 4500), undefined);
  assert.equal(previewToken(`p-${t}.localhost`, 4500), undefined);
  assert.equal(previewToken(`p-${t}g.localhost:4500`, 4500), undefined);
  assert.equal(previewToken(undefined, 4500), undefined);
});

test('upstream headers: hop-by-hop credentials removed, null origin kept', () => {
  const out = upstreamHeaders({ host: 'p-x.localhost:1', cookie: 'a', authorization: 'b', 'proxy-authorization': 'c', forwarded: 'd', origin: 'null', accept: 'text/html' });
  assert.deepEqual(out, { host: '127.0.0.1:5173', origin: 'null', accept: 'text/html' });
});

test('app CSP: only frame-src gains the preview listener; the preview is never served by the app', async () => {
  assert.equal(appCsp(), "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const withPreview = appCsp({ frameSrc: 'http://*.localhost:4555' });
  assert.equal(withPreview, appCsp().replace("frame-src 'self'", "frame-src 'self' http://*.localhost:4555"));
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-preview-gui-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const runtime = new ThreadRuntime({ open: async () => { throw new Error('not opened'); }, close: async () => {} }, join(dir, 'state.json'), 'owner');
  const server = guiApp(runtime, 'owner', 0, assets, { id: 'web', name: 'Web', webDev: true }, undefined, undefined, undefined, { frameSrc: 'http://*.localhost:4555' }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const session = await fetch(`http://127.0.0.1:${port}/api/session`);
    assert.equal(session.headers.get('content-security-policy'), withPreview);
    assert.equal((await session.json() as { agent: { webDev?: boolean } }).agent.webDev, true);
    // A preview Host on the app's port is refused (the app checks Host).
    const asPreview = await get(port, `p-${'a'.repeat(32)}.localhost:${port}`, '/api/session');
    assert.equal(asPreview.status, 403);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('thread preview API: status per conversation, revoke an approved origin, nothing for other agents', async () => {
  const { WebDevRegistry } = await import('ai-sdk-letta');
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-preview-api-'));
  const conversations: string[] = [];
  const runtime = new ThreadRuntime({
    open: async options => { const conversationId = 'conversationId' in options ? options.conversationId : `conv-${conversations.push('x')}`; return { agentId: 'agent-1', conversationId, history: [], agent: { stream: async function* () {}, interactions: { connect: () => () => {} }, transcript: () => [] } as never }; },
    close: async () => {},
  }, join(dir, 'state.json'), 'owner');
  try {
    const { id } = await runtime.create('owner', '6f1c2b1e-1d2a-4b7e-9a51-0c3d2e1f4a5b', 'Web');
    assert.deepEqual(runtime.webDevStatus('owner', id), { enabled: false });
    const registry = new WebDevRegistry({ directory: join(dir, 'webdev') });
    const tokens = new PreviewTokens();
    runtime.webDev = { registry, previewUrl: threadId => `http://p-${tokens.tokenOf(threadId)}.localhost:4555/` };
    const status = runtime.webDevStatus('owner', id) as { enabled: true; previewUrl: string; container: string; origins: string[] };
    assert.equal(status.enabled, true);
    assert.match(status.previewUrl, /^http:\/\/p-[a-f0-9]{32}\.localhost:4555\/$/);
    assert.equal(status.container, 'stopped');
    assert.deepEqual(status.origins, []);
    // An origin approved earlier (saved), revoked from the app.
    const { writeOrigins } = await import('ai-sdk-letta');
    writeOrigins(registry.originsFile('agent-1', runtime.conversationOf('owner', id)!), ['https://cdn.jsdelivr.net']);
    assert.deepEqual((runtime.webDevStatus('owner', id) as { origins: string[] }).origins, ['https://cdn.jsdelivr.net']);
    const after = await runtime.revokeWebOrigin('owner', id, { origin: 'https://cdn.jsdelivr.net' }) as { origins: string[] };
    assert.deepEqual(after.origins, []);
    await assert.rejects(runtime.revokeWebOrigin('owner', id, { origin: 'https://cdn.jsdelivr.net' }), /not_found/);
    await assert.rejects(runtime.revokeWebOrigin('owner', id, {}), /invalid_input/);
    assert.throws(() => runtime.webDevStatus('someone-else', id), /forbidden/);
    await registry.close();
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
