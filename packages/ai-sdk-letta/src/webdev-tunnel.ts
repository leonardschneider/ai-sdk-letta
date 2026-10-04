import type { ChildProcess } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, connect as netConnect, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { isBlockedAddress } from './web-fetch.js';

/**
 * Byte tunnels between this process and the web development services
 * container, which has no network at all. Every connection is multiplexed
 * over the stdin and stdout of one `<cli> exec -i <container> node -e
 * TUNNEL_SCRIPT ...` process, as frames `[u32 id][u8 type][u32 length][data]`
 * (type 0 open, 1 data, 2 close). Nothing listens on the host.
 *
 * - `connect <port>`: the host opens connections; each one is connected to
 *   `127.0.0.1:<port>` inside the container (the preview reaches the dev server).
 * - `listen <port>`: the container's `127.0.0.1:<port>` accepts connections
 *   and each one is opened on the host (the headless browser's HTTPS proxy
 *   reaches {@link handleEgress}, which only lets approved origins through).
 *
 * @module
 */

/** Frame types. */
const OPEN = 0, DATA = 1, CLOSE = 2;
/** Largest frame accepted (a sane bound; socket chunks are at most 64 KB). */
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * The tunnel's end inside the container (Node, no dependencies). Its
 * arguments: `connect <port>` or `listen <port>`. It exits when stdin closes.
 */
export const TUNNEL_SCRIPT = `const net=require('net');const [mode,p]=process.argv.slice(1);const port=Number(p);const conns=new Map();let next=1;
const frame=(id,t,d=Buffer.alloc(0))=>{const h=Buffer.alloc(9);h.writeUInt32BE(id,0);h.writeUInt8(t,4);h.writeUInt32BE(d.length,5);process.stdout.write(Buffer.concat([h,d]));};
const wire=(id,s)=>{conns.set(id,s);s.on('data',d=>frame(id,1,d));s.on('close',()=>{if(conns.delete(id))frame(id,2);});s.on('error',()=>{});};
if(mode==='listen')net.createServer(s=>{const id=next++;frame(id,0);wire(id,s);}).listen(port,'127.0.0.1');
let buf=Buffer.alloc(0);process.stdin.on('data',d=>{buf=Buffer.concat([buf,d]);while(buf.length>=9){const len=buf.readUInt32BE(5);if(buf.length<9+len)break;const id=buf.readUInt32BE(0),t=buf.readUInt8(4),data=buf.subarray(9,9+len);buf=buf.subarray(9+len);
if(t===0&&mode==='connect')wire(id,net.connect(port,'127.0.0.1'));else if(t===1)conns.get(id)?.write(data);else if(t===2){const s=conns.get(id);conns.delete(id);s?.end();}}});
process.stdin.on('end',()=>process.exit(0));`;

/** A Duplex with the socket methods HTTP clients call (no-ops here). */
export type TunnelStream = Duplex & { setTimeout(ms: number, cb?: () => void): TunnelStream; setNoDelay(): TunnelStream; setKeepAlive(): TunnelStream; ref(): TunnelStream; unref(): TunnelStream };

/**
 * The host's end of a tunnel: frames over a child's stdio. `open()` starts a
 * connection from the host; `onIncoming` receives connections the container
 * starts. Closing the mux ends every stream.
 */
export class FrameMux {
  private readonly streams = new Map<number, TunnelStream>();
  private next = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;
  private readonly closeListeners = new Set<() => void>();
  /** Connections the container opened (`listen` mode). */
  onIncoming?: (stream: TunnelStream) => void;

