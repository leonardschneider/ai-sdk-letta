import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { guiApp, ThreadRuntime } from '../src/index.js';

test('GUI loopback session, CSRF, origin, Host and static asset boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-gui-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  const runtime = new ThreadRuntime({ open: async () => { throw new Error('not opened'); }, close: async () => {} }, join(dir, 'state.json'), 'owner');
  const server = guiApp(runtime, 'owner', 0, assets, { id: 'sandbox', name: 'Sandbox', approvalTools: ['approval_demo'] }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/v1/threads`)).status, 401);
    for (const headers of [{ origin: 'https://evil.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }] as Record<string, string>[]) {
      assert.equal((await fetch(`${base}/api/session`, { headers })).status, 403, JSON.stringify(headers));
    }
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/session`, { headers: { host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHost, 403);
    const session = await fetch(`${base}/api/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
    const cookie = session.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const data = await session.json() as { csrf: string; agent: { id: string; name: string; approvalTools: string[] } };
    assert.deepEqual(data.agent, { id: 'sandbox', name: 'Sandbox', approvalTools: ['approval_demo'], files: false, ui: { latex: true } }); assert.equal(data.csrf.length, 64);
    assert.deepEqual(Object.keys(data).sort(), ['agent', 'csrf', 'versions']);
    const headers = { cookie: cookie.split(';')[0], origin: base, 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/api/v1/threads`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/threads`, { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/threads`, { method: 'POST', headers: { ...headers, 'x-csrf-token': data.csrf }, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/api/v1/threads`, { method: 'POST', headers: { ...headers, origin: 'http://localhost:4400', 'x-csrf-token': data.csrf }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/threads`, { headers: { cookie: 'ai_sdk_letta_session=' + '0'.repeat(64) } })).status, 401);
    const page = await fetch(base); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    // Fonts only from the app itself (KaTeX's are bundled), never data: URLs or another origin.
    assert.match(page.headers.get('content-security-policy')!, /(^|; )font-src 'self'(;|$)/);
    assert.equal((await fetch(`${base}/../.env`)).status, 404);
    assert.equal((await fetch(`${base}/src/index.ts`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

