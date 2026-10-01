import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { AttachmentStore, LettaAgent, ResourceStore, ToolInteractions, fileTools } from 'ai-sdk-letta';
import { PDF_PREVIEW_CSP, PREVIEW_CSP, ThreadRuntime, guiApp, previewType, tokenApiApp, type RuntimeHost } from '../src/index.js';
import { tools } from './fixtures.js';

const PDF = readFileSync(fileURLToPath(new URL('../../ai-sdk-letta/test/fixtures/quarterly-report.pdf', import.meta.url)));
const AGENT = 'agent-local-test';

/** A runtime whose fake agent stores attachments in the resources, as the real one does. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-resources-server-'));
  const root = join(directory, 'resources');
  let counter = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: LettaAgent<any> | undefined;
  const host: RuntimeHost = {
    attachmentsRoot: root,
    async close() { current?.close(); current = undefined; },
    async open(choice) {
      const conversationId = 'conversationId' in choice ? choice.conversationId : `conv-${++counter}`;
      const title = 'newTitle' in choice ? choice.newTitle : undefined;
      const store = ResourceStore.open(root, AGENT);
      const attachments = new AttachmentStore(store, conversationId, { title });
      const agent = current = new LettaAgent({ id: 'fixture', tools: { ...tools, ...fileTools }, lettaAgentId: AGENT, interactions: new ToolInteractions(), attachments,
        beforeTurn: () => store.beginTurn(conversationId), afterTurn: () => store.endTurn(conversationId),
        open: () => ({
          async send() { writeFileSync(join(attachments.directory, 'agent-notes.md'), '# Made by the agent\n'); }, async abort() {}, close() {},
          async *stream() { yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId } as SDKMessage; },
        }) });
      return { agent, agentId: AGENT, conversationId, history: [] };
    },
  };
  const runtime = new ThreadRuntime(host, join(directory, 'state.json'), 'owner');
  const store = () => ResourceStore.open(root, AGENT);
  return { directory, root, runtime, store, cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Fixture deadline');
}
const subjects = (store: ResourceStore) => execFileSync('git', [`--git-dir=${store.gitDir}`, 'log', '--format=%s'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString().trim().split('\n');
async function serve(app: ReturnType<typeof guiApp>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('preview types: HTML only for .html text, everything else plain text, images and PDFs as such; no preview for other bytes', () => {
  assert.equal(previewType({ name: 'a.html', kind: 'text', mediaType: 'text/plain' }), 'text/html; charset=utf-8');
  assert.equal(previewType({ name: 'a.svg', kind: 'text', mediaType: 'text/plain' }), 'text/plain; charset=utf-8', 'SVG (script-capable) is shown as text');
  assert.equal(previewType({ name: 'a.csv', kind: 'text', mediaType: 'text/csv' }), 'text/plain; charset=utf-8');
  assert.equal(previewType({ name: 'a.pdf', kind: 'pdf', mediaType: 'application/pdf' }), 'application/pdf');
  assert.equal(previewType({ name: 'a.png', kind: 'image', mediaType: 'image/png' }), 'image/png');
  assert.equal(previewType({ name: 'a.bin', kind: 'other', mediaType: 'application/octet-stream' }), undefined);
  for (const policy of [PREVIEW_CSP, PDF_PREVIEW_CSP]) {
    assert.match(policy, /default-src 'none'/);
    assert.doesNotMatch(policy, /script-src|connect-src|https?:|\*/, 'no script source and no network');
  }
  assert.match(PREVIEW_CSP, /; sandbox$/, 'sandboxed: opaque origin, no scripts, forms or popups');
});

