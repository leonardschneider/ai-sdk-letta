import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_LIMITS as LIBRARY_LIMITS, IMAGE_MEDIA_TYPES, IMAGE_PLACEHOLDER as LIBRARY_PLACEHOLDER } from 'ai-sdk-letta';
import { IMAGE_LIMITS, IMAGE_PLACEHOLDER, IMAGE_TYPES, ImageAttachmentAdapter, base64Bytes, checkBudget, dataUrlToImage, fitWithin, messages, pasteAttaches, sniffImageType } from '../src/attachments.js';
import { historyMessages, userContent } from '../src/messages.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test('browser limits and types mirror the library exactly', () => {
  assert.deepEqual({ ...IMAGE_LIMITS }, { ...LIBRARY_LIMITS });
  assert.deepEqual([...IMAGE_TYPES], [...IMAGE_MEDIA_TYPES]);
  assert.equal(IMAGE_PLACEHOLDER, LIBRARY_PLACEHOLDER);
});

test('type sniffing by content, not by file name or declared type', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])), 'image/jpeg');
  assert.equal(sniffImageType(new TextEncoder().encode('GIF87a')), 'image/gif');
  assert.equal(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')), undefined);
  assert.equal(sniffImageType(new TextEncoder().encode('%PDF-1.7')), undefined);
});

test('downscale target keeps aspect ratio, never upscales', () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 2048, height: 1536, scale: 2048 / 4032 });
  assert.deepEqual(fitWithin(1000, 6000), { width: 341, height: 2048, scale: 2048 / 6000 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600, scale: 1 });
});

test('data URL → wire image; only allowed types; sizes from base64', () => {
  assert.deepEqual(dataUrlToImage('data:image/png;base64,iVBORw0KGgo='), { mediaType: 'image/png', data: 'iVBORw0KGgo=' });
  assert.equal(dataUrlToImage('data:image/svg+xml;base64,PHN2Zz4='), undefined);
  assert.equal(dataUrlToImage('https://example.com/a.png'), undefined);
  assert.equal(dataUrlToImage('blob:http://127.0.0.1/x'), undefined);
  assert.equal(base64Bytes('AAAA'), 3); assert.equal(base64Bytes('AAA='), 2); assert.equal(base64Bytes('AA=='), 1);
});

test('send-time budget: count, per-image and total size', () => {
  const mb = 1024 * 1024;
  assert.equal(checkBudget([mb, mb]), undefined);
  assert.equal(checkBudget([mb, mb, mb, mb, mb]), messages.tooMany);
  assert.equal(checkBudget([6 * mb]), messages.tooLarge);
  assert.equal(checkBudget([4 * mb, 4 * mb, 4 * mb]), messages.totalTooLarge);
});

test('paste: image files attach; text (even with a snapshot image) pastes as text', () => {
  const screenshot = { name: 'image.png', type: 'image/png' };
  assert.equal(pasteAttaches({ types: ['Files'], text: '', files: [screenshot] }), true);
  // Finder copy: file names as text plus the files.
  assert.equal(pasteAttaches({ types: ['text/plain', 'Files'], text: 'cat.png\ndog.jpg', files: [{ name: 'cat.png', type: 'image/png' }, { name: 'dog.jpg', type: 'image/jpeg' }] }), true);
  // Office/Numbers copy: real text plus a rendered snapshot. Text wins, as before.
  assert.equal(pasteAttaches({ types: ['text/plain', 'text/html', 'Files'], text: 'Quarterly total 42', files: [screenshot] }), false);
  assert.equal(pasteAttaches({ types: ['text/plain'], text: 'plain text', files: [] }), false);
  assert.equal(pasteAttaches({ types: [], text: '', files: [] }), false);
});

test('adapter refuses more than the per-message count before reading any file', async () => {
  const current = Array.from({ length: IMAGE_LIMITS.maxImages }, (_, i) => ({ id: String(i), type: 'image', name: 'x.png', status: { type: 'complete' as const }, content: [] }));
  const adapter = new ImageAttachmentAdapter(() => current);
  const file = { name: 'x.png', type: 'image/png', size: 10, slice: () => assert.fail('must not read') } as unknown as File;
  await assert.rejects(adapter.add({ file }), (e: Error) => e.message === messages.tooMany);
  assert.equal(adapter.accept, 'image/png,image/jpeg,image/gif,image/webp');
});

test('adapter refuses unsupported content even when the name/type claim an image', async () => {
  const adapter = new ImageAttachmentAdapter(() => []);
  const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'fake.png', { type: 'image/png' });
  await assert.rejects(adapter.add({ file: svg }), (e: Error) => e.message === messages.unsupported);
  const huge = { name: 'huge.png', type: 'image/png', size: 41 * 1024 * 1024 } as File;
  await assert.rejects(adapter.add({ file: huge }), (e: Error) => e.message === messages.tooLarge);
});

test('bubbles: images first, placeholders for unknown bytes; restored history loads only data URLs', () => {
  assert.deepEqual(userContent('hi', ['data:image/png;base64,AAAA', '']), [{ type: 'image', image: 'data:image/png;base64,AAAA' }, { type: 'text', text: IMAGE_PLACEHOLDER }, { type: 'text', text: 'hi' }]);
  assert.deepEqual(userContent('', ['data:image/png;base64,AAAA']), [{ type: 'image', image: 'data:image/png;base64,AAAA' }]);
  const restored = historyMessages([{ id: 'u', role: 'user', parts: [
    { type: 'text', text: 'Describe' },
    { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
    { type: 'file', mediaType: 'image/png', url: 'https://example.com/tracker.png' },
    { type: 'text', text: IMAGE_PLACEHOLDER },
  ] }]);
  assert.deepEqual(restored[0].content, [
    { type: 'image', image: 'data:image/png;base64,AAAA' },
    { type: 'text', text: IMAGE_PLACEHOLDER },
    { type: 'text', text: IMAGE_PLACEHOLDER },
    { type: 'text', text: 'Describe' },
  ]);
});
