import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FrameMux, TUNNEL_SCRIPT } from '../src/webdev-tunnel.js';
import { tunnelFetch } from '../src/mcp-app-http.js';

/** A local HTTP server, and the tunnel's container end (`node -e TUNNEL_SCRIPT connect <port>`) as a local process. */
async function setup(handler: Parameters<typeof createServer>[1]) {
  const server: Server = createServer(handler);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const child = spawn(process.execPath, ['-e', TUNNEL_SCRIPT, 'connect', String(port)], { stdio: ['pipe', 'pipe', 'ignore'] });
  const mux = FrameMux.of(child);
  const tunnel = tunnelFetch(() => mux.connect());
  const done = async () => { await tunnel.close(); mux.close(); child.kill('SIGKILL'); server.closeAllConnections(); await new Promise(d => server.close(d)); };
  return { port, mux, child, tunnel, done };
}

test('tunnel fetch: JSON POST and an SSE stream, through a FrameMux', async () => {
  const seen: string[] = [];
  const { port, tunnel, done } = await setup((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${req.headers.host} ${body}`);
      if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 50);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: body }));
    });
  });
  try {
    const response = await tunnel.fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { echo: '{"a":1}' });
    const sse = await tunnel.fetch(`http://127.0.0.1:${port}/sse`, { method: 'POST', body: 'x' });
    assert.equal(sse.headers.get('content-type'), 'text/event-stream');
    const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    const chunks: string[] = [];
    for (;;) { const { done: end, value } = await reader.read(); if (end) break; chunks.push(value); text += value; }
    assert.equal(text, 'data: one\n\ndata: two\n\n');
    assert.ok(chunks.length >= 2, 'the events arrive as they are written (streamed)');
    assert.match(seen[0]!, /^POST \/mcp 127\.0\.0\.1:\d+ \{"a":1\}$/);
  } finally { await done(); }
});

test('tunnel fetch: refused after close, and when the tunnel is gone; https refused', async () => {
  const { port, tunnel, mux, done } = await setup((_req, res) => { res.end('ok'); });
  try {
    await assert.rejects(tunnel.fetch(`https://127.0.0.1:${port}/`), /Only http/);
    mux.close();
    await assert.rejects(tunnel.fetch(`http://127.0.0.1:${port}/`));
    await tunnel.close();
    await assert.rejects(tunnel.fetch(`http://127.0.0.1:${port}/`), /fetch failed/);
  } finally { await done(); }
});

/* ---------------- connector, config, dev apps over HTTP ---------------- */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_APPS_CONTEXT, McpApps, SandboxManager, WEBDEV_CONTEXT, WEBDEV_IMAGE, WebDevServices, mcpAppConnector, mcpAppDevTools, resolveMcpApps, resolveSandboxConfig, resolveWebDevConfig,
  type CommandLine, type McpAppClient, type McpAppConnector, type McpAppHttpEndpoint, type ServicesContainer, type ServicesDriver,
} from '../src/index.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `ai-sdk-letta-${prefix}-`));

test('connector: an http target goes through its fetch (Streamable HTTP POST to the URL)', async () => {
  const requests: { url: string; method?: string; accept?: string | null }[] = [];
  const endpoint: McpAppHttpEndpoint = {
    kind: 'http', url: 'http://127.0.0.1:3000/mcp',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init?.method ? { method: init.method } : {}), accept: new Headers(init?.headers).get('accept') });
      return new Response('nope', { status: 500 });
    }) as typeof fetch,
  };
  await assert.rejects(mcpAppConnector(endpoint, () => {}));
  assert.ok(requests.length >= 1);
  assert.equal(requests[0]!.url, 'http://127.0.0.1:3000/mcp');
  assert.equal(requests[0]!.method, 'POST');
  assert.match(requests[0]!.accept ?? '', /text\/event-stream/);
});

