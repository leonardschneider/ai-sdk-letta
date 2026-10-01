import { Worker } from 'node:worker_threads';
import { deflateSync } from 'node:zlib';

/**
 * PDF reading with [unpdf](https://github.com/unjs/unpdf) (a serverless
 * build of Mozilla's PDF.js; pure JavaScript, no native modules).
 *
 * Parsing untrusted PDFs runs in a short-lived worker thread with a memory
 * cap and a deadline, so a hostile or huge file cannot stall or exhaust the
 * host process. Scripts in PDFs are never evaluated.
 */

/** Bounds for PDF work. */
export const PDF_LIMITS = Object.freeze({
  /** Most pages read from one PDF. Later pages are ignored. */
  maxPages: 2000,
  /** Deadline for extracting a whole document's text. */
  textTimeoutMs: 60_000,
  /** Deadline for rendering page images. */
  imageTimeoutMs: 20_000,
  /** Worker heap. */
  workerMemoryMb: 768,
  /** Longest side of a page image returned to the model. */
  maxImageDimension: 1600,
  /** Embedded images smaller than this (either side) are ignored as decoration. */
  minImageDimension: 64,
});

type WorkerJob = { op: 'text'; maxPages: number } | { op: 'images'; pages: number[]; maxDimension: number; minDimension: number };
type WorkerResult = { ok: true; value: unknown } | { ok: false; code: 'password' | 'invalid'; message: string };

/**
 * Worker body (plain JavaScript, evaluated in the worker). It imports unpdf by
 * absolute URL, so it works from source, from `dist`, and when installed.
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { data, job, url } = workerData;
  let pdf;
  try {
    const unpdf = await import(url);
    pdf = await unpdf.getDocumentProxy(new Uint8Array(data), { isEvalSupported: false, enableXfa: false, verbosity: 0, stopAtErrors: false, disableFontFace: true });
    if (job.op === 'text') {
      const pages = [];
      const count = Math.min(pdf.numPages, job.maxPages);
      for (let n = 1; n <= count; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) if (typeof item.str === 'string') text += item.str + (item.hasEOL ? '\n' : '');
        pages.push(text.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
        page.cleanup();
      }
      parentPort.postMessage({ ok: true, value: { pages, total: pdf.numPages } });
      return;
    }
    const { OPS } = await unpdf.getResolvedPDFJS();
    const kinds = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat]);
    const result = [];
    for (const n of job.pages) {
      const page = await pdf.getPage(n);
      const list = await page.getOperatorList();
      const images = [];
      for (let i = 0; i < list.fnArray.length && images.length < 2; i++) {
        if (!kinds.has(list.fnArray[i])) continue;
        const arg = list.argsArray[i][0];
        const image = typeof arg === 'string'
          ? await new Promise(resolve => (arg.startsWith('g_') ? page.commonObjs : page.objs).get(arg, resolve))
          : arg;
        if (!image || !image.data || !image.width || !image.height) continue;
        if (image.width < job.minDimension || image.height < job.minDimension) continue;
        images.push({ width: image.width, height: image.height, kind: image.kind, data: image.data });
      }
      result.push({ page: n, images });
      page.cleanup();
    }
    parentPort.postMessage({ ok: true, value: result });
  } catch (error) {
    const name = error && error.name;
    parentPort.postMessage(name === 'PasswordException'
      ? { ok: false, code: 'password', message: 'password' }
      : { ok: false, code: 'invalid', message: String(error && error.message || error).slice(0, 200) });
  } finally {
    try { await pdf?.destroy(); } catch {}
  }
})();
`;

/** Thrown for unreadable PDFs. `code` is `password` or `invalid`. */
export class PdfError extends Error {
  override readonly name = 'PdfError';
  constructor(readonly code: 'password' | 'invalid' | 'timeout', message: string) { super(message); }
}

let unpdfUrl: string | undefined;
function runWorker<T>(bytes: Uint8Array, job: WorkerJob, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  unpdfUrl ??= import.meta.resolve('unpdf');
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    // Copy: the worker receives its own buffer, never a view of the caller's.
    const data = new Uint8Array(bytes).buffer;
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { data, job, url: unpdfUrl }, transferList: [data], resourceLimits: { maxOldGenerationSizeMb: PDF_LIMITS.workerMemoryMb }, stdout: true, stderr: true });
    let done = false;
    const finish = (error?: Error, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    const timer = setTimeout(() => finish(new PdfError('timeout', 'Reading the PDF took too long')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', (message: WorkerResult) => message.ok ? finish(undefined, message.value as T) : finish(new PdfError(message.code, message.code === 'password' ? 'The PDF is password-protected' : 'The PDF could not be read')));
    worker.on('error', () => finish(new PdfError('invalid', 'The PDF could not be read')));
    worker.on('exit', () => finish(new PdfError('invalid', 'The PDF could not be read')));
  });
}

