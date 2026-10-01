/** Tiny dependency-free PNG encoder for tests: solid RGB images of any size. */
import { deflateSync } from 'node:zlib';

const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const check = Buffer.alloc(4); check.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, check]);
};

/** A PNG of `width`×`height` filled with `rgb`. Pass `noise` to defeat compression (for size tests). */
export function png(width = 4, height = 4, rgb: [number, number, number] = [220, 0, 0], noise = false): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  let seed = 1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * row + 1 + x * 3;
    for (let c = 0; c < 3; c++) raw[offset + c] = noise ? (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24 : rgb[c]!;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: noise ? 0 : 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Minimal valid-looking headers for type sniffing. */
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
export const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
export const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(14)]);
