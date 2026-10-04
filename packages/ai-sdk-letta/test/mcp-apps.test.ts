import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitMCPAppTools } from '@ai-sdk/mcp';
import {
  MCP_APPS_CONTEXT, MCP_APPS_IMAGE, McpApps, McpAppRecords, ProcessStdioTransport, SANDBOX_TOOL_PERMISSIONS, agentToolName, appSource, appVisible, createToolBridge, defineAgent, grantedCsp, mcpAppCsp, mcpAppModelOutput, mcpAppRunArgs,
  modelVisible, parseProvenanceTrailers, prepareMcpApp, provenanceTrailers, resolveMcpApps, sandboxTools, toolResourceUri, toolVisibility, turnProvenance, withSource,
  type McpAppLauncher, type McpToolDefinition,
} from '../src/index.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `ai-sdk-letta-${prefix}-`));
const SERVER = join(import.meta.dirname, 'fixtures', 'mcp-app-server.mjs');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('deadline');
}

/* ------------------------------------------------------------------ */
/* Visibility                                                          */
/* ------------------------------------------------------------------ */

const def = (name: string, meta?: Record<string, unknown>): McpToolDefinition => ({ name, inputSchema: { type: 'object' }, ...(meta ? { _meta: meta } : {}) });

test('visibility: omitted means ["model", "app"] (where @ai-sdk/mcp 2.0.60 says model-only)', () => {
  const plain = def('plain');
  const withView = def('show', { ui: { resourceUri: 'ui://x/v.html' } });
  for (const tool of [plain, withView]) {
    assert.deepEqual(toolVisibility(tool), ['model', 'app']);
    assert.equal(modelVisible(tool), true);
    assert.equal(appVisible(tool), true);
  }
  // The upstream bug: splitMCPAppTools puts a tool without visibility in modelVisible only.
  const split = splitMCPAppTools({ tools: [withView] } as never);
  assert.equal(split.modelVisible.tools.length, 1);
  assert.equal(split.appVisible.tools.length, 0, 'upstream treats a missing visibility as model-only; our predicate does not');
});

test('visibility: explicit lists, unknown entries, and an empty list', () => {
  assert.deepEqual(toolVisibility(def('a', { ui: { visibility: ['app'] } })), ['app']);
  assert.equal(modelVisible(def('a', { ui: { visibility: ['app'] } })), false);
  assert.deepEqual(toolVisibility(def('m', { ui: { visibility: ['model'] } })), ['model']);
  assert.equal(appVisible(def('m', { ui: { visibility: ['model'] } })), false);
  assert.deepEqual(toolVisibility(def('x', { ui: { visibility: ['model', 'bogus', 'model'] } })), ['model']);
  assert.deepEqual(toolVisibility(def('n', { ui: { visibility: [] } })), []);
  assert.deepEqual(toolVisibility(def('s', { ui: { visibility: 'app' } })), ['model', 'app'], 'not an array: the default');
});

test('view URIs: _meta.ui.resourceUri, the legacy key, ui:// only', () => {
  assert.equal(toolResourceUri(def('a', { ui: { resourceUri: 'ui://a/b.html' } })), 'ui://a/b.html');
  assert.equal(toolResourceUri(def('a', { 'ui/resourceUri': 'ui://legacy/b.html' })), 'ui://legacy/b.html');
  assert.equal(toolResourceUri(def('a', { ui: { resourceUri: 'https://evil.example/x.html' } })), undefined);
  assert.equal(toolResourceUri(def('a')), undefined);
  assert.equal(agentToolName('clock', 'get-time'), 'clock__get-time');
  assert.equal(agentToolName('clock', 'a.b/c'), 'clock__a_b_c');
});

/* ------------------------------------------------------------------ */
/* CSP                                                                 */
/* ------------------------------------------------------------------ */