test('config: transport "http" with port and endpoint; defaults; refusals', () => {
  const [plain, http, custom] = resolveMcpApps([
    { id: 'a', command: ['node', 'a.js'] },
    { id: 'b', command: ['node', 'b.js'], transport: 'http' },
    { id: 'c', command: ['python', 'c.py'], transport: 'http', port: 8000, endpoint: '/mcp/' },
  ]);
  assert.equal(plain!.http, undefined);
  assert.deepEqual(http!.http, { port: 3000, path: '/mcp' });
  assert.deepEqual(custom!.http, { port: 8000, path: '/mcp/' });
  assert.throws(() => resolveMcpApps([{ id: 'a', command: ['x'], transport: 'sse' }]), /transport must be "stdio" or "http"/);
  assert.throws(() => resolveMcpApps([{ id: 'a', command: ['x'], transport: 'http', port: 3128 }]), /port must be/);
  assert.throws(() => resolveMcpApps([{ id: 'a', command: ['x'], transport: 'http', port: 80 }]), /port must be/);
  assert.throws(() => resolveMcpApps([{ id: 'a', command: ['x'], transport: 'http', endpoint: 'mcp' }]), /endpoint must be/);
  assert.throws(() => resolveMcpApps([{ id: 'a', command: ['x'], transport: 'http', endpoint: '/mcp?x=1' }]), /endpoint must be/);
  assert.throws(() => resolveMcpApps([{ id: 'a', command: ['x'], port: 3000 }]), /need transport "http"/);
});

/**
 * A fake services container whose `interactive` lines run locally (so the
 * `connect <port>` tunnel reaches a local HTTP server) and whose readiness
 * check answers what the test says.
 */
