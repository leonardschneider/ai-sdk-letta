import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { sniffImageType } from './images.js';
import { extractPdfText, PdfError } from './pdf.js';

/**
 * Bounds for attached files. A message may carry at most `maxFilesPerMessage`
 * non-image files; images keep their own limits (`IMAGE_LIMITS`).
 */
export interface FileLimits { maxFileBytes: number; maxFilesPerMessage: number; maxConversationFiles: number; maxConversationBytes: number }
export const FILE_LIMITS: Readonly<FileLimits> = Object.freeze({
  /** Largest single file. */
  maxFileBytes: 25 * 1024 * 1024,
  /** Most files (not counting images) in one user turn. */
  maxFilesPerMessage: 8,
  /** Most files kept for one conversation (images included). */
  maxConversationFiles: 100,
  /** Largest combined size of one conversation's files. */
  maxConversationBytes: 250 * 1024 * 1024,
});

/** Machine-readable reason for {@link FileInputError}. */
export type FileInputErrorCode =
  | 'file_unsupported_type' // not plain text, Markdown, CSV, JSON, code, PDF or a supported image
  | 'file_invalid' // empty, unreadable, password-protected or not what its name says
  | 'file_too_large' // one file over maxFileBytes
  | 'files_too_many' // more than maxFilesPerMessage in one turn
  | 'conversation_files_full' // the conversation's folder would exceed its count or size limit
  | 'file_not_found' // no such file in this conversation
  | 'file_name_invalid' // a name that is not a plain file name of this folder
  | 'file_range_invalid' // a page or line range that does not fit the file
  | 'files_unavailable'; // this agent has no file tools, so it could not read an attachment

/** A rejected file. `code` is stable; `message` is human-readable. */
export class FileInputError extends Error {
  override readonly name = 'FileInputError';
  constructor(readonly code: FileInputErrorCode, message: string) { super(message); }
}

/** What a stored file is, by content. */
export type FileKind = 'text' | 'pdf' | 'image';
/** Metadata of a stored attachment. */
export interface StoredFile {
  name: string;
  kind: FileKind;
  mediaType: string;
  /** Short type label, e.g. "PDF", "CSV", "Markdown", "PNG image". */
  label: string;
  bytes: number;
  sha256: string;
  /** PDFs: number of pages. */
  pages?: number;
  /** Text: number of lines. */
  lines?: number;
  createdAt: string;
}
/** A file validated and held in staging, not yet part of the conversation. */
export interface StagedFile extends StoredFile { id: string }

const MB = 1024 * 1024;
/** "2.1 MB", "340 KB", "512 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1).replace(/\.0$/, '')} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} byte${bytes === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ */
/* Type detection                                                      */
/* ------------------------------------------------------------------ */

