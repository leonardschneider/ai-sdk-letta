import { createHash } from 'node:crypto';
import type { ImageContent } from '@letta-ai/letta-agent-sdk';

/** Image types a user turn may carry. Letta's `ImageContent` accepts exactly these. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = typeof IMAGE_MEDIA_TYPES[number];

/**
 * Bounds for images in one user turn (decoded bytes). They keep requests,
 * backend history and restored views bounded; clients should downscale before
 * sending (the browser app does).
 */
export interface ImageLimits { maxImageBytes: number; maxImages: number; maxTotalBytes: number }
export const IMAGE_LIMITS: Readonly<ImageLimits> = Object.freeze({
  /** Largest single image. */
  maxImageBytes: 5 * 1024 * 1024,
  /** Most images in one user turn. */
  maxImages: 4,
  /** Largest combined size of all images in one user turn. */
  maxTotalBytes: 10 * 1024 * 1024,
});

/** Machine-readable reason for {@link ImageInputError}. */
export type ImageInputErrorCode =
  | 'image_unsupported_type' // not PNG, JPEG, GIF or WebP (by declared type or content)
  | 'image_invalid' // not base64, empty, or bytes that do not match the declared type
  | 'image_remote_url' // http(s) or other URLs: images are never fetched
  | 'image_too_large' // one image over maxImageBytes
  | 'images_too_many' // more than maxImages
  | 'images_too_large'; // combined size over maxTotalBytes

/** A rejected image input. `code` is stable; `message` is human-readable. */
export class ImageInputError extends Error {
  override readonly name = 'ImageInputError';
  constructor(readonly code: ImageInputErrorCode, message: string) { super(message); }
}

const MB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
/** Reference provider key used for images in the in-memory transcript. */
export const IMAGE_REFERENCE_PROVIDER = 'ai-sdk-letta-sha256';

/** Detect PNG, JPEG, GIF or WebP from magic bytes; `undefined` otherwise. */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | undefined {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return undefined;
}

/** Normalize a declared media type: `image/jpg` → `image/jpeg`, parameters and case dropped; `image`/`image/*` mean "detect". */
function declaredType(mediaType: unknown): ImageMediaType | 'detect' {
  if (mediaType === undefined) return 'detect';
  if (typeof mediaType !== 'string') throw new ImageInputError('image_unsupported_type', 'Image media type must be a string');
  const type = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  if (type === 'image' || type === 'image/*') return 'detect';
  const normalized = type === 'image/jpg' ? 'image/jpeg' : type;
  if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(normalized)) throw new ImageInputError('image_unsupported_type', `Unsupported image type ${type || 'unknown'}; use PNG, JPEG, GIF or WebP`);
  return normalized as ImageMediaType;
}

/** A validated image, ready for Letta. */
export interface DecodedImage { mediaType: ImageMediaType; base64: string; bytes: number; sha256: string }

function fromBase64(base64: string, declared: ImageMediaType | 'detect', limit: number): DecodedImage {
  const clean = base64.replace(/\s+/g, '');
  if (!clean || clean.length % 4 === 1 || !base64Pattern.test(clean)) throw new ImageInputError('image_invalid', 'Image data is not valid base64');
  // Cheap bound before decoding anything large.
  if (Math.floor(clean.length * 3 / 4) - 2 > limit) throw new ImageInputError('image_too_large', `Each image can be up to ${MB(limit)}`);
  const buffer = Buffer.from(clean, 'base64');
  return fromBytes(buffer, declared, limit, clean);
}

