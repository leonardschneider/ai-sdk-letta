import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import { AttachmentStore, FILE_LIMITS, LettaAgent, ToolInteractions, fileTools } from 'ai-sdk-letta';
import { ThreadRuntime, UPLOAD_BODY_LIMIT_BYTES, contentDisposition, displayRun, guiApp, tokenApiApp, type RuntimeHost } from '../src/index.js';
import { tools } from './fixtures.js';

const PDF = readFileSync(fileURLToPath(new URL('../../ai-sdk-letta/test/fixtures/quarterly-report.pdf', import.meta.url)));
const AGENT = 'agent-local-test';

/** A runtime over a fake Letta session whose agent stores attachments like the real one. */
function fixture(options: { files?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-files-server-'));
  const attachmentsRoot = join(directory, 'attachments');
  const sent: SendMessage[] = [];
  const opened: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: LettaAgent<any> | undefined;
  let counter = 0;
  const host: RuntimeHost = {
    ...(options.files === false ? {} : { attachmentsRoot }),
    async close() { current?.close(); current = undefined; },
    async open(choice) {
      const conversationId = 'conversationId' in choice ? choice.conversationId : `conv-${++counter}`;
      opened.push(conversationId);
      const attachments = options.files === false ? undefined : new AttachmentStore(attachmentsRoot, AGENT, conversationId);
      const agent = current = new LettaAgent({ id: 'fixture', tools: { ...tools, ...fileTools }, lettaAgentId: AGENT, interactions: new ToolInteractions(), attachments, open: () => ({
        async send(message) { sent.push(structuredClone(message)); }, async abort() {}, close() {},
        async *stream() {
          yield { type: 'assistant', content: 'Read', uuid: 'a' } as SDKMessage;
          yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId } as SDKMessage;
        },
      }) });
      return { agent, agentId: AGENT, conversationId, history: [] };
    },
  };
  const filename = join(directory, 'state.json');
  const runtime = new ThreadRuntime(host, filename, 'owner');
  return { directory, attachmentsRoot, runtime, sent, opened, filename, cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Fixture deadline');
}
async function serve(app: ReturnType<typeof guiApp>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('runs move staged uploads into the conversation folder and send only the note; state keeps metadata only', async () => {
  const f = fixture();
  try {
    const thread = randomUUID();
    await f.runtime.create('owner', thread, 'Files');
    const pdf = await f.runtime.upload('owner', 'Quarterly report.pdf', PDF);
    const csv = await f.runtime.upload('owner', 'team.csv', Buffer.from('name,role\nAna,Lead\n'));
    assert.deepEqual({ name: pdf.name, kind: pdf.kind, pages: pdf.pages }, { name: 'Quarterly report.pdf', kind: 'pdf', pages: 5 });
    const run = { id: randomUUID(), threadId: thread, text: 'What is the marketing budget?', parentRunId: null, files: [pdf.id!, csv.id!] };
    await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).status === 'completed');
    assert.equal(f.sent[0], 'What is the marketing budget?\n\nAttached: Quarterly report.pdf (PDF, 5 pages, 3 KB)\nAttached: team.csv (CSV, 2 lines, 19 bytes)');
    assert.deepEqual(f.runtime.files('owner', thread).map(file => file.name), ['Quarterly report.pdf', 'team.csv']);
    assert.equal(f.runtime.file('owner', thread, 'team.csv').bytes.toString(), 'name,role\nAna,Lead\n');
    const state = readFileSync(f.filename, 'utf8');
    assert.equal(state.includes('Ana,Lead'), false, 'runtime state never holds file bytes');
    assert.equal(JSON.parse(state).runs[0].files[0].pages, 5);
    assert.deepEqual(readdirSync(join(f.directory, 'uploads', '.staging')), [], 'staged uploads are consumed');
    // Idempotent retry accepted without resending; different files conflict.
    await f.runtime.start('owner', run);
    assert.equal(f.sent.length, 1);
    await assert.rejects(f.runtime.start('owner', { ...run, files: [pdf.id!] }), /id_conflict/);
    // A consumed upload cannot be sent again.
    await assert.rejects(f.runtime.start('owner', { id: randomUUID(), threadId: thread, text: 'again', parentRunId: run.id, files: [pdf.id!] }), (e: Error & { status?: number }) => e.message === 'file_not_found' && e.status === 404);
    // The reconnect/failed view shows the same note.
    const [user] = displayRun(f.runtime.events('owner', run.id, 0) && JSON.parse(readFileSync(f.filename, 'utf8')).runs[0]);
    assert.match((user!.parts[0] as { text: string }).text, /Attached: team\.csv \(CSV, 2 lines, 19 bytes\)$/);
  } finally { await f.cleanup(); }
});