const TEXT_LABELS: Record<string, [string, string]> = {
  md: ['Markdown', 'text/markdown'], markdown: ['Markdown', 'text/markdown'], mdx: ['Markdown', 'text/markdown'],
  csv: ['CSV', 'text/csv'], tsv: ['TSV', 'text/tab-separated-values'], json: ['JSON', 'application/json'], jsonl: ['JSON Lines', 'application/jsonl'], ndjson: ['JSON Lines', 'application/jsonl'],
  txt: ['Text', 'text/plain'], text: ['Text', 'text/plain'], log: ['Log', 'text/plain'], rst: ['Text', 'text/plain'], adoc: ['Text', 'text/plain'],
  yaml: ['YAML', 'text/plain'], yml: ['YAML', 'text/plain'], toml: ['TOML', 'text/plain'], ini: ['INI', 'text/plain'], cfg: ['Config', 'text/plain'], conf: ['Config', 'text/plain'], env: ['Text', 'text/plain'],
  xml: ['XML', 'text/plain'], html: ['HTML', 'text/plain'], htm: ['HTML', 'text/plain'], css: ['CSS', 'text/plain'], scss: ['SCSS', 'text/plain'], svg: ['SVG', 'text/plain'],
  js: ['JavaScript', 'text/plain'], mjs: ['JavaScript', 'text/plain'], cjs: ['JavaScript', 'text/plain'], jsx: ['JavaScript', 'text/plain'], ts: ['TypeScript', 'text/plain'], tsx: ['TypeScript', 'text/plain'], mts: ['TypeScript', 'text/plain'], cts: ['TypeScript', 'text/plain'],
  py: ['Python', 'text/plain'], rb: ['Ruby', 'text/plain'], go: ['Go', 'text/plain'], rs: ['Rust', 'text/plain'], java: ['Java', 'text/plain'], kt: ['Kotlin', 'text/plain'], swift: ['Swift', 'text/plain'],
  c: ['C', 'text/plain'], h: ['C', 'text/plain'], cc: ['C++', 'text/plain'], cpp: ['C++', 'text/plain'], hpp: ['C++', 'text/plain'], cs: ['C#', 'text/plain'], php: ['PHP', 'text/plain'], scala: ['Scala', 'text/plain'],
  sh: ['Shell', 'text/plain'], bash: ['Shell', 'text/plain'], zsh: ['Shell', 'text/plain'], fish: ['Shell', 'text/plain'], ps1: ['PowerShell', 'text/plain'], sql: ['SQL', 'text/plain'], r: ['R', 'text/plain'], lua: ['Lua', 'text/plain'],
  vue: ['Vue', 'text/plain'], svelte: ['Svelte', 'text/plain'], dart: ['Dart', 'text/plain'], ex: ['Elixir', 'text/plain'], exs: ['Elixir', 'text/plain'], erl: ['Erlang', 'text/plain'], hs: ['Haskell', 'text/plain'], ml: ['OCaml', 'text/plain'], clj: ['Clojure', 'text/plain'],
  tex: ['LaTeX', 'text/plain'], bib: ['BibTeX', 'text/plain'], diff: ['Diff', 'text/plain'], patch: ['Diff', 'text/plain'], graphql: ['GraphQL', 'text/plain'], proto: ['Protobuf', 'text/plain'], tf: ['Terraform', 'text/plain'],
  gitignore: ['Text', 'text/plain'], dockerfile: ['Dockerfile', 'text/plain'], makefile: ['Makefile', 'text/plain'],
};
/** Extensions accepted as text (content must still be UTF-8 text). */
export const TEXT_EXTENSIONS: readonly string[] = Object.freeze(Object.keys(TEXT_LABELS));
const IMAGE_LABELS: Record<string, [string, string]> = { 'image/png': ['PNG image', 'png'], 'image/jpeg': ['JPEG image', 'jpg'], 'image/gif': ['GIF image', 'gif'], 'image/webp': ['WebP image', 'webp'] };
const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|pages|numbers|key|epub)$/i;

const extensionOf = (name: string) => {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot + 1) : ['dockerfile', 'makefile'].includes(lower) ? lower : '';
};

/**
 * Is this UTF-8 text? Valid UTF-8, no NUL bytes, and almost no other control
 * characters (tab, newline, carriage return and form feed are fine). A UTF-8
 * byte-order mark is allowed.
 */
export function isText(bytes: Uint8Array): boolean {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return false; }
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) return false;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12 && code !== 27) || code === 127) control++;
  }
  return control <= Math.max(2, text.length / 1000);
}

/** Decode text bytes (UTF-8, BOM dropped). Assumes {@link isText} passed. */
export const decodeText = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);
const lineCount = (text: string) => text ? text.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0) : 0;
const isPdf = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-');

/**
 * Detect a supported file type by content: PDF (by its header), PNG, JPEG,
 * GIF or WebP (by magic bytes), or UTF-8 text. The name only refines the
 * label of text files (CSV, Markdown, ...) and must not contradict the
 * content (a ".pdf" that is not a PDF is refused).
 * @throws {FileInputError}
 */
export function detectFileType(bytes: Uint8Array, name: string): { kind: FileKind; mediaType: string; label: string } {
  if (!bytes.byteLength) throw new FileInputError('file_invalid', `${name} is empty`);
  const extension = extensionOf(name);
  const image = sniffImageType(bytes);
  if (image) return { kind: 'image', mediaType: image, label: IMAGE_LABELS[image]![0] };
  if (isPdf(bytes)) return { kind: 'pdf', mediaType: 'application/pdf', label: 'PDF' };
  if (extension === 'pdf') throw new FileInputError('file_invalid', `${name} is not a valid PDF`);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) throw new FileInputError('file_invalid', `${name} is not a valid image`);
  if (OFFICE.test(name)) throw new FileInputError('file_unsupported_type', `${name}: Office documents are not supported yet; export it as PDF or text`);
  if (!isText(bytes)) throw new FileInputError('file_unsupported_type', `${name} is not a supported file; attach text, Markdown, CSV, JSON, code, PDF or an image`);
  const [label, mediaType] = TEXT_LABELS[extension] ?? ['Text', 'text/plain'];
  return { kind: 'text', mediaType, label };
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/** Longest stored file name, in characters. */
export const MAX_NAME_LENGTH = 120;

