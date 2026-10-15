import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { guiApp, ThreadRuntime, checkRemote } from '../src/index.js';

const SERVED = 'phone-mac.tail1.ts.net';
/** A request as `tailscale serve` forwards it: loopback, the served Host, and the caller's identity headers. */
function call(base: string, path: string, headers: Record<string, string>, method = 'GET', body?: string) {
  return new Promise<{ status: number; cookie?: string; json?: unknown }>((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: { host: SERVED, ...headers } }, res => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => { let json: unknown; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0], json }); });
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

test('remote access: only the owner\'s Tailscale login through a served origin gets in; never Funnel or others', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-remote-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const runtime = new ThreadRuntime({ open: async () => { throw new Error('not opened'); }, close: async () => {} }, join(dir, 'state.json'), 'owner');
  const remote = checkRemote({ owners: ['Me@Example.com'], origins: [`https://${SERVED}`] });
  const server = guiApp(runtime, 'owner', 0, assets, { id: 'a', name: 'A' }, undefined, undefined, undefined, undefined, undefined, undefined, remote).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const me = { 'tailscale-user-login': 'me@example.com', 'tailscale-user-name': 'Me' };
  try {
    // Not the owner, no identity, or a Funnel request: refused.
    assert.equal((await call(base, '/api/session', { 'tailscale-user-login': 'someone@else.com' })).status, 403);
    assert.equal((await call(base, '/api/session', {})).status, 403);
    assert.equal((await call(base, '/api/session', { ...me, 'tailscale-funnel-request': '?1' })).status, 403);
    assert.equal((await call(base, '/', { 'tailscale-user-login': 'someone@else.com' })).status, 403, 'not even the page');
    // The owner: a session (Secure cookie), reads, and writes with the served origin and CSRF.
    const session = await call(base, '/api/session', me);
    assert.equal(session.status, 200);
    assert.match(session.cookie!, /Secure/); assert.match(session.cookie!, /HttpOnly/); assert.match(session.cookie!, /SameSite=Strict/);
    const { csrf } = session.json as { csrf: string };
    const cookie = session.cookie!.split(';')[0]!;
    assert.equal((await call(base, '/api/v1/threads', { ...me, cookie })).status, 200);
    const write = (origin: string) => call(base, '/api/v1/threads', { ...me, cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, 'POST', '{}');
    assert.equal((await write(`https://${SERVED}`)).status, 400, 'reaches the route (invalid body)');
    assert.equal((await write('http://127.0.0.1:4400')).status, 403, 'the loopback origin is not the remote one');
    assert.equal((await write('https://evil.test')).status, 403);
    assert.equal((await call(base, '/api/session', { ...me, 'sec-fetch-site': 'cross-site' })).status, 403);
    // Local access is unchanged.
    assert.equal((await fetch(`${base}/api/session`)).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('without remote access, a served host is refused even with an identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-remote-off-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const runtime = new ThreadRuntime({ open: async () => { throw new Error('not opened'); }, close: async () => {} }, join(dir, 'state.json'), 'owner');
  const server = guiApp(runtime, 'owner', 0, assets, { id: 'a', name: 'A' }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { assert.equal((await call(`http://127.0.0.1:${address.port}`, '/api/session', { 'tailscale-user-login': 'me@example.com' })).status, 403); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('remote settings are validated: an owner login and an https served origin', () => {
  assert.deepEqual(checkRemote({ owners: [' Me@Example.com '], origins: ['https://Mac.tail1.ts.net/'] }), { owners: ['me@example.com'], origins: ['https://mac.tail1.ts.net'] });
  assert.throws(() => checkRemote({ owners: [], origins: ['https://m.ts.net'] }), /Tailscale login/);
  assert.throws(() => checkRemote({ owners: ['me@x.com'], origins: [] }), /served address/);
  assert.throws(() => checkRemote({ owners: ['me@x.com'], origins: ['http://m.ts.net'] }), /must be https/);
  assert.throws(() => checkRemote({ owners: ['not-a-login'], origins: ['https://m.ts.net'] }), /Invalid owner/);
});
