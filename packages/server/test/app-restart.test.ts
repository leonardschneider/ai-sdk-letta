import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { LettaAgent, McpApps, ToolInteractions, resolveMcpApps } from 'ai-sdk-letta';
import { AppGate, ThreadRuntime, guiApp, type RuntimeHost } from '../src/index.js';
import { tools } from './fixtures.js';

const SERVER = join(import.meta.dirname, '..', '..', 'ai-sdk-letta', 'test', 'fixtures', 'mcp-app-server.mjs');
const line = { line: { command: process.execPath, args: [SERVER] }, stop: async () => {} };

/** A runtime with an installed app (`test`) and a dev app (`dev_clock`) of the thread's conversation, called once each. */
async function fixture(options: { viewOnly?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-app-restart-'));
  let refuse = false;
  const host: RuntimeHost = { async close() {}, async open(o) {
    if (refuse) throw Object.assign(new Error('view_only'), { code: 'view_only' });
    const conversationId = 'conversationId' in o ? o.conversationId : `conv-${randomUUID()}`;
    const agent = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'agent-1', interactions: new ToolInteractions(), open: () => ({ async send() {}, async abort() {}, close() {}, async *stream() { yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId } as SDKMessage; } }) });
    return { agent, agentId: 'agent-1', conversationId, history: [] };
  } };
  const runtime = new ThreadRuntime(host, join(directory, 'state.json'), 'owner');
  const apps = new McpApps(resolveMcpApps([{ id: 'test', command: ['node'], tools: { show: 'allow' } }]), { directory: join(directory, 'apps'), launcher: async () => line });
  await apps.ready();
  const gate = new AppGate({ apps, runtime, owner: 'owner', appOrigin: () => 'http://127.0.0.1:4999', sandboxPort: () => 5999, person: () => ({ id: 'local', name: 'You' }) });
  gate.restartWaitMs = 5000;
  if (!options.viewOnly) runtime.apps = gate;
  const thread = randomUUID();
  await runtime.create('owner', thread, 'Apps');
  const conversationId = runtime.conversationOf('owner', thread)!;
  const state = { launches: 0, fail: false };
  await apps.startDev({ name: 'clock', conversationId, folder: '/workspace/clock', command: 'node server.mjs', transport: 'stdio', launch: async () => { state.launches++; if (state.fail) throw new Error('boom: Cannot find module server.mjs'); return line; } });
  await apps.callAsAgent('dev_clock__show', { label: 'dev' }, { conversationId, toolCallId: 'call-dev' });
  await apps.callAsAgent('test__show', { label: 'installed' }, { conversationId, toolCallId: 'call-installed' });
  // View only: opening a session is refused from now on (as AdoptionRegistry's viewer does).
  refuse = !!options.viewOnly;
  return { runtime, apps, gate, thread, conversationId, state, directory, cleanup: async () => { await runtime.close(); await apps.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('instance: a dev app stopped after its idle timeout restarts by itself (starting, then the view); a failed one does not (Restart, Logs)', async () => {
  const f = await fixture();
  try {
    f.apps.devContainerStopped(f.conversationId, 'idle');
    // Waits up to restartWaitMs for the restart: the view comes back at once.
    const answer = await f.gate.instance('owner', f.thread, { toolCallId: 'call-dev' }) as { instance?: string };
    assert.ok(answer.instance, 'the view after an automatic restart');
    assert.equal(f.state.launches, 2);
    // A restart that takes longer than the wait: `starting` (the page asks again).
    f.apps.devContainerStopped(f.conversationId, 'idle');
    f.gate.restartWaitMs = 0;
    const starting = await f.gate.instance('owner', f.thread, { toolCallId: 'call-dev' }) as { status: string; appStatus: string };
    assert.equal(starting.status, 'starting');
    f.gate.restartWaitMs = 5000;
    assert.ok((await f.gate.instance('owner', f.thread, { toolCallId: 'call-dev' }) as { instance?: string }).instance);
    // A failed start: no automatic restart, the reason and Restart.
    f.state.fail = true;
    await f.apps.reloadDev('dev_clock');
    const launches = f.state.launches;
    const failed = await f.gate.instance('owner', f.thread, { toolCallId: 'call-dev' }) as { status: string; appStatus: string; error: string; restartable: boolean; app: { dev?: boolean } };
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.appStatus, 'failed');
    assert.match(failed.error, /boom/);
    assert.equal(failed.restartable, true);
    assert.equal(failed.app.dev, true);
    assert.equal(f.state.launches, launches, 'not restarted by itself');
    // Its view stays known to the page (it shows why, with Restart), but its tools are not the agent's while it fails.
    assert.ok(f.apps.viewTools().dev_clock__show);
    assert.equal(f.apps.agentTools(f.conversationId).names.has('dev_clock__show'), false);
    // Fixed: Restart works and the view loads again.
    f.state.fail = false;
    const restarted = await f.gate.restart('owner', f.thread, 'dev_clock');
    assert.equal(restarted.status, 'running');
    assert.ok((await f.gate.instance('owner', f.thread, { toolCallId: 'call-dev' }) as { instance?: string }).instance);
    assert.ok(f.gate.recent.some(e => e.event === 'app_restart' && e.app === 'dev_clock' && e.outcome === 'running'));
  } finally { await f.cleanup(); }
});

test('restart route: CSRF, the thread\'s own dev apps (members), installed apps (admins), unknown apps 404; view-only agents have no apps', async () => {
  const f = await fixture();
  const assets = join(f.directory, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const app = guiApp(f.runtime, 'owner', 0, assets, { id: 'a', name: 'A', apps: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/session`);
    const { csrf } = await session.json() as { csrf: string };
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': csrf };
    const url = (appId: string) => `${base}/api/v1/threads/${f.thread}/apps/${appId}/restart`;
    assert.equal((await fetch(url('dev_clock'), { method: 'POST', headers: { ...headers, 'x-csrf-token': 'nope' }, body: '{}' })).status, 403, 'CSRF');
    f.apps.devContainerStopped(f.conversationId, 'idle');
    const response = await fetch(url('dev_clock'), { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 200);
    const body = await response.json() as { status: string; app: { id: string } };
    assert.equal(body.status, 'running');
    assert.equal(body.app.id, 'dev_clock');
    assert.equal((await (await fetch(url('test'), { method: 'POST', headers, body: '{}' })).json() as { status: string }).status, 'running', 'installed app (the single-user app: you are the admin)');
    assert.equal((await fetch(url('nope'), { method: 'POST', headers, body: '{}' })).status, 404);
    // Another thread may not restart this thread's dev app.
    const other = randomUUID(); await f.runtime.create('owner', other, 'Other');
    assert.equal((await fetch(`${base}/api/v1/threads/${other}/apps/dev_clock/restart`, { method: 'POST', headers, body: '{}' })).status, 404);
    // Logs of the thread's dev app (none bound in this test).
    assert.equal((await fetch(`${base}/api/v1/threads/${f.thread}/apps/dev_clock/logs`, { headers: { cookie } })).status, 200);
    // The Apps dialog's Stop and Restart (admins).
    assert.equal((await (await fetch(`${base}/api/v1/apps/dev_clock/stop`, { method: 'POST', headers, body: '{}' })).json() as { stopReason: string }).stopReason, 'manual');
    assert.equal((await (await fetch(`${base}/api/v1/apps/dev_clock/restart`, { method: 'POST', headers, body: '{}' })).json() as { status: string }).status, 'running');
    // The status says why and whether it restarts by itself.
    const list = await (await fetch(`${base}/api/v1/apps`, { headers: { cookie } })).json() as { apps: { id: string; restartable?: boolean }[] };
    assert.equal(list.apps.find(a => a.id === 'dev_clock')!.restartable, true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
  // Installed apps need an admin (team members get 403).
  const g = await fixture();
  try {
    await assert.rejects(g.gate.restart('owner', g.thread, 'test', undefined, { admin: false }), (e: { code?: string }) => e.code === 'admin_required');
    assert.equal((await g.gate.restart('owner', g.thread, 'dev_clock', undefined, { admin: false })).status, 'running', 'members restart their thread\'s dev apps');
  } finally { await g.cleanup(); }
  // View-only agents: no apps on their runtime, so the route answers 404 (never restarts anything).
  const v = await fixture({ viewOnly: true });
  const assetsV = join(v.directory, 'assets'); mkdirSync(assetsV); writeFileSync(join(assetsV, 'index.html'), '<!doctype html>');
  const serverV = guiApp(v.runtime, 'owner', 0, assetsV, { id: 'v', name: 'V', viewOnly: true }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => serverV.once('listening', resolve));
  const addressV = serverV.address(); assert.ok(addressV && typeof addressV !== 'string');
  const baseV = `http://127.0.0.1:${addressV.port}`;
  try {
    const session = await fetch(`${baseV}/api/session`);
    const { csrf } = await session.json() as { csrf: string };
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const launches = v.state.launches;
    v.apps.devContainerStopped(v.conversationId, 'idle');
    const refused = await fetch(`${baseV}/api/v1/threads/${v.thread}/apps/dev_clock/restart`, { method: 'POST', headers: { cookie, origin: baseV, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}' });
    assert.equal(refused.status, 404);
    assert.equal(v.state.launches, launches);
  } finally { serverV.closeAllConnections(); await new Promise<void>(resolve => serverV.close(() => resolve())); await v.cleanup(); }
});

test('heartbeat: an open view keeps its dev app\'s container alive (touch on every request); refused before the view is served', async () => {
  const f = await fixture();
  try {
    let touches = 0;
    f.apps.bindDev(f.conversationId, { launch: async () => line, touch: () => { touches++; } });
    await f.apps.reloadDev('dev_clock');
    // The spec's own touch (set by mcp_app_dev_start) is what keeps the container alive; this fixture's spec has none: set one.
    (f.apps.devSpec('dev_clock') as { touch?: () => void }).touch = () => { touches++; };
    const minted = await f.gate.instance('owner', f.thread, { toolCallId: 'call-dev' }) as { instance: string; sandboxUrl: string };
    assert.throws(() => f.gate.heartbeat('owner', minted.instance), /not_found/);
    const token = new URL(minted.sandboxUrl).hostname.slice(2).split('.')[0]!;
    assert.equal(f.gate.sandboxPage(token).status, 200);
    const before = touches;
    assert.deepEqual(f.gate.heartbeat('owner', minted.instance), { ok: true });
    assert.equal(touches, before + 1);
    f.gate.closeInstance('owner', minted.instance);
    assert.throws(() => f.gate.heartbeat('owner', minted.instance), /not_found/);
  } finally { await f.cleanup(); }
});
