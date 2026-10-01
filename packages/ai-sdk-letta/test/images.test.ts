import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import type { ListMessagesResult, SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import {
  IMAGE_LIMITS, IMAGE_PLACEHOLDER, IMAGE_REFERENCE_PROVIDER, ImageInputError, LettaAgent, assertHistorySettled, compactImagePart, decodeImagePart, historyKey,
  imagePartDigest, projectHistory, sniffImageType, userTurnContent, validateImages,
} from '../src/index.js';
import { registry } from './fixtures.js';
import { GIF, JPEG, WEBP, png } from './png.js';

const red = png(8, 8, [220, 0, 0]);
const blue = png(8, 8, [0, 0, 220]);
const b64 = (bytes: Buffer) => bytes.toString('base64');
const dataUrl = (bytes: Buffer, type = 'image/png') => `data:${type};base64,${b64(bytes)}`;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const code = (c: string) => (error: unknown) => error instanceof ImageInputError && error.code === c;

function fixture() {
  const sent: SendMessage[] = [];
  const agent = new LettaAgent({ id: 'images', tools: registry, open: () => ({
    send: async message => { sent.push(structuredClone(message)); }, abort: async () => {}, close: () => {},
    async *stream() {
      yield { type: 'assistant', content: 'Seen', uuid: 'a' } as SDKMessage;
      yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId: 'test' } as SDKMessage;
    },
  }) });
  return { agent, sent };
}

test('sniffs PNG, JPEG, GIF and WebP by content only', () => {
  assert.equal(sniffImageType(red), 'image/png');
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(GIF), 'image/gif');
  assert.equal(sniffImageType(WEBP), 'image/webp');
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined);
  assert.equal(sniffImageType(Buffer.from('BM\x00\x00', 'latin1')), undefined);
});

test('decodes every AI SDK image shape: file data URL, base64, bytes, URL object, tagged data', () => {
  const shapes = [
    { type: 'file', mediaType: 'image/png', data: { type: 'url', url: dataUrl(red) } },
    { type: 'file', mediaType: 'image/png', data: { type: 'data', data: b64(red) } },
    { type: 'file', mediaType: 'image/png', data: dataUrl(red) },
    { type: 'image', image: b64(red) },
    { type: 'image', image: new Uint8Array(red) },
    { type: 'image', image: red.buffer.slice(red.byteOffset, red.byteOffset + red.byteLength) },
    { type: 'image', image: new URL(dataUrl(red)), mediaType: 'image/*' },
    { type: 'file', mediaType: 'image', data: red },
  ];
  for (const part of shapes) {
    const image = decodeImagePart(part);
    assert.equal(image.mediaType, 'image/png');
    assert.equal(image.base64, b64(red));
    assert.equal(image.bytes, red.length);
    assert.equal(image.sha256, sha(red));
  }
  assert.equal(decodeImagePart({ type: 'image', image: b64(JPEG), mediaType: 'image/jpg' }).mediaType, 'image/jpeg');
  assert.equal(decodeImagePart({ type: 'image', image: b64(WEBP), mediaType: 'IMAGE/WEBP; q=1' }).mediaType, 'image/webp');
});

test('rejects unsupported, mislabelled, remote and malformed images with typed errors', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.throws(() => decodeImagePart({ type: 'file', mediaType: 'image/svg+xml', data: b64(svg) }), code('image_unsupported_type'));
  assert.throws(() => decodeImagePart({ type: 'file', mediaType: 'image/bmp', data: b64(red) }), code('image_unsupported_type'));
  assert.throws(() => decodeImagePart({ type: 'image', image: b64(svg) }), code('image_unsupported_type'));
  // Declared PNG but JPEG bytes: never relabel.
  assert.throws(() => decodeImagePart({ type: 'image', image: b64(JPEG), mediaType: 'image/png' }), code('image_invalid'));
  assert.throws(() => decodeImagePart({ type: 'image', image: dataUrl(red, 'image/gif'), mediaType: 'image/png' }), code('image_invalid'));
  assert.throws(() => decodeImagePart({ type: 'image', image: 'https://example.com/cat.png' }), code('image_remote_url'));
  assert.throws(() => decodeImagePart({ type: 'image', image: new URL('https://example.com/cat.png') }), code('image_remote_url'));
  assert.throws(() => decodeImagePart({ type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'file:///etc/passwd' } }), code('image_remote_url'));
  assert.throws(() => decodeImagePart({ type: 'image', image: 'not base64!!' }), code('image_invalid'));
  assert.throws(() => decodeImagePart({ type: 'image', image: '' }), code('image_invalid'));
  assert.throws(() => decodeImagePart({ type: 'image', image: 'data:image/png,rawtext' }), code('image_invalid'));
  assert.throws(() => decodeImagePart({ type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { openai: 'file-1' } } }), code('image_invalid'));
  assert.throws(() => decodeImagePart({ type: 'image', image: b64(red), mediaType: 42 }), code('image_unsupported_type'));
});

