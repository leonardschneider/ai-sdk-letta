import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import { IMAGE_LIMITS, IMAGE_PLACEHOLDER, LettaAgent, ToolInteractions } from 'ai-sdk-letta';
import { BODY_LIMIT_BYTES, RUN_BODY_LIMIT_BYTES, ThreadRuntime, displayRun, guiApp, tokenApiApp, type RuntimeHost } from '../src/index.js';
import { tools } from './fixtures.js';

/** A valid PNG whose size is roughly `bytes` (stored, uncompressed noise). */
function png(bytes = 64): Buffer {
  const side = Math.max(1, Math.floor(Math.sqrt(bytes / 3)));
  const raw = Buffer.alloc((side * 3 + 1) * side);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  for (let y = 0; y < side; y++) raw[y * (side * 3 + 1)] = 0;
  const chunk = (type: string, data: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}
const image = (bytes = 64) => ({ mediaType: 'image/png', data: png(bytes).toString('base64') });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-images-'));
  const sent: SendMessage[] = [];
  let current: LettaAgent<typeof tools> | undefined;
  const host: RuntimeHost = {
    async close() { current?.close(); current = undefined; },
    async open(options) {
      const conversationId = 'conversationId' in options ? options.conversationId : randomUUID();
      const agent = current = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'same-agent', interactions: new ToolInteractions(), open: () => ({
        async send(message) { sent.push(structuredClone(message)); }, async abort() {}, close() {},
        async *stream() {
          yield { type: 'assistant', content: 'Seen', uuid: 'a' } as SDKMessage;
          yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId } as SDKMessage;
        },
      }) });
      return { agent, agentId: 'same-agent', conversationId, history: [] };
    },
  };
  const filename = join(directory, 'state.json');
  const runtime = new ThreadRuntime(host, filename, 'owner');
  return { directory, runtime, sent, filename, cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Fixture deadline');
}