test('the tree has one folder per conversation (with its thread), user folders, and changes when the agent writes files', async () => {
  const f = fixture();
  try {
    const [a, b] = [randomUUID(), randomUUID()];
    await f.runtime.create('owner', a, 'Trip planning');
    await f.runtime.create('owner', b, 'Budget');
    const tree = await f.runtime.resourceTree('owner');
    assert.deepEqual(tree.children.map(n => [n.name, n.type, n.conversationId]), [['Budget', 'folder', 'conv-2'], ['Trip planning', 'folder', 'conv-1']]);
    assert.deepEqual(tree.threads, { 'Trip planning': a, Budget: b });
    // A turn: the agent writes a file; it is committed at the end of the turn, and the tree's version changes.
    const run = { id: randomUUID(), threadId: b, text: 'write notes', parentRunId: null };
    await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).status === 'completed');
    await until(() => f.store().commits > tree.changes);
    assert.equal(subjects(f.store())[0], 'Agent changes in Budget');
    const after = await f.runtime.resourceTree('owner');
    assert.notEqual(after.version, tree.version);
    assert.ok(after.changes > tree.changes, 'commits are counted, so the browser can refresh');
    assert.deepEqual(after.children.find(n => n.name === 'Budget')!.children!.map(n => [n.name, n.bytes]), [['agent-notes.md', 20]]);
    // Every rename of the conversation renames its folder.
    const c = randomUUID();
    await f.runtime.create('owner', c, 'New conversation');
    f.runtime.updateMetadata('owner', c, { title: 'Lisbon itinerary' });
    await f.runtime.folderRenamed();
    assert.ok((await f.runtime.resourceTree('owner')).children.some(n => n.name === 'Lisbon itinerary'));
    f.runtime.updateMetadata('owner', c, { title: 'Porto itinerary' });
    await f.runtime.folderRenamed();
    const names = (await f.runtime.resourceTree('owner')).children.map(n => n.name);
    assert.ok(names.includes('Porto itinerary') && !names.includes('Lisbon itinerary'), names.join());
  } finally { await f.cleanup(); }
});

