/**
 * Conversation titles are one line of inline Markdown: links, **bold**,
 * *italic* and `code`. Nothing else is Markdown in a title: headings, lists,
 * quotes and images are not (an image shows its alt text).
 *
 * This module has no imports, so the browser app bundles it too
 * (`ai-sdk-letta/title`); folder names, search and the terminal use the
 * same rules through {@link titleText}.
 *
 * @module
 */

/** A piece of a parsed title. `start`/`end` are offsets in the title as written. */
export type TitleNode =
  | { type: 'text'; value: string; start: number; end: number }
  | { type: 'code'; value: string; start: number; end: number }
  | { type: 'strong' | 'emphasis'; children: TitleNode[]; start: number; end: number }
  /**
   * A link. `href` is set only for `http:`, `https:` and `mailto:` URLs
   * (see {@link safeLinkHref}); without it the link is inert and shows its
   * text. `auto` marks a bare URL (or `<url>`) whose text is the URL itself.
   */
  | { type: 'link'; url: string; href?: string; auto: boolean; children: TitleNode[]; start: number; end: number }
  /** An image: never loaded, shown as its alt text. */
  | { type: 'image'; alt: string; start: number; end: number };

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const SPACE = /\s/u;
const WORD = /[\p{L}\p{N}]/u;
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * The link target to use for `url`, or `undefined` when it must stay inert:
 * only absolute `http:`, `https:` and `mailto:` URLs are allowed (no
 * `javascript:`, `data:`, relative or protocol-relative URLs).
 */
export function safeLinkHref(url: string): string | undefined {
  const trimmed = url.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(trimmed) || /[\p{Cc}\p{Cf}\s]/u.test(trimmed)) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (!SAFE_PROTOCOLS.has(parsed.protocol)) return undefined;
    if (parsed.protocol === 'mailto:' ? parsed.pathname.length < 3 || !parsed.pathname.includes('@') : !parsed.hostname) return undefined;
    return parsed.href;
  } catch { return undefined; }
}

const runLength = (text: string, at: number, char: string, end: number) => { let n = 0; while (at + n < end && text[at + n] === char) n++; return n; };

/** End (exclusive) of the code span opened by the backtick run at `at`, or -1. */
function codeSpanEnd(text: string, at: number, end: number): number {
  const n = runLength(text, at, '`', end);
  for (let j = at + n; j < end;) {
    if (text[j] !== '`') { j++; continue; }
    const m = runLength(text, j, '`', end);
    if (m === n) return j + m;
    j += m;
  }
  return -1;
}

