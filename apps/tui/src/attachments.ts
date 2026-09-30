/**
 * Image attachments for the terminal UI: Ctrl+V reads an image from the
 * system clipboard; pasting or dropping an image file path attaches the file.
 *
 * Clipboard access uses only tools that ship with the OS or are commonly
 * installed; nothing is added as a dependency:
 * - macOS: `osascript` (JavaScript for Automation, AppKit's NSPasteboard):
 *   image data (converted to PNG) or copied image files (Finder ⌘C).
 * - Linux: `wl-paste` (Wayland) or `xclip` (X11), when installed.
 * - Elsewhere, or without those tools: a short notice; paste or drop the
 *   file path instead.
 *
 * Images are not resized in the terminal. Files over the per-image limit are
 * refused with a notice; downscale them first (the browser app does this
 * automatically).
 */
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { FileUIPart } from 'ai';
import { IMAGE_LIMITS, ImageInputError, sniffImageType } from 'ai-sdk-letta';
import type { TerminalAttachmentResult, TerminalAttachments } from '@ai-sdk/tui';

const MB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg|avif)$/i;
const SUPPORTED_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

/** Notices shown in the prompt title. Short: they share one line. */
export const notices = {
  noImage: 'No image on the clipboard',
  noTool: 'Clipboard images need wl-paste or xclip; paste a file path instead',
  unsupportedPlatform: 'Clipboard images are not supported here; paste a file path instead',
  unsupported: 'Only PNG, JPEG, GIF and WebP images can be attached',
  tooLarge: `Image too large (max ${MB(IMAGE_LIMITS.maxImageBytes)}); downscale it first`,
  tooMany: `Up to ${IMAGE_LIMITS.maxImages} images per message`,
  totalTooLarge: `Images too large together (max ${MB(IMAGE_LIMITS.maxTotalBytes)})`,
  unreadable: 'Could not read that image',
  clipboardFailed: 'Could not read the clipboard',
};

/**
 * Split pasted or dropped text into file paths, as terminals produce them:
 * shell-escaped (`My\ Photo.png`), single- or double-quoted, `file://` URLs,
 * several paths separated by spaces or newlines. `~` expands to the home
 * directory. Returns `undefined` unless every token looks like a path.
 */
export function parsePastedPaths(text: string, home = homedir()): string[] | undefined {
  const input = text.trim();
  if (!input || input.length > 16_384) return undefined;
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && i + 1 < input.length && '"\\$`'.includes(input[i + 1]!)) current += input[++i];
      else current += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '\\' && i + 1 < input.length) { current += input[++i]; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(current); current = ''; started = false; } }
    else { current += char; started = true; }
  }
  if (quote) return undefined;
  if (started) tokens.push(current);
  const paths = tokens.map(token => {
    if (/^file:\/\//i.test(token)) {
      try { const url = new URL(token); return url.hostname && url.hostname !== 'localhost' ? '' : decodeURIComponent(url.pathname); } catch { return ''; }
    }
    if (token === '~' || token.startsWith('~/')) return join(home, token.slice(1));
    return token;
  });
  return paths.length && paths.every(path => isAbsolute(path) || /^\.{1,2}\//.test(path)) ? paths : undefined;
}

/** A validated image, ready to be an AI SDK `file` part. */
async function imageFile(bytes: Buffer, filename?: string): Promise<FileUIPart> {
  const mediaType = sniffImageType(bytes);
  if (!mediaType) throw new ImageInputError('image_unsupported_type', notices.unsupported);
  if (bytes.byteLength > IMAGE_LIMITS.maxImageBytes) throw new ImageInputError('image_too_large', notices.tooLarge);
  return { type: 'file', mediaType, ...(filename ? { filename } : {}), url: `data:${mediaType};base64,${bytes.toString('base64')}` };
}

const bytesOf = (file: FileUIPart) => { const data = file.url.slice(file.url.indexOf(',') + 1); return Math.floor(data.length * 3 / 4); };

/** Enforce per-message count and total size, given what is already attached. */
export function withinBudget(attached: readonly FileUIPart[], adding: readonly FileUIPart[]): string | undefined {
  if (attached.length + adding.length > IMAGE_LIMITS.maxImages) return notices.tooMany;
  const total = [...attached, ...adding].reduce((sum, file) => sum + bytesOf(file), 0);
  return total > IMAGE_LIMITS.maxTotalBytes ? notices.totalTooLarge : undefined;
}

/** Read image files from absolute paths. Refuses non-files, symlink loops, oversized and unsupported files. */
export async function readImagePaths(paths: readonly string[], cwd = process.cwd()): Promise<FileUIPart[]> {
  const files: FileUIPart[] = [];
  for (const raw of paths) {
    const path = resolve(cwd, raw);
    const info = await stat(path);
    if (!info.isFile()) throw new ImageInputError('image_invalid', notices.unreadable);
    if (info.size > IMAGE_LIMITS.maxImageBytes) throw new ImageInputError('image_too_large', notices.tooLarge);
    files.push(await imageFile(await readFile(path), path.split('/').at(-1)));
  }
  return files;
}

type Run = (command: string, args: string[], options?: { timeoutMs?: number; maxBuffer?: number }) => Promise<{ stdout: Buffer; code: number }>;
/** Run a clipboard tool without a shell, bounded in time and output. Rejects when it is missing (ENOENT) or times out. */
const run: Run = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { encoding: 'buffer', timeout: options.timeoutMs ?? 5000, maxBuffer: options.maxBuffer ?? IMAGE_LIMITS.maxImageBytes + 1024, windowsHide: true }, (error, stdout) => {
    if (!error) { resolve({ stdout, code: 0 }); return; }
    const code = (error as { code?: unknown }).code;
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new ImageInputError('image_too_large', notices.tooLarge));
    else if (typeof code === 'number') resolve({ stdout, code });
    else reject(error);
  });
});

