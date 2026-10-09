import { spawn, type ChildProcess } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { Agent, fetch as undiciFetch } from 'undici';
import { FrameMux } from './webdev-tunnel.js';

/**
 * Streamable HTTP for MCP App servers that listen inside a container without
 * network: a `fetch` whose every connection is a byte stream of a tunnel
 * (`FrameMux.connect()`, see `webdev-tunnel.ts`) to `127.0.0.1:<port>` in
 * the container. Nothing listens on the host and no port is published. The
 * host part of the URL is only what the server sees in `Host`.
 *
 * @module
 */

/** An MCP App server reachable over Streamable HTTP (the URL as the server sees it, and the fetch that reaches it). */
export interface McpAppHttpEndpoint {
  readonly kind: 'http';
  /** For example `http://127.0.0.1:3000/mcp`. */
  readonly url: string;
  /** Reaches the server (through a tunnel). */
  readonly fetch: typeof globalThis.fetch;
  /** Calls `listener` once when the way to the server is gone (the tunnel closed). Returns an unsubscribe function. */
  onClosed?(listener: () => void): () => void;
}

/** Bounds of a tunnel fetch. */
export const MCP_APP_HTTP_LIMITS = Object.freeze({
  /** Connections at once (each one is a tunnel stream). */
  connections: 8,
  /** Time until the response headers arrive (tool calls are bounded separately). */
  headersTimeoutMs: 120_000,
  /** Longest silence within a response body (SSE streams send keep-alives). */
  bodyTimeoutMs: 600_000,
  keepAliveTimeoutMs: 10_000,
});

/** A `fetch` over connections made by `connect` (a tunnel stream each), and how to close them all. Plain `http:` URLs only. */
export function tunnelFetch(connect: () => Duplex): { fetch: typeof globalThis.fetch; close(): Promise<void> } {
  const agent = new Agent({
    connections: MCP_APP_HTTP_LIMITS.connections,
    pipelining: 1,
    headersTimeout: MCP_APP_HTTP_LIMITS.headersTimeoutMs,
    bodyTimeout: MCP_APP_HTTP_LIMITS.bodyTimeoutMs,
    keepAliveTimeout: MCP_APP_HTTP_LIMITS.keepAliveTimeoutMs,
    connect: (_options, callback) => {
      let stream: Duplex;
      try { stream = connect(); } catch (error) { callback(error instanceof Error ? error : new Error('tunnel_closed'), null); return; }
      // Asynchronously, as a real connect (undici sets its state after calling the connector).
      process.nextTick(() => callback(null, stream as never));
    },
  });
  let closed = false;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (closed) throw new TypeError('fetch failed', { cause: new Error('tunnel_closed') });
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:') throw new TypeError(`Only http: URLs go through the tunnel (got ${url.protocol})`);
    return await undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never) as unknown as Response;
  }) as typeof globalThis.fetch;
  return { fetch, close: async () => { if (closed) return; closed = true; await agent.destroy().catch(() => {}); } };
}

/**
 * Inside a container (Node, no dependencies): `free <port>` prints `free` or
 * `busy` (does something accept connections on `127.0.0.1:<port>`?);
 * `wait <port> <seconds> <mark>` waits until it does and prints `ready`, or
 * `exited` when no process whose environment has `<mark>` (`KEY=value`) is
 * left, or `timeout`.
 */
export const PORT_WAIT_SCRIPT = `const net=require('net'),fs=require('fs');const [mode,p,secs,mark]=process.argv.slice(1);const port=Number(p);const end=Date.now()+Number(secs||0)*1000;
const alive=()=>{if(!mark)return true;for(const d of fs.readdirSync('/proc')){if(!/^[0-9]+$/.test(d)||d===String(process.pid))continue;try{if(fs.readFileSync('/proc/'+d+'/environ','latin1').split('\\0').includes(mark))return true;}catch{}}return false;};
const once=()=>{const s=net.connect(port,'127.0.0.1');s.setTimeout(2000,()=>s.destroy(new Error('t')));s.once('connect',()=>{s.destroy();console.log(mode==='free'?'busy':'ready');process.exit(0);});s.once('error',()=>{s.destroy();if(mode==='free'){console.log('free');process.exit(0);}if(!alive()){console.log('exited');process.exit(0);}if(Date.now()>end){console.log('timeout');process.exit(0);}setTimeout(once,300);});};once();`;

/** Ports a Streamable HTTP MCP App server may not use, and why. */
export const RESERVED_HTTP_PORTS: Readonly<Record<number, string>> = Object.freeze({ 5173: 'the dev server', 3128: 'the egress proxy' });

/**
 * A Streamable HTTP endpoint over a `connect <port>` tunnel process (`line`
 * runs `node -e TUNNEL_SCRIPT connect <port>` inside the container): one
 * {@link FrameMux} and one bounded {@link tunnelFetch}. `close()` ends both
 * and kills the process.
 */
export function openHttpTunnel(line: { command: string; args: string[] }, url: string, spawner: typeof spawn = spawn): { endpoint: McpAppHttpEndpoint; mux: FrameMux; close(): Promise<void> } {
  const child: ChildProcess = spawner(line.command, line.args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const mux = FrameMux.of(child);
  const tunnel = tunnelFetch(() => mux.connect());
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { mux.close(); child.kill('SIGKILL'); await tunnel.close(); })();
  mux.onClose(() => { void close(); });
  return { endpoint: { kind: 'http', url, fetch: tunnel.fetch, onClosed: listener => mux.onClose(listener) }, mux, close };
}