test('limits: per-image size, count per message and total payload', () => {
  const small = { maxImageBytes: 1000, maxImages: 2, maxTotalBytes: 1500 };
  const big = png(40, 40, [0, 0, 0], true);
  assert.ok(big.length > 1000);
  assert.throws(() => validateImages([{ mediaType: 'image/png', data: b64(big) }], small), code('image_too_large'));
  const mid = png(16, 16, [0, 0, 0], true);
  assert.ok(mid.length > 750 && mid.length < 1000);
  assert.throws(() => validateImages([{ data: b64(mid) }, { data: b64(mid) }], small), code('images_too_large'));
  assert.throws(() => validateImages([{ data: b64(red) }, { data: b64(red) }, { data: b64(red) }], small), code('images_too_many'));
  assert.equal(validateImages([{ data: b64(red) }, { mediaType: 'image/png', data: b64(blue) }], small).length, 2);
  assert.throws(() => validateImages([{ data: 42 }] as never), code('image_invalid'));
  // Defaults are the documented ones.
  assert.deepEqual({ ...IMAGE_LIMITS }, { maxImageBytes: 5 * 1024 * 1024, maxImages: 4, maxTotalBytes: 10 * 1024 * 1024 });
  const tooMany = Array.from({ length: IMAGE_LIMITS.maxImages + 1 }, () => ({ type: 'image' as const, image: b64(red) }));
  assert.throws(() => userTurnContent(tooMany), code('images_too_many'));
  // An oversized base64 string is rejected before it is decoded.
  assert.throws(() => decodeImagePart({ type: 'image', image: 'A'.repeat(8 * 1024 * 1024) }), code('image_too_large'));
});

test('new turn is converted to Letta ImageContent in order; text-only stays a plain string', () => {
  assert.deepEqual(userTurnContent('hello').message, 'hello');
  assert.deepEqual(userTurnContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]).message, 'ab');
  const turn = userTurnContent([
    { type: 'text', text: 'What is this?' },
    { type: 'file', mediaType: 'image/png', data: { type: 'url', url: dataUrl(red) } },
    { type: 'text', text: ' ' },
    { type: 'image', image: b64(blue), mediaType: 'image/png' },
  ] as never);
  assert.deepEqual(turn.message, [
    { type: 'text', text: 'What is this?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(red) } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(blue) } },
  ]);
  // Image-only turns are allowed; empty turns and non-image files are not.
  assert.deepEqual(userTurnContent([{ type: 'image', image: red }]).message, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(red) } }]);
  assert.throws(() => userTurnContent([{ type: 'text', text: '  ' }]), /text or an image/);
  assert.throws(() => userTurnContent([{ type: 'file', mediaType: 'application/pdf', data: 'JVBERi0=' }]), code('image_unsupported_type'));
  assert.throws(() => userTurnContent('x'.repeat(8001)), /8000/);
});

test('history guard: images compare by content hash; the retained transcript stores no image bytes', async () => {
  const f = fixture();
  const first: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Look' }, { type: 'file', mediaType: 'image/png', url: dataUrl(red) }] };
  const result = await f.agent.generate({ messages: await convertToModelMessages([first]) });
  assert.equal(result.text, 'Seen');
  assert.deepEqual(f.sent[0], [{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(red) } }]);
  // The agent holds only a hash reference, never the bytes.
  const retained = JSON.stringify((f.agent as unknown as { history: ModelMessage[] }).history);
  assert.equal(retained.includes(b64(red)), false);
  assert.ok(retained.includes(sha(red)));
  // A UI client resending the same image (as data URL) extends history correctly.
  const reply: UIMessage = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Seen' }] };
  const next: UIMessage = { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'And now?' }] };
  await f.agent.generate({ messages: await convertToModelMessages([first, reply, next]) });
  assert.deepEqual(f.sent[1], 'And now?');
  // A different image in the old turn is an edit, and is rejected without sending.
  const edited: UIMessage = { ...first, parts: [{ type: 'text', text: 'Look' }, { type: 'file', mediaType: 'image/png', url: dataUrl(blue) }] };
  const again: UIMessage = { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'third' }] };
  await assert.rejects(f.agent.generate({ messages: await convertToModelMessages([edited, reply, next, reply, again]) }), /History edits/);
  // Removing the image is an edit too.
  const stripped: UIMessage = { ...first, parts: [{ type: 'text', text: 'Look' }] };
  await assert.rejects(f.agent.generate({ messages: await convertToModelMessages([stripped, reply, next, reply, again]) }), /History edits/);
  assert.equal(f.sent.length, 2);
});

test('prompt string and prompt messages with images; stream sends exactly the new turn', async () => {
  const f = fixture();
  const stream = await f.agent.stream({ prompt: [{ role: 'user', content: [{ type: 'image', image: red }] }] });
  assert.equal(await stream.text, 'Seen');
  assert.deepEqual(f.sent, [[{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(red) } }]]);
  await f.agent.generate({ prompt: 'text after image' });
  assert.deepEqual(f.sent[1], 'text after image');
  // `transcript` lets a caller extend history with a multimodal turn; it holds hashes, not bytes.
  const transcript = f.agent.transcript;
  assert.equal(JSON.stringify(transcript).includes(b64(red)), false);
  await f.agent.generate({ messages: [...transcript, { role: 'user', content: [{ type: 'text', text: 'again' }, { type: 'image', image: blue }] }] });
  assert.deepEqual(f.sent[2], [{ type: 'text', text: 'again' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(blue) } }]);
  transcript.pop();
  await assert.rejects(f.agent.generate({ messages: [...transcript, { role: 'user', content: 'dropped a turn' }] }), /History edits/);
});

