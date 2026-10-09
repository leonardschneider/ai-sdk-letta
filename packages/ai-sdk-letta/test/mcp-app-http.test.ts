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