/** `[text](url "title")` starting at the `[` at `at`: the text range, the URL and the end, or undefined. */
function matchLink(text: string, at: number, end: number): { from: number; to: number; url: string; end: number } | undefined {
  let depth = 0;
  let close = -1;
  for (let j = at; j < end; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') { const e = codeSpanEnd(text, j, end); if (e > 0) { j = e - 1; continue; } j += runLength(text, j, '`', end) - 1; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) { close = j; break; }
  }
  if (close < 0 || text[close + 1] !== '(') return undefined;
  let j = close + 2;
  while (j < end && text[j] === ' ') j++;
  let url = '';
  if (text[j] === '<') {
    const stop = text.indexOf('>', j);
    if (stop < 0 || stop >= end || /[<\n]/.test(text.slice(j + 1, stop))) return undefined;
    url = text.slice(j + 1, stop); j = stop + 1;
  } else {
    let parens = 0;
    const startUrl = j;
    for (; j < end; j++) {
      const c = text[j]!;
      if (c === '\\' && j + 1 < end && PUNCTUATION.test(text[j + 1]!)) { j++; continue; }
      if (SPACE.test(c)) break;
      if (c === '(') parens++;
      else if (c === ')') { if (parens === 0) break; parens--; }
    }
    url = text.slice(startUrl, j).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  while (j < end && text[j] === ' ') j++;
  // An optional link title ("…", '…' or (…)) is accepted and ignored.
  const quote = text[j];
  if (quote === '"' || quote === '\'' || quote === '(') {
    const closer = quote === '(' ? ')' : quote;
    const stop = text.indexOf(closer, j + 1);
    if (stop < 0 || stop >= end) return undefined;
    j = stop + 1;
    while (j < end && text[j] === ' ') j++;
  }
  if (text[j] !== ')') return undefined;
  return { from: at + 1, to: close, url, end: j + 1 };
}

/** Emphasis (`*x*`, `_x_`) or strong (`**x**`, `__x__`) opened at `at`, or undefined. */
function matchEmphasis(text: string, at: number, end: number): { size: 1 | 2; to: number; end: number } | undefined {
  const char = text[at]!;
  const run = runLength(text, at, char, end);
  const before = at > 0 ? text[at - 1]! : ' ';
  if (char === '_' && WORD.test(before)) return undefined;
  for (const size of (run >= 2 ? [2, 1] : [1]) as (1 | 2)[]) {
    const after = text[at + size];
    if (after === undefined || at + size >= end || SPACE.test(after)) continue;
    if (size === 1 && after === char) continue;
    for (let j = at + size; j < end;) {
      const c = text[j]!;
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { const e = codeSpanEnd(text, j, end); j = e > 0 ? e : j + runLength(text, j, '`', end); continue; }
      if (c === '[') { const link = matchLink(text, j, end); if (link) { j = link.end; continue; } }
      if (c !== char) { j++; continue; }
      const r = runLength(text, j, char, end);
      const closeAt = size === 2 ? j + r - 2 : j + r - 1;
      const prev = text[closeAt - 1]!;
      const next = closeAt + size < end ? text[closeAt + size]! : ' ';
      const fits = size === 2 ? r >= 2 : r === 1 || r >= 3;
      if (fits && closeAt > at + size && !SPACE.test(prev) && !(char === '_' && WORD.test(next))) return { size, to: closeAt, end: closeAt + size };
      j += r;
    }
  }
  return undefined;
}