function fromBytes(bytes: Uint8Array, declared: ImageMediaType | 'detect', limit: number, base64?: string): DecodedImage {
  if (!bytes.byteLength) throw new ImageInputError('image_invalid', 'Image is empty');
  if (bytes.byteLength > limit) throw new ImageInputError('image_too_large', `Each image can be up to ${MB(limit)}`);
  const sniffed = sniffImageType(bytes);
  if (!sniffed) throw new ImageInputError(declared === 'detect' ? 'image_unsupported_type' : 'image_invalid', declared === 'detect' ? 'Unsupported image; use PNG, JPEG, GIF or WebP' : `Image content is not a valid ${declared.slice(6).toUpperCase()}`);
  if (declared !== 'detect' && declared !== sniffed) throw new ImageInputError('image_invalid', `Image content (${sniffed}) does not match its declared type (${declared})`);
  const data = base64 ?? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  return { mediaType: sniffed, base64: data, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Parse a `data:` URL (base64 only). */
function fromDataUrl(url: string, declared: ImageMediaType | 'detect', limit: number): DecodedImage {
  const match = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/s.exec(url);
  if (!match || !match[2]!.split(';').includes('base64')) throw new ImageInputError('image_invalid', 'Image data URLs must be base64-encoded');
  const urlType = match[1] ? declaredType(match[1]) : 'detect';
  if (declared !== 'detect' && urlType !== 'detect' && urlType !== declared) throw new ImageInputError('image_invalid', 'Image data URL type does not match the declared type');
  return fromBase64(match[3]!, declared === 'detect' ? urlType : declared, limit);
}

/** An image-carrying user content part, as found in AI SDK model messages. */
type PartLike = { type: string; image?: unknown; data?: unknown; mediaType?: unknown };

/** The reference hash in a compact transcript part, if this part is one. */
function referenceOf(value: unknown): string | undefined {
  const pick = (v: unknown) => {
    const ref = v && typeof v === 'object' && !(v instanceof Uint8Array) && !(v instanceof ArrayBuffer) && !(v instanceof URL) ? (v as Record<string, unknown>)[IMAGE_REFERENCE_PROVIDER] : undefined;
    return typeof ref === 'string' && /^[a-f0-9]{64}$/.test(ref) ? ref : undefined;
  };
  if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'reference') return pick((value as { reference?: unknown }).reference);
  return pick(value);
}

/** True for AI SDK `image` parts and `file` parts whose media type is an image. */
export function isImagePart(part: PartLike): boolean {
  if (part.type === 'image') return true;
  return part.type === 'file' && typeof part.mediaType === 'string' && /^image(?:\/|$)/i.test(part.mediaType.trim());
}

/**
 * Validate one AI SDK `image` or `file` part and decode it. Accepts base64
 * strings, `data:` URLs (string or `URL`), bytes, and the tagged
 * `{ type: 'data' | 'url' }` file shapes. Remote URLs are rejected: images are
 * never fetched.
 * @throws {ImageInputError}
 */
export function decodeImagePart(part: PartLike, limit: number = IMAGE_LIMITS.maxImageBytes): DecodedImage {
  const declared = declaredType(part.mediaType);
  let value: unknown = part.type === 'image' ? part.image : part.data;
  if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer) && !(value instanceof URL)) {
    const tagged = value as { type?: unknown; data?: unknown; url?: unknown };
    if (tagged.type === 'data') value = tagged.data;
    else if (tagged.type === 'url') value = tagged.url;
    else throw new ImageInputError('image_invalid', 'Provider file references and inline text are not supported for images');
  }
  if (value instanceof URL) value = value.href;
  if (typeof value === 'string') {
    if (/^data:/i.test(value)) return fromDataUrl(value, declared, limit);
    // Base64 never contains ':'; anything with a scheme is a URL we will not fetch.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value.trimStart())) throw new ImageInputError('image_remote_url', 'Image URLs are not fetched; attach the image data instead');
    return fromBase64(value, declared, limit);
  }
  if (value instanceof ArrayBuffer) return fromBytes(new Uint8Array(value), declared, limit);
  if (value instanceof Uint8Array) return fromBytes(value, declared, limit);
  throw new ImageInputError('image_invalid', 'Unsupported image data');
}

/** Enforce count and combined size over already-decoded images. @throws {ImageInputError} */
export function assertImageBudget(images: readonly { bytes: number }[], limits: Readonly<ImageLimits> = IMAGE_LIMITS): void {
  if (images.length > limits.maxImages) throw new ImageInputError('images_too_many', `Attach up to ${limits.maxImages} images per message`);
  const total = images.reduce((sum, image) => sum + image.bytes, 0);
  if (total > limits.maxTotalBytes) throw new ImageInputError('images_too_large', `Images in one message can total up to ${MB(limits.maxTotalBytes)}`);
}

/**
 * Validate a list of base64 images (as received over HTTP) against every
 * limit. Returns decoded images with their content hash.
 * @throws {ImageInputError}
 */
export function validateImages(images: readonly { mediaType?: unknown; data?: unknown }[], limits: Readonly<ImageLimits> = IMAGE_LIMITS): DecodedImage[] {
  if (!Array.isArray(images)) throw new ImageInputError('image_invalid', 'Images must be a list');
  if (images.length > limits.maxImages) throw new ImageInputError('images_too_many', `Attach up to ${limits.maxImages} images per message`);
  const decoded = images.map(image => {
    if (!image || typeof image !== 'object' || typeof image.data !== 'string') throw new ImageInputError('image_invalid', 'Each image needs base64 data');
    return decodeImagePart({ type: 'image', image: image.data, mediaType: image.mediaType }, limits.maxImageBytes);
  });
  assertImageBudget(decoded, limits);
  return decoded;
}

/** Letta `ImageContent` for a decoded image. */
export const toLettaImage = (image: DecodedImage): ImageContent => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });

/**
 * Content hash of an image part, for history comparison. Compact transcript
 * references (see {@link compactImagePart}) yield their stored hash; anything
 * else is decoded and hashed.
 */
export function imagePartDigest(part: PartLike): string {
  return referenceOf(part.type === 'image' ? part.image : part.data) ?? decodeImagePart(part, Number.MAX_SAFE_INTEGER).sha256;
}

/** Replace an image part's data with a content-hash reference, so transcripts never hold image bytes twice. */
export function compactImagePart(part: PartLike): { type: 'file'; mediaType: string; data: { type: 'reference'; reference: Record<string, string> } } {
  const existing = referenceOf(part.type === 'image' ? part.image : part.data);
  const mediaType = typeof part.mediaType === 'string' && part.mediaType.includes('/') ? part.mediaType : 'image';
  if (existing) return { type: 'file', mediaType, data: { type: 'reference', reference: { [IMAGE_REFERENCE_PROVIDER]: existing } } };
  const image = decodeImagePart(part, Number.MAX_SAFE_INTEGER);
  return { type: 'file', mediaType: image.mediaType, data: { type: 'reference', reference: { [IMAGE_REFERENCE_PROVIDER]: image.sha256 } } };
}
