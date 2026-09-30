import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { UIMessage } from 'ai';
import { LettaAgent } from 'ai-sdk-letta';
import { ThreadRuntime, RuntimeFault, tokenApiApp, type RuntimeHost } from '../src/index.js';
import { tools } from './fixtures.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-metadata-'));
  const filename = join(directory, 'state.json');
  const history: UIMessage[] = [{ id: 'existing', role: 'user', parts: [{ type: 'text', text: 'Existing history' }] }];
  let opens = 0, closes = 0, sends = 0;
  const host: RuntimeHost = {
    async close() { closes++; },
    async open(options) {
      opens++;
      const agent = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'same-agent', open: signal => ({
        async send() { sends++; }, async abort() {}, close() {},
        async *stream() {
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      }) });
      return { agent, agentId: 'same-agent', conversationId: 'conversationId' in options ? options.conversationId : randomUUID(), history: structuredClone(history) };
    },
  };
  const runtime = new ThreadRuntime(host, filename, 'owner');
  return { runtime, host, filename, counts: () => ({ opens, closes, sends }), cleanup: async () => {
    await runtime.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    rmSync(directory, { recursive: true, force: true });
  } };
}
const fault = (code: string, status: number) => (error: unknown) => error instanceof RuntimeFault && error.code === code && error.status === status;

test('rename/archive/restore persist metadata without history changes or host calls', async () => {
  const f = fixture();
  try {
    const id = randomUUID(); await f.runtime.create('owner', id, 'Original');
    const before = await f.runtime.history('owner', id);
    const stateBefore = JSON.parse(readFileSync(f.filename, 'utf8'));
    const counts = f.counts();
    assert.equal(f.runtime.updateMetadata('owner', id, { title: '  Renamed  ' }).title, 'Renamed');
    f.runtime.updateMetadata('owner', id, { archived: true });
    assert.deepEqual(f.counts(), counts);
    const restored = new ThreadRuntime(f.host, f.filename, 'owner');
    const [listed] = restored.list('owner');
    assert.deepEqual({ ...listed, createdAt: undefined, lastActivityAt: undefined }, { id, title: 'Renamed', state: 'ready', archived: true, createdAt: undefined, lastActivityAt: undefined });
    assert.ok(Date.parse(listed.createdAt!) > 0 && listed.lastActivityAt === listed.createdAt, 'metadata edits never count as conversation activity');
    assert.deepEqual(await restored.history('owner', id), before);
    await assert.rejects(restored.start('owner', { id: randomUUID(), threadId: id, text: 'No replay', parentRunId: null }), fault('thread_archived', 409));
    const afterHistory = f.counts();
    restored.updateMetadata('owner', id, { archived: false });
    restored.updateMetadata('owner', id, { archived: false });
    assert.deepEqual(f.counts(), afterHistory);
    assert.deepEqual(await restored.history('owner', id), before);
    const stateAfter = JSON.parse(readFileSync(f.filename, 'utf8'));
    assert.deepEqual(stateAfter.runs, stateBefore.runs);
    assert.equal(stateAfter.threads[0].conversationId, stateBefore.threads[0].conversationId);
    assert.equal(f.counts().sends, 0);
    await restored.close();
  } finally { await f.cleanup(); }
});

test('legacy threads migrate; metadata rejects invalid titles, fields and owners', async () => {
  const f = fixture();
  try {
    const id = randomUUID(); await f.runtime.create('owner', id, 'Original');
    const state = JSON.parse(readFileSync(f.filename, 'utf8'));
    delete state.threads[0].archived;
    writeFileSync(f.filename, JSON.stringify(state));
    const runtime = new ThreadRuntime(f.host, f.filename, 'owner');
    assert.equal(runtime.list('owner')[0].archived, false);
    for (const title of ['', '  ', 'a'.repeat(121), '\u001b[31mred', 'line\nline', '\u202eevil', 42, null]) {
      assert.throws(() => runtime.updateMetadata('owner', id, { title }), fault('invalid_input', 400));
    }
    for (const patch of [{}, [], { archived: 'true' }, { owner: 'other' }, JSON.parse('{"__proto__":{}}')]) {
      assert.throws(() => runtime.updateMetadata('owner', id, patch), fault('invalid_input', 400));
    }
    assert.throws(() => runtime.updateMetadata('other', id, { archived: true }), fault('forbidden', 403));
    assert.throws(() => runtime.updateMetadata('owner', randomUUID(), { title: 'New' }), fault('not_found', 404));
    assert.equal(runtime.list('owner')[0].title, 'Original');
    await runtime.close();
  } finally { await f.cleanup(); }
});

test('running conversation can be renamed but cannot be archived', async () => {
  const f = fixture();
  try {
    const id = randomUUID(); await f.runtime.create('owner', id, 'Original');
    const run = await f.runtime.start('owner', { id: randomUUID(), threadId: id, text: 'Wait', parentRunId: null });
    f.runtime.updateMetadata('owner', id, { title: 'Running' });
    assert.throws(() => f.runtime.updateMetadata('owner', id, { archived: true, title: 'Must not apply' }), fault('runtime_busy', 409));
    assert.equal(f.runtime.list('owner')[0].title, 'Running');
    assert.equal(f.runtime.list('owner')[0].archived, false);
    f.runtime.cancel('owner', run.id);
  } finally { await f.cleanup(); }
});

test('PATCH metadata is authenticated and returns the list representation', async () => {
  const f = fixture();
  const token = 'a'.repeat(64);
  const server = tokenApiApp(f.runtime, token, 'owner', 0).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const id = randomUUID(); await f.runtime.create('owner', id, 'Original');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/threads/${id}`;
    const patch = (headers: Record<string, string>) => fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ title: 'HTTP name', archived: true }) });
    assert.equal((await patch({})).status, 401);
    assert.equal((await patch({ authorization: `Bearer ${token}`, 'x-runtime-owner': 'other' })).status, 403);
    const response = await patch({ authorization: `Bearer ${token}`, 'x-runtime-owner': 'owner' });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual({ ...body, createdAt: undefined, lastActivityAt: undefined }, { id, title: 'HTTP name', state: 'ready', archived: true, createdAt: undefined, lastActivityAt: undefined });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test('legacy threads without timestamps stay valid; runs record activity and display times', async () => {
  const f = fixture();
  try {
    const id = randomUUID(); await f.runtime.create('owner', id, 'Original');
    const state = JSON.parse(readFileSync(f.filename, 'utf8'));
    delete state.threads[0].createdAt; delete state.threads[0].lastActivityAt;
    writeFileSync(f.filename, JSON.stringify(state));
    const runtime = new ThreadRuntime(f.host, f.filename, 'owner');
    assert.deepEqual(runtime.list('owner'), [{ id, title: 'Original', state: 'ready', archived: false }]);
    assert.deepEqual(runtime.updateMetadata('owner', id, { title: 'Legacy rename' }), { id, title: 'Legacy rename', state: 'ready', archived: false });
    const before = Date.now();
    const run = await runtime.start('owner', { id: randomUUID(), threadId: id, text: 'Wait', parentRunId: null });
    const activity = Date.parse(runtime.list('owner')[0].lastActivityAt!);
    assert.ok(activity >= before && activity <= Date.now());
    runtime.cancel('owner', run.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    const view = await runtime.view('owner', id);
    assert.equal(view.messages[0]?.metadata && (view.messages[0].metadata as { createdAt: string }).createdAt, new Date(activity).toISOString());
    await runtime.close();
  } finally { await f.cleanup(); }
});
