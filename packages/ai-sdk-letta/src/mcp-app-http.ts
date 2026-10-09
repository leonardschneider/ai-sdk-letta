import type { Duplex } from 'node:stream';
import { Agent, fetch as undiciFetch } from 'undici';

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
