/** Pure model of the Resources panel: tree helpers, file types, CSV parsing and persisted layout. No I/O. */

export type ResourceNode = { name: string; path: string; type: 'file' | 'folder'; bytes?: number; modifiedAt: string; conversationId?: string; children?: ResourceNode[] };
export type ResourceTree = { children: ResourceNode[]; truncated: boolean; version: string; threads: Record<string, string>; changes: number };

/** What a preview shows, by extension (the server decides by content again). */
export type PreviewKind = 'table' | 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'atlassian' | 'none';
const extension = (name: string) => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };
const TEXT = new Set(['txt', 'text', 'log', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'css', 'scss', 'svg', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'r', 'lua', 'tex', 'bib', 'diff', 'patch', 'rst', 'adoc', 'env', 'gitignore', 'dockerfile', 'makefile']);
export function previewKind(name: string): PreviewKind {
  // A Jira issue or Confluence page saved by the Atlassian tools: rendered as Atlassian does.
  if (/\.adf\.json$/i.test(name)) return 'atlassian';
  const ext = extension(name);
  if (ext === 'csv' || ext === 'tsv') return 'table';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (TEXT.has(ext) || !ext) return 'text';
  return 'none';
}
/** Icon family for a file name. */
export type IconKind = 'pdf' | 'table' | 'image' | 'markdown' | 'html' | 'code' | 'text' | 'atlassian' | 'other';
export function iconKind(name: string): IconKind {
  const ext = extension(name);
  const kind = previewKind(name);
  if (kind === 'pdf' || kind === 'image' || kind === 'table' || kind === 'markdown' || kind === 'html' || kind === 'atlassian') return kind;
  if (['txt', 'text', 'log', 'rst', 'adoc', ''].includes(ext)) return 'text';
  if (kind === 'text') return 'code';
  return 'other';
}

/** "2.1 MB", "340 KB", "512 B" (compact, for the tree). */
export function shortSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Every node, depth first. */
export function* walk(nodes: readonly ResourceNode[]): Generator<ResourceNode> {
  for (const node of nodes) { yield node; if (node.children) yield* walk(node.children); }
}
export const find = (nodes: readonly ResourceNode[], path: string) => { for (const node of walk(nodes)) if (node.path === path) return node; return undefined; };
export const parentPath = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const joinPath = (folder: string, name: string) => folder ? `${folder}/${name}` : name;
/** Folders that hold `path` (for expanding the tree to it). */
export const ancestors = (path: string) => { const out: string[] = []; let p = parentPath(path); while (p) { out.unshift(p); p = parentPath(p); } return out; };
/** Can `from` be dropped into `folder`? Not into itself, its own descendants, or where it already is. */
export function canDrop(from: string, folder: string): boolean {
  if (!from) return false;
  if (folder === from || folder.startsWith(`${from}/`)) return false;
  return parentPath(from) !== folder;
}

/** Same rules as the server's name sanitizer, for inline validation: a plain visible name. */
export function validName(name: string): string | undefined {
  const value = name.trim();
  if (!value) return 'Enter a name.';
  if (value.length > 120) return 'Use at most 120 characters.';
  if (/[/\\]/.test(value)) return 'Names can’t contain slashes.';
  if (value.startsWith('.')) return 'Names can’t start with a dot.';
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return 'Names can’t contain control characters.';
  return undefined;
}

/**
 * Parse CSV or TSV (RFC 4180 quotes, CRLF or LF), up to `maxRows` rows.
 * Returns the rows and whether more were left out.
 */
export function parseDelimited(text: string, delimiter: ',' | '\t', maxRows = 500): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
      if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), truncated: true };
      continue;
    }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.length > maxRows ? { rows: rows.slice(0, maxRows), truncated: true } : { rows, truncated: false };
}

/* ------------------------------------------------------------------ */
/* Persisted layout                                                    */
/* ------------------------------------------------------------------ */

export type Layout = { sidebar: boolean; resources: boolean; resourcesWidth: number };
export const LAYOUT_KEY = 'ai-sdk-letta-layout';
export const DEFAULT_LAYOUT: Layout = { sidebar: true, resources: false, resourcesWidth: 320 };
export const RESOURCES_WIDTH = { min: 240, max: 640 } as const;
export const clampWidth = (width: number) => Math.round(Math.min(RESOURCES_WIDTH.max, Math.max(RESOURCES_WIDTH.min, Number.isFinite(width) ? width : DEFAULT_LAYOUT.resourcesWidth)));
export function readLayout(raw: string | null): Layout {
  try {
    const value = JSON.parse(raw ?? '') as Partial<Layout>;
    return { sidebar: typeof value.sidebar === 'boolean' ? value.sidebar : DEFAULT_LAYOUT.sidebar, resources: typeof value.resources === 'boolean' ? value.resources : DEFAULT_LAYOUT.resources, resourcesWidth: clampWidth(Number(value.resourcesWidth)) };
  } catch { return { ...DEFAULT_LAYOUT }; }
}

/** Toast text for a resources error code. */
export function resourceError(code: string): string {
  return ({
    file_exists: 'Something with that name is already there. Pick another name.',
    file_name_invalid: 'That name or location can’t be used.',
    file_not_found: 'That file or folder no longer exists. The list was refreshed.',
    file_too_large: 'That file is too large (up to 25 MB).',
    payload_too_large: 'That file is too large (up to 25 MB).',
    resources_busy: 'The files are busy. Try again in a moment.',
    resources_full: 'There are too many files to manage here.',
    files_unavailable: 'This agent has no files.',
    resources_empty: 'Start a conversation first; its files appear here.',
    preview_unavailable: 'No preview for this type. Download it instead.',
    atlassian_not_connected: 'Connect Atlassian to load its images.',
    session_required: 'The local server restarted. Refresh the page.',
    csrf_required: 'The local server restarted. Refresh the page.',
  } as Record<string, string>)[code] ?? 'That didn’t work. Nothing was changed.';
}

/** A saved Jira issue or Confluence page (`.adf.json` written by `atlassian_fetch`), as the preview reads it. */
export type SavedAtlassianDocument = { format: string; source: { product: 'jira' | 'confluence'; url: string; title: string; key?: string; version?: number; updated?: string }; fetchedAt?: string; media?: Record<string, { name: string; mediaType?: string; download?: string }>; document: { type: 'doc'; content: unknown[] } };
/** Parse a `.adf.json` preview: a saved document, or a bare ADF document. */
export function parseAtlassianDocument(text: string): SavedAtlassianDocument | { document: { type: 'doc'; content: unknown[] }; source?: undefined; media?: undefined } | undefined {
  try {
    const value = JSON.parse(text) as Partial<SavedAtlassianDocument> & { type?: string; content?: unknown };
    if (value?.format === 'ai-sdk-letta/atlassian@1' && value.source && value.document?.type === 'doc' && Array.isArray(value.document.content)) return value as SavedAtlassianDocument;
    if (value?.type === 'doc' && Array.isArray(value.content)) return { document: value as { type: 'doc'; content: unknown[] } };
  } catch { /* not JSON */ }
  return undefined;
}
