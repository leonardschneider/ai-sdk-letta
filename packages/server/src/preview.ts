import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WEBDEV_PORT } from 'ai-sdk-letta';

/**
 * Live previews of web apps the agent develops (see `webDevTools`).
 *
 * A second loopback listener, never the app's origin: it answers only
 * `Host: p-<token>.localhost:<port>`, where the token (128 random bits, one
 * per conversation, new on every start) names the conversation. Each
 * preview is therefore its own origin and its own site, away from the app
 * (`127.0.0.1:<port>`) and from other conversations' previews: a page in
 * the preview cannot read the app's API with the person's session, nor
 * another conversation's preview.
 *
 * Requests go to the dev server through the conversation's tunnel (no port
 * is published): `Cookie`, `Authorization` and forwarding headers are
 * removed, `Host` (and `Origin`) are rewritten to the dev server's, and
 * responses get {@link previewCsp} (only the preview itself and origins
 * approved in that conversation; framed only by the app). WebSocket
 * upgrades (HMR) are relayed the same way.
 *
 * @module
 */

/** What the preview server needs from the runtime. */
export interface PreviewTarget {
  /** A byte stream to the dev server, or undefined when none runs. */
  connect(): Duplex | undefined;
  /** Origins approved in the conversation (added to the CSP). */
  origins: readonly string[];
}

/** One token per conversation (thread), random on every start. */
export class PreviewTokens {
  private readonly byThread = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  /** The token of a thread (created on first use). */
  tokenOf(threadId: string): string {
    let token = this.byThread.get(threadId);
    if (!token) { token = randomBytes(16).toString('hex'); this.byThread.set(threadId, token); this.byToken.set(token, threadId); }
    return token;
  }
  /** The thread of a token, if any. */
  threadOf(token: string): string | undefined { return this.byToken.get(token); }
}

/** `p-<token>` of a Host header on this port, or undefined (anything else is refused). */
export function previewToken(host: string | undefined, port: number): string | undefined {
  const match = /^p-([a-f0-9]{32})\.localhost:(\d{1,5})$/.exec(String(host ?? '').toLowerCase());
  return match && Number(match[2]) === port ? match[1] : undefined;
}

/** `s-<token>` of a Host header on this port (an MCP App view instance), or undefined. */
export function sandboxToken(host: string | undefined, port: number): string | undefined {
  const match = /^s-([a-f0-9]{32})\.localhost:(\d{1,5})$/.exec(String(host ?? '').toLowerCase());
  return match && Number(match[2]) === port ? match[1] : undefined;
}

/** The origin of a conversation's preview. */
export const previewOrigin = (token: string, port: number) => `http://p-${token}.localhost:${port}`;

/**
 * Content-Security-Policy of a preview: its own origin (the dev server), the
 * HMR WebSocket, and origins approved in the conversation; inline and eval
 * scripts (dev servers need them); no plugins, forms only to itself, framed
 * only by the app (`frameAncestors`).
 */
export function previewCsp(origin: string, approved: readonly string[], frameAncestors: readonly string[]): string {
  const extra = approved.length ? ` ${approved.join(' ')}` : '';
  return [
    `default-src 'self' data: blob:${extra}`,
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:${extra}`,
    `style-src 'self' 'unsafe-inline'${extra}`,
    `img-src 'self' data: blob:${extra}`,
    `font-src 'self' data:${extra}`,
    `connect-src 'self' ${origin.replace(/^http:/, 'ws:')}${extra}`,
    `media-src 'self' data: blob:${extra}`,
    `worker-src 'self' blob:`,
    `frame-src 'self'`,
    `form-action 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors ${frameAncestors.length ? frameAncestors.join(' ') : "'none'"}`,
  ].join('; ');
}

/** Request headers never sent to the dev server. */
const STRIPPED = ['cookie', 'authorization', 'proxy-authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'tailscale-app-capabilities'];
/** The headers sent to the dev server: credentials removed, Host and Origin its own. */
export function upstreamHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) if (value !== undefined && !STRIPPED.includes(key.toLowerCase())) out[key] = value;
  out.host = `127.0.0.1:${WEBDEV_PORT}`;
  if (typeof out.origin === 'string' && out.origin !== 'null') out.origin = `http://127.0.0.1:${WEBDEV_PORT}`;
  if (typeof out.referer === 'string') delete out.referer;
  return out;
}
/** Response headers from the dev server that the preview replaces or drops. */
const DROPPED_RESPONSE = ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'set-cookie', 'strict-transport-security', 'access-control-allow-origin', 'access-control-allow-credentials'];