const BARE_URL = /^(?:https?:\/\/|mailto:|www\.)[^\s<>]+/i;
/** A bare URL at `at` (GFM-style trailing punctuation left out), or undefined. */
function matchBareUrl(text: string, at: number, end: number): string | undefined {
  const before = at > 0 ? text[at - 1]! : ' ';
  if (!SPACE.test(before) && !'(*_~"\''.includes(before)) return undefined;
  let url = BARE_URL.exec(text.slice(at, end))?.[0];
  if (!url) return undefined;
  for (;;) {
    if (/[.,;:!?'"*_~]$/.test(url)) url = url.slice(0, -1);
    else if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    else break;
  }
  return /^(?:https?:\/\/|mailto:|www\.)./i.test(url) && !/^(?:https?:\/\/|www\.)$/i.test(url) ? url : undefined;
}

function parseRange(text: string, from: number, to: number, links: boolean): TitleNode[] {
  const nodes: TitleNode[] = [];
  let buffer = '';
  let bufferStart = from;
  const add = (value: string, at: number) => { if (!buffer) bufferStart = at; buffer += value; };
  const flush = (at: number) => { if (buffer) nodes.push({ type: 'text', value: buffer, start: bufferStart, end: at }); buffer = ''; };
  let i = from;
  while (i < to) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < to && PUNCTUATION.test(text[i + 1]!)) { add(text[i + 1]!, i); i += 2; continue; }
    if (c === '`') {
      const close = codeSpanEnd(text, i, to);
      const n = runLength(text, i, '`', to);
      if (close < 0) { add('`'.repeat(n), i); i += n; continue; }
      let value = text.slice(i + n, close - n);
      if (value.length > 2 && value.startsWith(' ') && value.endsWith(' ') && value.trim()) value = value.slice(1, -1);
      flush(i); nodes.push({ type: 'code', value, start: i, end: close }); i = close; continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      const image = matchLink(text, i + 1, to);
      if (image) { flush(i); nodes.push({ type: 'image', alt: plain(parseRange(text, image.from, image.to, false)), start: i, end: image.end }); i = image.end; continue; }
    }
    if (c === '[' && links) {
      const link = matchLink(text, i, to);
      if (link) {
        flush(i);
        const href = safeLinkHref(link.url);
        nodes.push({ type: 'link', url: link.url, ...(href ? { href } : {}), auto: false, children: parseRange(text, link.from, link.to, false), start: i, end: link.end });
        i = link.end; continue;
      }
    }
    if (c === '<' && links) {
      const auto = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(text.slice(i, to));
      if (auto) {
        flush(i);
        const url = auto[1]!.includes(':') ? auto[1]! : `mailto:${auto[1]}`;
        const href = safeLinkHref(url);
        const end = i + auto[0].length;
        nodes.push({ type: 'link', url, ...(href ? { href } : {}), auto: true, children: [{ type: 'text', value: auto[1]!, start: i + 1, end: end - 1 }], start: i, end });
        i = end; continue;
      }
    }
    if (links && (c === 'h' || c === 'H' || c === 'm' || c === 'M' || c === 'w' || c === 'W')) {
      const url = matchBareUrl(text, i, to);
      if (url) {
        flush(i);
        const target = /^www\./i.test(url) ? `https://${url}` : url;
        const href = safeLinkHref(target);
        nodes.push({ type: 'link', url: target, ...(href ? { href } : {}), auto: true, children: [{ type: 'text', value: url, start: i, end: i + url.length }], start: i, end: i + url.length });
        i += url.length; continue;
      }
    }
    if (c === '*' || c === '_') {
      const emphasis = matchEmphasis(text, i, to);
      if (emphasis) {
        flush(i);
        nodes.push({ type: emphasis.size === 2 ? 'strong' : 'emphasis', children: parseRange(text, i + emphasis.size, emphasis.to, links), start: i, end: emphasis.end });
        i = emphasis.end; continue;
      }
      const n = runLength(text, i, c, to);
      add(c.repeat(n), i); i += n; continue;
    }
    add(c, i); i++;
  }
  flush(to);
  return nodes;
}

function plain(nodes: readonly TitleNode[], short = false): string {
  return nodes.map(node => node.type === 'text' || node.type === 'code' ? node.value : node.type === 'image' ? node.alt
    : node.type === 'link' && short && looksLikeUrl(plain(node.children)) ? shortUrl(plain(node.children)) : plain(node.children, short)).join('');
}

/** Whether a link's text is itself a URL (a bare URL, or `[https://…](https://…)`). */
export const looksLikeUrl = (text: string) => /^(?:https?:\/\/|mailto:|www\.)\S+$/i.test(text.trim());

/**
 * A URL shortened for display: no scheme, no `www.`, no trailing slash, and
 * at most `max` characters (`example.com/docs/very-long-pa…`).
 */
export function shortUrl(url: string, max = 32): string {
  const bare = url.trim().replace(/^(?:https?:\/\/|mailto:)/i, '').replace(/^www\./i, '').replace(/\/$/, '');
  const chars = [...bare];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : bare;
}

/** Parse a title's inline Markdown. Never throws; anything that is not a construct stays text. */
export function parseTitle(title: string): TitleNode[] {
  return parseRange(title, 0, title.length, true);
}

/** The visible text of parsed nodes (see {@link titleText}). */
export function nodesText(nodes: readonly TitleNode[], options: { shortUrls?: boolean } = {}): string {
  return plain(nodes, !!options.shortUrls);
}

/**
 * The text a title shows, without Markdown syntax: `Review [Spec](https://x) **v2**`
 * becomes `Review Spec v2`. Used for search, window titles and the terminal;
 * folder names use `shortUrls` (a bare URL becomes `example.com/docs`).
 */
export function titleText(title: string, options: { shortUrls?: boolean } = {}): string {
  return nodesText(parseTitle(title), options).replace(/\s+/g, ' ').trim();
}
