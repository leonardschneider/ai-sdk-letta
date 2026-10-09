import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import {
  BROWSER_TOOL_NAMES, BROWSER_TOOL_SPECS, DEFAULT_MEMORY, FrameMux, SANDBOX_IMAGE, SANDBOX_TOOL_PERMISSIONS, SandboxManager, TRUSTED_TOOLS, WEBDEV_CONTEXT, WEBDEV_IMAGE, WEBDEV_TOOL_NAMES, WEBDEV_TOOL_PERMISSIONS, WEB_DEV_NOTE,
  WebDevRegistry, WebDevServices, browserFlags, browserModelOutput, connectOrigin, createToolBridge, creationOptions, defineAgent, handleEgress, normalizeWebOrigin, resolveSandboxConfig, resolveWebDevConfig, sandboxTools,
  servicesRunArgs, sourceOfTool, turnProvenance, TUNNEL_SCRIPT, parseProvenanceTrailers, provenanceTrailers, webDevEnabled, webDevTools, withSource, ToolInteractions,
  type BrowserConnector, type BrowserResult, type ServicesContainer, type ServicesDriver, type ServicesRequest,
} from '../src/index.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `ai-sdk-letta-${prefix}-`));

/* ------------------------------------------------------------------ */
/* Tool allowlist, schemas, permissions                                */
/* ------------------------------------------------------------------ */

const ALLOWED = ['navigate_page', 'take_snapshot', 'take_screenshot', 'click', 'fill', 'fill_form', 'press_key', 'type_text', 'hover', 'wait_for', 'handle_dialog', 'list_console_messages', 'get_console_message',
  'list_network_requests', 'get_network_request', 'evaluate_script', 'emulate', 'resize_page', 'get_css_styles', 'lighthouse_audit', 'list_webmcp_tools', 'execute_webmcp_tool', 'list_pages'];

test('browser tools: exactly the 23-tool allowlist, as browser_*', () => {
  assert.deepEqual(BROWSER_TOOL_SPECS.map(s => s.name).sort(), [...ALLOWED].sort());
  assert.equal(BROWSER_TOOL_NAMES.length, 23);
  for (const name of ALLOWED) assert.ok((webDevTools as Record<string, unknown>)[`browser_${name}`], name);
  for (const excluded of ['upload_file', 'take_heapsnapshot', 'new_page', 'close_page', 'select_page', 'drag', 'performance_start_trace', 'performance_stop_trace', 'performance_analyze_insight']) {
    assert.equal((webDevTools as Record<string, unknown>)[`browser_${excluded}`], undefined, excluded);
  }
});

test('browser tool schemas: no file path parameter anywhere, no extra properties accepted', () => {
  const paths: string[] = [];
  const walk = (schema: unknown, where: string) => {
    if (!schema || typeof schema !== 'object') return;
    const record = schema as Record<string, unknown>;
    if (record.properties && typeof record.properties === 'object') {
      for (const [key, value] of Object.entries(record.properties)) { if (/path/i.test(key)) paths.push(`${where}.${key}`); walk(value, `${where}.${key}`); }
      assert.equal(record.additionalProperties, false, `${where} must refuse unknown properties`);
    }
    for (const value of Object.values(record)) if (typeof value === 'object') walk(value, where);
  };
  for (const spec of BROWSER_TOOL_SPECS) walk(spec.inputSchema, spec.name);
  assert.deepEqual(paths, []);
  const screenshot = BROWSER_TOOL_SPECS.find(s => s.name === 'take_screenshot')!.inputSchema as { properties: Record<string, unknown> };
  assert.equal('filePath' in screenshot.properties, false);
  assert.ok('fullPage' in screenshot.properties);
});

test('the bridge refuses a filePath argument before anything runs', async () => {
  let ran = 0;
  const services = { callBrowser: async () => { ran++; return { content: [] }; } };
  const bridge = createToolBridge({ tools: { browser_take_screenshot: webDevTools.browser_take_screenshot! }, permissions: { browser_take_screenshot: 'allow' }, context: () => ({ [WEBDEV_CONTEXT]: services }) });
  const refused = await bridge.execute('browser_take_screenshot', 'c1', { filePath: '/workspace/x.png' });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /invalid_arguments/);
  assert.equal(ran, 0);
});