  constructor(private readonly input: NodeJS.WritableStream, output: NodeJS.ReadableStream) {
    output.on('data', (chunk: Buffer) => this.receive(chunk));
    output.on('end', () => this.close());
    output.on('error', () => this.close());
    input.on('error', () => this.close());
  }
  /** A mux over a spawned `exec -i` process; closes with it. */
  static of(child: ChildProcess): FrameMux {
    const mux = new FrameMux(child.stdin!, child.stdout!);
    child.once('exit', () => mux.close());
    child.once('error', () => mux.close());
    return mux;
  }
  get open(): boolean { return !this.closed; }
  /** Called once when the mux closes. */
  onClose(listener: () => void): () => void { if (this.closed) { listener(); return () => {}; } this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  /** Number of open streams. */
  get size(): number { return this.streams.size; }

  private send(id: number, type: number, data: Buffer = Buffer.alloc(0)) {
    if (this.closed) return;
    for (let offset = 0; offset < data.length || offset === 0; offset += 64 * 1024) {
      const part = data.subarray(offset, offset + 64 * 1024);
      const header = Buffer.alloc(9);
      header.writeUInt32BE(id, 0); header.writeUInt8(type, 4); header.writeUInt32BE(part.length, 5);
      this.input.write(Buffer.concat([header, part]));
      if (!data.length) break;
    }
  }
  private stream(id: number): TunnelStream {
    let ended = false;
    const mux = this;
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) { mux.send(id, DATA, Buffer.from(chunk)); callback(); },
      final(callback) { if (!ended) { ended = true; mux.send(id, CLOSE); } callback(); },
      destroy(error, callback) { if (mux.streams.delete(id) && !ended) { ended = true; mux.send(id, CLOSE); } callback(error); },
    }) as TunnelStream;
    stream.setTimeout = (_ms: number, cb?: () => void) => { void cb; return stream; };
    stream.setNoDelay = () => stream; stream.setKeepAlive = () => stream; stream.ref = () => stream; stream.unref = () => stream;
    // The remote side closed: no more data comes, and nothing more can be written.
    (stream as unknown as { remoteClosed: () => void }).remoteClosed = () => { ended = true; this.streams.delete(id); stream.push(null); stream.end(); };
    this.streams.set(id, stream);
    return stream;
  }
  /** Open a connection from the host (`connect` mode). */
  connect(): TunnelStream {
    if (this.closed) throw new Error('tunnel_closed');
    const id = this.next++;
    const stream = this.stream(id);
    this.send(id, OPEN);
    return stream;
  }
  private receive(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 9) {
      const length = this.buffer.readUInt32BE(5);
      if (length > MAX_FRAME_BYTES) { this.close(); return; }
      if (this.buffer.length < 9 + length) break;
      const id = this.buffer.readUInt32BE(0), type = this.buffer.readUInt8(4);
      const data = Buffer.from(this.buffer.subarray(9, 9 + length));
      this.buffer = this.buffer.subarray(9 + length);
      if (type === OPEN) {
        const stream = this.stream(id);
        if (this.onIncoming) this.onIncoming(stream); else stream.destroy();
      } else if (type === DATA) this.streams.get(id)?.push(data);
      else if (type === CLOSE) (this.streams.get(id) as unknown as { remoteClosed?: () => void } | undefined)?.remoteClosed?.();
    }
  }
  /** End every stream and stop accepting frames. Idempotent. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
    for (const listener of this.closeListeners) { try { listener(); } catch { /* ignore */ } }
    this.closeListeners.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Egress: approved HTTPS origins only                                 */
/* ------------------------------------------------------------------ */

