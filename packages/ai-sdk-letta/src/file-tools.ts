import { tool, jsonSchema, type Tool } from 'ai';
import { FileInputError, describeFile, formatBytes, type StoredFile } from './attachments.js';
import { AttachmentStore, RESOURCE_LIMITS } from './resources.js';
import { pdfPageImages } from './pdf.js';
import type { ToolPermission } from './definition.js';

/** Names of the built-in file tools. */
export const FILE_TOOL_NAMES = ['list_files', 'read_file', 'search_files'] as const;
export type FileToolName = typeof FILE_TOOL_NAMES[number];

/**
 * Key under which the tool bridge passes the active conversation's
 * {@link AttachmentStore} to tools (`options.context[ATTACHMENTS_CONTEXT]`).
 * The runtime binds it when it opens a conversation: names resolve in that
 * conversation's folder, or from the agent's resources root with a leading
 * `/`; nothing the model sends can reach outside the root.
 */
export const ATTACHMENTS_CONTEXT = 'ai-sdk-letta.attachments';

/** Bounds for what the file tools return to the model. */
export const READ_LIMITS = Object.freeze({
  /** Most characters of file text in one `read_file` result. */
  maxChars: 12_000,
  /** Most PDF pages in one `read_file` call. */
  maxPages: 20,
  /** Most pages without text rendered to images in one call. */
  maxImagePages: 2,
  /** Most passages in one `search_files` result. */
  maxResults: 20,
  /** Most characters of one `search_files` result. */
  maxSearchChars: 8_000,
  /** Longest snippet per passage. */
  snippetChars: 240,
});

/** What a file tool returns: text for the model, plus page images when a page has no text. */
export interface FileToolOutput { text: string; images?: { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }[]; isError?: boolean }