test('permissions: everything allow (evaluate_script too), approving an origin asks and can never be allow', () => {
  for (const name of WEBDEV_TOOL_NAMES) assert.equal(WEBDEV_TOOL_PERMISSIONS[name], name === 'allow_web_origin' ? 'ask' : 'allow', name);
  assert.equal(WEBDEV_TOOL_PERMISSIONS.browser_evaluate_script, 'allow');
  const base = { id: 'web', name: 'Web', model: 'openai-codex/gpt-5.5', instructions: 'x', sandbox: { provider: 'docker' as const } };
  assert.throws(() => defineAgent({ ...base, tools: { ...sandboxTools, ...webDevTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS, ...WEBDEV_TOOL_PERMISSIONS, allow_web_origin: 'allow' } }), /allow_web_origin/);
});

test('opt-in: the web development image by default, the note in the instructions, enabled only with a sandbox', () => {
  const base = { id: 'web', name: 'Web', model: 'openai-codex/gpt-5.5', instructions: 'Be helpful.' };
  const web = defineAgent({ ...base, tools: { ...sandboxTools, ...webDevTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS, ...WEBDEV_TOOL_PERMISSIONS }, sandbox: { provider: 'docker' } });
  assert.equal(web.sandbox!.image, WEBDEV_IMAGE);
  assert.equal(webDevEnabled(web), true);
  assert.ok(String(creationOptions(web, '/tmp').systemPrompt).includes(WEB_DEV_NOTE));
  assert.deepEqual(web.webDev, { memory: '3G', idleTimeoutMs: 1_800_000 });
  // Another image when named.
  assert.equal(defineAgent({ ...base, tools: { ...sandboxTools, ...webDevTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS, ...WEBDEV_TOOL_PERMISSIONS }, sandbox: { provider: 'docker', image: 'my/image:1' } }).sandbox!.image, 'my/image:1');
  // Without the web tools: the plain image, no note.
  const plain = defineAgent({ ...base, tools: { ...sandboxTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS }, sandbox: { provider: 'docker' } });
  assert.equal(plain.sandbox!.image, SANDBOX_IMAGE);
  assert.equal(webDevEnabled(plain), false);
  assert.ok(!String(creationOptions(plain, '/tmp').systemPrompt).includes(WEB_DEV_NOTE));
  // Without a sandbox: never enabled.
  const noSandbox = defineAgent({ ...base, tools: { ...sandboxTools, ...webDevTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS, ...WEBDEV_TOOL_PERMISSIONS } });
  assert.equal(webDevEnabled(noSandbox), false);
  assert.throws(() => resolveWebDevConfig({ memory: 'lots' }), /memory/);
  assert.throws(() => resolveWebDevConfig({ nope: 1 } as never), /Unknown webDev/);
});

test('browser output is never trusted: not in trustedTools, and a browser source with the page URL', () => {
  const base = { id: 'web', name: 'Web', model: 'openai-codex/gpt-5.5', instructions: 'x', tools: { ...sandboxTools, ...webDevTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS, ...WEBDEV_TOOL_PERMISSIONS }, sandbox: { provider: 'docker' as const } };
  assert.throws(() => defineAgent({ ...base, memory: { trustedTools: ['browser_take_snapshot'] } }), /trustedTools cannot include browser_take_snapshot/);
  assert.throws(() => defineAgent({ ...base, memory: { trustedTools: ['dev_server_logs'] } }), /dev_server_logs/);
  // Even if a caller passes them as trusted, the source stays untrusted.
  for (const name of [...BROWSER_TOOL_NAMES, 'dev_server_logs', 'dev_server_start']) assert.equal(sourceOfTool(name, new Set([...TRUSTED_TOOLS, name]))?.kind, 'browser', name);
  for (const name of ['web_dev_guide', 'dev_server_stop', 'allow_web_origin']) assert.equal(sourceOfTool(name), undefined, name);
  const provenance = withSource(turnProvenance({ actor: { id: 'u', name: 'U', role: 'admin' } }), { kind: 'browser', label: 'http://127.0.0.1:5173/' });
  assert.deepEqual(provenance.sources, [{ kind: 'browser', label: 'http://127.0.0.1:5173/' }]);
  const parsed = parseProvenanceTrailers(provenanceTrailers(provenance));
  assert.deepEqual(parsed?.sources, [{ kind: 'browser', label: 'http://127.0.0.1:5173/' }]);
  assert.equal(DEFAULT_MEMORY.trustedTools.length, 0);
});