/**
 * JXA for macOS: writes the clipboard image as PNG to argv[0] and prints
 * `IMAGE`; prints copied file paths as `FILES\n<path>...`; otherwise `NONE`.
 * NSPasteboard converts TIFF and other image types to PNG itself.
 */
export const MACOS_CLIPBOARD_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  const urls = pb.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
  if (urls && !urls.isNil() && urls.count > 0) {
    const paths = [];
    for (let i = 0; i < urls.count; i++) paths.push(ObjC.unwrap(urls.objectAtIndex(i).path));
    return 'FILES\\n' + paths.join('\\n');
  }
  let data = pb.dataForType($.NSPasteboardTypePNG);
  if (!data || data.isNil()) {
    const tiff = pb.dataForType($.NSPasteboardTypeTIFF);
    if (!tiff || tiff.isNil()) return 'NONE';
    const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (!rep || rep.isNil()) return 'NONE';
    data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  }
  if (!data || data.isNil()) return 'NONE';
  return data.writeToFileAtomically(argv[0], true) ? 'IMAGE' : 'NONE';
}`;

/** Clipboard reader for one platform. Returns image bytes, file paths, or nothing. */
export type ClipboardContent = { image: Buffer } | { paths: string[] } | { none: string };

export async function readClipboard(platform: NodeJS.Platform = process.platform, exec: Run = run): Promise<ClipboardContent> {
  if (platform === 'darwin') {
    const directory = await mkdtemp(join(tmpdir(), 'ai-sdk-letta-clipboard-'));
    try {
      const target = join(directory, 'clipboard.png');
      const { stdout, code } = await exec('osascript', ['-l', 'JavaScript', '-e', MACOS_CLIPBOARD_SCRIPT, target], { maxBuffer: 1024 * 1024 });
      const out = stdout.toString('utf8').trim();
      if (code !== 0) return { none: notices.clipboardFailed };
      if (out.startsWith('FILES\n')) return { paths: out.slice(6).split('\n').filter(Boolean) };
      if (out !== 'IMAGE') return { none: notices.noImage };
      const info = await lstat(target);
      if (info.size > IMAGE_LIMITS.maxImageBytes) throw new ImageInputError('image_too_large', notices.tooLarge);
      return { image: await readFile(target) };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    const tools: [string, (type: string) => string[], string[]][] = [
      ['wl-paste', type => ['--no-newline', '--type', type], ['--list-types']],
      ['xclip', type => ['-selection', 'clipboard', '-t', type, '-o'], ['-selection', 'clipboard', '-t', 'TARGETS', '-o']],
    ];
    let found = false;
    for (const [tool, read, list] of tools) {
      // Wayland tools need a Wayland session, xclip an X display.
      if (tool === 'wl-paste' && !process.env.WAYLAND_DISPLAY) continue;
      if (tool === 'xclip' && !process.env.DISPLAY) continue;
      let types: string[];
      try { types = (await exec(tool, list, { maxBuffer: 64 * 1024 })).stdout.toString('utf8').split(/\r?\n/).map(t => t.trim()).filter(Boolean); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return { none: notices.clipboardFailed }; }
      found = true;
      const type = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].find(t => types.includes(t));
      if (type) {
        const { stdout, code } = await exec(tool, read(type));
        return code === 0 && stdout.length ? { image: stdout } : { none: notices.noImage };
      }
      if (types.includes('text/uri-list')) {
        const { stdout } = await exec(tool, read('text/uri-list'), { maxBuffer: 64 * 1024 });
        const paths = parsePastedPaths(stdout.toString('utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => `'${line.replace(/'/g, "'\\''")}'`).join(' '));
        if (paths?.length) return { paths };
      }
      return { none: notices.noImage };
    }
    return { none: found ? notices.noImage : notices.noTool };
  }
  return { none: notices.unsupportedPlatform };
}

const failure = (error: unknown): TerminalAttachmentResult => ({ notice: error instanceof ImageInputError ? error.message : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'File not found' : notices.unreadable });

/**
 * Attachment handlers for `runAgentTUI({ attachments })`: Ctrl+V reads an
 * image (or copied image files) from the clipboard; pasted or dropped image
 * paths attach those files. Other pasted text is inserted unchanged.
 */
export function terminalAttachments(options: { platform?: NodeJS.Platform; exec?: Run; cwd?: string } = {}): TerminalAttachments {
  return {
    fromClipboard: async ({ attached }) => {
      try {
        const content = await readClipboard(options.platform, options.exec);
        if ('none' in content) return { notice: content.none };
        const files = 'image' in content ? [await imageFile(content.image, 'clipboard.png')] : await readImagePaths(content.paths, options.cwd);
        const over = withinBudget(attached, files);
        return over ? { notice: over } : { files };
      } catch (error) { return failure(error); }
    },
    fromText: async (text, { attached }) => {
      const paths = parsePastedPaths(text);
      // Only paths that name images are treated as attachments; everything else is typed text.
      if (!paths?.every(path => IMAGE_EXTENSIONS.test(path))) return undefined;
      if (!paths.every(path => SUPPORTED_EXTENSIONS.test(path))) return { notice: notices.unsupported };
      try {
        const files = await readImagePaths(paths, options.cwd);
        const over = withinBudget(attached, files);
        return over ? { notice: over } : { files };
      } catch (error) {
        // A path-looking paste that is not a readable file stays text (e.g. a path you meant to type).
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
        return failure(error);
      }
    },
  };
}