test('images sent with a run are saved under their name (and still sent inline) when the agent has file tools', async () => {
  const f = fixture();
  try {
    const thread = randomUUID();
    await f.runtime.create('owner', thread, 'Images');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
    const run = { id: randomUUID(), threadId: thread, text: 'Look', parentRunId: null, images: [{ mediaType: 'image/png', data: png.toString('base64'), name: '../Screen Shot.png' }] };
    await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).status === 'completed');
    assert.deepEqual((f.sent[0] as { type: string }[]).map(item => item.type), ['text', 'image', 'text']);
    assert.match(JSON.stringify(f.sent[0]), /Attached: Screen Shot\.png \(PNG image, 69 bytes\)/);
    assert.deepEqual(f.runtime.files('owner', thread).map(file => file.name), ['Screen Shot.png']);
  } finally { await f.cleanup(); }
});

test('conversation isolation at the server: each thread lists and downloads only its own files', async () => {
  const f = fixture();
  try {
    const [a, b] = [randomUUID(), randomUUID()];
    await f.runtime.create('owner', a, 'A');
    await f.runtime.create('owner', b, 'B');
    const upload = await f.runtime.upload('owner', 'secret.txt', Buffer.from('alpha only'));
    const run = { id: randomUUID(), threadId: a, text: 'keep this', parentRunId: null, files: [upload.id!] };
    await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).status === 'completed');
    assert.deepEqual(f.runtime.files('owner', a).map(x => x.name), ['secret.txt']);
    assert.deepEqual(f.runtime.files('owner', b), []);
    assert.throws(() => f.runtime.file('owner', b, 'secret.txt'), (e: Error & { status?: number }) => e.message === 'file_not_found' && e.status === 404);
    assert.throws(() => f.runtime.file('owner', a, '../conv-2/secret.txt'), /file_name_invalid/);
    assert.throws(() => f.runtime.files('intruder', a), /forbidden/);
    // Archiving keeps the files.
    f.runtime.updateMetadata('owner', a, { archived: true });
    assert.deepEqual(f.runtime.files('owner', a).map(x => x.name), ['secret.txt']);
  } finally { await f.cleanup(); }
});

test('uploads are validated again on the server, bounded, and refused when the agent has no file tools', async () => {
  const f = fixture();
  const none = fixture({ files: false });
  try {
    await assert.rejects(f.runtime.upload('owner', 'a.bin', Buffer.from([0, 1, 2, 255])), (e: Error & { status?: number }) => e.message === 'file_unsupported_type' && e.status === 400);
    await assert.rejects(f.runtime.upload('owner', 'fake.pdf', Buffer.from('hello')), /file_invalid/);
    await assert.rejects(f.runtime.upload('owner', 'deck.pptx', Buffer.from('PK\x03\x04')), /file_unsupported_type/);
    await assert.rejects(f.runtime.upload('owner', 'big.txt', Buffer.alloc(FILE_LIMITS.maxFileBytes + 1, 97)), (e: Error & { status?: number }) => e.message === 'file_too_large' && e.status === 413);
    await assert.rejects(f.runtime.upload('owner', '', Buffer.from('x')), /file_name_invalid/);
    await assert.rejects(f.runtime.upload('intruder', 'a.txt', Buffer.from('x')), /forbidden/);
    const thread = randomUUID();
    await f.runtime.create('owner', thread, 'Limits');
    const ids: string[] = [];
    for (let i = 0; i <= FILE_LIMITS.maxFilesPerMessage; i++) ids.push((await f.runtime.upload('owner', `${i}.txt`, Buffer.from(`file ${i}`))).id!);
    // At most three uploads are validated at once.
    const burst = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => f.runtime.upload('owner', `b${i}.pdf`, PDF)));
    assert.ok(burst.some(r => r.status === 'rejected' && (r.reason as Error).message === 'uploads_busy'));
    assert.ok(burst.filter(r => r.status === 'fulfilled').length >= 3);
    await assert.rejects(f.runtime.start('owner', { id: randomUUID(), threadId: thread, text: 'x', parentRunId: null, files: ids }), /files_too_many/);
    await assert.rejects(f.runtime.start('owner', { id: randomUUID(), threadId: thread, text: 'x', parentRunId: null, files: ['not-a-uuid'] }), /invalid_input/);
    await assert.rejects(f.runtime.start('owner', { id: randomUUID(), threadId: thread, text: 'x', parentRunId: null, files: [randomUUID()] }), /file_not_found/);
    assert.equal(f.sent.length, 0);
    await assert.rejects(none.runtime.upload('owner', 'a.txt', Buffer.from('x')), (e: Error & { status?: number }) => e.message === 'files_unavailable' && e.status === 404);
    const other = randomUUID();
    await none.runtime.create('owner', other, 'No files');
    await assert.rejects(none.runtime.start('owner', { id: randomUUID(), threadId: other, text: 'x', parentRunId: null, files: [randomUUID()] }), /files_unavailable/);
    assert.throws(() => none.runtime.files('owner', other), /files_unavailable/);
  } finally { await f.cleanup(); await none.cleanup(); }
});