function httpSetup(options: { ready?: string; busy?: boolean } = {}) {
  const execs: string[][] = [];
  const driver: ServicesDriver = {
    kind: 'docker',
    async start() {
      const container: ServicesContainer = {
        name: 'svc-1',
        async exec(argv, opts) {
          execs.push(opts?.detach ? ['(detach)', ...argv] : argv);
          if (argv.join(' ').includes('if [ -d "$1" ]')) return { code: 0, stdout: argv.at(-2) === '/workspace/Chat/notes' ? 'dir\n' : 'missing\n', stderr: '' };
          if (argv[0] === 'node' && argv[3] === 'free') return { code: 0, stdout: options.busy ? 'busy\n' : 'free\n', stderr: '' };
          if (argv[0] === 'node' && argv[3] === 'wait') return { code: 0, stdout: `${options.ready ?? 'ready'}\n`, stderr: '' };
          if (argv[0] === 'tail') return { code: 0, stdout: 'Error: listen EADDRINUSE\n', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive: (argv): CommandLine => ({ command: argv[0] === 'node' ? process.execPath : argv[0]!, args: argv.slice(1) }),
        async stop() {},
      };
      return container;
    },
  };
  const workspace = tmp('mcphttp-ws');
  const manager = new SandboxManager(resolveSandboxConfig({ provider: async () => { throw new Error('no sandbox'); }, image: WEBDEV_IMAGE }), { workspace: () => workspace, folder: () => 'Chat', owner: 'agent.conv' });
  const services = new WebDevServices(manager, resolveWebDevConfig({}), { driver });
  const targets: unknown[] = [];
  const answers: string[] = [];
  // The fake client fetches through the endpoint (the tunnel) once per connect.
  const connector: McpAppConnector = async target => {
    targets.push(target);
    if ((target as McpAppHttpEndpoint).kind === 'http') answers.push(await (await (target as McpAppHttpEndpoint).fetch((target as McpAppHttpEndpoint).url, { method: 'POST', body: '{}' })).text());
    const client: McpAppClient = { serverInfo: { name: 'notes' }, listTools: async () => ({ tools: [{ name: 'show', inputSchema: { type: 'object' } }] }), callTool: async () => ({ content: [] }), readResource: async () => ({ contents: [] }), listResources: async () => ({ resources: [] }), close: async () => {} };
    return client;
  };
  const apps = new McpApps([], { directory: join(tmp('mcphttp-state'), 'apps'), connector });
  const context = { [WEBDEV_CONTEXT]: services, [MCP_APPS_CONTEXT]: { apps, conversationId: 'conv-a' } };
  const run = async (input: Record<string, unknown>, name: keyof typeof mcpAppDevTools = 'app_dev_start') => await mcpAppDevTools[name].execute!(input as never, { toolCallId: 'c', messages: [], context } as never) as { text: string; isError?: boolean };
  return { services, apps, execs, targets, answers, run };
}

test('dev start over http (the default): detached with PORT/HOST, readiness, tunnel to the port; stop closes the tunnel', async () => {
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end(`hello ${req.method} ${req.url}`); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const { services, apps, execs, targets, answers, run } = httpSetup();
  try {
    const started = await run({ name: 'notes', cwd: 'notes', command: 'node server.js', port });
    assert.equal(started.isError, undefined, started.text);
    assert.match(started.text, new RegExp(`Streamable HTTP at http://127\\.0\\.0\\.1:${port}/mcp`));
    const detached = execs.find(argv => argv[0] === '(detach)')!;
    assert.ok(detached.includes(`PORT=${port}`) && detached.includes('HOST=127.0.0.1') && detached.includes('AI_SDK_LETTA_DEV_APP=notes'));
    assert.ok(detached.includes('/tmp/devapp-notes.log'));
    assert.ok(execs.some(argv => argv[0] === 'node' && argv[3] === 'wait' && argv[4] === String(port)));
    assert.equal((targets[0] as McpAppHttpEndpoint).kind, 'http');
    assert.equal(answers[0], 'hello POST /mcp');
    assert.equal(services.devAppPort('notes'), port);
    assert.equal(apps.status().find(s => s.id === 'dev_notes')?.status, 'running');
    // Reload: a new server start and a new tunnel.
    const reloaded = await run({ name: 'notes' }, 'app_dev_reload');
    assert.equal(reloaded.isError, undefined, reloaded.text);
    assert.equal(answers.length, 2);
    const endpoint = targets[1] as McpAppHttpEndpoint;
    const stopped = await run({ name: 'notes' }, 'app_dev_stop');
    assert.match(stopped.text, /stopped/);
    assert.equal(services.devAppPort('notes'), undefined);
    await assert.rejects(endpoint.fetch(endpoint.url), /fetch failed/);
  } finally { await services.close(); server.closeAllConnections(); await new Promise(d => server.close(d)); }
});

test('dev start over http: reserved ports, a port another dev app uses, a busy port, a server that never listens', async () => {
  const { services, run } = httpSetup();
  assert.match((await run({ name: 'notes', cwd: 'notes', command: 'x', port: 5173 })).text, /port 5173 is used by the dev server/);
  assert.match((await run({ name: 'notes', cwd: 'notes', command: 'x', port: 3128 })).text, /port 3128 is used by the egress proxy/);
  assert.match((await run({ name: 'notes', cwd: 'notes', command: 'x', path: 'mcp' })).text, /path must be/);
  assert.match((await run({ name: 'notes', cwd: 'notes', command: 'x', transport: 'stdio', port: 3000 })).text, /port and path are for transport "http"/);
  // A second dev app on the same port.
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal((await run({ name: 'notes', cwd: 'notes', command: 'x', port })).isError, undefined);
    const clash = await run({ name: 'other', cwd: 'notes', command: 'x', port });
    assert.equal(clash.isError, true);
    assert.match(clash.text, new RegExp(`the dev app "notes" uses port ${port}`));
  } finally { await services.close(); server.closeAllConnections(); await new Promise(d => server.close(d)); }
  const busy = httpSetup({ busy: true });
  const refused = await busy.run({ name: 'notes', cwd: 'notes', command: 'x' });
  assert.match(refused.text, /something already listens on 127\.0\.0\.1:3000/);
  assert.ok(!busy.execs.some(argv => argv[0] === '(detach)'), 'nothing started');
  await busy.services.close();
  const slow = httpSetup({ ready: 'timeout' });
  const timedOut = await slow.run({ name: 'notes', cwd: 'notes', command: 'x' });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.text, /nothing accepted connections on 127\.0\.0\.1:3000/);
  assert.match(timedOut.text, /EADDRINUSE/);
  await slow.services.close();
});