/**
 * A safe, plain file name: the last path segment only, NFC-normalized,
 * without control, formatting or path characters, not hidden, at most
 * {@link MAX_NAME_LENGTH} characters (the extension is kept).
 */
export function sanitizeFileName(input: string, fallback = 'file'): string {
  let name = String(input ?? '').split(/[\\/]/).pop()!.normalize('NFC');
  name = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/[<>:"|?*[\]{}$`]/g, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!name) name = fallback;
  if ([...name].length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = [...name.slice(0, name.length - extension.length)].slice(0, MAX_NAME_LENGTH - extension.length).join('').trim() + extension;
  }
  return name;
}

/** True for a name that {@link sanitizeFileName} leaves unchanged. */
export const isPlainFileName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && sanitizeFileName(name) === name;

/** Make the extension agree with the detected content (e.g. a PDF named "report" becomes "report.pdf"). */
function withExtension(name: string, type: { kind: FileKind; mediaType: string }): string {
  const extension = extensionOf(name);
  if (type.kind === 'pdf' && extension !== 'pdf') return sanitizeFileName(`${name}.pdf`);
  if (type.kind === 'image') {
    const wanted = IMAGE_LABELS[type.mediaType]![1];
    const ok = wanted === 'jpg' ? ['jpg', 'jpeg'].includes(extension) : extension === wanted;
    if (!ok) return sanitizeFileName(`${name.replace(/\.(png|jpe?g|gif|webp)$/i, '')}.${wanted}`);
  }
  return name;
}

/** "report.pdf" → "report (2).pdf". */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  return sanitizeFileName(`${[...base].slice(0, MAX_NAME_LENGTH - extension.length - 6).join('')} (${n})${extension}`);
}

/* ------------------------------------------------------------------ */
/* Message note                                                        */
/* ------------------------------------------------------------------ */

/** "PDF, 12 pages, 2.1 MB" */
export function describeFile(file: Pick<StoredFile, 'label' | 'bytes' | 'pages' | 'lines'>): string {
  const count = file.pages !== undefined ? `${file.pages} page${file.pages === 1 ? '' : 's'}` : file.lines !== undefined ? `${file.lines.toLocaleString('en-US')} line${file.lines === 1 ? '' : 's'}` : '';
  return [file.label, count, formatBytes(file.bytes)].filter(Boolean).join(', ');
}

const NOTE_PREFIX = 'Attached: ';
/** One line per file, e.g. "Attached: report.pdf (PDF, 12 pages, 2.1 MB)". This is all the model sees of a file until it reads it. */
export const attachmentNote = (files: readonly Pick<StoredFile, 'name' | 'label' | 'bytes' | 'pages' | 'lines'>[]): string => files.map(file => `${NOTE_PREFIX}${file.name} (${describeFile(file)})`).join('\n');

/** Append the note to a user's text, separated by a blank line. */
export const withAttachmentNote = (text: string, files: readonly Pick<StoredFile, 'name' | 'label' | 'bytes' | 'pages' | 'lines'>[]): string =>
  files.length ? `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${attachmentNote(files)}` : text;

/**
 * Split the attachment note off a user message: trailing "Attached: name (description)"
 * lines become `files`. Used to show file chips for restored history.
 */