/** Options of {@link handleEgress}. */
export interface EgressOptions {
  /** Is this exact origin (`https://host[:port]`) approved in this conversation? Read on every connection. */
  allowed(origin: string): boolean;
  /** DNS resolution (tests). @default dns.lookup with all addresses */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** Address check (tests). @default isBlockedAddress (web search's SSRF rules) */
  blocked?: (address: string) => boolean;
  /** Opening the upstream connection (tests). @default net.connect */
  connect?: (port: number, address: string) => Socket;
  /** Time to connect upstream. @default 10000 */
  connectTimeoutMs?: number;
  /** Every decision, for logs and tests. */
  onDecision?: (decision: { origin?: string; allowed: boolean; reason?: string }) => void;
}

const respond = (stream: Duplex, status: string, reason: string) => {
  stream.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
};

/** `https://host[:port]` of a CONNECT target (default port omitted), or undefined if it is not a plain host and port. */
export function connectOrigin(target: string): { origin: string; host: string; port: number } | undefined {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(target.trim());
  if (!match) return undefined;
  const port = Number(match[2]);
  if (!port || port > 65535) return undefined;
  const host = match[1]!.toLowerCase();
  return { origin: `https://${host}${port === 443 ? '' : `:${port}`}`, host: host.replace(/^\[|\]$/g, ''), port };
}

/**
 * One connection of the headless browser's proxy (it reaches the host
 * through the tunnel). Only `CONNECT` to an approved HTTPS origin is
 * accepted; the name is resolved here, every address must pass web search's
 * SSRF checks (no private, loopback, link-local or reserved addresses), and
 * the connection goes to the address that was checked (no second lookup, so
 * DNS rebinding cannot change it). Anything else gets a 403 and is closed.
 */
export async function handleEgress(stream: Duplex, options: EgressOptions): Promise<void> {
  const decide = (allowed: boolean, origin?: string, reason?: string) => options.onDecision?.({ ...(origin ? { origin } : {}), allowed, ...(reason ? { reason } : {}) });
  let head = Buffer.alloc(0);
  const request = await new Promise<{ line: string; rest: Buffer } | undefined>(resolve => {
    const timer = setTimeout(() => done(undefined), 10_000);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end >= 0) done({ line: head.subarray(0, head.indexOf('\r\n')).toString('latin1'), rest: head.subarray(end + 4) });
      else if (head.length > 8192) done(undefined);
    };
    const done = (value: { line: string; rest: Buffer } | undefined) => { clearTimeout(timer); stream.off('data', onData); stream.off('end', ended); resolve(value); };
    const ended = () => done(undefined);
    stream.on('data', onData);
    stream.once('end', ended);
  });
  if (!request) { decide(false, undefined, 'bad_request'); respond(stream, '400 Bad Request', 'Bad request'); return; }
  const [method, target] = request.line.split(' ');
  if (method !== 'CONNECT' || !target) { decide(false, undefined, 'not_https'); respond(stream, '403 Forbidden', 'Only approved HTTPS origins are reachable.'); return; }
  const parsed = connectOrigin(target);
  if (!parsed) { decide(false, undefined, 'bad_target'); respond(stream, '403 Forbidden', 'Not an approved origin.'); return; }
  if (!options.allowed(parsed.origin)) { decide(false, parsed.origin, 'not_approved'); respond(stream, '403 Forbidden', `${parsed.origin} is not approved in this conversation.`); return; }
  const blocked = options.blocked ?? isBlockedAddress;
  let address: string;
  try {
    let addresses: { address: string; family: number }[];
    if (isIP(parsed.host)) addresses = [{ address: parsed.host, family: isIP(parsed.host) }];
    else if (/(^|\.)localhost$/i.test(parsed.host)) addresses = [{ address: '127.0.0.1', family: 4 }];
    else addresses = await (options.resolve ?? (host => dnsLookup(host, { all: true, verbatim: true })))(parsed.host);
    if (!addresses.length) throw new Error('dns_failed');
    if (addresses.some(entry => blocked(entry.address))) { decide(false, parsed.origin, 'blocked_address'); respond(stream, '403 Forbidden', `${parsed.origin} resolves to a private or reserved address.`); return; }
    address = addresses[0]!.address;
  } catch { decide(false, parsed.origin, 'dns_failed'); respond(stream, '502 Bad Gateway', 'The name could not be resolved.'); return; }
  const upstream = (options.connect ?? ((port, host) => netConnect({ port, host })))(parsed.port, address);
  const timer = setTimeout(() => upstream.destroy(new Error('connect_timeout')), options.connectTimeoutMs ?? 10_000);
  upstream.once('connect', () => {
    clearTimeout(timer);
    decide(true, parsed.origin);
    stream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (request.rest.length) upstream.write(request.rest);
    stream.pipe(upstream); upstream.pipe(stream);
  });
  upstream.once('error', () => { clearTimeout(timer); if (!stream.destroyed) { if (upstream.connecting) { decide(false, parsed.origin, 'connect_failed'); respond(stream, '502 Bad Gateway', 'The origin could not be reached.'); } else stream.destroy(); } });
  upstream.once('close', () => { if (!stream.destroyed) stream.end(); });
  stream.once('close', () => upstream.destroy());
  stream.on('error', () => upstream.destroy());
}