/**
 * Extract the text of every page (up to {@link PDF_LIMITS}.maxPages). Pages
 * without a text layer (scans) yield an empty string.
 * @throws {PdfError}
 */
export async function extractPdfText(bytes: Uint8Array, options: { signal?: AbortSignal; timeoutMs?: number; maxPages?: number } = {}): Promise<string[]> {
  const result = await runWorker<{ pages: string[]; total: number }>(bytes, { op: 'text', maxPages: options.maxPages ?? PDF_LIMITS.maxPages }, options.timeoutMs ?? PDF_LIMITS.textTimeoutMs, options.signal);
  return result.pages;
}

/** A PNG produced from an image embedded in a PDF page. */
export interface PdfPageImage { page: number; png: Buffer; width: number; height: number }

/**
 * Images of the given pages, for pages without a text layer: the large
 * images embedded in each page (a scanned page is one), as PNGs no larger
 * than {@link PDF_LIMITS}.maxImageDimension. Vector-only pages yield none.
 * Pure JavaScript: PDF.js decodes the images and they are encoded here with zlib.
 * @throws {PdfError}
 */
export async function pdfPageImages(bytes: Uint8Array, pages: readonly number[], options: { signal?: AbortSignal; timeoutMs?: number; maxDimension?: number } = {}): Promise<PdfPageImage[]> {
  const maxDimension = options.maxDimension ?? PDF_LIMITS.maxImageDimension;
  const raw = await runWorker<{ page: number; images: { width: number; height: number; kind?: number; data: Uint8Array | Uint8ClampedArray }[] }[]>(bytes, { op: 'images', pages: [...pages], maxDimension, minDimension: PDF_LIMITS.minImageDimension }, options.timeoutMs ?? PDF_LIMITS.imageTimeoutMs, options.signal);
  const result: PdfPageImage[] = [];
  for (const { page, images } of raw) {
    for (const image of images) {
      const pixels = toPixels(image);
      if (!pixels) continue;
      const scaled = downscale(pixels, maxDimension);
      result.push({ page, png: encodePng(scaled), width: scaled.width, height: scaled.height });
    }
  }
  return result;
}

/** Decoded pixels: 1 (gray), 3 (RGB) or 4 (RGBA) channels, 8 bits each. */
export interface Pixels { width: number; height: number; channels: 1 | 3 | 4; data: Uint8Array }

/** PDF.js image data to pixels. Handles packed 1-bit gray (scans), gray, RGB and RGBA. */
function toPixels(image: { width: number; height: number; kind?: number; data: Uint8Array | Uint8ClampedArray }): Pixels | undefined {
  const { width, height, data } = image;
  const area = width * height;
  if (!Number.isSafeInteger(area) || area <= 0 || area > 100_000_000) return undefined;
  // PDF.js ImageKind.GRAYSCALE_1BPP: rows padded to bytes; a set bit is white.
  if (image.kind === 1 || data.length === Math.ceil(width / 8) * height) {
    const stride = Math.ceil(width / 8);
    if (data.length < stride * height) return undefined;
    const out = new Uint8Array(area);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = data[y * stride + (x >> 3)]! & (0x80 >> (x & 7)) ? 255 : 0;
    return { width, height, channels: 1, data: out };
  }
  const channels = data.length / area;
  if (channels !== 1 && channels !== 3 && channels !== 4) return undefined;
  return { width, height, channels, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** Box-filter downscale so the longest side is at most `max`. */
export function downscale(pixels: Pixels, max: number): Pixels {
  const scale = Math.min(1, max / Math.max(pixels.width, pixels.height));
  if (scale >= 1) return pixels;
  const width = Math.max(1, Math.round(pixels.width * scale));
  const height = Math.max(1, Math.round(pixels.height * scale));
  const { channels } = pixels;
  const out = new Uint8Array(width * height * channels);
  const xRatio = pixels.width / width;
  const yRatio = pixels.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio), y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio), x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) sum += pixels.data[(sy * pixels.width + sx) * channels + c]!;
        out[(y * width + x) * channels + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return { width, height, channels, data: out };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(buffers: Buffer[]) {
  let c = 0xffffffff;
  for (const buffer of buffers) for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode pixels as a PNG (8-bit gray, RGB or RGBA; zlib from Node). */
export function encodePng(pixels: Pixels): Buffer {
  const { width, height, channels, data } = pixels;
  const row = width * channels;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (row + 1)] = 0; raw.set(data.subarray(y * row, (y + 1) * row), y * (row + 1) + 1); }
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const name = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32([name, body]));
    return Buffer.concat([length, name, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