test('browser output to the model: bounded text, images as image parts, errors as error text', () => {
  const long = 'x'.repeat(20_000);
  const out = browserModelOutput({ output: { content: [{ type: 'text', text: long }, { type: 'image', data: 'AAAA', mimeType: 'image/webp' }] } satisfies BrowserResult }) as { type: string; value: { type: string; text?: string }[] };
  assert.equal(out.type, 'content');
  assert.ok(out.value[0]!.text!.length < 15_000);
  assert.match(out.value[0]!.text!, /more characters omitted/);
  assert.deepEqual(out.value[1], { type: 'image-data', data: 'AAAA', mediaType: 'image/webp' });
  assert.deepEqual(browserModelOutput({ output: { content: [{ type: 'text', text: 'boom' }], isError: true } }), { type: 'error-text', value: 'boom' });
});

/* ------------------------------------------------------------------ */
/* Origins, browser flags, container arguments                         */
/* ------------------------------------------------------------------ */

test('origins: https host names only, no paths, IPs, credentials or local names', () => {
  assert.deepEqual(normalizeWebOrigin('https://cdn.jsdelivr.net'), { origin: 'https://cdn.jsdelivr.net' });
  assert.deepEqual(normalizeWebOrigin('https://CDN.example.com:8443/'), { origin: 'https://cdn.example.com:8443' });
  for (const bad of ['http://cdn.jsdelivr.net', 'https://cdn.jsdelivr.net/npm/x', 'https://1.2.3.4', 'https://[::1]', 'https://user:pw@cdn.jsdelivr.net', 'https://localhost', 'https://printer.local', 'https://intranet', 'ftp://x.y', 'cdn.jsdelivr.net', '']) {
    assert.ok('error' in normalizeWebOrigin(bad), bad);
  }
});

test('browser flags: the app only, plus approved origins through the proxy; --no-sandbox only under Docker', () => {
  const none = browserFlags({ docker: false, origins: [] });
  for (const flag of ['--headless', '--isolated', '--executablePath=/usr/bin/chromium', '--no-usage-statistics', '--no-performance-crux', '--no-page-id-routing', '--categoryExperimentalWebmcp', '--chromeArg=--enable-features=WebMCP', '--allowedUrlPattern=http://127.0.0.1:5173/*', '--allowedUrlPattern=ws://127.0.0.1:5173/*', '--screenshotFormat=webp', '--screenshotMaxWidth=1024']) assert.ok(none.includes(flag), flag);
  assert.ok(!none.some(f => f.startsWith('--proxyServer')));
  assert.ok(!none.includes('--chromeArg=--no-sandbox'));
  const docker = browserFlags({ docker: true, origins: ['https://cdn.jsdelivr.net'] });
  assert.ok(docker.includes('--chromeArg=--no-sandbox'));
  assert.ok(docker.includes('--proxyServer=http://127.0.0.1:3128'));
  assert.ok(docker.includes('--allowedUrlPattern=https://cdn.jsdelivr.net/*'));
});

test('services container: no network, --init, no capabilities, host UID, memory, labels, the same mounts', () => {
  const request = { image: WEBDEV_IMAGE, mounts: [{ hostPath: '/h/ws', containerPath: '/workspace' }, { hostPath: '/h/p/.git/hooks', containerPath: '/project/.git/hooks', readOnly: true }], labels: { 'ai-sdk-letta.sandbox': '1' }, memory: '3G', cpus: 2 };
  for (const kind of ['docker', 'apple-container'] as const) {
    const args = servicesRunArgs(kind, 'svc', request, { uid: 501, gid: 20 });
    const joined = args.join(' ');
    assert.match(joined, /--init/); assert.match(joined, /--network none/); assert.match(joined, /--cap-drop ALL/); assert.match(joined, /--user 501:20/); assert.match(joined, /--memory 3G/);
    assert.match(joined, /--label ai-sdk-letta\.sandbox=1/); assert.match(joined, /type=bind,src=\/h\/ws,dst=\/workspace/); assert.match(joined, /dst=\/project\/\.git\/hooks,readonly/);
    assert.ok(!args.includes('-p') && !args.includes('--publish') && !args.includes('--publish-socket'), 'nothing is published');
  }
});