test('content-disposition is always an attachment with a safe ASCII fallback and the exact UTF-8 name', () => {
  assert.equal(contentDisposition('report.pdf'), `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  assert.equal(contentDisposition('Bericht über Q3 (final).pdf'), `attachment; filename="Bericht uber Q3 (final).pdf"; filename*=UTF-8''Bericht%20%C3%BCber%20Q3%20%28final%29.pdf`);
  const tricky = contentDisposition('a"b\\c;d%e.txt');
  assert.match(tricky, /^attachment; filename="a_b_c_d_e\.txt"; filename\*=UTF-8''a%22b%5Cc%3Bd%25e\.txt$/);
  assert.equal(contentDisposition('日本.txt').startsWith('attachment; filename=".txt"'), true);
});

test('GUI routes: upload, list and download need the session; uploads need Origin and CSRF; body limits and headers', async () => {
  const f = fixture();
  const assets = join(f.directory, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const { base, close } = await serve(guiApp(f.runtime, 'owner', 0, assets, { id: 'sandbox', name: 'Sandbox', files: true }));
  try {
    const session = await fetch(`${base}/api/session`);
    const { csrf, agent } = await session.json() as { csrf: string; agent: { files: boolean } };
    assert.equal(agent.files, true);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const json = { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': csrf };
    const raw = (name: string) => ({ cookie, origin: base, 'content-type': 'application/octet-stream', 'x-csrf-token': csrf, 'x-file-name': encodeURIComponent(name) });
    // Authentication and CSRF.
    assert.equal((await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...raw('a.txt'), cookie: '' }, body: 'hello' })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...raw('a.txt'), 'x-csrf-token': 'nope' }, body: 'hello' })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...raw('a.txt'), origin: 'https://evil.test' }, body: 'hello' })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...raw('a.txt'), 'sec-fetch-site': 'cross-site' }, body: 'hello' })).status, 403);
    // Only raw octet-stream bodies.
    assert.equal((await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...json, 'x-file-name': 'a.txt' }, body: '{"a":1}' })).status, 415);
    // Upload a PDF and a CSV with a non-ASCII name.
    const pdf = await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: raw('Bericht über Q3.pdf'), body: PDF });
    assert.equal(pdf.status, 201);
    const pdfMeta = await pdf.json() as { id: string; name: string; pages: number };
    assert.deepEqual({ name: pdfMeta.name, pages: pdfMeta.pages }, { name: 'Bericht über Q3.pdf', pages: 5 });
    const csv = await (await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: raw('<script>.html'), body: '<script>alert(1)</script>' })).json() as { id: string; name: string };
    assert.equal(csv.name, '_script_.html');
    // Refused uploads get fixed codes.
    const binary = await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: raw('x.bin'), body: Buffer.from([0, 1, 2, 3]) });
    assert.equal(binary.status, 400); assert.deepEqual(await binary.json(), { error: 'file_unsupported_type' });
    // The raised limit applies only here and stays bounded.
    const huge = await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: raw('huge.txt'), body: Buffer.alloc(UPLOAD_BODY_LIMIT_BYTES + 1, 97) });
    assert.equal(huge.status, 413); assert.deepEqual(await huge.json(), { error: 'payload_too_large' });
    const otherRoute = await fetch(`${base}/api/v1/threads`, { method: 'POST', headers: { ...raw('x'), 'content-type': 'application/octet-stream' }, body: Buffer.alloc(64 * 1024, 97) });
    assert.notEqual(otherRoute.status, 201);
    // Send them with a run.
    const thread = randomUUID();
    assert.equal((await fetch(`${base}/api/v1/threads`, { method: 'POST', headers: json, body: JSON.stringify({ id: thread, title: 'Files' }) })).status, 201);
    const started = await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: json, body: JSON.stringify({ id: randomUUID(), threadId: thread, text: 'Read these', parentRunId: null, files: [pdfMeta.id, csv.id] }) });
    assert.equal(started.status, 202);
    const { id } = await started.json() as { id: string };
    await until(() => f.runtime.events('owner', id, 0).status === 'completed');
    // List and download: session required, read-only (no CSRF needed for GET).
    assert.equal((await fetch(`${base}/api/v1/threads/${thread}/files`)).status, 401);
    const list = await (await fetch(`${base}/api/v1/threads/${thread}/files`, { headers: { cookie } })).json() as { name: string; pages?: number }[];
    assert.deepEqual(list.map(x => [x.name, x.pages]), [['Bericht über Q3.pdf', 5], ['_script_.html', undefined]]);
    const download = await fetch(`${base}/api/v1/threads/${thread}/files/${encodeURIComponent('Bericht über Q3.pdf')}`, { headers: { cookie } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.equal(download.headers.get('content-disposition'), `attachment; filename="Bericht uber Q3.pdf"; filename*=UTF-8''Bericht%20%C3%BCber%20Q3.pdf`);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(download.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(download.headers.get('content-security-policy')!, /sandbox/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PDF);
    const html = await fetch(`${base}/api/v1/threads/${thread}/files/_script_.html`, { headers: { cookie } });
    assert.equal(html.headers.get('content-type'), 'text/plain; charset=utf-8', 'text is never served as HTML');
    assert.match(html.headers.get('content-disposition')!, /^attachment;/);
    assert.equal((await fetch(`${base}/api/v1/threads/${thread}/files/${encodeURIComponent('../state.json')}`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${base}/api/v1/threads/${thread}/files/missing.pdf`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/v1/threads/${thread}/files/x`, { headers: { cookie, origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/threads/${randomUUID()}/files`, { headers: { cookie } })).status, 404);
    const capabilities = await (await fetch(`${base}/api/v1/capabilities`, { headers: { cookie } })).json() as { files: { maxFileBytes: number } };
    assert.equal(capabilities.files.maxFileBytes, FILE_LIMITS.maxFileBytes);
  } finally { await close(); await f.cleanup(); }
});