test('CSP: declared domains intersected with approved origins; junk dropped', () => {
  const declared = { connectDomains: ['https://api.example.org', 'https://evil.example.net', "'unsafe-eval'", 'http://insecure.example.org', 'https://*.example.org', 'https://api.example.org/path; script-src *'], resourceDomains: ['https://cdn.example.org'], frameDomains: ['https://frames.example.org'] };
  const granted = grantedCsp(declared, ['https://api.example.org', 'https://cdn.example.org']);
  assert.deepEqual(granted, { connectDomains: ['https://api.example.org'], resourceDomains: ['https://cdn.example.org'], frameDomains: [], baseUriDomains: [] });
  // Nothing declared: nothing granted, whatever is approved.
  assert.deepEqual(grantedCsp(undefined, ['https://api.example.org']), { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
  // Approved but not declared: not granted (no loosening).
  assert.deepEqual(grantedCsp({ connectDomains: [] }, ['https://api.example.org']).connectDomains, []);
});

test('CSP header: restrictive default, never unsafe-eval, frame-src none unless granted, framed by the app only', () => {
  const restrictive = mcpAppCsp({}, 'http://127.0.0.1:4400');
  for (const part of ["default-src 'none'", "script-src 'self' 'unsafe-inline'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'none'", 'frame-ancestors http://127.0.0.1:4400']) assert.ok(restrictive.includes(part), part);
  assert.doesNotMatch(restrictive, /unsafe-eval/);
  const granted = mcpAppCsp({ connectDomains: ['https://api.example.org'], resourceDomains: ['https://cdn.example.org'], frameDomains: ['https://f.example.org'] }, 'http://127.0.0.1:4400');
  assert.match(granted, /connect-src https:\/\/api\.example\.org(;|$)/);
  assert.match(granted, /script-src 'self' 'unsafe-inline' https:\/\/cdn\.example\.org/);
  assert.match(granted, /frame-src https:\/\/f\.example\.org/);
  assert.doesNotMatch(granted, /unsafe-eval/);
  assert.throws(() => mcpAppCsp({}, "http://x; script-src *"), /invalid_frame_ancestor/);
});

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

test('config: local packages and folders only, policies, origins, ids', () => {
  const dir = tmp('apps-config');
  try {
    const tgz = join(dir, 'clock-1.0.0.tgz'); writeFileSync(tgz, 'x');
    const resolved = resolveMcpApps([{ id: 'clock', package: tgz, tools: { show: 'allow', hide: 'deny' }, origins: ['https://api.example.org', 'https://api.example.org/'] }, { id: 'local', path: dir, command: ['node', 'server.js'] }]);
    assert.equal(resolved[0]!.source?.kind, 'tarball');
    assert.deepEqual(resolved[0]!.origins, ['https://api.example.org']);
    assert.deepEqual(resolved[0]!.tools, { show: 'allow', hide: 'deny' });
    assert.equal(resolved[1]!.source?.kind, 'folder');
    for (const bad of ['https://registry.npmjs.org/x.tgz', 'git+ssh://github.com/x/y.git', 'npm:foo', '//host/share']) assert.throws(() => resolveMcpApps([{ id: 'x', package: bad }]), /local path, not a URL/, bad);
    assert.throws(() => resolveMcpApps([{ id: 'x', package: join(dir, 'missing.tgz') }]), /does not exist/);
    assert.throws(() => resolveMcpApps([{ id: 'Bad_Id', package: tgz }]), /id must be/);
    assert.throws(() => resolveMcpApps([{ id: 'a', package: tgz }, { id: 'a', package: tgz }]), /Duplicate/);
    assert.throws(() => resolveMcpApps([{ id: 'a', package: tgz, tools: { x: 'maybe' } }]), /allow/);
    assert.throws(() => resolveMcpApps([{ id: 'a', package: tgz, origins: ['http://insecure.example.org'] }]), /https/);
    assert.throws(() => resolveMcpApps([{ id: 'a', package: tgz, url: 'x' }]), /Unknown/);
    assert.throws(() => resolveMcpApps([{ id: 'a' }]), /needs package, path or command/);
    // Definitions: a sandbox provider is required; app tool names are reserved; app tools are never trusted for memory.
    const base = { id: 'apps-agent', name: 'Apps', model: 'openai/x', instructions: 'x' };
    assert.throws(() => defineAgent({ ...base, tools: {}, mcpApps: [{ id: 'clock', package: tgz }] }), /sandbox/);
    const ok = defineAgent({ ...base, tools: {}, sandbox: { provider: 'docker' }, mcpApps: [{ id: 'clock', package: tgz }] });
    assert.equal(ok.mcpApps?.[0]?.id, 'clock');
    assert.throws(() => defineAgent({ ...base, tools: { clock__x: sandboxTools.run_command }, permissions: { clock__x: 'allow' }, sandbox: { provider: 'docker' }, mcpApps: [{ id: 'clock', package: tgz }] }), /reserved for the MCP App/);
    assert.throws(() => defineAgent({ ...base, tools: {}, sandbox: { provider: 'docker' }, memory: { trustedTools: ['clock__show'] }, mcpApps: [{ id: 'clock', package: tgz }] }), /always untrusted/);
    void SANDBOX_TOOL_PERMISSIONS;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('packages: tarballs unpack under the state folder; entries outside package/ are refused; bin is the default command; version is checked', async () => {
  const dir = tmp('apps-pack');
  try {
    const src = join(dir, 'src', 'package'); mkdirSync(join(src, 'dist'), { recursive: true });
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: '@x/clock', version: '2.0.3', bin: { clock: 'dist/index.js' } }));
    writeFileSync(join(src, 'dist', 'index.js'), '');
    const tgz = join(dir, 'clock.tgz');
    execFileSync('tar', ['-czf', tgz, '-C', join(dir, 'src'), 'package']);
    const [config] = resolveMcpApps([{ id: 'clock', package: tgz, version: '2.0.3' }]);
    const prepared = await prepareMcpApp(config!, join(dir, 'state'));
    assert.deepEqual(prepared.command, ['node', 'dist/index.js']);
    assert.equal(prepared.packageVersion, '2.0.3');
    assert.ok(prepared.folder!.startsWith(join(dir, 'state', 'clock')));
    assert.ok(existsSync(join(prepared.folder!, 'dist', 'index.js')));
    const [wrong] = resolveMcpApps([{ id: 'clock', package: tgz, version: '9.9.9' }]);
    await assert.rejects(prepareMcpApp(wrong!, join(dir, 'state')), /expected version 9\.9\.9/);
    // A tarball with an entry outside package/.
    mkdirSync(join(dir, 'evil'), { recursive: true }); writeFileSync(join(dir, 'evil', 'x'), 'x');
    const evil = join(dir, 'evil.tgz');
    execFileSync('tar', ['-czf', evil, '-C', dir, 'evil']);
    const [bad] = resolveMcpApps([{ id: 'evil', package: evil }]);
    await assert.rejects(prepareMcpApp(bad!, join(dir, 'state')), /outside "package\/"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('containers: no network, no capabilities, read-only root and app folder, labelled', () => {
  const args = mcpAppRunArgs('docker', 'n', { image: MCP_APPS_IMAGE, folder: '/state/pkg', labels: { 'ai-sdk-letta.sandbox': '1' }, uid: { uid: 501, gid: 20 } });
  const joined = args.join(' ');
  for (const part of ['--network none', '--cap-drop ALL', '--security-opt no-new-privileges', '--read-only', 'type=bind,src=/state/pkg,dst=/app,readonly', '--user 501:20', '--label ai-sdk-letta.sandbox=1']) assert.ok(joined.includes(part), part);
  const apple = mcpAppRunArgs('apple-container', 'n', { image: MCP_APPS_IMAGE, folder: '/state/pkg', labels: {} }).join(' ');
  for (const part of ['--network none', '--cap-drop ALL', '--read-only', 'dst=/app,readonly']) assert.ok(apple.includes(part), part);
  assert.match(MCP_APPS_IMAGE, /^ai-sdk-letta-mcp-apps:[a-f0-9]{12}$/);
});

/* ------------------------------------------------------------------ */
/* Running apps (a real stdio server, no container)                     */
/* ------------------------------------------------------------------ */

/** Launch the fixture server as a plain process (what the container launcher does with `exec -i`). */
const processLauncher = (pidFile: string, stops: string[]): McpAppLauncher => async app => ({ line: { command: process.execPath, args: [SERVER, pidFile] }, stop: async () => { stops.push(app.config.id); } });

async function openApps(dir: string, policies: Record<string, 'allow' | 'ask' | 'deny'> = {}) {
  const pidFile = join(dir, 'pid');
  const stops: string[] = [];
  const configs = resolveMcpApps([{ id: 'test', command: ['node', 'server.mjs'], tools: policies, origins: ['https://api.example.org'] }]);
  const apps = new McpApps(configs, { directory: join(dir, 'state'), launcher: processLauncher(pidFile, stops) });
  await apps.ready();
  return { apps, pid: () => Number(readFileSync(pidFile, 'utf8')), stops };
}

test('apps: discovery, model tools (our predicate), and views read with their CSP', async () => {
  const dir = tmp('apps-run');
  const { apps } = await openApps(dir, { plain: 'deny', show: 'allow' });
  try {
    const status = apps.status()[0]!;
    assert.equal(status.status, 'running');
    // The host advertises the MCP Apps extension (spec: io.modelcontextprotocol/ui with the profile MIME type).
    const init = JSON.parse(readFileSync(join(dir, 'pid.init.json'), 'utf8')) as { capabilities?: { extensions?: Record<string, { mimeTypes?: string[] }> } };
    assert.deepEqual(init.capabilities?.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes, ['text/html;profile=mcp-app']);
    assert.equal(status.name, 'Test App');
    const { tools, permissions } = apps.agentTools();
    // record is app-only, nobody is hidden, plain is denied: the agent gets show and secret only.
    assert.deepEqual(Object.keys(tools).sort(), ['test__secret', 'test__show']);
    assert.deepEqual(permissions, { test__show: 'allow', test__secret: 'ask' });
    assert.equal(status.views.length, 1);
    assert.deepEqual(status.views[0]!.granted.connectDomains, ['https://api.example.org']);
    assert.deepEqual(status.views[0]!.granted.resourceDomains, []);
    assert.deepEqual(Object.keys(apps.viewTools()), ['test__show']);
  } finally { await apps.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('apps: the agent sees content only (bounded); structuredContent is recorded for the view and survives a reload', async () => {
  const dir = tmp('apps-records');
  const { apps } = await openApps(dir, { show: 'allow' });
  try {
    const { tools, permissions } = apps.agentTools();
    const bridge = createToolBridge({ tools, permissions, context: () => ({ [MCP_APPS_CONTEXT]: { apps, conversationId: 'conv-1' } }) });
    const out = await bridge.execute('test__show', 'call-1', { label: 'hello' });
    assert.equal(out.isError, false);
    assert.deepEqual(out.content, [{ type: 'text', text: 'shown hello' }]);
    assert.doesNotMatch(JSON.stringify(out.content), /structuredContent|label/);
    const record = apps.records.get('call-1', ['conv-1'])!;
    assert.equal(record.status, 'done');
    assert.deepEqual(record.result?.structuredContent, { label: 'hello', big: '' });
    assert.equal(record.resourceUri, 'ui://test/view.html');
    assert.ok(record.fingerprint);
    assert.equal(apps.records.get('call-1', ['other-conversation']), undefined, 'records are scoped by conversation');
    // A reload: a new records store reads the same file.
    const reread = new McpAppRecords(join(dir, 'state', 'records.json'));
    assert.deepEqual(reread.get('call-1', ['conv-1'])?.result?.structuredContent, { label: 'hello', big: '' });
    // Oversized results keep their content but not structuredContent.
    await bridge.execute('test__show', 'call-2', { label: 'x', size: 600_000 });
    const big = apps.records.get('call-2', ['conv-1'])!;
    assert.equal(big.truncated, true);
    assert.equal(big.result?.structuredContent, undefined);
    // The model never gets more than the limit.
    const long = mcpAppModelOutput({ output: { result: { content: [{ type: 'text', text: 'y'.repeat(50_000) }] } } });
    assert.equal(long.type, 'text');
    assert.ok((long.value as string).length < 16_000);
  } finally { await apps.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('apps: a running call is recorded as running, then cancelled when interrupted by a restart', () => {
  const dir = tmp('apps-interrupted');
  try {
    const file = join(dir, 'records.json');
    const records = new McpAppRecords(file);
    records.add({ conversationId: 'c', toolCallId: 't', app: 'a', tool: 'show', agentTool: 'a__show', resourceUri: 'ui://a/v', input: {}, status: 'running', at: new Date().toISOString() });
    const after = new McpAppRecords(file);
    assert.equal(after.get('t', ['c'])?.status, 'cancelled');
    assert.equal(after.get('t', ['c'])?.reason, 'interrupted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apps: app calls are refused for tools without "app" visibility and for denied tools', async () => {
  const dir = tmp('apps-gate');
  const { apps } = await openApps(dir, { plain: 'deny' });
  try {
    await assert.rejects(apps.callAsApp('test', 'secret', {}), (e: Error & { code?: string }) => e.code === 'not_app_visible');
    await assert.rejects(apps.callAsApp('test', 'nobody', {}), (e: Error & { code?: string }) => e.code === 'not_app_visible');
    await assert.rejects(apps.callAsApp('test', 'plain', {}), (e: Error & { code?: string }) => e.code === 'tool_denied');
    await assert.rejects(apps.callAsApp('test', 'missing', {}), (e: Error & { code?: string }) => e.code === 'tool_unknown');
    const ok = await apps.callAsApp('test', 'record', { note: 'x' });
    assert.deepEqual(ok.structuredContent, { count: 1 });
    // The agent cannot call an app-only tool either.
    await assert.rejects(apps.callAsAgent('test__record', {}, { conversationId: 'c', toolCallId: 'x' }), (e: Error & { code?: string }) => e.code === 'tool_unknown');
    // Disabled: everything refuses.
    apps.setEnabled('test', false);
    await assert.rejects(apps.callAsApp('test', 'record', {}), (e: Error & { code?: string }) => e.code === 'app_disabled');
    apps.setEnabled('test', true);
    // Resources: ui:// of the same app only.
    await assert.rejects(apps.readResource('test', 'file:///etc/passwd'), (e: Error & { code?: string }) => e.code === 'resource_refused');
    assert.equal((await apps.readResource('test', 'ui://test/view.html')).contents.length, 1);
  } finally { await apps.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('process cleanup: closing kills the server (no handle left), and the environment is stopped', async () => {
  const dir = tmp('apps-cleanup');
  const { apps, pid, stops } = await openApps(dir);
  const server = pid();
  assert.equal(alive(server), true);
  await apps.close();
  await until(() => !alive(server));
  assert.deepEqual(stops, ['test']);
  rmSync(dir, { recursive: true, force: true });
});

test('process cleanup: the stdio transport kills its child even if it ignores stdin closing', async () => {
  const transport = new ProcessStdioTransport({ command: process.execPath, args: ['-e', 'process.stdin.resume(); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'] });
  await transport.start();
  const child = transport.process!;
  const exited = new Promise(resolve => child.once('exit', resolve));
  let closed = 0;
  transport.onclose = () => { closed++; };
  await transport.close();
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(closed, 1);
  await transport.close();
  assert.equal(closed, 1, 'idempotent');
});

test('a server that fails to start is reported, and the others keep working', async () => {
  const dir = tmp('apps-fail');
  try {
    const configs = resolveMcpApps([{ id: 'good', command: ['x'] }, { id: 'bad', command: ['x'] }]);
    const apps = new McpApps(configs, { directory: join(dir, 'state'), launcher: async app => app.config.id === 'bad' ? (() => { throw new Error('no such image'); })() : { line: { command: process.execPath, args: [SERVER] }, stop: async () => {} } });
    await apps.ready();
    const status = Object.fromEntries(apps.status().map(s => [s.id, s]));
    assert.equal(status.good!.status, 'running');
    assert.equal(status.bad!.status, 'failed');
    assert.match(status.bad!.error ?? '', /no such image/);
    assert.ok(Object.keys(apps.agentTools().tools).every(name => name.startsWith('good__')));
    await apps.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

test('provenance: app content is its own untrusted kind, round-trips through trailers', () => {
  const base = turnProvenance({ turn: 't', actor: { id: 'u1', name: 'Ann' } });
  const read = withSource(withSource(base, appSource('clock', 'get-time')), { ...appSource('clock'), label: 'app:clock (message)', reviewed: true });
  assert.equal(read.sources.length, 2);
  assert.ok(read.sources.every(s => s.kind === 'app'));
  const parsed = parseProvenanceTrailers(provenanceTrailers(read))!;
  assert.deepEqual(parsed.sources.map(s => s.kind), ['app', 'app']);
  assert.equal(parsed.sources[1]!.reviewed, true);
});