test('renaming a conversation during a turn renames its folder after the turn; the running command keeps its folder; chips resolve', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-rename-'));
  const root = join(directory, 'resources');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let cwdDuringTurn = '';
  let wroteAfterRename = false;
  const host: RuntimeHost = {
    attachmentsRoot: root,
    async close() {},
    async open() {
      const store = ResourceStore.open(root, AGENT);
      const attachments = new AttachmentStore(store, 'conv-1', { title: 'Trip' });
      const agent = new LettaAgent({ id: 'fixture', tools: { ...tools, ...fileTools }, lettaAgentId: AGENT, interactions: new ToolInteractions(), attachments,
        beforeTurn: () => store.beginTurn('conv-1'), afterTurn: () => store.endTurn('conv-1'),
        open: () => ({
          // Like a command running in the conversation's folder: it starts there, the user renames the chat, it keeps writing there.
          async send() { cwdDuringTurn = attachments.directory; await gate; writeFileSync(join(cwdDuringTurn, 'result.txt'), 'done'); wroteAfterRename = true; },
          async abort() {}, close() {},
          async *stream() { yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId: 'conv-1' } as SDKMessage; },
        }) });
      return { agent, agentId: AGENT, conversationId: 'conv-1', history: [] };
    },
  };
  const runtime = new ThreadRuntime(host, join(directory, 'state.json'), 'owner');
  try {
    const thread = randomUUID();
    await runtime.create('owner', thread, 'Trip');
    const staged = await runtime.upload('owner', 'plan.md', Buffer.from('# Plan\n'));
    const run = { id: randomUUID(), threadId: thread, text: 'work', parentRunId: null, files: [staged.id!] };
    await runtime.start('owner', run);
    await until(() => cwdDuringTurn !== '');
    runtime.updateMetadata('owner', thread, { title: 'Lisbon' });
    await runtime.folderRenamed();
    assert.deepEqual((await runtime.resourceTree('owner')).children.map(n => n.name), ['Trip'], 'not renamed while the turn runs');
    release();
    await until(() => runtime.events('owner', run.id, 0).status === 'completed');
    const store = ResourceStore.open(root, AGENT);
    await until(() => subjects(store)[0] === 'Rename folder Trip → Lisbon');
    assert.ok(wroteAfterRename);
    assert.deepEqual(subjects(store).slice(0, 2), ['Rename folder Trip → Lisbon', 'Agent changes in Trip']);
    assert.deepEqual((await runtime.resourceTree('owner')).children[0]!.children!.map(n => n.name), ['plan.md', 'result.txt'], 'the command finished in the folder, which then moved as a whole');
    assert.equal(runtime.file('owner', thread, 'plan.md').bytes.toString(), '# Plan\n', 'the chip still downloads');
    // Idle again: a rename applies at once.
    runtime.updateMetadata('owner', thread, { title: 'Porto' });
    await runtime.folderRenamed();
    assert.deepEqual((await runtime.resourceTree('owner')).children.map(n => n.name), ['Porto']);
    assert.equal(runtime.file('owner', thread, 'plan.md').bytes.toString(), '# Plan\n');
  } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('operations: upload, folder, move, rename, delete and restore are one commit each; chips in old messages still download after moves', async () => {
  const f = fixture();
  try {
    const a = randomUUID();
    await f.runtime.create('owner', a, 'Alpha');
    const staged = await f.runtime.upload('owner', 'report.pdf', PDF);
    const run = { id: randomUUID(), threadId: a, text: 'read it', parentRunId: null, files: [staged.id!] };
    await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).status === 'completed');
    assert.equal(f.runtime.file('owner', a, 'report.pdf').bytes.byteLength, PDF.byteLength);
    await f.runtime.resourceUpload('owner', 'Alpha', 'data.csv', Buffer.from('a,b\n1,2\n'));
    await f.runtime.resourceFolder('owner', { parent: '', name: 'Archive' });
    await f.runtime.resourceMove('owner', { from: 'Alpha/report.pdf', to: 'Archive/report.pdf' });
    await f.runtime.resourceMove('owner', { from: 'Archive/report.pdf', to: 'Archive/Q3 report.pdf' });
    // The message's chip ("report.pdf" in Alpha) follows the file.
    const moved = f.runtime.file('owner', a, 'report.pdf');
    assert.equal(moved.file.name, 'Q3 report.pdf');
    assert.deepEqual(moved.bytes, PDF);
    const deleted = await f.runtime.resourceDelete('owner', { path: 'Archive' });
    assert.throws(() => f.runtime.file('owner', a, 'report.pdf'), /file_not_found/);
    await f.runtime.resourceRestore('owner', { path: 'Archive', commit: deleted.commit });
    assert.deepEqual(f.runtime.file('owner', a, 'report.pdf').bytes, PDF, 'undo brings the file and its link back');
    const log = (await f.runtime.resourceHistory('owner')).map(c => c.message);
    assert.deepEqual(log.slice(0, 7), ['Restore Archive', 'Delete Archive', 'Rename Archive/report.pdf to Q3 report.pdf', 'Move Alpha/report.pdf to Archive', 'Create folder Archive', 'Upload Alpha/data.csv', 'Agent changes in Alpha']);
    assert.ok(log.includes('Attach report.pdf in Alpha'));
    // Fixed error codes, nothing changed.
    await assert.rejects(f.runtime.resourceMove('owner', { from: 'Alpha', to: 'Alpha/x' }), /file_name_invalid/);
    await assert.rejects(f.runtime.resourceMove('owner', { from: 'Alpha/data.csv', to: 'Archive/Q3 report.pdf' }), (e: Error & { status?: number }) => e.message === 'file_exists' && e.status === 409);
    await assert.rejects(f.runtime.resourceDelete('owner', { path: '../state.json' }), /file_name_invalid/);
    assert.throws(() => f.runtime.resourceDelete('owner', {}), /invalid_input/);
    await assert.rejects(f.runtime.resourceTree('intruder'), /forbidden/);
  } finally { await f.cleanup(); }
});