export function parseAttachmentNote(text: string): { text: string; files: { name: string; description: string; label: string }[] } {
  const lines = text.split('\n');
  const files: { name: string; description: string; label: string }[] = [];
  while (lines.length) {
    const match = /^Attached: (.+) \(([^()\n]+)\)$/.exec(lines.at(-1)!.trimEnd());
    if (!match) break;
    files.unshift({ name: match[1]!, description: match[2]!, label: match[2]!.split(',')[0]!.trim() });
    lines.pop();
  }
  return { text: files.length ? lines.join('\n').trimEnd() : text, files };
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

const AGENT_ID = /^agent-[a-zA-Z0-9-]{1,100}$/;
const CONVERSATION_ID = /^(?:default|(?:conv-|local-conv-)[a-zA-Z0-9-]{1,100})$/;
const UPLOAD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
/** Staged uploads older than this are removed on the next upload. */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function syncDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Write a private (0600) file atomically: a unique temporary file, fsync, then a no-clobber link. Throws EEXIST if `path` exists. */
function writeNew(directory: string, path: string, data: Uint8Array | string) {
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
}
/** Replace a private sidecar atomically (rename over it). */
function writeReplace(directory: string, path: string, data: string) {
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
/** Read a regular, singly-linked file without following symlinks. */
function readPrivate(path: string, limit = Number.MAX_SAFE_INTEGER): Buffer {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new FileInputError('file_not_found', 'No such file');
    if (code === 'ELOOP' || code === 'EMLINK') throw new FileInputError('file_name_invalid', 'Refusing to follow a link');
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new FileInputError('file_name_invalid', 'Not a regular file');
    if (info.size > limit) throw new FileInputError('file_too_large', 'File too large');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
/** Create a private directory (0700) and refuse it if it is a symlink or not a directory. */
function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new FileInputError('file_name_invalid', 'Unsafe attachment directory');
  if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/** A validated file, ready to store. */
interface Prepared { name: string; kind: FileKind; mediaType: string; label: string; bytes: Uint8Array; sha256: string; pages?: string[]; lines?: number }

/**
 * Validate a file by content and extract what reading it needs (PDF text,
 * line counts). The name is sanitized and its extension made to match the
 * content.
 * @throws {FileInputError}
 */
export async function prepareFile(name: string, bytes: Uint8Array, options: { signal?: AbortSignal; limits?: Readonly<FileLimits> } = {}): Promise<Prepared> {
  const limits = options.limits ?? FILE_LIMITS;
  if (bytes.byteLength > limits.maxFileBytes) throw new FileInputError('file_too_large', `Each file can be up to ${formatBytes(limits.maxFileBytes)}`);
  const safe = sanitizeFileName(name);
  const type = detectFileType(bytes, safe);
  const prepared: Prepared = { name: withExtension(safe, type), ...type, bytes, sha256: sha256(bytes) };
  if (type.kind === 'text') prepared.lines = lineCount(decodeText(bytes));
  if (type.kind === 'pdf') {
    try { prepared.pages = await extractPdfText(bytes, { signal: options.signal }); }
    catch (error) {
      options.signal?.throwIfAborted();
      throw new FileInputError('file_invalid', error instanceof PdfError && error.code === 'password' ? `${prepared.name} is password-protected` : `${prepared.name} could not be read as a PDF`);
    }
  }
  return prepared;
}

const metadataOf = (p: Prepared, name = p.name): StoredFile => ({ name, kind: p.kind, mediaType: p.mediaType, label: p.label, bytes: p.bytes.byteLength, sha256: p.sha256,
  ...(p.pages ? { pages: p.pages.length } : {}), ...(p.lines !== undefined ? { lines: p.lines } : {}), createdAt: new Date().toISOString() });

/**
 * One conversation's attachment folder, `<root>/<agentId>/<conversationId>/`
 * (directories 0700, files 0600).
 *
 * Every name resolves inside this folder only: names must be plain file
 * names exactly as stored (no separators, no leading dot), symlinks and
 * hard links are never followed, and the folder's real path must equal the
 * expected one. A store never sees another conversation's files.
 *
 * Besides the files, private sidecars live in `.meta/` (metadata) and
 * `.text/` (text extracted from PDFs).
 */
export class AttachmentStore {
  readonly directory: string;
  constructor(readonly root: string, readonly agentId: string, readonly conversationId: string, readonly limits: Readonly<FileLimits> = FILE_LIMITS) {
    if (!isAbsolute(root)) throw new FileInputError('file_name_invalid', 'Attachment root must be absolute');
    if (!AGENT_ID.test(agentId)) throw new FileInputError('file_name_invalid', 'Invalid agent ID for attachments');
    if (!CONVERSATION_ID.test(conversationId)) throw new FileInputError('file_name_invalid', 'Invalid conversation ID for attachments');
    this.directory = join(root, agentId, conversationId);
  }

  /** Create (0700) and verify the folder; returns its real path. */
  private ensure(): string {
    privateDirectory(this.root);
    privateDirectory(join(this.root, this.agentId));
    privateDirectory(this.directory);
    const real = realpathSync(this.directory);
    if (real !== join(realpathSync(this.root), this.agentId, this.conversationId)) throw new FileInputError('file_name_invalid', 'Unsafe attachment directory');
    for (const sub of ['.meta', '.text']) privateDirectory(join(real, sub));
    return real;
  }
  /** The folder's real path, or `undefined` if nothing was ever stored. */
  private existing(): string | undefined {
    try { lstatSync(this.directory); } catch (error) { if (missing(error)) return undefined; throw error; }
    return this.ensure();
  }

  /** Every stored file, oldest first. A file added by hand is described from its content; links and odd names are skipped. */
  list(): StoredFile[] {
    const directory = this.existing();
    if (!directory) return [];
    const files: StoredFile[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isFile() || !isPlainFileName(entry.name)) continue;
      let info;
      try { info = lstatSync(join(directory, entry.name)); } catch { continue; }
      if (!info.isFile() || info.nlink !== 1) continue;
      let meta: StoredFile | undefined;
      try { meta = JSON.parse(readPrivate(join(directory, '.meta', `${entry.name}.json`), 64 * 1024).toString('utf8')) as StoredFile; } catch { meta = undefined; }
      if (!meta || meta.name !== entry.name || meta.bytes !== info.size || !SHA.test(meta.sha256)) {
        if (info.size > this.limits.maxFileBytes) continue;
        try {
          const bytes = readPrivate(join(directory, entry.name), this.limits.maxFileBytes);
          const type = detectFileType(bytes, entry.name);
          meta = { name: entry.name, ...type, bytes: bytes.byteLength, sha256: sha256(bytes), ...(type.kind === 'text' ? { lines: lineCount(decodeText(bytes)) } : {}), createdAt: info.mtime.toISOString() };
        } catch { continue; }
      }
      files.push(meta);
    }
    return files.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
  }

  /** Metadata of one file by its exact name. @throws {FileInputError} `file_not_found` or `file_name_invalid` */
  get(name: unknown): StoredFile {
    if (!isPlainFileName(name)) throw new FileInputError('file_name_invalid', 'Use a file name exactly as listed by list_files');
    const file = this.list().find(f => f.name === name);
    if (!file) throw new FileInputError('file_not_found', `No file named "${name}" in this conversation`);
    return file;
  }

  /** The bytes of one file, read without following links and checked against its recorded hash. */
  read(name: unknown): { file: StoredFile; bytes: Buffer } {
    const file = this.get(name);
    const bytes = readPrivate(join(this.ensure(), file.name), this.limits.maxFileBytes);
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new FileInputError('file_invalid', `${file.name} changed on disk; attach it again`);
    return { file, bytes };
  }

  /**
   * Readable content: the text of a text file, or one string per PDF page
   * (empty for pages without a text layer). PDF text is cached by content hash.
   * @throws {FileInputError}
   */
  async content(name: unknown, signal?: AbortSignal): Promise<{ file: StoredFile; text: string } | { file: StoredFile; pages: string[] }> {
    const { file, bytes } = this.read(name);
    if (file.kind === 'text') return { file, text: decodeText(bytes) };
    if (file.kind !== 'pdf') throw new FileInputError('file_unsupported_type', `${file.name} is an image; it has no text to read`);
    const directory = this.ensure();
    const cache = join(directory, '.text', `${file.sha256}.json`);
    try {
      const pages = JSON.parse(readPrivate(cache).toString('utf8')) as unknown;
      if (Array.isArray(pages) && pages.every(p => typeof p === 'string')) return { file, pages };
    } catch { /* extract below */ }
    const prepared = await prepareFile(file.name, bytes, { signal, limits: this.limits });
    writeReplace(join(directory, '.text'), cache, JSON.stringify(prepared.pages ?? []));
    return { file, pages: prepared.pages ?? [] };
  }

  private budget(adding: readonly { bytes: number }[], existing: readonly StoredFile[]) {
    if (existing.length + adding.length > this.limits.maxConversationFiles) throw new FileInputError('conversation_files_full', `A conversation can keep up to ${this.limits.maxConversationFiles} files`);
    const total = existing.reduce((sum, f) => sum + f.bytes, 0) + adding.reduce((sum, f) => sum + f.bytes, 0);
    if (total > this.limits.maxConversationBytes) throw new FileInputError('conversation_files_full', `A conversation's files can total up to ${formatBytes(this.limits.maxConversationBytes)}`);
  }

  /** A stored file with this content under this name (or a numbered variant of it), if any. */
  private duplicate(p: Prepared, existing: readonly StoredFile[]) {
    return existing.find(f => f.sha256 === p.sha256 && (f.name === p.name || Array.from({ length: 98 }, (_, i) => numberedName(p.name, i + 2)).includes(f.name)));
  }

  /** Write one prepared file under a free name ("report (2).pdf" on collision). */
  private place(p: Prepared, existing: readonly StoredFile[]): StoredFile {
    const same = this.duplicate(p, existing);
    if (same) return same;
    const directory = this.ensure();
    for (let n = 1; n <= 100; n++) {
      const name = n === 1 ? p.name : numberedName(p.name, n);
      try { writeNew(directory, join(directory, name), p.bytes); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
      const file = metadataOf(p, name);
      if (p.pages) writeReplace(join(directory, '.text'), join(directory, '.text', `${p.sha256}.json`), JSON.stringify(p.pages));
      writeReplace(join(directory, '.meta'), join(directory, '.meta', `${name}.json`), JSON.stringify(file));
      syncDirectory(directory);
      return file;
    }
    throw new FileInputError('file_name_invalid', 'Too many files with this name');
  }

  /**
   * Store validated files: all are checked against the conversation's limits
   * first, then written. An identical file already stored under the same name
   * is reused rather than duplicated.
   * @throws {FileInputError}
   */
  store(files: readonly Prepared[]): StoredFile[] {
    const existing = this.list();
    this.budget(files.filter(p => !this.duplicate(p, existing)).map(p => ({ bytes: p.bytes.byteLength })), existing);
    const stored: StoredFile[] = [];
    for (const p of files) stored.push(this.place(p, [...existing, ...stored]));
    return stored;
  }

  /** Validate and store files (see {@link prepareFile} and {@link store}). */
  async save(files: readonly { name: string; bytes: Uint8Array }[], options: { signal?: AbortSignal } = {}): Promise<StoredFile[]> {
    const prepared: Prepared[] = [];
    for (const file of files) prepared.push(await prepareFile(file.name, file.bytes, { ...options, limits: this.limits }));
    return this.store(prepared);
  }
}

/** Bytes of an uploaded file waiting to be sent, plus its validated metadata. */
export interface StagedUpload { meta: StagedFile; prepared: Prepared }

/**
 * Validated uploads waiting to be sent with a message (`<root>/.staging/`,
 * private). A browser uploads each file as soon as it is attached; the
 * message that sends it moves it into the conversation's folder
 * ({@link AttachmentStore.store}). Uploads expire after {@link STAGING_TTL_MS}.
 */
export class UploadStaging {
  readonly directory: string;
  constructor(readonly root: string, readonly limits: Readonly<FileLimits> = FILE_LIMITS, readonly maxPending = 32) {
    if (!isAbsolute(root)) throw new FileInputError('file_name_invalid', 'Attachment root must be absolute');
    this.directory = join(root, '.staging');
  }
  private ensure() { privateDirectory(this.root); privateDirectory(this.directory); return this.directory; }
  private sweep(directory: string) {
    const now = Date.now();
    for (const entry of readdirSync(directory)) {
      if (!UPLOAD_ID.test(entry) && !entry.startsWith('.tmp-')) continue;
      try { if (now - lstatSync(join(directory, entry)).mtimeMs > STAGING_TTL_MS) rmSync(join(directory, entry), { recursive: true, force: true }); } catch { /* raced */ }
    }
  }

  /** Validate (type by content, size, PDF text) and stage an upload. @throws {FileInputError} */
  async stage(name: string, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<StagedFile> {
    const prepared = await prepareFile(name, bytes, { ...options, limits: this.limits });
    const directory = this.ensure();
    this.sweep(directory);
    if (readdirSync(directory).filter(entry => UPLOAD_ID.test(entry)).length >= this.maxPending) throw new FileInputError('files_too_many', 'Too many uploads waiting to be sent; send or remove some first');
    const id = randomUUID();
    const target = join(directory, id);
    mkdirSync(target, { mode: 0o700 });
    const meta: StagedFile = { id, ...metadataOf(prepared) };
    writeNew(target, join(target, 'data'), prepared.bytes);
    if (prepared.pages) writeNew(target, join(target, 'text.json'), JSON.stringify(prepared.pages));
    writeNew(target, join(target, 'meta.json'), JSON.stringify(meta));
    syncDirectory(target);
    return meta;
  }

  /** Load staged uploads by ID, re-checking their bytes. @throws {FileInputError} `file_not_found`, `files_too_many` */
  load(ids: readonly unknown[]): StagedUpload[] {
    if (ids.length > this.limits.maxFilesPerMessage) throw new FileInputError('files_too_many', `Attach up to ${this.limits.maxFilesPerMessage} files per message`);
    if (new Set(ids).size !== ids.length) throw new FileInputError('file_invalid', 'The same upload was listed twice');
    const directory = this.ensure();
    return ids.map(id => {
      if (typeof id !== 'string' || !UPLOAD_ID.test(id)) throw new FileInputError('file_not_found', 'Unknown upload');
      const target = join(directory, id);
      try {
        const meta = JSON.parse(readPrivate(join(target, 'meta.json'), 64 * 1024).toString('utf8')) as StagedFile;
        const bytes = readPrivate(join(target, 'data'), this.limits.maxFileBytes);
        if (meta.id !== id || bytes.byteLength !== meta.bytes || sha256(bytes) !== meta.sha256) throw new Error('mismatch');
        const pages = meta.kind === 'pdf' ? JSON.parse(readPrivate(join(target, 'text.json')).toString('utf8')) as string[] : undefined;
        return { meta, prepared: { name: meta.name, kind: meta.kind, mediaType: meta.mediaType, label: meta.label, bytes, sha256: meta.sha256, ...(pages ? { pages } : {}), ...(meta.lines !== undefined ? { lines: meta.lines } : {}) } };
      } catch { throw new FileInputError('file_not_found', 'That upload expired or was already sent; attach the file again'); }
    });
  }

  /** Remove staged uploads (after they were stored, or when discarded). */
  discard(ids: readonly string[]) {
    const directory = this.ensure();
    for (const id of ids) if (UPLOAD_ID.test(id)) rmSync(join(directory, id), { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* File parts in a user turn                                           */
/* ------------------------------------------------------------------ */

/** A non-image AI SDK `file` part's bytes and name. Remote URLs are never fetched. @throws {FileInputError} */
export function decodeFilePart(part: { data?: unknown; filename?: unknown; mediaType?: unknown }, limit = FILE_LIMITS.maxFileBytes): { name: string; bytes: Uint8Array } {
  const name = typeof part.filename === 'string' && part.filename.trim() ? part.filename : 'file';
  let value: unknown = part.data;
  if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer) && !(value instanceof URL)) {
    const tagged = value as { type?: unknown; data?: unknown; url?: unknown; text?: unknown };
    if (tagged.type === 'data') value = tagged.data;
    else if (tagged.type === 'url') value = tagged.url;
    else if (tagged.type === 'text' && typeof tagged.text === 'string') return { name, bytes: new TextEncoder().encode(tagged.text) };
    else throw new FileInputError('file_invalid', 'Provider file references are not supported');
  }
  if (value instanceof URL) value = value.href;
  const tooLarge = () => new FileInputError('file_too_large', `Each file can be up to ${formatBytes(limit)}`);
  if (typeof value === 'string') {
    let base64 = value;
    if (/^data:/i.test(value)) {
      const match = /^data:[^,]*?(;base64)?,(.*)$/is.exec(value);
      if (!match) throw new FileInputError('file_invalid', 'Malformed data URL');
      if (!match[1]) { const bytes = new TextEncoder().encode(decodeURIComponent(match[2]!)); if (bytes.byteLength > limit) throw tooLarge(); return { name, bytes }; }
      base64 = match[2]!;
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(value.trimStart())) throw new FileInputError('file_invalid', 'File URLs are not fetched; attach the file data instead');
    const clean = base64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new FileInputError('file_invalid', 'File data is not valid base64');
    if (Math.floor(clean.length * 3 / 4) - 2 > limit) throw tooLarge();
    const bytes = Buffer.from(clean, 'base64');
    if (bytes.byteLength > limit) throw tooLarge();
    return { name, bytes };
  }
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : undefined;
  if (!bytes) throw new FileInputError('file_invalid', 'Unsupported file data');
  if (bytes.byteLength > limit) throw tooLarge();
  return { name, bytes };
}
