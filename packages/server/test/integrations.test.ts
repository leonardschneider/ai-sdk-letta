import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import { CredentialStore, LettaAgent, ToolInteractions, LOCAL_USER_ID, type TurnActor } from 'ai-sdk-letta';
import { ThreadRuntime, TeamDirectory, guiApp, teamApp, type RuntimeHost, type TeamAgent } from '../src/index.js';
import { tools } from './fixtures.js';

const SITE = 'https://acme.atlassian.net';
const TOKEN = 'ATATT3x-very-secret-token';
/** Fake Atlassian: accepts one email/token pair; records whether a request carried credentials. */
function fakeAtlassian() {
  const seen: { url: string; auth?: string }[] = [];
  let token = TOKEN;
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const auth = new Headers(init.headers).get('authorization') ?? undefined;
    seen.push({ url: url.href, ...(auth ? { auth } : {}) });
    if (url.origin !== SITE) return new Response('{}', { status: 404 });
    const valid = auth === `Basic ${Buffer.from(`me@example.com:${token}`).toString('base64')}`;
    if (!valid) return new Response('{"message":"Unauthorized"}', { status: 401 });
    if (url.pathname === '/rest/api/3/myself') return Response.json({ accountId: 'acc', displayName: 'Me Example' });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetch: fetcher, seen, rotate: () => { token = 'rotated'; } };
}

