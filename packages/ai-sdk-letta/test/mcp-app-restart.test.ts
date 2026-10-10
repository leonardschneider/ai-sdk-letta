import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpApps, SandboxManager, WEBDEV_IMAGE, WebDevServices, autoRestartable, bindDevApps, readDevApps, resolveSandboxConfig, resolveWebDevConfig, type McpAppDevPersisted, type ServicesContainer, type ServicesDriver } from '../src/index.js';

const SERVER = join(import.meta.dirname, 'fixtures', 'mcp-app-server.mjs');
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `ai-sdk-letta-${prefix}-`));
const line = { line: { command: process.execPath, args: [SERVER] }, stop: async () => {} };

/** A dev app started as `mcp_app_dev_start` would (stdio), whose launches are counted; `fail` makes the next launches fail. */
function devSpec(conversationId: string, state: { launches: number; fail?: boolean }, touch?: () => void) {
  return { name: 'clock', conversationId, folder: '/workspace/clock', command: 'node server.mjs', transport: 'stdio' as const,
    launch: async () => { state.launches++; if (state.fail) throw new Error('boom: Cannot find module server.mjs'); return line; }, ...(touch ? { touch } : {}) };
}

test('a dev app stopped by its idle container keeps its spec (persisted), restarts by itself, and survives a restart of the process', async () => {
  const directory = tmp('restart');
  const state = { launches: 0 };
  try {
    const apps = new McpApps([], { directory });
    const started = await apps.startDev(devSpec('conv-1', state));
    assert.equal(started.status, 'running');
    // The spec is kept on disk (0600), with its tools (for views after a restart).
    const file = join(directory, 'dev-apps.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const saved = readDevApps(file);
    assert.deepEqual(saved.map(({ tools: _t, startedAt: _s, ...rest }) => rest), [{ name: 'clock', conversationId: 'conv-1', folder: '/workspace/clock', command: 'node server.mjs', transport: 'stdio', generation: 1 }]);
    assert.ok(saved[0]!.tools!.some(t => t.name === 'show'));

    // The services container stops after its idle timeout: the app is stopped (idle), not forgotten nor failed.
    apps.devContainerStopped('conv-1', 'idle');
    let status = apps.status().find(s => s.id === 'dev_clock')!;
    assert.equal(status.status, 'stopped');
    assert.equal(status.stopReason, 'idle');
    assert.equal(status.autoRestart, true);
    assert.equal(status.restartable, true);
    assert.deepEqual(apps.devApps('conv-1'), ['dev_clock']);
    // Its tools stay the agent's (a call starts it again) and its views stay known.
    assert.ok(apps.agentTools('conv-1').names.has('dev_clock__show'));
    assert.ok(apps.viewTools().dev_clock__show);

    // The agent's call restarts it transparently.
    const result = await apps.callAsAgent('dev_clock__show', { label: 'back' }, { conversationId: 'conv-1', toolCallId: 'c1' });
    assert.match(JSON.stringify(result.content), /shown back/);
    assert.equal(state.launches, 2);
    assert.equal(apps.status().find(s => s.id === 'dev_clock')!.status, 'running');
    await apps.close();

    // The process restarts: the dev app is read back, stopped (restart), with its tools, waiting for its conversation's services.
    const again = new McpApps([], { directory });
    status = again.status().find(s => s.id === 'dev_clock')!;
    assert.equal(status.status, 'stopped');
    assert.equal(status.stopReason, 'restart');
    assert.equal(status.restartable, false, 'not before its conversation is bound');
    assert.equal(status.autoRestart, undefined);
    assert.equal(status.dev?.command, 'node server.mjs');
    assert.ok(again.viewTools().dev_clock__show, 'its views are still known');
    await assert.rejects(again.restart('dev_clock'), /conversation is open/);
    // The conversation opens: bound, it restarts from the kept spec.
    const relaunched: McpAppDevPersisted[] = [];
    again.bindDev('conv-1', { launch: async spec => { relaunched.push(spec); return line; } });
    assert.equal(again.autoRestarts('dev_clock'), true);
    assert.equal(await again.ensureDev('dev_clock'), 'running');
    assert.equal(relaunched[0]?.command, 'node server.mjs');
    assert.equal(relaunched[0]?.folder, '/workspace/clock');
    assert.equal(again.status().find(s => s.id === 'dev_clock')!.dev?.generation, 3, 'the generation continues across the restart');
    // Stopping it for good forgets it on disk too.
    await again.stopDev('dev_clock');
    assert.deepEqual(readDevApps(file), []);
    await again.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a dev app that failed is not restarted by itself; Restart works once it is fixed', async () => {
  const directory = tmp('restart-failed');
  const state = { launches: 0, fail: true };
  const apps = new McpApps([], { directory });
  try {
    const started = await apps.startDev(devSpec('conv-1', state));
    assert.equal(started.status, 'failed');
    const status = apps.status().find(s => s.id === 'dev_clock')!;
    assert.equal(status.autoRestart, undefined);
    assert.equal(status.restartable, true);
    assert.match(status.error!, /boom/);
    assert.equal(await apps.ensureDev('dev_clock', 50), 'failed');
    assert.equal(state.launches, 1, 'never relaunched by itself');
    // The agent's call does not restart it either.
    await assert.rejects(apps.callAsAgent('dev_clock__show', {}, { conversationId: 'conv-1', toolCallId: 'x' }), /tool_unknown|No app tool/);
    state.fail = false;
    assert.equal(await apps.restart('dev_clock'), 'running');
    assert.equal(state.launches, 2);
    // Stopped by someone: kept, restartable, not restarted by itself.
    await apps.stopApp('dev_clock');
    const stopped = apps.status().find(s => s.id === 'dev_clock')!;
    assert.equal(stopped.stopReason, 'manual');
    assert.equal(stopped.autoRestart, undefined);
    assert.equal(autoRestartable('manual'), false);
    assert.equal(autoRestartable('idle'), true);
    assert.equal(autoRestartable('exited'), false);
  } finally { await apps.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent restarts share one start', async () => {
  const directory = tmp('restart-once');
  const state = { launches: 0 };
  const apps = new McpApps([], { directory });
  try {
    await apps.startDev(devSpec('conv-1', state));
    apps.devContainerStopped('conv-1', 'idle');
    const all = await Promise.all([apps.ensureDev('dev_clock'), apps.ensureDev('dev_clock'), apps.ensureDev('dev_clock')]);
    assert.deepEqual(all, ['running', 'running', 'running']);
    assert.equal(state.launches, 2);
  } finally { await apps.close(); rmSync(directory, { recursive: true, force: true }); }
});

/** A services driver whose containers do nothing (they only count stops). */
function quietDriver() {
  const containers: { stopped: boolean }[] = [];
  const driver: ServicesDriver = { kind: 'docker', async start() {
    const record = { stopped: false }; containers.push(record);
    const container: ServicesContainer = { name: `svc-${containers.length}`, async exec() { return { code: 0, stdout: 'dir\npkg\n', stderr: '' }; }, interactive: argv => ({ command: 'true', args: argv }), async stop() { record.stopped = true; } };
    return container;
  } };
  return { driver, containers };
}
function manager() {
  const workspace = tmp('restart-ws');
  return new SandboxManager(resolveSandboxConfig({ provider: async () => { throw new Error('no sandbox in tests'); }, image: WEBDEV_IMAGE }), { workspace: () => workspace, folder: () => 'My chat', owner: 'agent.conv' });
}

test('the services container idle-stops its dev apps (reason idle); a view heartbeat (touch) keeps it running', async () => {
  const directory = tmp('restart-idle');
  const { driver, containers } = quietDriver();
  const services = new WebDevServices(manager(), resolveWebDevConfig({ idleTimeoutMs: 1000 }), { driver });
  const apps = new McpApps([], { directory });
  try {
    bindDevApps(apps, 'conv-1', services);
    bindDevApps(apps, 'conv-1', services); // idempotent
    await services.devServerLogs(); // no container yet
    await services.hold(async () => { await (services as unknown as { containerNow(): Promise<unknown> }).containerNow(); });
    const state = { launches: 0 };
    await apps.startDev(devSpec('conv-1', state, () => services.touch()));
    services.touch();
    // An open view sends a heartbeat (touchDev) more often than the idle timeout: the container keeps running.
    for (let i = 0; i < 6; i++) { await new Promise(resolve => setTimeout(resolve, 300)); apps.touchDev('dev_clock'); }
    assert.equal(containers[0]!.stopped, false, 'kept alive by the heartbeat');
    assert.equal(apps.status().find(s => s.id === 'dev_clock')!.status, 'running');
    // No more heartbeats: it stops for idleness, and the dev app with it (idle, restartable).
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(containers[0]!.stopped, true);
    const status = apps.status().find(s => s.id === 'dev_clock')!;
    assert.equal(status.status, 'stopped');
    assert.equal(status.stopReason, 'idle');
    assert.equal(status.autoRestart, true);
    assert.equal(JSON.parse(readFileSync(join(directory, 'dev-apps.json'), 'utf8')).apps.length, 1);
  } finally { await services.close(); await apps.close(); rmSync(directory, { recursive: true, force: true }); }
});