type Context = Record<string, unknown> | undefined;
function storeOf(context: Context): AttachmentStore {
  const store = context?.[ATTACHMENTS_CONTEXT];
  if (!(store instanceof AttachmentStore)) throw new FileInputError('files_unavailable', 'Files are not available in this session');
  return store;
}
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const quote = (value: string) => JSON.stringify(value);
const errorOutput = (error: unknown): FileToolOutput => {
  if (error instanceof FileInputError) return { text: `Error (${error.code}): ${error.message}`, isError: true };
  throw error;
};
/** Add the available names to a not-found error, so the model can correct itself. */
function notFound(store: AttachmentStore, error: unknown): never {
  if (error instanceof FileInputError && (error.code === 'file_not_found' || error.code === 'file_name_invalid')) {
    const names = store.list().map(f => f.name).slice(0, 30);
    throw new FileInputError(error.code, `${error.message}. ${names.length ? `Files in this conversation's folder: ${names.map(quote).join(', ')}.` : 'This conversation\'s folder is empty.'} Other folders: list_files with folder "/".`);
  }
  throw error;
}

/**
 * Convert a file tool's output for the model. Results restored from Letta
 * (or replayed by the AI SDK) arrive as the plain text the model saw; they
 * are returned unchanged.
 */
function toModelOutput({ output }: { output: unknown }) {
  if (typeof output === 'string') return { type: 'text' as const, value: output };
  const result = output as FileToolOutput;
  if (result.isError) return { type: 'error-text' as const, value: result.text };
  if (!result.images?.length) return { type: 'text' as const, value: result.text };
  return { type: 'content' as const, value: [{ type: 'text' as const, text: result.text }, ...result.images.map(image => ({ type: 'file' as const, mediaType: image.mediaType, data: { type: 'data' as const, data: image.data } }))] };
}

/* ------------------------------------------------------------------ */
/* Ranges                                                              */
/* ------------------------------------------------------------------ */

/**
 * Parse a 1-based inclusive range such as "3", "2-5", "2–5" or "10-" (to
 * the end), optionally prefixed with "page(s)" or "line(s)".
 * @throws {FileInputError} `file_range_invalid`
 */
export function parseRange(input: string | undefined, total: number, unit: 'page' | 'line'): { start: number; end: number } {
  if (input === undefined || !input.trim()) return { start: 1, end: total };
  const clean = input.trim().toLowerCase().replace(/^(pages?|lines?|pp?\.?|l\.?)\s*/, '');
  const match = /^(\d{1,9})\s*(?:(?:-|–|—|\.\.|to)\s*(\d{1,9})?)?$/.exec(clean);
  const bad = (why: string) => new FileInputError('file_range_invalid', `Invalid range ${quote(input)}: ${why}. Use a ${unit} number like "3" or a range like "2-5" (1 to ${total.toLocaleString('en-US')})`);
  if (!match) throw bad('not a number or range');
  const start = Number(match[1]);
  const open = /(-|–|—|\.\.|to)\s*$/.test(clean);
  const end = match[2] !== undefined ? Number(match[2]) : open ? total : start;
  if (start < 1 || end < start) throw bad('the start must be at least 1 and not after the end');
  if (start > total) throw bad(`this file has ${plural(total, unit)}`);
  return { start, end: Math.min(end, total) };
}
const span = (start: number, end: number) => start === end ? String(start) : `${start}–${end}`;
const rangeArg = (start: number, end: number) => start === end ? String(start) : `${start}-${end}`;

/* ------------------------------------------------------------------ */
/* list_files                                                          */
/* ------------------------------------------------------------------ */

function listLine(file: StoredFile) { return `- ${file.name} (${describeFile(file)})`; }

/**
 * Text of `list_files`: one line per file with its type, size and page or
 * line count, in this conversation's folder (default) or another folder
 * (`"/"` lists every conversation's folder).
 */
export function listFiles(store: AttachmentStore, folder?: string): FileToolOutput {
  const all = folder !== undefined && folder.trim() !== '' && folder.trim() !== '.';
  const scope = all ? `/${store.resolvePath(folder!)}`.replace(/\/$/, '') || '/' : 'this conversation\'s folder';
  const scanned = store.scan(all ? folder : undefined);
  const files = scanned.files.slice(0, RESOURCE_LIMITS.maxListed);
  const where = all ? scope : `this conversation's folder (/${store.path})`;
  if (!files.length && !scanned.others.length) return { text: all ? `No files in ${scope}.` : `No files in ${where}. Other conversations' files: list_files with folder "/".` };
  const total = scanned.files.reduce((sum, f) => sum + f.bytes, 0);
  const more = scanned.files.length > files.length || scanned.truncated ? `\n[Showing ${files.length} of ${scanned.files.length}${scanned.truncated ? '+' : ''} files; pass a folder to narrow.]` : '';
  const others = scanned.others.length ? `\nOther files (not readable as text, PDF or image): ${scanned.others.slice(0, 30).map(quote).join(', ')}${scanned.others.length > 30 ? ', …' : ''}` : '';
  const hint = all ? '' : '\nOther conversations\' files: list_files with folder "/".';
  return { text: `${plural(scanned.files.length, 'file')} in ${where} (${formatBytes(total)}):\n${files.map(listLine).join('\n')}${more}${others}\n\nRead with read_file (use a page or line range); find passages with search_files.${hint}` };
}

/* ------------------------------------------------------------------ */
/* read_file                                                           */
/* ------------------------------------------------------------------ */

const splitLines = (text: string) => { const lines = text.split(/\r\n|\r|\n/); if (lines.length > 1 && lines.at(-1) === '') lines.pop(); return lines; };

/**
 * Text of `read_file`: a PDF's pages or a text file's lines in `range`,
 * bounded by {@link READ_LIMITS}. The result says when it is truncated and
 * which range to read next. Pages without text come back as images when
 * the page holds one (a scan), or with a notice otherwise.
 */
export async function readFile(store: AttachmentStore, name: string, range?: string, signal?: AbortSignal): Promise<FileToolOutput> {
  let content: Awaited<ReturnType<AttachmentStore['content']>>;
  let file: StoredFile;
  try { file = store.get(name); } catch (error) { notFound(store, error); }
  if (file.kind === 'image') {
    const { bytes } = store.read(file.name);
    return { text: `${file.name} (${describeFile(file)}). The image is attached below.`, images: [{ mediaType: file.mediaType as 'image/png', data: bytes.toString('base64') }] };
  }
  content = await store.content(file.name, signal);
  file = content.file;
  const limit = READ_LIMITS.maxChars;
  if ('text' in content) {
    const lines = splitLines(content.text);
    if (!lines.length || (lines.length === 1 && !lines[0])) return { text: `${file.name} (${describeFile(file)}) is empty.` };
    const { start, end } = parseRange(range, lines.length, 'line');
    let used = 0;
    let last = start - 1;
    const out: string[] = [];
    let cut = '';
    for (let n = start; n <= end; n++) {
      const line = lines[n - 1]!;
      if (used + line.length + 1 > limit) {
        if (n === start) {
          out.push(line.slice(0, limit));
          last = n;
          cut = `\n[Line ${n} has ${line.length.toLocaleString('en-US')} characters; only the first ${limit.toLocaleString('en-US')} are shown. Use search_files to find specific values in it.]`;
        }
        break;
      }
      out.push(line); used += line.length + 1; last = n;
    }
    const header = `${file.name} (${describeFile(file)}): lines ${span(start, last)} of ${lines.length.toLocaleString('en-US')}`;
    const more = last < end
      ? `\n\n[Truncated at the ${limit.toLocaleString('en-US')}-character limit: showing lines ${span(start, last)}. To continue, call read_file with name ${quote(file.name)} and range "${rangeArg(last + 1, Math.min(end, lines.length))}".]`
      : last < lines.length ? `\n\n[End of the requested range. The file continues to line ${lines.length.toLocaleString('en-US')}.]` : '';
    return { text: `${header}\n\n${out.join('\n')}${cut}${more}` };
  }
  const pages = content.pages;
  const total = file.pages ?? pages.length;
  if (!pages.length) return { text: `${file.name} (${describeFile(file)}) has no pages.` };
  const requested = parseRange(range, pages.length, 'page');
  const end = Math.min(requested.end, requested.start + READ_LIMITS.maxPages - 1);
  const parts: string[] = [];
  const empty: number[] = [];
  let used = 0;
  let last = requested.start - 1;
  let cut = '';
  for (let n = requested.start; n <= end; n++) {
    const text = pages[n - 1]!;
    const block = `--- Page ${n} ---\n${text || '(no text layer)'}`;
    if (used + block.length + 2 > limit) {
      if (n === requested.start) {
        parts.push(block.slice(0, limit));
        last = n;
        cut = `\n[Page ${n} has ${text.length.toLocaleString('en-US')} characters; only the first ${(limit - 20).toLocaleString('en-US')} are shown. Use search_files to find specific passages on it.]`;
      }
      break;
    }
    parts.push(block); used += block.length + 2; last = n;
    if (!text) empty.push(n);
  }
  // Pages without a text layer: return the page's own image if it has one (a scan).
  let images: FileToolOutput['images'] = [];
  const notes: string[] = [];
  if (empty.length) {
    const wanted = empty.slice(0, READ_LIMITS.maxImagePages);
    let found: Awaited<ReturnType<typeof pdfPageImages>> = [];
    try { found = await pdfPageImages(store.read(file.name).bytes, wanted, { signal }); } catch { signal?.throwIfAborted(); found = []; }
    images = found.map(image => ({ mediaType: 'image/png' as const, data: image.png.toString('base64') }));
    const withImage = new Set(found.map(image => image.page));
    const shown = wanted.filter(n => withImage.has(n));
    const blank = empty.filter(n => !withImage.has(n));
    if (shown.length) notes.push(`[${shown.length === 1 ? `Page ${shown[0]} has` : `Pages ${shown.join(', ')} have`} no text layer (likely scanned); ${shown.length === 1 ? 'its image is' : 'their images are'} attached below in page order.]`);
    const skipped = blank.filter(n => !wanted.includes(n) || !withImage.has(n));
    const unread = skipped.filter(n => wanted.includes(n));
    const later = skipped.filter(n => !wanted.includes(n));
    if (unread.length) notes.push(`[${unread.length === 1 ? `Page ${unread[0]} has` : `Pages ${unread.join(', ')} have`} no extractable text (it may be a drawing or an unsupported scan).]`);
    if (later.length) notes.push(`[${later.length === 1 ? `Page ${later[0]} has` : `Pages ${later.join(', ')} have`} no text layer. To see ${later.length === 1 ? 'it' : 'them'} as images, call read_file for at most ${READ_LIMITS.maxImagePages} such pages at a time.]`);
  }
  const header = `${file.name} (${describeFile(file)}): pages ${span(requested.start, last)} of ${total.toLocaleString('en-US')}`;
  const next = Math.min(requested.end, pages.length);
  const more = last < next
    ? `\n\n[Truncated${last < end ? ` at the ${limit.toLocaleString('en-US')}-character limit` : ` at ${READ_LIMITS.maxPages} pages per call`}: showing pages ${span(requested.start, last)}. To continue, call read_file with name ${quote(file.name)} and range "${rangeArg(last + 1, Math.min(next, last + READ_LIMITS.maxPages))}".]`
    : '';
  const omitted = total > pages.length ? `\n[Only the first ${pages.length.toLocaleString('en-US')} pages of this PDF can be read.]` : '';
  return { text: `${header}\n\n${parts.join('\n\n')}${cut}${notes.length ? `\n\n${notes.join('\n')}` : ''}${more}${omitted}`, ...(images.length ? { images } : {}) };
}

/* ------------------------------------------------------------------ */
/* search_files                                                        */
/* ------------------------------------------------------------------ */

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const terms = (query: string) => [...new Set(fold(query).split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2))].slice(0, 12);