/* ------------------------------------------------------------------ */
/* Tunnel                                                              */
/* ------------------------------------------------------------------ */

/** Two muxes wired back to back (host ↔ "container"). */
function pair() {
  const toContainer = new PassThrough(), toHost = new PassThrough();
  const host = new FrameMux(toContainer, toHost);
  const container = new FrameMux(toHost, toContainer);
  return { host, container };
}

test('tunnel: streams in both directions, large chunks, close from either side', async () => {
  const { host, container } = pair();
  const received: Buffer[] = [];
  container.onIncoming = stream => { stream.on('data', (d: Buffer) => { received.push(d); stream.write(Buffer.from(`echo:${d.length}`)); }); };
  const stream = host.connect();
  const replies: string[] = [];
  stream.on('data', (d: Buffer) => replies.push(d.toString()));
  const big = Buffer.alloc(200_000, 7);
  stream.write(big);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(Buffer.concat(received).length, big.length);
  assert.ok(replies.join('').startsWith('echo:'));
  const ended = new Promise(resolve => stream.once('end', resolve));
  for (const s of (container as unknown as { streams: Map<number, Duplex> }).streams.values()) s.end();
  await ended;
  assert.equal(host.size, 0);
  host.close(); container.close();
  assert.throws(() => host.connect(), /tunnel_closed/);
});

test('tunnel script (the container end), run locally: connect mode reaches a port; listen mode opens host streams', async () => {
  const { spawn } = await import('node:child_process');
  const { createServer: netServer, connect: netConnect } = await import('node:net');
  // connect: host → TUNNEL_SCRIPT → a local echo server.
  const echo = netServer(socket => socket.pipe(socket));
  await new Promise<void>(resolve => echo.listen(0, '127.0.0.1', resolve));
  const echoPort = (echo.address() as { port: number }).port;
  // A minimal environment for the stand-in container end.
  const env = { PATH: process.env.PATH ?? '' };
  const connectChild = spawn(process.execPath, ['-e', TUNNEL_SCRIPT, 'connect', String(echoPort)], { stdio: ['pipe', 'pipe', 'ignore'], env });
  const connectMux = FrameMux.of(connectChild);
  const stream = connectMux.connect();
  const echoed = new Promise<string>(resolve => stream.once('data', d => resolve(String(d))));
  stream.write('hello through the tunnel');
  assert.equal(await echoed, 'hello through the tunnel');
  // listen: a client inside ("the container") → TUNNEL_SCRIPT → a stream opened on the host.
  const port = 20000 + Math.floor(Math.random() * 20000);
  const listenChild = spawn(process.execPath, ['-e', TUNNEL_SCRIPT, 'listen', String(port)], { stdio: ['pipe', 'pipe', 'ignore'], env });
  const listenMux = FrameMux.of(listenChild);
  const incoming = new Promise<Duplex>(resolve => { listenMux.onIncoming = s => resolve(s); });
  await new Promise(resolve => setTimeout(resolve, 300));
  const client = netConnect(port, '127.0.0.1');
  client.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n');
  const hostSide = await incoming;
  const first = await new Promise<string>(resolve => hostSide.once('data', d => resolve(String(d))));
  assert.match(first, /^CONNECT example\.com:443/);
  const back = new Promise<string>(resolve => client.once('data', d => resolve(String(d))));
  hostSide.write('HTTP/1.1 403 Forbidden\r\n\r\n');
  assert.match(await back, /403/);
  client.destroy();
  connectChild.kill(); listenChild.kill(); echo.close();
});

test('tunnel: oversized frames close the mux', () => {
  const input = new PassThrough(), output = new PassThrough();
  const mux = new FrameMux(input, output);
  const header = Buffer.alloc(9); header.writeUInt32BE(1, 0); header.writeUInt8(1, 4); header.writeUInt32BE(50 * 1024 * 1024, 5);
  output.write(header);
  assert.equal(mux.open, false);
});

/* ------------------------------------------------------------------ */
/* Egress                                                              */
/* ------------------------------------------------------------------ */

/** A client stream for handleEgress and its peer, plus a fake upstream. */
function egressPair() {
  const { host, container } = pair();
  let server: Duplex | undefined;
  container.onIncoming = s => { server = s; };
  const client = host.connect();
  return { client, server: () => server!, close: () => { host.close(); container.close(); } };
}
const readAll = (stream: Duplex) => new Promise<string>(resolve => { let text = ''; stream.on('data', d => text += d); stream.on('end', () => resolve(text)); stream.on('close', () => resolve(text)); });

