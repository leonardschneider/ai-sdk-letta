import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { marked, type Token, type Tokens } from 'marked';
import { ADF_SCHEMA } from './adf-schema.js';

/**
 * Atlassian Document Format (ADF) for agents: plain Markdown to read, and
 * block-splice writes that never lose what Markdown cannot express.
 *
 * - {@link adfToMarkdown} turns a document into readable Markdown, one
 *   top-level block after another, separated by one blank line. Elements
 *   without a Markdown form are shown as short readable tokens (`@Name`,
 *   `[status: DONE]`, `[image: name.png]`, `[macro: toc]`, …).
 * - {@link spliceMarkdown} applies an edited Markdown file back to the
 *   original document. The original is the source of truth: top-level blocks
 *   whose Markdown is unchanged are kept verbatim (with every attribute,
 *   mark and ID), only edited blocks are converted again, and an edit that
 *   would lose a protected element (a mention, image, status, macro, task
 *   state, colour, comment…) is refused, naming the elements.
 */

/** An ADF node. */
export type AdfNode = { type: string; attrs?: Record<string, unknown>; content?: AdfNode[]; marks?: AdfMark[]; text?: string; version?: number };
/** An ADF mark. */
export type AdfMark = { type: string; attrs?: Record<string, unknown> };
/** An ADF document (`{ version: 1, type: 'doc', content }`). */
export type AdfDocument = { version: 1; type: 'doc'; content: AdfNode[] };

const SEPARATOR = '\n\n';

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