/** Cut `line` to about `size` characters around `index`. */
function snippet(line: string, index: number, size = READ_LIMITS.snippetChars): string {
  const clean = line.replace(/\s+/g, ' ').trim();
  if (clean.length <= size) return clean;
  const at = Math.max(0, Math.min(clean.length - size, index - Math.floor(size / 3)));
  return `${at > 0 ? '…' : ''}${clean.slice(at, at + size).trim()}${at + size < clean.length ? '…' : ''}`;
}

/**
 * Text of `search_files`: passages (lines) that contain the query, or most
 * of its words, with the file name and page or line number. Case- and
 * accent-insensitive. Images are not searched.
 */
export async function searchFiles(store: AttachmentStore, query: string, name?: string, signal?: AbortSignal, folder?: string): Promise<FileToolOutput> {
  const phrase = fold(query.trim().replace(/\s+/g, ' '));
  const words = terms(query);
  if (!phrase) throw new FileInputError('file_range_invalid', 'Search for at least one word');
  let files: StoredFile[];
  if (name !== undefined) { try { files = [store.get(name)]; } catch (error) { notFound(store, error); } }
  else files = store.list(folder);
  const searchable = files.filter(f => f.kind !== 'image').slice(0, 500);
  if (!searchable.length) return { text: files.length ? 'Only images here; they cannot be searched. Use read_file to look at one.' : 'No files here. Other conversations\' files: search_files with folder "/".' };
  type Hit = { file: string; where: string; text: string; score: number; order: number };
  const hits: Hit[] = [];
  let order = 0;
  const need = Math.max(1, Math.ceil(words.length * 0.6));
  const consider = (file: StoredFile, where: string, line: string) => {
    order++;
    const folded = fold(line);
    const at = folded.indexOf(phrase);
    if (at >= 0) { hits.push({ file: file.name, where, text: snippet(line, at), score: 1000, order }); return; }
    if (words.length < 2) return;
    let count = 0; let first = -1;
    for (const word of words) { const i = folded.indexOf(word); if (i >= 0) { count++; if (first < 0 || i < first) first = i; } }
    if (count >= need) hits.push({ file: file.name, where, text: snippet(line, first), score: count, order });
  };
  for (const file of searchable) {
    signal?.throwIfAborted();
    let content;
    try { content = await store.content(file.name, signal); } catch { continue; }
    if ('text' in content) splitLines(content.text).forEach((line, i) => consider(file, `line ${(i + 1).toLocaleString('en-US')}`, line));
    else content.pages.forEach((page, i) => { for (const line of splitLines(page)) consider(file, `page ${i + 1}`, line); });
  }
  if (!hits.length) return { text: `No passages found for ${quote(query.trim())} in ${plural(searchable.length, 'file')}${files.length > searchable.length ? ' (images are not searched)' : ''}. Try other words, or read_file to look through a file.` };
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  const lines: string[] = [];
  let used = 0;
  for (const hit of hits.slice(0, READ_LIMITS.maxResults)) {
    const line = `${hit.file}, ${hit.where}: ${hit.text}`;
    if (used + line.length + 1 > READ_LIMITS.maxSearchChars) break;
    lines.push(line); used += line.length + 1;
  }
  const exact = hits.filter(h => h.score === 1000).length;
  const fileCount = new Set(hits.map(h => h.file)).size;
  const summary = `Found ${plural(hits.length, 'passage')} for ${quote(query.trim())} in ${plural(fileCount, 'file')}${exact < hits.length ? ` (${exact} exact; others contain most of the words)` : ''}${lines.length < hits.length ? `, showing the first ${lines.length}. Narrow the query or pass name to search one file` : ''}.`;
  return { text: `${summary}\n\n${lines.join('\n')}\n\nFor more context, call read_file with that page or a line range around it.` };
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

type ListInput = { folder?: string };
type ReadInput = { name: string; range?: string };
type SearchInput = { query: string; name?: string; folder?: string };
const nameSchema = { type: 'string', minLength: 1, maxLength: 1024, description: 'File path as list_files shows it: relative to this conversation\'s folder, or from the root with a leading "/".' } as const;
const folderSchema = { type: 'string', maxLength: 1024, description: 'Folder to list instead of this conversation\'s: "/" for all resources, or a path like "/Other chat".' } as const;

/**
 * Built-in tools to read the agent's resources: the files the user attached
 * or uploaded, and files the agent made, one folder per conversation. Names
 * resolve in the current conversation's folder (bound by the runtime) or from
 * the resources root with a leading `/`; never outside it, never through links.
 *
 * Add them to a definition, with permissions, to accept file attachments:
 * ```ts
 * tools: { ...fileTools, my_tool }, permissions: { ...FILE_TOOL_PERMISSIONS, my_tool: 'ask' }
 * ```
 */
export const fileTools: { list_files: Tool<ListInput, FileToolOutput>; read_file: Tool<ReadInput, FileToolOutput>; search_files: Tool<SearchInput, FileToolOutput> } = {
  list_files: tool({
    description: 'List files with type, size and page or line count: this conversation\'s folder by default; folder "/" lists all resources (one folder per conversation).',
    inputSchema: jsonSchema<ListInput>({ type: 'object', properties: { folder: folderSchema }, additionalProperties: false }),
    execute: async ({ folder } = {}, options) => { try { return listFiles(storeOf(options.context as Context), folder); } catch (error) { return errorOutput(error); } },
    toModelOutput,
  }),
  read_file: tool({
    description: `Read a file (path as list_files shows it; "/" starts at the root, for other conversations' folders). For PDFs, pass the pages you need as range (e.g. "3" or "2-4"; up to ${READ_LIMITS.maxPages} per call); for text files, a line range (e.g. "1-200"). Read only what you need: list_files shows page and line counts, and search_files finds where something is. Results are limited to about ${READ_LIMITS.maxChars.toLocaleString('en-US')} characters and say how to read more. Pages without text (scans) come back as images, and images can be viewed.`,
    inputSchema: jsonSchema<ReadInput>({ type: 'object', properties: { name: nameSchema, range: { type: 'string', maxLength: 40, description: 'Pages for a PDF ("3", "2-5", "10-") or lines for a text file ("1-200"). Omit to start at the beginning.' } }, required: ['name'], additionalProperties: false }),
    execute: async ({ name, range }, options) => { try { return await readFile(storeOf(options.context as Context), name, range, options.abortSignal); } catch (error) { return errorOutput(error); } },
    toModelOutput,
  }),
  search_files: tool({
    description: 'Search the text of files (PDFs, text, CSV, JSON, code) in this conversation\'s folder, or in folder (e.g. "/" for all). Returns passages with file and page or line, to read further with read_file.',
    inputSchema: jsonSchema<SearchInput>({ type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words or a phrase to find (case- and accent-insensitive).' }, name: { ...nameSchema, description: 'Optional: search only this file.' }, folder: { ...folderSchema, description: 'Optional: search this folder instead ("/" for all resources).' } }, required: ['query'], additionalProperties: false }),
    execute: async ({ query, name, folder }, options) => { try { return await searchFiles(storeOf(options.context as Context), query, name, options.abortSignal, folder); } catch (error) { return errorOutput(error); } },
    toModelOutput,
  }),
};

/** Default policy for the file tools: they only read the agent's own resources. */
export const FILE_TOOL_PERMISSIONS: Readonly<Record<FileToolName, ToolPermission>> = Object.freeze({ list_files: 'allow', read_file: 'allow', search_files: 'allow' });

/** Does a definition accept file attachments? True when it includes the built-in `read_file` tool and does not deny it. */
export function filesEnabled(definition: { tools: object; permissions: Readonly<Record<string, ToolPermission>> }): boolean {
  return (definition.tools as Record<string, unknown>).read_file === fileTools.read_file && ['allow', 'ask'].includes(definition.permissions.read_file ?? 'deny');
}