test('runs send exactly the new turn as Letta ImageContent; state keeps only image metadata', async () => {
  const f = fixture();
  try {
    const thread = randomUUID();
    await f.runtime.create('owner', thread, 'Images');
    const picture = image();
    const run = { id: randomUUID(), threadId: thread, text: 'What is this?', parentRunId: null, images: [picture] };
    await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).status === 'completed');
    assert.deepEqual(f.sent, [[{ type: 'text', text: 'What is this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: picture.data } }]]);
    // Image-only turn.
    const only = { id: randomUUID(), threadId: thread, text: '', parentRunId: run.id, images: [picture, image(100)] };
    await f.runtime.start('owner', only);
    await until(() => f.runtime.events('owner', only.id, 0).status === 'completed');
    assert.equal((f.sent[1] as unknown[]).length, 2);
    const state = readFileSync(f.filename, 'utf8');
    assert.equal(state.includes(picture.data), false, 'runtime state must never hold image bytes');
    const saved = JSON.parse(state).runs[0].images;
    assert.equal(saved.length, 1); assert.equal(saved[0].mediaType, 'image/png'); assert.match(saved[0].sha256, /^[a-f0-9]{64}$/);
    // Idempotent retry with the same images is accepted without resending; different images conflict.
    await f.runtime.start('owner', run);
    assert.equal(f.sent.length, 2);
    await assert.rejects(f.runtime.start('owner', { ...run, images: [image(100)] }), /id_conflict/);
    await assert.rejects(f.runtime.start('owner', { ...run, images: [] }), /id_conflict/);
  } finally { await f.cleanup(); }
});

test('runtime rejects invalid images with fixed codes and never delivers them', async () => {
  const f = fixture();
  try {
    const thread = randomUUID();
    await f.runtime.create('owner', thread, 'Images');
    const run = (images: unknown, text = 'x') => ({ id: randomUUID(), threadId: thread, text, parentRunId: null, images } as never);
    const svg = { mediaType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') };
    await assert.rejects(f.runtime.start('owner', run([svg])), (e: Error & { status?: number }) => e.message === 'image_unsupported_type' && e.status === 400);
    await assert.rejects(f.runtime.start('owner', run([{ mediaType: 'image/png', data: Buffer.from('GIF89a').toString('base64') }])), /image_invalid/);
    await assert.rejects(f.runtime.start('owner', run([{ mediaType: 'image/png', data: 'https://example.com/x.png' }])), /image_remote_url|image_invalid/);
    await assert.rejects(f.runtime.start('owner', run(Array.from({ length: IMAGE_LIMITS.maxImages + 1 }, () => image()))), (e: Error & { status?: number }) => e.message === 'images_too_many' && e.status === 400);
    await assert.rejects(f.runtime.start('owner', run([image(IMAGE_LIMITS.maxImageBytes + 1024)])), (e: Error & { status?: number }) => e.message === 'image_too_large' && e.status === 413);
    const nearMax = image(IMAGE_LIMITS.maxImageBytes - 64 * 1024);
    await assert.rejects(f.runtime.start('owner', run([nearMax, nearMax, nearMax])), (e: Error & { status?: number }) => e.message === 'images_too_large' && e.status === 413);
    await assert.rejects(f.runtime.start('owner', run('not a list')), /invalid_input/);
    await assert.rejects(f.runtime.start('owner', run([], '   ')), /invalid_input/);
    assert.equal(f.sent.length, 0);
  } finally { await f.cleanup(); }
});

test('reconnect and failed-run views show an [Image] placeholder, never bytes', () => {
  const [user] = displayRun({ id: 'r', threadId: 't', input: '', images: [{ mediaType: 'image/png', bytes: 10, sha256: 'a'.repeat(64) }], parentRunId: null, status: 'failed', events: [] });
  assert.deepEqual(user.parts, [{ type: 'text', text: IMAGE_PLACEHOLDER }]);
  const [withText] = displayRun({ id: 'r', threadId: 't', input: 'hi', images: [{ mediaType: 'image/png', bytes: 10, sha256: 'a'.repeat(64) }, { mediaType: 'image/png', bytes: 10, sha256: 'b'.repeat(64) }], parentRunId: null, status: 'failed', events: [] });
  assert.deepEqual(withText.parts, [{ type: 'text', text: 'hi' }, { type: 'text', text: IMAGE_PLACEHOLDER }, { type: 'text', text: IMAGE_PLACEHOLDER }]);
});

test('GUI: raised body limit applies only to POST /v1/runs, still bounded, behind session, Origin and CSRF', async () => {
  const f = fixture();
  const assets = join(f.directory, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const server = guiApp(f.runtime, 'owner', 0, assets, { id: 'sandbox', name: 'Sandbox' }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/session`);
    const { csrf } = await session.json() as { csrf: string };
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': csrf };
    const thread = randomUUID();
    assert.equal((await fetch(`${base}/api/v1/threads`, { method: 'POST', headers, body: JSON.stringify({ id: thread, title: 'Images' }) })).status, 201);
    const picture = image(2 * 1024 * 1024);
    const body = JSON.stringify({ id: randomUUID(), threadId: thread, text: 'Look', parentRunId: null, images: [picture] });
    assert.ok(body.length > BODY_LIMIT_BYTES * 50);
    // Mutations with images still need the session cookie, the exact Origin and the CSRF token.
    assert.equal((await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: { ...headers, cookie: '' }, body })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: { ...headers, 'x-csrf-token': 'x' }, body })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: { ...headers, origin: 'http://localhost:4400' }, body })).status, 403);
    assert.equal(f.sent.length, 0);
    const accepted = await fetch(`${base}/api/v1/runs`, { method: 'POST', headers, body });
    assert.equal(accepted.status, 202);
    const { id } = await accepted.json() as { id: string };
    await until(() => f.runtime.events('owner', id, 0).status === 'completed');
    assert.equal(f.sent.length, 1);
    // Other routes keep the small limit.
    const bigPatch = JSON.stringify({ title: 'x'.repeat(BODY_LIMIT_BYTES + 10) });
    const patch = await fetch(`${base}/api/v1/threads/${thread}`, { method: 'PATCH', headers, body: bigPatch });
    assert.equal(patch.status, 413); assert.deepEqual(await patch.json(), { error: 'payload_too_large' });
    const bigThread = await fetch(`${base}/api/v1/threads`, { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), title: 'x', pad: 'y'.repeat(BODY_LIMIT_BYTES) }) });
    assert.equal(bigThread.status, 413);
    // The runs route is still bounded.
    const huge = JSON.stringify({ id: randomUUID(), threadId: thread, text: 'x', parentRunId: null, images: [{ mediaType: 'image/png', data: 'A'.repeat(RUN_BODY_LIMIT_BYTES) }] });
    const tooBig = await fetch(`${base}/api/v1/runs`, { method: 'POST', headers, body: huge });
    assert.equal(tooBig.status, 413); assert.deepEqual(await tooBig.json(), { error: 'payload_too_large' });
    // Oversized decoded images get a fixed image code.
    const over = await fetch(`${base}/api/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), threadId: thread, text: 'x', parentRunId: id, images: [image(IMAGE_LIMITS.maxImageBytes + 1024)] }) });
    assert.equal(over.status, 413); assert.deepEqual(await over.json(), { error: 'image_too_large' });
    const svg = await fetch(`${base}/api/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), threadId: thread, text: 'x', parentRunId: id, images: [{ mediaType: 'image/svg+xml', data: 'PHN2Zy8+' }] }) });
    assert.equal(svg.status, 400); assert.deepEqual(await svg.json(), { error: 'image_unsupported_type' });
    assert.equal(f.sent.length, 1);
    // CSP: local blob/data images only; never remote.
    const csp = (await fetch(base)).headers.get('content-security-policy')!;
    assert.match(csp, /img-src 'self' data: blob:;/);
    assert.doesNotMatch(csp, /img-src[^;]*(https?:|\*)/);
    const capabilities = await (await fetch(`${base}/api/v1/capabilities`, { headers: { cookie } })).json() as { images: { maxImages: number; mediaTypes: string[] } };
    assert.equal(capabilities.images.maxImages, IMAGE_LIMITS.maxImages);
    assert.deepEqual(capabilities.images.mediaTypes, ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test('token API accepts image runs under the same bounds, and still refuses browsers', async () => {
  const f = fixture();
  const token = 'b'.repeat(64);
  const server = tokenApiApp(f.runtime, token, 'owner', 0).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-runtime-owner': 'owner', 'content-type': 'application/json' };
  try {
    const thread = randomUUID();
    assert.equal((await fetch(`${base}/v1/threads`, { method: 'POST', headers, body: JSON.stringify({ id: thread, title: 'API' }) })).status, 201);
    const body = JSON.stringify({ id: randomUUID(), threadId: thread, text: '', parentRunId: null, images: [image(512 * 1024)] });
    assert.equal((await fetch(`${base}/v1/runs`, { method: 'POST', headers: { ...headers, origin: 'http://127.0.0.1' }, body })).status, 401);
    assert.equal((await fetch(`${base}/v1/runs`, { method: 'POST', headers, body })).status, 202);
    await until(() => f.sent.length === 1);
    assert.equal((f.sent[0] as { type: string }[])[0]!.type, 'image');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