/** Options of {@link startPreviewServer}. */
export interface PreviewServerOptions {
  /** Loopback port; `0` picks a free one. */
  port: number;
  /** The conversation of a token (undefined: unknown token, 404); its `connect()` is undefined while no dev server runs (503). */
  resolve(token: string): PreviewTarget | undefined;
  /** Origins allowed to frame previews (the app's). */
  frameAncestors(): readonly string[];
  /** Also listen on `::1` (browsers may resolve `*.localhost` there first). @default true */
  ipv6?: boolean;
  /**
   * MCP App views (see `AppGate`): what `s-<token>.localhost` serves, once
   * per token (the sandbox proxy page and its CSP). Without it, such hosts
   * get 404 like any unknown host.
   */
  sandbox?(token: string): { status: 200; html: string; csp: string } | { status: 404 | 410 };
}

const page = (res: ServerResponse, status: number, title: string, text: string) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors *" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${title}</title><body style="font:14px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;color:#777"><p style="max-width:28em;text-align:center">${text}</p>`);
};

/** The request handler of the preview listener (exported for tests). */
export function previewHandler(options: Omit<PreviewServerOptions, 'ipv6'>, port: () => number) {
  // Relayed WebSockets (HMR) are no longer HTTP connections: tracked here so closing the listener ends them.
  const relayed = new Set<Duplex>();
  const route = (req: IncomingMessage) => { const token = previewToken(req.headers.host, port()); return token ? { token, target: options.resolve(token) } : undefined; };
  const http = (req: IncomingMessage, res: ServerResponse) => {
    // MCP App views: their own origin per instance, served once, only the sandbox proxy page (GET /).
    const app = options.sandbox ? sandboxToken(req.headers.host, port()) : undefined;
    if (app) {
      const strict = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' };
      if (req.method !== 'GET' || (req.url ?? '/') !== '/') { res.writeHead(404, strict); res.end('Not found'); return; }
      const page = options.sandbox!(app);
      if (page.status !== 200) { res.writeHead(page.status, strict); res.end(page.status === 410 ? 'Gone' : 'Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': page.csp, 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), payment=(), display-capture=()' });
      res.end(page.html);
      return;
    }
    const found = route(req);
    if (!found?.target) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Not found'); return; }
    const target = found.target;
    const stream = target.connect();
    if (!stream) { page(res, 503, 'No dev server', 'No dev server is running in this conversation. Ask the agent to start it.'); return; }
    const origin = previewOrigin(found.token, port());
    // One tunnel stream per request (no keep-alive pool): the request goes over exactly this stream.
    const upstream = httpRequest({ method: req.method, path: req.url, headers: { ...upstreamHeaders(req.headers), connection: 'close' }, createConnection: () => stream as never }, response => {
      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && !DROPPED_RESPONSE.includes(key.toLowerCase())) headers[key] = value;
      headers['content-security-policy'] = previewCsp(origin, target.origins, options.frameAncestors());
      headers['referrer-policy'] = 'no-referrer';
      headers['x-content-type-options'] = 'nosniff';
      headers['cross-origin-opener-policy'] = 'same-origin';
      res.writeHead(response.statusCode ?? 502, headers);
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) page(res, 502, 'Dev server unavailable', 'The dev server did not answer. It may still be starting, or it stopped; check with the agent.'); else res.destroy(); stream.destroy(); });
    req.pipe(upstream);
    res.on('close', () => { if (!res.writableFinished) { upstream.destroy(); stream.destroy(); } });
  };
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (options.sandbox && sandboxToken(req.headers.host, port())) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const found = route(req);
    const stream = found?.target?.connect();
    if (!found || !stream) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const headers = upstreamHeaders(req.headers);
    const lines = Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(v => `${key}: ${String(v).replace(/[\r\n]/g, '')}`));
    stream.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) stream.write(head);
    stream.pipe(socket); socket.pipe(stream);
    relayed.add(socket); relayed.add(stream);
    const end = () => { stream.destroy(); socket.destroy(); };
    stream.on('error', end); socket.on('error', end);
    stream.on('close', () => { relayed.delete(stream); socket.destroy(); });
    socket.on('close', () => { relayed.delete(socket); stream.destroy(); });
  };
  /** End every relayed WebSocket. */
  const closeRelayed = () => { for (const s of relayed) s.destroy(); relayed.clear(); };
  return { http, upgrade, closeRelayed };
}

/** A running preview listener. */
export interface PreviewServer { port: number; close(): void }

/** Start the preview listener on loopback (127.0.0.1, and ::1 on the same port when possible). */
export async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
  let bound = options.port;
  const handler = previewHandler(options, () => bound);
  const servers: Server[] = [];
  const make = () => { const server = createServer(handler.http); server.on('upgrade', handler.upgrade); server.on('clientError', (_error, socket) => socket.destroy()); servers.push(server); return server; };
  const listen = (server: Server, port: number, host: string) => new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); const address = server.address(); resolve(typeof address === 'object' && address ? address.port : port); });
  });
  bound = await listen(make(), options.port, '127.0.0.1');
  if (options.ipv6 !== false) { try { await listen(make(), bound, '::1'); } catch { servers.pop()?.close(); } }
  return { port: bound, close: () => { for (const server of servers) { server.close(); server.closeAllConnections?.(); } handler.closeRelayed(); } };
}
