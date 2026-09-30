/**
 * Image attachments for the composer: type detection by content, client-side
 * downscaling and the same limits the server enforces. Pure helpers are
 * exported for tests; the adapter and canvas code only run in the browser.
 */
import type { Attachment, AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react';

/** Mirrors `IMAGE_LIMITS` in ai-sdk-letta (a test keeps them equal). */
export const IMAGE_LIMITS = { maxImageBytes: 5 * 1024 * 1024, maxImages: 4, maxTotalBytes: 10 * 1024 * 1024 } as const;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = typeof IMAGE_TYPES[number];
/** Longest side after downscaling. Larger images are resized before sending. */
export const MAX_DIMENSION = 2048;
/** Files above this are refused before decoding, even if downscaling could shrink them. */
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
/** Same text the server and library use for an image that cannot be shown. */
export const IMAGE_PLACEHOLDER = '[Image]';

/** A user-facing attachment problem; `message` is shown as a toast. */
export class AttachmentError extends Error { override readonly name = 'AttachmentError'; }

export const messages = {
  unsupported: 'Only PNG, JPEG, GIF and WebP images can be attached.',
  tooMany: `You can attach up to ${IMAGE_LIMITS.maxImages} images per message.`,
  tooLarge: `That image is too large. Each image can be up to ${IMAGE_LIMITS.maxImageBytes / 1024 / 1024} MB.`,
  totalTooLarge: `These images are too large together. A message can carry up to ${IMAGE_LIMITS.maxTotalBytes / 1024 / 1024} MB of images.`,
  unreadable: 'That image couldn’t be read. Try another file.',
};

/** PNG, JPEG, GIF or WebP from magic bytes. */
export function sniffImageType(bytes: Uint8Array): ImageType | undefined {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return undefined;
}

/** Target size that fits within `max` on the longest side, never upscaling. */
export function fitWithin(width: number, height: number, max = MAX_DIMENSION) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** Decoded size of base64 text (no data: prefix). */
export const base64Bytes = (data: string) => Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

/** Split an image data URL into the wire shape `POST /v1/runs` expects. */
export function dataUrlToImage(url: string): { mediaType: ImageType; data: string } | undefined {
  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  const type = match?.[1]!.toLowerCase();
  return match && (IMAGE_TYPES as readonly string[]).includes(type!) ? { mediaType: type as ImageType, data: match[2]! } : undefined;
}

/** Count and combined-size check over images about to be sent. Returns the error text, if any. */
export function checkBudget(sizes: readonly number[]): string | undefined {
  if (sizes.length > IMAGE_LIMITS.maxImages) return messages.tooMany;
  if (sizes.some(size => size > IMAGE_LIMITS.maxImageBytes)) return messages.tooLarge;
  if (sizes.reduce((sum, size) => sum + size, 0) > IMAGE_LIMITS.maxTotalBytes) return messages.totalTooLarge;
  return undefined;
}

/**
 * Should a paste attach its files instead of inserting text? Only when image
 * files are present and any plain text is just their file names (Finder
 * copies). Rich copies from Office, Numbers and similar apps carry a snapshot
 * image *and* text; those paste as text, as before.
 */
export function pasteAttaches(clipboard: { types: readonly string[]; text: string; files: readonly { name: string; type: string }[] }): boolean {
  if (!clipboard.files.length) return false;
  const text = clipboard.text.trim();
  if (!text) return true;
  const names = new Set(clipboard.files.map(file => file.name));
  return text.split(/\r?\n/).every(line => names.has(line.trim()));
}

const extension: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function renamed(name: string, type: ImageType) {
  const base = (name || 'image').replace(/\.[a-z0-9]{1,5}$/i, '') || 'image';
  return `${base}.${extension[type]}`;
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
}

/**
 * Validate one image file and, when it is large, downscale it so it stays
 * within {@link MAX_DIMENSION} and the per-image limit. Animated GIFs are never
 * re-encoded. Throws {@link AttachmentError} with a user-facing message.
 */
export async function prepareImage(file: File): Promise<File> {
  if (file.size > MAX_SOURCE_BYTES) throw new AttachmentError(messages.tooLarge);
  const type = sniffImageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (!type) throw new AttachmentError(messages.unsupported);
  if (type === 'image/gif') {
    if (file.size > IMAGE_LIMITS.maxImageBytes) throw new AttachmentError(messages.tooLarge);
    return file.type === type ? file : new File([file], renamed(file.name, type), { type });
  }
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new AttachmentError(messages.unreadable); }
  try {
    const target = fitWithin(bitmap.width, bitmap.height);
    if (target.scale === 1 && file.size <= IMAGE_LIMITS.maxImageBytes) return file.type === type ? file : new File([file], renamed(file.name, type), { type });
    // Same format first (keeps transparency), then JPEG, then smaller sizes.
    const attempts: { scale: number; type: string; quality?: number }[] = [
      { scale: 1, type, quality: type === 'image/png' ? undefined : 0.9 },
      { scale: 1, type: 'image/jpeg', quality: 0.85 },
      { scale: 0.75, type: 'image/jpeg', quality: 0.8 },
      { scale: 0.5, type: 'image/jpeg', quality: 0.8 },
    ];
    for (const attempt of attempts) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(target.width * attempt.scale));
      canvas.height = Math.max(1, Math.round(target.height * attempt.scale));
      const context = canvas.getContext('2d');
      if (!context) throw new AttachmentError(messages.unreadable);
      if (attempt.type === 'image/jpeg') { context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); }
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await encode(canvas, attempt.type, attempt.quality);
      const encoded = blob && sniffImageType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
      if (blob && encoded && blob.size <= IMAGE_LIMITS.maxImageBytes) return new File([blob], renamed(file.name, encoded), { type: encoded });
    }
    throw new AttachmentError(messages.tooLarge);
  } finally { bitmap.close(); }
}