test('egress: only CONNECT to an approved https origin; private addresses refused after resolution (pinned)', async () => {
  const cases: { line: string; allowed: string[]; resolve?: string[]; status: RegExp; reason?: string }[] = [
    { line: 'GET http://example.com/ HTTP/1.1', allowed: ['https://example.com'], status: /403/, reason: 'not_https' },
    { line: 'CONNECT evil.com:443 HTTP/1.1', allowed: ['https://example.com'], status: /403/, reason: 'not_approved' },
    { line: 'CONNECT example.com:8443 HTTP/1.1', allowed: ['https://example.com'], status: /403/, reason: 'not_approved' },
    { line: 'CONNECT example.com:443 HTTP/1.1', allowed: ['https://example.com'], resolve: ['10.0.0.5'], status: /403/, reason: 'blocked_address' },
    { line: 'CONNECT example.com:443 HTTP/1.1', allowed: ['https://example.com'], resolve: ['93.184.216.34', '127.0.0.1'], status: /403/, reason: 'blocked_address' },
    { line: 'CONNECT 192.168.1.1:443 HTTP/1.1', allowed: ['https://192.168.1.1'], status: /403/, reason: 'blocked_address' },
  ];
  for (const c of cases) {
    const { client, server, close } = egressPair();
    const decisions: { allowed: boolean; reason?: string }[] = [];
    client.write(`${c.line}\r\nHost: x\r\n\r\n`);
    await new Promise(resolve => setTimeout(resolve, 10));
    const answer = readAll(client);
    await handleEgress(server(), { allowed: origin => c.allowed.includes(origin), resolve: async () => (c.resolve ?? ['93.184.216.34']).map(address => ({ address, family: 4 })), connect: () => { throw new Error('must not connect'); }, onDecision: d => decisions.push(d) });
    assert.match(await answer, c.status, c.line);
    assert.equal(decisions[0]?.reason, c.reason, c.line);
    close();
  }
});