async function listen(app: ReturnType<typeof guiApp>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('single-user GUI: connect, status, test, disconnect; the token is stored 0600 and never returned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-int-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const runtime = new ThreadRuntime({ open: async () => { throw new Error('not opened'); }, close: async () => {} }, join(dir, 'state.json'), 'owner');
  const store = new CredentialStore(join(dir, 'credentials'));
  const atlassian = fakeAtlassian();
  const { base, close } = await listen(guiApp(runtime, 'owner', 0, assets, { id: 'a', name: 'A', integrations: ['atlassian'] }, store, { fetch: atlassian.fetch }));
  try {
    const session = await fetch(`${base}/api/session`);
    const { csrf, agent } = await session.json() as { csrf: string; agent: { integrations?: string[] } };
    assert.deepEqual(agent.integrations, ['atlassian']);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie, origin: base, 'x-csrf-token': csrf, 'content-type': 'application/json' };
    // Session and CSRF are required.
    assert.equal((await fetch(`${base}/api/integrations/atlassian`)).status, 401);
    assert.equal((await fetch(`${base}/api/integrations/atlassian`, { method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.deepEqual(await (await fetch(`${base}/api/integrations/atlassian`, { headers })).json(), { connected: false });
    // A wrong token is refused with a readable message and nothing is stored.
    const wrong = await fetch(`${base}/api/integrations/atlassian`, { method: 'PUT', headers, body: JSON.stringify({ site: 'acme.atlassian.net', email: 'me@example.com', token: 'nope' }) });
    assert.equal(wrong.status, 400);
    assert.deepEqual(await wrong.json(), { error: 'token_rejected', message: 'Atlassian rejected the saved API token (it expired or was revoked).' });
    assert.equal(store.atlassian(LOCAL_USER_ID), undefined);
    const badSite = await fetch(`${base}/api/integrations/atlassian`, { method: 'PUT', headers, body: JSON.stringify({ site: 'https://evil.example.com', email: 'me@example.com', token: TOKEN }) });
    assert.equal(badSite.status, 400);
    assert.equal(((await badSite.json()) as { error: string }).error, 'invalid_site');
    assert.equal(atlassian.seen.some(r => !r.url.startsWith(SITE)), false, 'never sends a token to another host');
    const extra = await fetch(`${base}/api/integrations/atlassian`, { method: 'PUT', headers, body: JSON.stringify({ site: SITE, email: 'me@example.com', token: TOKEN, admin: true }) });
    assert.equal(extra.status, 400);
    // Connect.
    const connected = await fetch(`${base}/api/integrations/atlassian`, { method: 'PUT', headers, body: JSON.stringify({ site: 'acme.atlassian.net', email: 'me@example.com', token: TOKEN }) });
    assert.equal(connected.status, 200);
    const text = await connected.text();
    assert.equal(text.includes(TOKEN), false);
    const status = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(status).sort(), ['accountName', 'checkedAt', 'connected', 'email', 'savedAt', 'site', 'status']);
    assert.equal(status.site, SITE);
    // Every read of the status: never the token.
    const read = await (await fetch(`${base}/api/integrations/atlassian`, { headers })).text();
    assert.equal(read.includes(TOKEN), false);
    assert.equal(read.includes(Buffer.from(`me@example.com:${TOKEN}`).toString('base64')), false);
    const folder = join(dir, 'credentials', 'atlassian');
    const [file] = readdirSync(folder);
    assert.equal(statSync(join(folder, file!)).mode & 0o777, 0o600);
    assert.equal(statSync(folder).mode & 0o777, 0o700);
    assert.ok(readFileSync(join(folder, file!), 'utf8').includes(TOKEN), 'stored on the server');
    // Test connection; then the token is revoked at Atlassian.
    assert.equal(((await (await fetch(`${base}/api/integrations/atlassian/test`, { method: 'POST', headers })).json()) as { status: string }).status, 'ok');
    atlassian.rotate();
    const rejected = await (await fetch(`${base}/api/integrations/atlassian/test`, { method: 'POST', headers })).json() as { status: string; rejectedAt?: string };
    assert.equal(rejected.status, 'rejected');
    assert.ok(rejected.rejectedAt);
    // Disconnect.
    assert.deepEqual(await (await fetch(`${base}/api/integrations/atlassian`, { method: 'DELETE', headers })).json(), { connected: false });
    assert.equal(readdirSync(folder).length, 0);
  } finally { await close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('GUI without Atlassian tools has no integration routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-int-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const runtime = new ThreadRuntime({ open: async () => { throw new Error('not opened'); }, close: async () => {} }, join(dir, 'state.json'), 'owner');
  const { base, close } = await listen(guiApp(runtime, 'owner', 0, assets, { id: 'a', name: 'A' }));
  try {
    const session = await fetch(`${base}/api/session`);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await fetch(`${base}/api/integrations/atlassian`, { headers: { cookie } })).status, 404);
  } finally { await close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

/** A team runtime whose fake agent records the actor of each turn and can ask an approval on behalf of its author. */
function teamFixture() {
  const actors: (TurnActor | undefined)[] = [];
  const host: RuntimeHost = {
    parallel: true, async close() {},
    async open(target) {
      const conversationId = 'conversationId' in target ? target.conversationId : `local-conv-${randomUUID()}`;
      const interactions = new ToolInteractions();
      let input = '';
      let actor: TurnActor | undefined;
      const agent = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'agent-local-team', interactions, open: (signal, turn) => {
        actor = turn.actor; actors.push(turn.actor);
        return {
          async send(message: SendMessage) { input = typeof message === 'string' ? message : ''; },
          async abort() {}, close() {},
          async *stream() {
            if (input.includes('approve')) {
              yield { type: 'tool_call', toolCallId: 'tool-1', toolName: 'text_stats', toolInput: { text: 'x' }, uuid: '1' } as SDKMessage;
              const response = await interactions.request({ toolCallId: 'tool-1', tool: 'text_stats', kind: 'approval', title: 'Allow?', ...(actor ? { onBehalfOf: actor.id } : {}) }, signal);
              yield { type: 'tool_result', toolCallId: 'tool-1', content: JSON.stringify({ approved: response.approved }), uuid: '2' } as SDKMessage;
            }
            yield { type: 'assistant', content: 'Done', uuid: '3' } as SDKMessage;
            yield { type: 'result', success: true, uuid: '4', durationMs: 1, conversationId } as SDKMessage;
          },
        };
      } });
      return { agent, agentId: 'agent-local-team', conversationId, history: [], reload: async () => [], close: async () => { agent.close(); } };
    },
  };
  return { host, actors };
}

test('team: each person has their own connection; turns act for their author; only that person may approve an action on their account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-int-team-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const directory = new TeamDirectory(join(dir, 'team', 'team.json'), ['owner@example.com']);
  directory.bootstrap(['alpha']);
  const fixture = teamFixture();
  const runtime = new ThreadRuntime(fixture.host, join(dir, 'state.json'), 'team', { queue: true, parallel: true });
  const store = new CredentialStore(join(dir, 'credentials'));
  const atlassian = fakeAtlassian();
  const agents = new Map<string, TeamAgent>([['alpha', { info: { id: 'alpha', name: 'Alpha', integrations: ['atlassian'] }, runtime }]]);
  const server = teamApp({ port: 0, assets, agents, directory, origins: ['https://machine.example.ts.net'], credentials: store, integrationOptions: { fetch: atlassian.fetch } }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const people = { owner: { 'tailscale-user-login': 'owner@example.com', 'tailscale-user-name': 'Olivia Owner' }, mia: { 'tailscale-user-login': 'mia@example.com', 'tailscale-user-name': 'Mia' }, otto: { 'tailscale-user-login': 'otto@example.com', 'tailscale-user-name': 'Otto' } };
  const raw = (method: string, path: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${address.port}${path}`, { method, headers }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, text })); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  const call = async (who: keyof typeof people, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { host: 'machine.example.ts.net', ...people[who] };
    if (method !== 'GET') { headers.origin = 'https://machine.example.ts.net'; headers['x-csrf-token'] = (JSON.parse((await raw('GET', '/api/session', headers)).text) as { csrf: string }).csrf; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    return raw(method, path, headers, body === undefined ? undefined : JSON.stringify(body));
  };
  try {
    await call('owner', 'POST', '/api/agents/alpha/members', { login: 'mia@example.com' });
    await call('mia', 'GET', '/api/session'); // first visit creates Mia's record
    // People without a user record (no agent) have no integrations.
    assert.equal((await call('otto', 'GET', '/api/integrations/atlassian')).status, 404);
    // Mia connects; the owner (an admin) sees only their own (not connected) status.
    const connected = await call('mia', 'PUT', '/api/integrations/atlassian', { site: SITE, email: 'me@example.com', token: TOKEN });
    assert.equal(connected.status, 200, connected.text);
    assert.equal(connected.text.includes(TOKEN), false);
    assert.equal(JSON.parse((await call('owner', 'GET', '/api/integrations/atlassian')).text).connected, false);
    assert.equal(JSON.parse((await call('mia', 'GET', '/api/integrations/atlassian')).text).connected, true);
    const mia = directory.userByLogin('mia@example.com')!;
    assert.equal(store.atlassian(mia.id)!.token, TOKEN);
    assert.equal(store.atlassian(directory.userByLogin('owner@example.com')!.id), undefined);
    // Mia's turn acts as Mia; its approval (on her account) can be answered only by Mia, not even by an admin.
    const thread = JSON.parse((await call('mia', 'POST', '/api/agents/alpha/v1/threads', { id: randomUUID(), title: 'T' })).text) as { id: string };
    const runId = randomUUID();
    assert.equal((await call('mia', 'POST', '/api/agents/alpha/v1/runs', { id: runId, threadId: thread.id, text: 'please approve', parentRunId: null })).status, 202);
    let pending: { id: string } | undefined;
    for (let i = 0; i < 200 && !pending; i++) { pending = runtime.pendingInteraction('team', runId) as { id: string } | undefined; if (!pending) await new Promise(r => setTimeout(r, 10)); }
    assert.ok(pending);
    assert.deepEqual(fixture.actors.at(-1), { id: mia.id, name: 'Mia', login: 'mia@example.com' });
    const byAdmin = await call('owner', 'POST', `/api/agents/alpha/v1/runs/${runId}/answer`, { id: pending!.id, approved: true });
    assert.equal(byAdmin.status, 403);
    assert.equal(JSON.parse(byAdmin.text).error, 'not_your_account');
    const byMia = await call('mia', 'POST', `/api/agents/alpha/v1/runs/${runId}/answer`, { id: pending!.id, approved: true });
    assert.equal(byMia.status, 200, byMia.text);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.close(); rmSync(dir, { recursive: true, force: true });
  }
});