test('HTTP: resources need the session, mutations need Origin and CSRF; previews are inline, sandboxed and never same-origin script', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-assets-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const { base, close } = await serve(guiApp(f.runtime, 'owner', 0, dir, { id: 'x', name: 'X', files: true }));
  try {
    const session = await fetch(`${base}/api/session`);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf } = await session.json() as { csrf: string };
    const json = { cookie, origin: base, 'x-csrf-token': csrf, 'content-type': 'application/json' };
    const a = randomUUID();
    await fetch(`${base}/api/v1/threads`, { method: 'POST', headers: json, body: JSON.stringify({ id: a, title: 'Alpha' }) });
    assert.equal((await fetch(`${base}/api/v1/resources`)).status, 401, 'session required');
    const tree = await (await fetch(`${base}/api/v1/resources`, { headers: { cookie } })).json() as { children: { name: string }[] };
    assert.deepEqual(tree.children.map(n => n.name), ['Alpha']);
    const upload = (name: string, body: string | Uint8Array, headers: Record<string, string> = { cookie, origin: base, 'x-csrf-token': csrf }) => fetch(`${base}/api/v1/resources/upload?folder=Alpha`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) }, body });
    assert.equal((await upload('x.txt', 'x', { cookie })).status, 403, 'CSRF required');
    assert.equal((await upload('x.txt', 'x', { cookie, origin: 'https://evil.test', 'x-csrf-token': csrf })).status, 403, 'Origin checked');
    const html = '<!doctype html><title>Safe</title><script>document.title="PWNED";fetch("https://evil.test")</script><p>Hello <b>world</b></p>';
    assert.equal((await upload('page.html', html)).status, 201);
    assert.equal((await upload('report.pdf', PDF)).status, 201);
    assert.equal((await upload('tool.bin', new Uint8Array([0, 1, 2, 3]))).status, 201, 'any type can be stored');
    const preview = (path: string) => fetch(`${base}/api/v1/resources/preview?path=${encodeURIComponent(path)}`, { headers: { cookie } });
    const page = await preview('Alpha/page.html');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(page.headers.get('content-security-policy'), PREVIEW_CSP);
    assert.match(page.headers.get('content-disposition')!, /^inline;/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(await page.text(), html);
    const pdf = await preview('Alpha/report.pdf');
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(pdf.headers.get('content-security-policy'), PDF_PREVIEW_CSP);
    assert.equal((await preview('Alpha/tool.bin')).status, 415);
    assert.equal((await preview('../state.json')).status, 400);
    assert.equal((await preview('Alpha/missing.txt')).status, 404);
    const download = await fetch(`${base}/api/v1/resources/file?path=${encodeURIComponent('Alpha/page.html')}`, { headers: { cookie } });
    assert.equal(download.headers.get('content-type'), 'text/plain; charset=utf-8', 'downloads never serve HTML');
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    const bin = await fetch(`${base}/api/v1/resources/file?path=${encodeURIComponent('Alpha/tool.bin')}`, { headers: { cookie } });
    assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
    // Mutations through JSON routes.
    const post = (path: string, body: unknown, headers: Record<string, string> = json) => fetch(`${base}/api/v1/resources/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post('folders', { parent: '', name: 'Archive' }, { cookie, 'content-type': 'application/json' })).status, 403);
    assert.equal((await post('folders', { parent: '', name: 'Archive' })).status, 201);
    assert.equal((await post('move', { from: 'Alpha/page.html', to: 'Archive/page.html' })).status, 200);
    assert.equal((await post('move', { from: 'Alpha/report.pdf', to: '../../escape.pdf' })).status, 400);
    const removed = await (await post('delete', { path: 'Archive/page.html' })).json() as { commit: string };
    assert.equal((await post('restore', { path: 'Archive/page.html', commit: removed.commit })).status, 200);
    assert.equal((await post('restore', { path: 'Archive/page.html', commit: removed.commit })).status, 409);
    const history = await (await fetch(`${base}/api/v1/resources/history`, { headers: { cookie } })).json() as { message: string }[];
    assert.deepEqual(history.slice(0, 4).map(c => c.message), ['Restore Archive/page.html', 'Delete Archive/page.html', 'Move Alpha/page.html to Archive', 'Create folder Archive']);
    // The app may frame previews from itself; nothing else may frame the app.
    const app = await fetch(base);
    assert.match(app.headers.get('content-security-policy')!, /frame-src 'self'/);
    assert.match(app.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  } finally { await close(); await f.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('token API exposes the same resources routes behind the bearer token', async () => {
  const f = fixture();
  const token = 'd'.repeat(64);
  const { base, close } = await serve(tokenApiApp(f.runtime, token, 'owner', 0));
  const headers = { authorization: `Bearer ${token}`, 'x-runtime-owner': 'owner' };
  try {
    await f.runtime.create('owner', randomUUID(), 'Alpha');
    assert.equal((await fetch(`${base}/v1/resources`)).status, 401);
    const tree = await (await fetch(`${base}/v1/resources`, { headers })).json() as { children: { name: string }[] };
    assert.deepEqual(tree.children.map(n => n.name), ['Alpha']);
  } finally { await close(); await f.cleanup(); }
});
