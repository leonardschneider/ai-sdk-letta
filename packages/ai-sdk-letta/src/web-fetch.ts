import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { LookupFunction } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

/**
 * Reading web pages for `web_search`, safely: only `http(s)` URLs, never a
 * private, loopback or link-local address (checked on every redirect, and
 * the connection goes to the address that was checked, so DNS cannot change
 * it in between), bounded in time and size, no cookies. The readable text is
 * extracted with Mozilla Readability (on linkedom) and returned as plain text.
 *
 * The approach (SSRF checks per hop, Readability for the text) follows the
 * ideas of `mcp-searxng` (MIT) and Morphic's fetch tool (Apache-2.0); no code
 * is copied from them.
 *
 * @module
 */

/** Bounds of one page read. */
export const PAGE_LIMITS = Object.freeze({
  /** Longest a page may take, connection to last byte. */
  timeoutMs: 12_000,
  /** Most bytes of a page (after decompression); the rest is not read. */
  maxBytes: 2 * 1024 * 1024,
  /** Most characters of readable text kept per page. */
  maxCharacters: 8000,
  /** Most redirects followed. */
  maxRedirects: 5,
  /** Longest URL accepted. */
  maxUrlLength: 2048,
});

/** The user agent of page reads: honest about what it is. */
export const WEB_USER_AGENT = 'Mozilla/5.0 (compatible; ai-sdk-letta-web-research/1.0; +https://github.com/leonardschneider/ai-sdk-letta)';

/** Why a page could not be read. Fixed codes, safe to show. */
export type PageErrorCode = 'invalid_url' | 'blocked_address' | 'dns_failed' | 'too_many_redirects' | 'http_error' | 'unsupported_type' | 'timeout' | 'fetch_failed' | 'empty';
export class PageError extends Error {
  constructor(readonly code: PageErrorCode, readonly detail?: string) { super(code); this.name = 'PageError'; }
}

/** A page's readable text. `url` is where it ended up (after redirects). */
export type ReadablePage = { url: string; title: string; text: string; truncated: boolean; contentType: string };