test('token API: uploads and downloads need the bearer token and refuse browser origins', async () => {
  const f = fixture();
  const token = 'c'.repeat(64);
  const { base, close } = await serve(tokenApiApp(f.runtime, token, 'owner', 0));
  const headers = { authorization: `Bearer ${token}`, 'x-runtime-owner': 'owner' };
  try {
    assert.equal((await fetch(`${base}/v1/uploads`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'a.txt' }, body: 'x' })).status, 401);
    assert.equal((await fetch(`${base}/v1/uploads`, { method: 'POST', headers: { ...headers, origin: 'http://127.0.0.1', 'content-type': 'application/octet-stream', 'x-file-name': 'a.txt' }, body: 'x' })).status, 401);
    const upload = await fetch(`${base}/v1/uploads`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': 'notes.md' }, body: '# Notes\n' });
    assert.equal(upload.status, 201);
    const { id } = await upload.json() as { id: string };
    const thread = randomUUID();
    await fetch(`${base}/v1/threads`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: thread, title: 'API' }) });
    const run = await fetch(`${base}/v1/runs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), threadId: thread, text: '', parentRunId: null, files: [id] }) });
    assert.equal(run.status, 202);
    await until(() => f.sent.length === 1);
    assert.equal(f.sent[0], 'Attached: notes.md (Markdown, 1 line, 8 bytes)');
    assert.equal((await fetch(`${base}/v1/threads/${thread}/files/notes.md`)).status, 401);
    assert.equal(await (await fetch(`${base}/v1/threads/${thread}/files/notes.md`, { headers })).text(), '# Notes\n');
  } finally { await close(); await f.cleanup(); }
});