test('invalid images are rejected before any delivery and do not poison the agent', async () => {
  const f = fixture();
  await assert.rejects(f.agent.generate({ messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/svg+xml', data: 'PHN2Zy8+' }] }] }), code('image_unsupported_type'));
  await assert.rejects(f.agent.generate({ messages: [{ role: 'user', content: [{ type: 'image', image: new URL('https://example.com/x.png') }] }] }), code('image_remote_url'));
  assert.equal(f.sent.length, 0);
  assert.equal((await f.agent.generate({ prompt: 'still usable' })).text, 'Seen');
});

test('historyKey distinguishes image position and content, and accepts compact references', () => {
  const withImage = (image: Buffer, before = true): ModelMessage[] => [{ role: 'user', content: before ? [{ type: 'image', image }, { type: 'text', text: 'x' }] : [{ type: 'text', text: 'x' }, { type: 'image', image }] }];
  assert.equal(historyKey(withImage(red)), historyKey(withImage(red)));
  assert.notEqual(historyKey(withImage(red)), historyKey(withImage(blue)));
  assert.notEqual(historyKey(withImage(red, true)), historyKey(withImage(red, false)));
  const compact = compactImagePart({ type: 'image', image: red });
  assert.deepEqual(compact, { type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { [IMAGE_REFERENCE_PROVIDER]: sha(red) } } });
  assert.equal(imagePartDigest(compact), sha(red));
  assert.equal(historyKey([{ role: 'user', content: [compact, { type: 'text', text: 'x' }] }]), historyKey(withImage(red)));
  // Text around an image is not merged across it.
  assert.notEqual(historyKey([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', image: red }, { type: 'text', text: 'b' }] }]),
    historyKey([{ role: 'user', content: [{ type: 'text', text: 'ab' }, { type: 'image', image: red }] }]));
  // Images from the assistant role are not user input history.
  assert.throws(() => historyKey([{ role: 'assistant', content: [{ type: 'file', mediaType: 'image/png', data: red }] }]), /Only text, user image/);
});

const rows = (...messages: Record<string, unknown>[]) => messages as unknown as ListMessagesResult['messages'];
const letta = (bytes: Buffer, type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: type, data: b64(bytes) } });

test('history projection restores user images as data URLs, placeholders for the rest', () => {
  const history = rows(
    { id: 'u1', message_type: 'user_message', date: '2026-09-30T04:52:15.538Z', content: [{ type: 'text', text: '<system-reminder>secret</system-reminder>' }, { type: 'text', text: 'Describe' }, letta(red)] },
    { id: 'a1', message_type: 'assistant_message', content: [{ type: 'text', text: 'A red square.' }] },
    { id: 'u2', message_type: 'user_message', content: [letta(Buffer.from('<svg/>'), 'image/svg+xml'), letta(JPEG, 'image/png'), { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }] },
    { id: 'u3', message_type: 'user_message', content: [letta(blue)] },
  );
  const display = projectHistory(history, []);
  assert.deepEqual(display[0].parts, [{ type: 'text', text: 'Describe' }, { type: 'file', mediaType: 'image/png', url: dataUrl(red) }]);
  assert.equal(display[0].metadata && (display[0].metadata as { createdAt: string }).createdAt, '2026-09-30T04:52:15.538Z');
  // Unsupported, mislabelled and URL images are never turned into a data URL.
  assert.deepEqual(display[2].parts, [{ type: 'text', text: IMAGE_PLACEHOLDER }, { type: 'text', text: IMAGE_PLACEHOLDER }, { type: 'text', text: IMAGE_PLACEHOLDER }]);
  assert.deepEqual(display[3].parts, [{ type: 'file', mediaType: 'image/png', url: dataUrl(blue) }]);
  assert.equal(JSON.stringify(display).includes('secret'), false);
  // The display budget goes to the newest images; older ones become placeholders.
  const limited = projectHistory(history, [], blue.length);
  assert.deepEqual(limited[0].parts, [{ type: 'text', text: 'Describe' }, { type: 'text', text: IMAGE_PLACEHOLDER }]);
  assert.deepEqual(limited[3].parts, [{ type: 'file', mediaType: 'image/png', url: dataUrl(blue) }]);
  assert.deepEqual(projectHistory(history, [], 0)[3].parts, [{ type: 'text', text: IMAGE_PLACEHOLDER }]);
});

test('an unanswered image-only user turn is unsettled history', () => {
  assert.throws(() => assertHistorySettled(rows({ id: 'u', message_type: 'user_message', content: [letta(red)] })), /unfinished/);
  assertHistorySettled(rows({ id: 'u', message_type: 'user_message', content: [letta(red)] }, { id: 'a', message_type: 'assistant_message', content: 'ok' }));
});