test('egress: an approved origin is connected to the address that was checked, and relayed', async () => {
  const { client, server, close } = egressPair();
  let connectedTo: string | undefined;
  const upstream = new PassThrough() as unknown as Socket & PassThrough;
  const emitter = upstream as unknown as EventEmitter;
  client.write('CONNECT cdn.example.com:443 HTTP/1.1\r\nHost: cdn.example.com:443\r\n\r\nHELLO');
  await new Promise(resolve => setTimeout(resolve, 10));
  const chunks: string[] = [];
  client.on('data', d => chunks.push(String(d)));
  await handleEgress(server(), { allowed: o => o === 'https://cdn.example.com', resolve: async () => [{ address: '93.184.216.34', family: 4 }], connect: (port, address) => { connectedTo = `${address}:${port}`; setImmediate(() => emitter.emit('connect')); return upstream; } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(connectedTo, '93.184.216.34:443');
  assert.match(chunks.join(''), /200 Connection Established/);
  close();
});

test('connectOrigin parses host:port targets', () => {
  assert.deepEqual(connectOrigin('cdn.example.com:443'), { origin: 'https://cdn.example.com', host: 'cdn.example.com', port: 443 });
  assert.equal(connectOrigin('cdn.example.com:8443')!.origin, 'https://cdn.example.com:8443');
  assert.equal(connectOrigin('cdn.example.com'), undefined);
  assert.equal(connectOrigin('a b:443'), undefined);
});

/* ------------------------------------------------------------------ */
/* Services lifecycle, dev server paths, origins                       */
/* ------------------------------------------------------------------ */

/** A fake driver: records starts and stops and the commands run. */
function fakeDriver(options: { folders?: string[]; ready?: string } = {}) {
  const starts: ServicesRequest[] = [];
  const containers: { name: string; stopped: boolean; execs: string[][] }[] = [];
  const driver: ServicesDriver = {
    kind: 'docker',
    async start(request) {
      starts.push(request);
      const record = { name: `svc-${containers.length + 1}`, stopped: false, execs: [] as string[][] };
      containers.push(record);
      const container: ServicesContainer = {
        name: record.name,
        async exec(argv, opts) {
          record.execs.push([...(opts?.cwd ? [`cwd=${opts.cwd}`] : []), ...argv]);
          const script = argv.join(' ');
          if (script.includes('if [ -d "$1" ]')) return { code: 0, stdout: (options.folders ?? []).includes(argv.at(-2)!) ? 'dir\npkg\n' : 'missing\napp/\nnotes.md\n', stderr: '' };
          if (script.includes('curl')) return { code: 0, stdout: `${options.ready ?? 'ready 200'}\n`, stderr: '' };
          if (argv[0] === 'tail') return { code: 0, stdout: '  VITE v7 ready in 300 ms\n', stderr: '' };
          if (script.includes('alive')) return { code: 0, stdout: 'yes\n', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive: argv => ({ command: 'true', args: argv }),
        async stop() { record.stopped = true; },
      };
      return container;
    },
  };
  return { driver, starts, containers };
}

function manager(project = false) {
  const workspace = tmp('webdev-ws');
  return new SandboxManager(resolveSandboxConfig({ provider: async () => { throw new Error('no sandbox in tests'); }, image: WEBDEV_IMAGE }), { workspace: () => workspace, folder: () => 'My chat', owner: 'agent.conv' }) as SandboxManager & { hasProject: boolean } & { project?: unknown };
}

test('services: started lazily on first use, reused, stopped when idle and on close (no leaks)', async () => {
  const { driver, starts, containers } = fakeDriver({ folders: ['/workspace/My chat/app'] });
  let changes = 0;
  const services = new WebDevServices(manager(), resolveWebDevConfig({ idleTimeoutMs: 1000 }), { driver, onChange: () => changes++ });
  assert.equal(starts.length, 0, 'nothing starts before a tool call');
  assert.equal(services.status().container, 'stopped');
  const started = await services.startDevServer({ cwd: 'app', command: 'npx vite --host 127.0.0.1 --port 5173 --strictPort' });
  assert.equal(started.ok, true, started.text);
  assert.match(started.text, /Folder: \/workspace\/My chat\/app/);
  await services.devServerLogs();
  assert.equal(starts.length, 1, 'reused');
  assert.equal(starts[0]!.memory, '3G'.replace('3G', '3G'));
  assert.equal(starts[0]!.labels['ai-sdk-letta.sandbox.role'], 'services');
  assert.equal(services.status().container, 'running');
  assert.equal(services.status().devServer?.folder, '/workspace/My chat/app');
  // Idle: stopped after the timeout.
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(containers[0]!.stopped, true);
  assert.equal(services.status().container, 'stopped');
  assert.equal(services.status().devServer, undefined);
  assert.ok(changes >= 2);
  // A new call starts a new one; close stops it and refuses more.
  await services.devServerLogs();
  assert.equal(starts.length, 1, 'logs never start a container');
  await services.startDevServer({ cwd: 'app', command: 'npm run dev' });
  assert.equal(starts.length, 2);
  await services.close();
  assert.equal(containers[1]!.stopped, true);
  await assert.rejects(services.startDevServer({ cwd: 'app', command: 'x' }), /closed/);
});

test('dev server: cwd resolves like run_command, and a wrong folder names the resolved path and what is there', async () => {
  const { driver, containers } = fakeDriver({ folders: ['/workspace/My chat/app'] });
  const services = new WebDevServices(manager(), resolveWebDevConfig({}), { driver });
  assert.equal(services.resolveFolder(undefined), '/workspace/My chat');
  assert.equal(services.resolveFolder('app'), '/workspace/My chat/app');
  assert.equal(services.resolveFolder('/workspace/Other/app'), '/workspace/Other/app');
  assert.throws(() => services.resolveFolder('../escape'), /cwd_invalid|\.\./);
  assert.throws(() => services.resolveFolder('/etc'), /inside \/workspace/);
  const wrong = await services.startDevServer({ cwd: 'demo', command: 'npm run dev' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.text, /the folder \/workspace\/My chat\/demo does not exist/);
  assert.match(wrong.text, /resolved from this conversation's folder, \/workspace\/My chat/);
  assert.match(wrong.text, /app\//);
  // The dev server runs with polling, marked, in the folder, from an empty environment.
  await services.startDevServer({ cwd: 'app', command: 'npm run dev' });
  const launch = containers[0]!.execs.find(argv => argv[0] === 'env')!;
  assert.ok(launch.includes('CHOKIDAR_USEPOLLING=true') && launch.includes('CHOKIDAR_INTERVAL=300') && launch.includes('AI_SDK_LETTA_DEV_SERVER=1'));
  assert.equal(launch[1], '-i');
  assert.ok(launch.includes('/workspace/My chat/app'));
  await services.close();
});

test('dev server: not answering on 127.0.0.1 is reported and stopped', async () => {
  const { driver, containers } = fakeDriver({ folders: ['/workspace/My chat'], ready: 'timeout 200' });
  const services = new WebDevServices(manager(), resolveWebDevConfig({}), { driver });
  const result = await services.startDevServer({ command: 'npx vite' });
  assert.equal(result.ok, false);
  assert.match(result.text, /answers on \[::1\]:5173 only/);
  assert.ok(containers[0]!.execs.filter(argv => argv.join(' ').includes('kill -KILL')).length >= 2, 'stopped');
  assert.equal(services.status().devServer, undefined);
  await services.close();
});

test('origins: approved per conversation (persisted, browser restarted), revoked (connections closed)', async () => {
  const directory = tmp('webdev-origins');
  const { driver, containers } = fakeDriver({ folders: ['/workspace/My chat'] });
  const launches: string[][] = [];
  let closed = 0;
  const connector: BrowserConnector = async command => { launches.push(command.args); return { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }), close: async () => { closed++; } }; };
  const registry = new WebDevRegistry({ directory, driver, browser: connector });
  const services = registry.attach('agent-1', 'conv-1', manager(), resolveWebDevConfig({}));
  const navigate = BROWSER_TOOL_SPECS.find(s => s.name === 'navigate_page')!;
  await services.callBrowser(navigate, { type: 'url', url: 'http://127.0.0.1:5173/' });
  assert.ok(!launches[0]!.some(f => f.startsWith('--proxyServer')));
  await services.approveOrigin('https://cdn.jsdelivr.net');
  assert.equal(closed, 1, 'browser restarted');
  // The old browser is stopped inside the container too (closing the client only ends the local exec process).
  assert.ok(containers[0]!.execs.some(argv => argv.join(' ').includes('AI_SDK_LETTA_BROWSER=1') && argv.join(' ').includes('kill -KILL')));
  assert.deepEqual(JSON.parse(readFileSync(registry.originsFile('agent-1', 'conv-1'), 'utf8')), { origins: ['https://cdn.jsdelivr.net'] });
  await services.callBrowser(navigate, { type: 'url', url: 'http://127.0.0.1:5173/' });
  assert.ok(launches[1]!.includes('--allowedUrlPattern=https://cdn.jsdelivr.net/*'));
  assert.ok(launches[1]!.includes('--proxyServer=http://127.0.0.1:3128'));
  // Another conversation does not see it.
  assert.deepEqual(registry.status('agent-1', 'conv-2').origins, []);
  // Revoke.
  assert.equal(await registry.revokeOrigin('agent-1', 'conv-1', 'https://cdn.jsdelivr.net'), true);
  assert.deepEqual(services.origins, []);
  assert.equal(closed, 2);
  assert.equal(await registry.revokeOrigin('agent-1', 'conv-1', 'https://cdn.jsdelivr.net'), false);
  await assert.rejects(services.approveOrigin('http://insecure.example.org'), /https/);
  // Saved origins are read back by a new registry (a restart), and can be revoked without starting anything.
  await services.approveOrigin('https://fonts.example.org');
  await registry.close();
  const again = new WebDevRegistry({ directory, driver, browser: connector });
  assert.deepEqual(again.status('agent-1', 'conv-1'), { container: 'stopped', origins: ['https://fonts.example.org'] });
  assert.equal(await again.revokeOrigin('agent-1', 'conv-1', 'https://fonts.example.org'), true);
  assert.deepEqual(again.status('agent-1', 'conv-1').origins, []);
  rmSync(directory, { recursive: true, force: true });
});

test('registry: services outlive a session (rebound to the new sandbox) and all stop on close', async () => {
  const { driver, containers } = fakeDriver({ folders: ['/workspace/My chat'] });
  const registry = new WebDevRegistry({ directory: tmp('webdev-reg'), driver });
  const first = registry.attach('a', 'c', manager(), resolveWebDevConfig({}));
  await first.startDevServer({ command: 'npm run dev' });
  const second = manager();
  const again = registry.attach('a', 'c', second, resolveWebDevConfig({}));
  assert.equal(again, first);
  assert.equal(again.sandbox, second);
  assert.equal(registry.active, 1);
  await registry.close();
  assert.equal(containers[0]!.stopped, true);
  assert.equal(registry.active, 0);
});

test('allow_web_origin asks with the origin and reason, refuses bad origins without asking, and approves through the bridge', async () => {
  const { driver } = fakeDriver();
  const services = new WebDevServices(manager(), resolveWebDevConfig({}), { driver, browser: async () => ({ callTool: async () => ({ content: [] }), close: async () => {} }) });
  const broker = new ToolInteractions();
  const asked: unknown[] = [];
  broker.connect(async request => { asked.push(request); return { id: request.id, approved: true }; });
  const bridge = createToolBridge({ tools: { allow_web_origin: webDevTools.allow_web_origin! }, permissions: { allow_web_origin: 'ask' }, interactions: broker, context: () => ({ [WEBDEV_CONTEXT]: services }), timeoutMs: 10_000 });
  const bad = await bridge.execute('allow_web_origin', 'c1', { origin: 'http://cdn.example.com', reason: 'lib' });
  assert.match(JSON.stringify(bad.content), /Only https/);
  assert.equal(asked.length, 0);
  const ok = await bridge.execute('allow_web_origin', 'c2', { origin: 'https://cdn.jsdelivr.net', reason: 'Chart.js' });
  assert.equal(ok.isError, false, JSON.stringify(ok));
  assert.equal(asked.length, 1);
  assert.match(JSON.stringify(asked[0]), /web-origin/);
  assert.match(JSON.stringify(asked[0]), /Chart\.js/);
  assert.deepEqual(services.origins, ['https://cdn.jsdelivr.net']);
  await services.close();
});

test('tools without services (no sandbox) answer sandbox_unavailable', async () => {
  const output = await (webDevTools.dev_server_start!.execute as (input: unknown, options: unknown) => Promise<{ text: string; isError?: boolean }>)({ command: 'npm run dev' }, { toolCallId: 'x', messages: [], context: {} });
  assert.equal(output.isError, true);
  assert.match(output.text, /sandbox_unavailable/);
});

test('the preview tunnel is only available while the container runs', async () => {
  const { driver } = fakeDriver({ folders: ['/workspace/My chat'] });
  const services = new WebDevServices(manager(), resolveWebDevConfig({}), { driver });
  assert.equal(services.connectPreview(), undefined);
  await services.close();
});

// Keep the imports used in type positions.
void createServer; void httpRequest;

test('dev apps: STATE_DIR=/workspace/.app-state/<name>, created before the server starts (stdio and http)', async () => {
  const { driver, containers } = fakeDriver({ folders: ['/workspace/My chat/notes'] });
  const services = new WebDevServices(manager(), resolveWebDevConfig({}), { driver });
  try {
    const line = await services.devAppLine('notes', { cwd: 'notes', command: 'node server.js' });
    assert.ok(line.ok);
    assert.equal(line.stateDir, '/workspace/.app-state/notes');
    assert.ok(line.line.args.includes('STATE_DIR=/workspace/.app-state/notes'), line.line.args.join(' '));
    const execs = containers[0]!.execs.map(argv => argv.join(' '));
    const mkdir = execs.findIndex(e => e === 'mkdir -p /workspace/.app-state/notes');
    assert.ok(mkdir >= 0, 'created first');
    // HTTP: the detached server gets the same STATE_DIR (here it never listens: the fake has no port).
    await services.devAppHttpStart('notes', { cwd: 'notes', command: 'node server.js', port: 3000, path: '/mcp' });
    const started = containers[0]!.execs.find(argv => argv[0] === 'env' && argv.includes('PORT=3000'));
    assert.ok(started?.includes('STATE_DIR=/workspace/.app-state/notes'), started?.join(' '));
    const all = containers[0]!.execs.map(argv => argv.join(' '));
    assert.ok(all.lastIndexOf('mkdir -p /workspace/.app-state/notes') < all.findIndex(e => e.startsWith('env ') && e.includes('PORT=3000')));
  } finally { await services.close(); }
});