let validator: ValidateFunction | undefined;
/** Is `value` a valid ADF document (the Atlassian JSON schema, `full`)? Returns the first problems when not. */
export function validateAdf(value: unknown): { valid: true } | { valid: false; errors: string[] } {
  validator ??= new Ajv({ strict: false, allErrors: false, validateSchema: false }).compile(structuredClone(ADF_SCHEMA) as Record<string, unknown>);
  if (validator(value)) return { valid: true };
  return { valid: false, errors: (validator.errors ?? []).slice(0, 5).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`) };
}
/** Is `value` shaped like an ADF document (without full validation)? */
export function isAdfDocument(value: unknown): value is AdfDocument {
  return !!value && typeof value === 'object' && (value as AdfNode).type === 'doc' && Array.isArray((value as AdfNode).content);
}

/* ------------------------------------------------------------------ */
/* ADF → Markdown                                                      */
/* ------------------------------------------------------------------ */

/** How to name things Markdown cannot show (for example, media by attachment name). */
export interface MarkdownOptions {
  /** Name of a media node (a file attachment), e.g. from the issue's attachment list. */
  mediaName?(attrs: Record<string, unknown>): string | undefined;
}

const escapeText = (text: string) => text
  .replace(/\\/g, '\\\\')
  .replace(/([*_`[\]<>|~])/g, '\\$1')
  .replace(/^(\s*)([#>+-])(\s)/gm, '$1\\$2$3')
  .replace(/^(\s*\d+)([.)])(\s)/gm, '$1\\$2$3')
  .replace(/!(?=\[)/g, '\\!');
const codeSpan = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest || /^\s|\s$/.test(text) ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
};
const safeHref = (href: unknown) => typeof href === 'string' ? href.replace(/[()\s]/g, c => encodeURIComponent(c)) : '';
const attr = (node: AdfNode, key: string) => node.attrs?.[key];
const str = (value: unknown) => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);

/** One inline node (text with marks, mention, emoji…) as Markdown. */
function inline(node: AdfNode, options: MarkdownOptions): string {
  switch (node.type) {
    case 'text': {
      const marks = node.marks ?? [];
      const code = marks.some(m => m.type === 'code');
      let out = code ? codeSpan(node.text ?? '') : escapeText(node.text ?? '');
      if (!out) return '';
      for (const mark of marks) {
        if (mark.type === 'strong') out = `**${out}**`;
        else if (mark.type === 'em') out = `*${out}*`;
        else if (mark.type === 'strike') out = `~~${out}~~`;
      }
      const link = marks.find(m => m.type === 'link');
      if (link) out = `[${out}](${safeHref(link.attrs?.href)})`;
      return out;
    }
    case 'hardBreak': return '\\\n';
    case 'mention': return `@${str(attr(node, 'text')).replace(/^@/, '') || 'someone'}`;
    case 'emoji': return str(attr(node, 'text')) || str(attr(node, 'shortName'));
    case 'status': return `[status: ${str(attr(node, 'text'))}]`;
    case 'date': { const ms = Number(attr(node, 'timestamp')); return Number.isFinite(ms) ? `[date: ${new Date(ms).toISOString().slice(0, 10)}]` : '[date]'; }
    case 'inlineCard': return attr(node, 'url') ? `<${str(attr(node, 'url'))}>` : '[link card]';
    case 'placeholder': return `[placeholder: ${str(attr(node, 'text'))}]`;
    case 'inlineExtension': return `[macro: ${str(attr(node, 'extensionKey'))}]`;
    case 'mediaInline': return `[file: ${options.mediaName?.(node.attrs ?? {}) ?? str(attr(node, 'alt')) ?? 'attachment'}]`;
    default: return node.content ? inlines(node.content, options) : node.text ? escapeText(node.text) : `[${node.type}]`;
  }
}
const inlines = (nodes: readonly AdfNode[] | undefined, options: MarkdownOptions) => (nodes ?? []).map(n => inline(n, options)).join('');
const indent = (text: string, prefix: string) => text.split('\n').map((line, i) => (line ? (i === 0 ? '' : ' '.repeat(prefix.length)) + line : line)).join('\n').replace(/^/, prefix);
const quote = (text: string) => text.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
const cell = (node: AdfNode, options: MarkdownOptions) => (node.content ?? []).map(child => child.type === 'paragraph' ? inlines(child.content, options) : blocks([child], options).replace(/\n+/g, ' ')).join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
function mediaLabel(node: AdfNode, options: MarkdownOptions): string {
  const media = node.type === 'media' ? node : node.content?.find(c => c.type === 'media');
  const attrs = media?.attrs ?? {};
  const name = options.mediaName?.(attrs) ?? (str(attrs.alt) || (attrs.type === 'external' ? str(attrs.url) : '') || 'attachment');
  return `[image: ${name}]`;
}

/** One block node as Markdown (no trailing newline). */
function block(node: AdfNode, options: MarkdownOptions): string {
  switch (node.type) {
    case 'paragraph': return inlines(node.content, options);
    case 'heading': return `${'#'.repeat(Math.min(6, Math.max(1, Number(attr(node, 'level')) || 1)))} ${inlines(node.content, options)}`;
    case 'bulletList': return (node.content ?? []).map(item => indent(blocks(item.content ?? [], options, '\n'), '- ')).join('\n');
    case 'orderedList': {
      const start = Number(attr(node, 'order')) || 1;
      return (node.content ?? []).map((item, i) => indent(blocks(item.content ?? [], options, '\n'), `${start + i}. `)).join('\n');
    }
    case 'taskList': return (node.content ?? []).map(item => item.type === 'taskItem' ? `- [${attr(item, 'state') === 'DONE' ? 'x' : ' '}] ${inlines(item.content, options)}` : indent(block(item, options), '  ')).join('\n');
    case 'decisionList': return (node.content ?? []).map(item => `- [decision] ${inlines(item.content, options)}`).join('\n');
    case 'codeBlock': {
      const text = (node.content ?? []).map(n => n.text ?? '').join('');
      const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
      const fence = '`'.repeat(longest + 1);
      return `${fence}${str(attr(node, 'language'))}\n${text}\n${fence}`;
    }
    case 'blockquote': return quote(blocks(node.content ?? [], options));
    case 'rule': return '---';
    case 'panel': return quote(`**[${str(attr(node, 'panelType')) || 'info'} panel]**\n${blocks(node.content ?? [], options)}`);
    case 'expand': case 'nestedExpand': return `**[expand: ${str(attr(node, 'title'))}]**\n\n${blocks(node.content ?? [], options)}`;
    case 'mediaSingle': case 'mediaGroup': return (node.type === 'mediaGroup' ? node.content ?? [] : [node]).map(m => mediaLabel(m, options)).join(' ');
    case 'table': {
      const rows = (node.content ?? []).map(row => (row.content ?? []).map(c => cell(c, options)));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(r => r.length));
      const pad = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      const header = node.content?.[0]?.content?.every(c => c.type === 'tableHeader') ?? false;
      const head = header ? rows[0]! : Array.from({ length: width }, () => '');
      const body = header ? rows.slice(1) : rows;
      return [pad(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(pad)].join('\n');
    }
    case 'layoutSection': return (node.content ?? []).map(column => blocks(column.content ?? [], options)).join(SEPARATOR);
    case 'extension': case 'bodiedExtension': case 'multiBodiedExtension': case 'syncBlock': case 'bodiedSyncBlock': {
      const key = str(attr(node, 'extensionKey')) || node.type;
      const body = node.content?.length ? `\n${blocks(node.content, options)}` : '';
      return `[macro: ${key}]${body}`;
    }
    case 'blockCard': case 'embedCard': return attr(node, 'url') ? `<${str(attr(node, 'url'))}>` : `[${node.type}]`;
    default: return node.content ? blocks(node.content, options) : `[${node.type}]`;
  }
}
const blocks = (nodes: readonly AdfNode[], options: MarkdownOptions, separator = SEPARATOR) => nodes.map(n => block(n, options)).filter(text => text !== '').join(separator);

/** Drop blank lines outside code fences, so one block never reads as several (see {@link splitBlocks}). */
function compact(text: string): string {
  let fence: string | undefined;
  return text.split('\n').filter(line => {
    if (fence) { if (line.trim().startsWith(fence) && !line.trim().replace(/`+|~+/, '')) fence = undefined; return true; }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) { fence = open[1]; return true; }
    return line.trim() !== '';
  }).join('\n');
}

/** The Markdown of each top-level block of a document (empty paragraphs give an empty string). Blocks never contain blank lines outside code. */
export function blockMarkdown(doc: AdfDocument, options: MarkdownOptions = {}): string[] {
  return doc.content.map(node => compact(block(node, options).replace(/\s+$/, '')));
}

/**
 * A document as plain Markdown for the model: each top-level block, separated
 * by one blank line. Elements without a Markdown form become short tokens:
 * `@Name` (mention), `[status: DONE]`, `[date: 2026-10-01]`, `[image: file.png]`,
 * `[macro: toc]`, `> **[info panel]**`, `- [ ]` / `- [x]` (tasks).
 */
export function adfToMarkdown(doc: AdfDocument, options: MarkdownOptions = {}): string {
  const text = blockMarkdown(doc, options).filter(Boolean).join(SEPARATOR);
  return text ? `${text}\n` : '';
}

/* ------------------------------------------------------------------ */
/* Markdown → ADF                                                      */
/* ------------------------------------------------------------------ */

/** Convert Markdown (as an agent writes it) to ADF: paragraphs, headings, lists, task lists, code, quotes, rules, tables, links, emphasis. Raw HTML is kept as text. */
export function markdownToAdf(markdown: string): AdfDocument {
  return { version: 1, type: 'doc', content: tokensToBlocks(marked.lexer(markdown, { gfm: true })) };
}

type InlineToken = Token;
function tokensToBlocks(tokens: readonly Token[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space': break;
      case 'paragraph': { const content = toInline((token as Tokens.Paragraph).tokens); out.push(content.length ? { type: 'paragraph', content } : { type: 'paragraph' }); break; }
      case 'text': { const t = token as Tokens.Text; out.push({ type: 'paragraph', content: toInline(t.tokens ?? [{ type: 'text', raw: t.raw, text: t.text } as Token]) }); break; }
      case 'heading': { const h = token as Tokens.Heading; out.push({ type: 'heading', attrs: { level: Math.min(6, h.depth) }, content: toInline(h.tokens) }); break; }
      case 'code': { const c = token as Tokens.Code; out.push({ type: 'codeBlock', ...(c.lang ? { attrs: { language: c.lang } } : {}), ...(c.text ? { content: [{ type: 'text', text: c.text }] } : {}) }); break; }
      case 'blockquote': out.push({ type: 'blockquote', content: tokensToBlocks((token as Tokens.Blockquote).tokens) }); break;
      case 'hr': out.push({ type: 'rule' }); break;
      case 'list': out.push(listNode(token as Tokens.List)); break;
      case 'table': out.push(tableNode(token as Tokens.Table)); break;
      case 'html': { const text = (token as Tokens.HTML).text.trim(); if (text) out.push({ type: 'paragraph', content: [{ type: 'text', text }] }); break; }
      default: if ('raw' in token && String(token.raw).trim()) out.push({ type: 'paragraph', content: [{ type: 'text', text: String(token.raw).trim() }] });
    }
  }
  return out;
}
function listNode(list: Tokens.List): AdfNode {
  if (list.items.length && list.items.every(item => item.task)) {
    return { type: 'taskList', attrs: { localId: localId() }, content: list.items.map(item => ({ type: 'taskItem', attrs: { localId: localId(), state: item.checked ? 'DONE' : 'TODO' }, content: toInline(item.tokens.filter(t => t.type !== 'checkbox').flatMap(t => t.type === 'text' || t.type === 'paragraph' ? (t as Tokens.Text).tokens ?? [t] : [])) })) };
  }
  const items = list.items.map(item => {
    const content = tokensToBlocks(item.tokens.filter(t => t.type !== 'checkbox'));
    return { type: 'listItem', content: content.length ? content : [{ type: 'paragraph' }] };
  });
  const start = Number(list.start);
  return list.ordered ? { type: 'orderedList', attrs: { order: Number.isInteger(start) && start > 0 ? start : 1 }, content: items } : { type: 'bulletList', content: items };
}
function tableNode(table: Tokens.Table): AdfNode {
  const row = (cells: Tokens.TableCell[], type: 'tableHeader' | 'tableCell'): AdfNode => ({ type: 'tableRow', content: cells.map(c => { const content = toInline(c.tokens); return { type, attrs: {}, content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }] }; }) });
  return { type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: [row(table.header, 'tableHeader'), ...table.rows.map(r => row(r, 'tableCell'))] };
}
const localId = () => crypto.randomUUID();

/** Inline tokens to ADF text nodes; marks accumulate through nesting. */
function toInline(tokens: readonly InlineToken[] | undefined, marks: AdfMark[] = []): AdfNode[] {
  const out: AdfNode[] = [];
  const text = (value: string, extra: AdfMark[] = []) => {
    if (!value) return;
    const all = [...marks, ...extra];
    const last = out.at(-1);
    if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(all)) { last.text += value; return; }
    out.push(all.length ? { type: 'text', text: value, marks: all } : { type: 'text', text: value });
  };
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'text': { const t = token as Tokens.Text; if (t.tokens?.length) out.push(...toInline(t.tokens, marks)); else text(decode(t.text)); break; }
      case 'escape': text((token as Tokens.Escape).text); break;
      case 'strong': out.push(...toInline((token as Tokens.Strong).tokens, [...marks, { type: 'strong' }])); break;
      case 'em': out.push(...toInline((token as Tokens.Em).tokens, [...marks, { type: 'em' }])); break;
      case 'del': out.push(...toInline((token as Tokens.Del).tokens, [...marks, { type: 'strike' }])); break;
      case 'codespan': text(decode((token as Tokens.Codespan).text), [{ type: 'code' }]); break;
      case 'br': out.push({ type: 'hardBreak' }); break;
      case 'link': {
        const link = token as Tokens.Link;
        const href = /^(https?:|mailto:)/i.test(link.href) ? link.href : undefined;
        if (!href) { text(link.raw); break; }
        out.push(...toInline(link.tokens, [...marks, { type: 'link', attrs: { href } }]));
        break;
      }
      case 'image': { const image = token as Tokens.Image; text(image.raw); break; }
      case 'html': text((token as Tokens.HTML).raw); break;
      default: text('raw' in token ? String(token.raw) : '');
    }
  }
  return merge(out);
}
/** Marked keeps HTML entities in text; ADF stores the characters. */
const decode = (value: string) => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" } as Record<string, string>)[name]!);
function merge(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (node.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) last.text = (last.text ?? '') + (node.text ?? '');
    else out.push(node);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Protected elements                                                  */
/* ------------------------------------------------------------------ */

/**
 * A protected element: something an edit through Markdown would lose, keyed
 * so that the same element before and after compares equal.
 */
export type ProtectedElement = { key: string; label: string };

const PROTECTED_NODES: Record<string, (node: AdfNode) => string> = {
  mention: n => `mention ${str(attr(n, 'text')) || str(attr(n, 'id'))}`,
  media: n => `image or file ${str(attr(n, 'alt')) || str(attr(n, 'id')) || str(attr(n, 'url'))}`.trim(),
  mediaInline: n => `file ${str(attr(n, 'alt')) || str(attr(n, 'id'))}`,
  mediaSingle: () => 'image', mediaGroup: () => 'file group',
  status: n => `status "${str(attr(n, 'text'))}"`,
  emoji: n => `emoji ${str(attr(n, 'shortName'))}`,
  date: n => `date ${str(attr(n, 'timestamp'))}`,
  inlineCard: n => `link card ${str(attr(n, 'url'))}`, blockCard: n => `link card ${str(attr(n, 'url'))}`, embedCard: n => `embed ${str(attr(n, 'url'))}`,
  extension: n => `macro ${str(attr(n, 'extensionKey'))}`, bodiedExtension: n => `macro ${str(attr(n, 'extensionKey'))}`, inlineExtension: n => `macro ${str(attr(n, 'extensionKey'))}`, multiBodiedExtension: n => `macro ${str(attr(n, 'extensionKey'))}`,
  panel: n => `${str(attr(n, 'panelType')) || 'info'} panel`,
  expand: n => `expand "${str(attr(n, 'title'))}"`, nestedExpand: n => `expand "${str(attr(n, 'title'))}"`,
  layoutSection: () => 'column layout', layoutColumn: () => 'layout column',
  taskItem: n => `task (${str(attr(n, 'state')) || 'TODO'})`, taskList: () => 'task list',
  decisionItem: n => `decision (${str(attr(n, 'state'))})`, decisionList: () => 'decision list',
  placeholder: n => `placeholder "${str(attr(n, 'text'))}"`,
  syncBlock: () => 'synced block', bodiedSyncBlock: () => 'synced block',
};
const PROTECTED_MARKS: Record<string, (mark: AdfMark) => string> = {
  textColor: m => `text colour ${str(m.attrs?.color)}`, backgroundColor: m => `highlight ${str(m.attrs?.color)}`,
  annotation: () => 'inline comment', alignment: m => `alignment ${str(m.attrs?.align)}`, indentation: m => `indentation ${str(m.attrs?.level)}`,
  breakout: m => `width ${str(m.attrs?.mode)}`, subsup: m => str(m.attrs?.type) === 'sub' ? 'subscript' : 'superscript', underline: () => 'underline',
  border: () => 'image border', dataConsumer: () => 'data link', fragment: () => 'fragment', fontSize: () => 'font size',
};
/** Attributes that identify a protected element (others, like generated local IDs, may change). */
const IDENTITY: Record<string, readonly string[]> = {
  mention: ['id'], media: ['id', 'url', 'collection'], mediaInline: ['id', 'collection'], status: ['text', 'color'], emoji: ['shortName', 'id'], date: ['timestamp'],
  inlineCard: ['url'], blockCard: ['url'], embedCard: ['url'], extension: ['extensionKey', 'parameters'], bodiedExtension: ['extensionKey', 'parameters'], inlineExtension: ['extensionKey', 'parameters'], multiBodiedExtension: ['extensionKey', 'parameters'],
  panel: ['panelType'], expand: ['title'], nestedExpand: ['title'], taskItem: ['state'], decisionItem: ['state'], placeholder: ['text'],
};
const stable = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

/**
 * Every protected element of some ADF nodes (in document order). Tables
 * count too when a cell has a colour, a span or a width, which Markdown
 * cannot express.
 */
export function protectedElements(nodes: readonly AdfNode[]): ProtectedElement[] {
  const out: ProtectedElement[] = [];
  const walk = (node: AdfNode) => {
    const describe = PROTECTED_NODES[node.type];
    if (describe) out.push({ key: `node:${node.type}:${stable((IDENTITY[node.type] ?? []).map(k => node.attrs?.[k]))}:${node.type === 'taskItem' || node.type === 'decisionItem' ? createHash('sha256').update(stable(node.content ?? [])).digest('hex').slice(0, 12) : ''}`, label: describe(node) });
    if ((node.type === 'tableCell' || node.type === 'tableHeader') && node.attrs && (node.attrs.background || Number(node.attrs.colspan ?? 1) > 1 || Number(node.attrs.rowspan ?? 1) > 1 || node.attrs.colwidth)) out.push({ key: `node:${node.type}:${stable([node.attrs.background, node.attrs.colspan, node.attrs.rowspan])}`, label: 'table cell formatting (colour, merged cells or widths)' });
    for (const mark of node.marks ?? []) {
      const label = PROTECTED_MARKS[mark.type];
      if (label) out.push({ key: `mark:${mark.type}:${stable(mark.attrs ?? {})}:${node.text ?? ''}`, label: `${label(mark)}${node.text ? ` on "${node.text.length > 30 ? `${node.text.slice(0, 29)}…` : node.text}"` : ''}` });
    }
    for (const child of node.content ?? []) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

/** Protected elements of `before` that are missing from `after` (each label once, with a count). */
export function lostElements(before: readonly AdfNode[], after: readonly AdfNode[]): string[] {
  const remaining = new Map<string, number>();
  for (const element of protectedElements(after)) remaining.set(element.key, (remaining.get(element.key) ?? 0) + 1);
  const lost = new Map<string, number>();
  for (const element of protectedElements(before)) {
    const left = remaining.get(element.key) ?? 0;
    if (left > 0) remaining.set(element.key, left - 1);
    else lost.set(element.label, (lost.get(element.label) ?? 0) + 1);
  }
  return [...lost].map(([label, count]) => count > 1 ? `${label} (×${count})` : label);
}

/* ------------------------------------------------------------------ */
/* Block splice                                                        */
/* ------------------------------------------------------------------ */

/** One changed region of a spliced document: original top-level blocks `[from, to)` replaced by `after`. */
export type SpliceChange = { from: number; to: number; before: AdfNode[]; after: AdfNode[]; beforeMarkdown: string; afterMarkdown: string };
/** Result of {@link spliceMarkdown}. */
export type SpliceResult =
  | { ok: true; unchanged: true; doc: AdfDocument; changes: [] }
  | { ok: true; unchanged: false; doc: AdfDocument; changes: SpliceChange[] }
  | { ok: false; reason: 'protected'; lost: string[]; changes: SpliceChange[]; message: string }
  | { ok: false; reason: 'invalid'; errors: string[]; changes: SpliceChange[]; message: string };

/** Split Markdown into top-level blocks the way {@link adfToMarkdown} writes them (blank lines outside fences). */
export function splitBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  const flush = () => { if (current.length) { out.push(current.join('\n').replace(/\s+$/, '')); current = []; } };
  for (const line of lines) {
    if (fence) { current.push(line); if (line.trim().startsWith(fence) && line.trim().replace(/`+|~+/, '') === '') fence = undefined; continue; }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) { fence = open[1]; current.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    current.push(line);
  }
  flush();
  return out.filter(Boolean);
}

/**
 * Longest common subsequence of two block lists, as matched index pairs.
 * Blocks are compared by their exact Markdown.
 */
function matchBlocks(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length, m = b.length;
  // Trim the common prefix and suffix first (the usual edit touches a few blocks).
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let end = 0;
  while (end < n - start && end < m - start && a[n - 1 - end] === b[m - 1 - end]) end++;
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  const A = a.slice(start, n - end), B = b.slice(start, m - end);
  if (A.length * B.length > 4_000_000) throw new Error('Document too large to compare');
  const table = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) table[i]![j] = A[i] === B[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  for (let i = 0, j = 0; i < A.length && j < B.length;) {
    if (A[i] === B[j]) { pairs.push([start + i, start + j]); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++; else j++;
  }
  for (let k = 0; k < end; k++) pairs.push([n - end + k, m - end + k]);
  return pairs;
}

/**
 * Apply an edited Markdown version of `original` (as {@link adfToMarkdown}
 * wrote it) back to the document.
 *
 * Blocks are matched by their exact Markdown. Unchanged blocks keep their
 * original ADF verbatim. Between two unchanged blocks, the edited Markdown
 * replaces exactly the original blocks that lay between them (so an appended
 * paragraph is an insertion, never an edit of its neighbour). Each changed
 * region is converted with {@link markdownToAdf}; if it would lose a
 * protected element ({@link lostElements}), or the result is not valid ADF,
 * nothing is written and the result names why.
 */
export function spliceMarkdown(original: AdfDocument, edited: string, options: MarkdownOptions = {}): SpliceResult {
  const before = blockMarkdown(original, options);
  // Empty paragraphs export as nothing; keep them aligned to their (empty) Markdown.
  const kept = before.map((text, index) => ({ text, index })).filter(b => b.text !== '');
  const after = splitBlocks(edited);
  const pairs = matchBlocks(kept.map(b => b.text), after);
  const changes: SpliceChange[] = [];
  const content: AdfNode[] = [];
  let ai = 0, bi = 0, oi = 0;
  const region = (endKept: number, endAfter: number, nextOriginal: number) => {
    const from = oi, to = nextOriginal;
    const removed = original.content.slice(from, to);
    const added = after.slice(bi, endAfter);
    const removedText = kept.slice(ai, endKept).map(b => b.text);
    if (removedText.length || added.length) {
      const markdown = added.join(SEPARATOR);
      const converted = markdown ? markdownToAdf(markdown).content : [];
      changes.push({ from, to, before: removed, after: converted, beforeMarkdown: removedText.join(SEPARATOR), afterMarkdown: markdown });
      // Empty paragraphs inside the edited range are dropped with it only if they were between edited blocks.
      content.push(...converted);
    } else content.push(...removed);
  };
  for (const [k, j] of pairs) {
    const originalIndex = kept[k]!.index;
    region(k, j, originalIndex);
    content.push(original.content[originalIndex]!);
    ai = k + 1; bi = j + 1; oi = originalIndex + 1;
  }
  region(kept.length, after.length, original.content.length);
  if (!changes.length) return { ok: true, unchanged: true, doc: original, changes: [] };
  const lost = changes.flatMap(change => lostElements(change.before, change.after));
  if (lost.length) {
    const unique = [...new Set(lost)];
    return { ok: false, reason: 'protected', lost: unique, changes, message: `This edit would remove or change ${unique.join(', ')}, which Markdown cannot express. Nothing was written. Keep the blocks that contain them exactly as they are (edit other blocks), or ask the user to change them in Atlassian.` };
  }
  const doc: AdfDocument = { version: 1, type: 'doc', content };
  const valid = validateAdf(doc);
  if (!valid.valid) return { ok: false, reason: 'invalid', errors: valid.errors, changes, message: `The edited Markdown does not convert to a valid Atlassian document (${valid.errors.join('; ')}). Nothing was written.` };
  return { ok: true, unchanged: false, doc, changes };
}

/** A stable SHA-256 of a document (keys sorted), to detect concurrent changes. */
export function adfHash(doc: unknown): string {
  return createHash('sha256').update(stable(doc ?? null)).digest('hex');
}