/** Options of {@link readPage}. */
export interface ReadPageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxCharacters?: number;
  /**
   * **Testing only.** Exact origins (`http://127.0.0.1:4567`) that may be
   * read although they are on a private or loopback address, for fixtures
   * served on loopback. Redirects elsewhere are still checked.
   */
  unsafeAllowOrigins?: readonly string[];
  /** Resolve a host name (tests). @default node:dns lookup, all addresses */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(network, prefix, 'ipv6');

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:10.0.0.1`, `::ffff:a00:1`), if it is one. */
function mappedIPv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return undefined;
  const high = parseInt(hex[1]!, 16), low = parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Whether an IP address must never be read: private, loopback, link-local,
 * shared (CGNAT), multicast, reserved or documentation ranges, in IPv4 or
 * IPv6 (IPv4-mapped addresses are checked as IPv4). Anything that is not an
 * IP address is blocked too.
 */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const version = isIP(bare);
  if (version === 4) return blocked.check(bare, 'ipv4');
  if (version !== 6) return true;
  const v4 = mappedIPv4(bare);
  if (v4) return isIP(v4) !== 4 || blocked.check(v4, 'ipv4');
  return blocked.check(bare, 'ipv6');
}

/** Parse and check a URL to read: `http(s)` only, no credentials, bounded length. @throws PageError('invalid_url') */
export function checkPageUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > PAGE_LIMITS.maxUrlLength) throw new PageError('invalid_url');
  let url: URL;
  try { url = new URL(value); } catch { throw new PageError('invalid_url'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname) throw new PageError('invalid_url');
  url.hash = '';
  return url;
}

const defaultResolve = async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true });

/** The address to connect to for `url`, after checking every address the name resolves to. */
async function safeAddress(url: URL, options: ReadPageOptions): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const allowed = options.unsafeAllowOrigins?.includes(url.origin) ?? false;
  const literal = isIP(host);
  let addresses: { address: string; family: number }[];
  if (literal) addresses = [{ address: host, family: literal }];
  else {
    if (/(^|\.)localhost$/i.test(host) && !allowed) throw new PageError('blocked_address');
    try { addresses = await (options.resolve ?? defaultResolve)(host); } catch { throw new PageError('dns_failed'); }
  }
  if (!addresses.length) throw new PageError('dns_failed');
  // Every address must be public: a name with one private address could be connected to it.
  if (!allowed && addresses.some(entry => isBlockedAddress(entry.address))) throw new PageError('blocked_address');
  // Even an allowed test origin must be on loopback.
  if (allowed && !addresses.every(entry => /^127\./.test(entry.address) || entry.address === '::1')) throw new PageError('blocked_address');
  return addresses[0]!;
}

function decoded(response: IncomingMessage) {
  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(createGunzip());
  if (encoding === 'deflate') return response.pipe(createInflate());
  if (encoding === 'br') return response.pipe(createBrotliDecompress());
  return response;
}

type Fetched = { url: string; status: number; contentType: string; body: Buffer; truncated: boolean; location?: string };

/** One request to a checked address: no cookies, no redirects followed here. */
function requestOnce(url: URL, address: { address: string; family: number }, maxBytes: number, signal: AbortSignal): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    // Connect to the checked address only (the name is still used for TLS and the Host header).
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [address]);
      else callback(null, address.address, address.family);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', lookup, signal, agent: false,
      headers: { 'User-Agent': WEB_USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en;q=0.9, *;q=0.5' },
    }, response => {
      const status = response.statusCode ?? 0;
      const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
      if (status >= 300 && status < 400) {
        const location = response.headers.location;
        response.resume();
        resolve({ url: url.href, status, contentType, body: Buffer.alloc(0), truncated: false, ...(location ? { location } : {}) });
        return;
      }
      if (status < 200 || status >= 300) { response.resume(); resolve({ url: url.href, status, contentType, body: Buffer.alloc(0), truncated: false }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (truncated: boolean) => { if (done) return; done = true; resolve({ url: url.href, status, contentType, body: Buffer.concat(chunks), truncated }); };
      const stream = decoded(response);
      stream.on('data', (chunk: Buffer) => {
        if (done) return;
        const room = maxBytes - size;
        if (chunk.length >= room) { chunks.push(chunk.subarray(0, room)); size = maxBytes; finish(true); request.destroy(); return; }
        chunks.push(chunk); size += chunk.length;
      });
      stream.on('end', () => finish(false));
      stream.on('error', error => { if (!done) { done = true; reject(error); } });
      response.on('error', error => { if (!done) { done = true; reject(error); } });
    });
    request.on('error', reject);
    request.end();
  });
}

/** The text encoding of a page: the Content-Type charset, else a `<meta charset>`, else UTF-8. */
function decodeText(body: Buffer, contentType: string): string {
  const declared = /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1];
  try { return new TextDecoder(declared ?? 'utf-8').decode(body); } catch { return new TextDecoder('utf-8').decode(body); }
}

const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'OBJECT', 'CANVAS', 'HEAD']);

type TextNode = { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<TextNode>; getAttribute?(name: string): string | null };
/** Plain text of an element: paragraphs, headings and list items on their own lines; scripts, styles and hidden elements left out. */
function plainText(root: TextNode): string {
  const out: string[] = [];
  const walk = (node: TextNode) => {
    if (node.nodeType === 3) { out.push((node.textContent ?? '').replace(/\s+/g, ' ')); return; }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    const name = node.nodeName.toUpperCase();
    const hidden = node.getAttribute ? node.getAttribute('hidden') !== null || node.getAttribute('aria-hidden') === 'true' : false;
    if (SKIP.has(name) || hidden) return;
    const block = BLOCK.has(name);
    if (block) out.push('\n\n');
    if (name === 'LI') out.push('- ');
    if (/^H[1-6]$/.test(name)) out.push('#'.repeat(Number(name[1])) + ' ');
    if (name === 'BR') out.push('\n');
    if (name === 'TD' || name === 'TH') out.push(' | ');
    for (const child of Array.from(node.childNodes)) walk(child);
    if (block) out.push('\n\n');
  };
  walk(root);
  return out.join('').replace(/[\p{Cc}\p{Cf}]/gu, match => match === '\n' ? '\n' : '').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
}

/**
 * The readable text of an HTML page: Mozilla Readability's article when it
 * finds one, else the body's text, as plain text (no links, no markup).
 */
export function readableText(html: string, url: string): { title: string; text: string } {
  const { document } = parseHTML(html);
  const fallbackTitle = (document.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  let article: { title?: string | null; content?: string | null } | null = null;
  try {
    // Readability changes the document it reads: give it its own copy.
    const { document: copy } = parseHTML(html);
    Object.defineProperty(copy, 'documentURI', { value: url, configurable: true });
    article = new Readability(copy as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 200, keepClasses: false }).parse();
  } catch { article = null; }
  if (article?.content) {
    const { document: content } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
    const text = plainText(content.body as unknown as TextNode);
    if (text) return { title: (article.title ?? fallbackTitle).replace(/\s+/g, ' ').trim(), text };
  }
  return { title: fallbackTitle, text: document.body ? plainText(document.body as unknown as TextNode) : '' };
}

/**
 * Read one page's readable text, safely (see the module description).
 * @throws PageError with a fixed code
 */
export async function readPage(target: string, options: ReadPageOptions = {}): Promise<ReadablePage> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PAGE_LIMITS.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const maxBytes = options.maxBytes ?? PAGE_LIMITS.maxBytes;
  let url = checkPageUrl(target);
  try {
    for (let hop = 0; ; hop++) {
      const address = await safeAddress(url, options);
      signal.throwIfAborted();
      const response = await requestOnce(url, address, maxBytes, signal);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location || hop >= PAGE_LIMITS.maxRedirects) throw new PageError(response.location ? 'too_many_redirects' : 'http_error', String(response.status));
        let next: URL;
        try { next = new URL(response.location, url); } catch { throw new PageError('invalid_url'); }
        url = checkPageUrl(next.href);
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new PageError('http_error', String(response.status));
      const type = response.contentType.split(';')[0]!.trim();
      const html = type === 'text/html' || type === 'application/xhtml+xml' || (!type && /^\s*</.test(response.body.subarray(0, 512).toString('latin1')));
      if (!html && type !== 'text/plain' && type !== 'text/markdown') throw new PageError('unsupported_type', type || 'unknown');
      const source = decodeText(response.body, response.contentType);
      const { title, text } = html ? readableText(source, url.href) : { title: '', text: source.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n\t]/gu, '').trim() };
      if (!text) throw new PageError('empty');
      const max = options.maxCharacters ?? PAGE_LIMITS.maxCharacters;
      const chars = Array.from(text);
      return { url: url.href, title: title.slice(0, 300), text: chars.length > max ? chars.slice(0, max).join('') : text, truncated: response.truncated || chars.length > max, contentType: type || (html ? 'text/html' : 'text/plain') };
    }
  } catch (error) {
    if (error instanceof PageError) throw error;
    if (timeout.aborted || signal.aborted) throw new PageError('timeout');
    throw new PageError('fetch_failed');
  }
}