function readDataUrl(file: Blob, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); reject(signal?.reason ?? new Error('aborted')); };
    reader.onload = () => { signal?.removeEventListener('abort', abort); resolve(String(reader.result)); };
    reader.onerror = () => { signal?.removeEventListener('abort', abort); reject(new AttachmentError(messages.unreadable)); };
    signal?.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(file);
  });
}

/** Bytes an attachment will send: the prepared file, or its data URL once complete. */
export function attachmentBytes(attachment: Attachment): number {
  if (attachment.file) return attachment.file.size;
  const image = attachment.content?.find(part => part.type === 'image');
  const parsed = image?.type === 'image' ? dataUrlToImage(image.image) : undefined;
  return parsed ? base64Bytes(parsed.data) : 0;
}

/**
 * assistant-ui attachment adapter for images, modelled on its
 * `SimpleImageAttachmentAdapter`: files are validated and downscaled when
 * added (so the thumbnail shows what will be sent) and read as data URLs on
 * send. `current` returns the composer's attachments, to enforce the per-message
 * count and total size at add time.
 */
export class ImageAttachmentAdapter implements AttachmentAdapter {
  accept = IMAGE_TYPES.join(',');
  private reserved = 0;
  constructor(private readonly current: () => readonly Attachment[]) {}

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    // Reserve a slot synchronously: several files can be dropped or pasted at once.
    if (this.current().length + this.reserved >= IMAGE_LIMITS.maxImages) throw new AttachmentError(messages.tooMany);
    this.reserved++;
    try {
      const prepared = await prepareImage(file);
      const total = this.current().reduce((sum, attachment) => sum + attachmentBytes(attachment), 0) + prepared.size;
      if (total > IMAGE_LIMITS.maxTotalBytes) throw new AttachmentError(messages.totalTooLarge);
      return { id: crypto.randomUUID(), type: 'image', name: prepared.name, contentType: prepared.type, file: prepared, status: { type: 'requires-action', reason: 'composer-send' } };
    } finally { this.reserved--; }
  }

  async send(attachment: PendingAttachment, options?: { signal?: AbortSignal }): Promise<CompleteAttachment> {
    return { ...attachment, status: { type: 'complete' }, content: [{ type: 'image', image: await readDataUrl(attachment.file, options?.signal), filename: attachment.name }] };
  }

  async remove(): Promise<void> {}
}
