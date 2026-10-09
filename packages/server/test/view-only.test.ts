import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UIMessage } from 'ai';
import { adoptedDefinition, AdoptionStore, conversationDirectory } from 'ai-sdk-letta';
import { AdoptionRegistry, LiveConversations, ThreadRuntime, viewOnlyAllowed, type AdoptionBackend, type ImportedConversation, type LiveFs } from '../src/index.js';

const BLOG = 'agent-local-2cc740f1-9438-4173-9418-aa89a45d258d';

function fixture(directory?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-viewonly-'));
  const busy = new Set<string>();
  const conversations: ImportedConversation[] = [{ conversationId: 'local-conv-11', title: 'research', lastActivityAt: '2026-09-06T00:00:00.000Z' }];
  const backend: AdoptionBackend = {
    list: async () => [{ agentId: BLOG, name: 'blog', model: 'openai-codex/gpt-6', conversations: 1 }],
    agent: async id => id === BLOG ? { id, name: 'blog', model: 'openai-codex/gpt-6', tags: ['git-memory-enabled'], system: 'You are blog.\n' } : undefined,
    conversations: async () => conversations,
    setSystem: async () => { throw new Error('never in view only'); },
    activity: id => busy.has(id) ? { active: true, recent: true } : { active: false, recent: false },
    ...(directory ? { directory } : {}),
  };
  let built = 0; let opened = 0; const peeked: string[] = [];
  const build = (_definition: unknown, folder: string) => {
    built++;
    mkdirSync(folder, { recursive: true });
    return { runtime: new ThreadRuntime({ open: async () => { opened++; throw new Error('no session'); }, close: async () => {} }, join(folder, 'state.json'), 'local-gui') };
  };
  const peek = () => async (conversationId: string): Promise<UIMessage[]> => { peeked.push(conversationId); return [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]; };
  const registry = new AdoptionRegistry({ stateDirectory: dir, owner: 'local-gui', reserved: { definitionIds: ['example-assistant'] }, backend, build: build as never, peek, ...(directory ? { live: { debounceMs: 20, pollMs: 60_000 } } : {}) });
  return { dir, busy, conversations, registry, peeked, built: () => built, opened: () => opened };
}

async function serve(app: import('express').Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('view only: adopted while Letta Code is active, no tools, sandbox or dreaming; off is refused while active', async () => {
  const { dir, busy, registry, built } = fixture();
  try {
    busy.add(BLOG);
    await assert.rejects(registry.adopt({ agentId: BLOG }), (e: { code?: string }) => e.code === 'letta_code_active');
    await assert.rejects(registry.adopt({ agentId: BLOG, viewOnly: 'yes' }), (e: { code?: string }) => e.code === 'invalid_input');
    const record = await registry.adopt({ agentId: BLOG, viewOnly: true });
    assert.equal(record.viewOnly, true);
    assert.equal(new AdoptionStore(join(dir, 'adopted.json')).get(record.definitionId)?.viewOnly, true);
    assert.equal(built(), 0, 'the host factory (tools, containers, memory review) is never used');
    const [info] = registry.agents();
    assert.equal(info!.viewOnly, true); assert.equal(info!.adopted?.viewOnly, true); assert.equal(info!.files, false);
    const definition = adoptedDefinition({ ...record, tools: ['files', 'sandbox', 'decisions'] }, { sandbox: { provider: 'docker', git: { name: 'a', email: 'a@b.c' } } as never, dreaming: { trigger: 'auto' } as never });
    assert.deepEqual(Object.keys(definition.tools), []); assert.equal(definition.sandbox, undefined); assert.equal(definition.dreaming.trigger, 'off');
    // Changes other than View only are refused.
    for (const call of [() => registry.setTools(record.definitionId, { tools: ['files'] }), () => registry.setProject(record.definitionId, { path: null }), () => registry.setSandbox(record.definitionId, { commandTimeoutMs: null }), () => registry.applyInstructions(record.definitionId)])
      await assert.rejects(call(), (e: { code?: string }) => e.code === 'view_only');
    await assert.rejects(registry.setViewOnly(record.definitionId, {}), (e: { code?: string }) => e.code === 'invalid_input');
    await assert.rejects(registry.setViewOnly(record.definitionId, { viewOnly: false }), (e: { code?: string }) => e.code === 'letta_code_active');
    busy.delete(BLOG);
    assert.deepEqual(await registry.setViewOnly(record.definitionId, { viewOnly: false }), { viewOnly: false });
    assert.equal(built(), 1); assert.equal(registry.agents()[0]!.viewOnly, undefined);
    assert.equal(new AdoptionStore(join(dir, 'adopted.json')).get(record.definitionId)?.viewOnly, undefined);
    // On again: allowed even while active.
    busy.add(BLOG);
    assert.deepEqual(await registry.setViewOnly(record.definitionId, { viewOnly: true }), { viewOnly: true });
  } finally { await registry.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('view only: the agent API answers reads and refuses every mutation with 403 view_only; no session is opened', async () => {
  const { dir, registry, peeked, opened } = fixture();
  const { base, close } = await serve(registry.routes());
  try {
    const record = await registry.adopt({ agentId: BLOG, viewOnly: true });
    const api = `${base}/agents/${record.definitionId}/v1`;
    const threads = await (await fetch(`${api}/threads`)).json() as { id: string }[];
    assert.equal(threads.length, 1);
    const thread = threads[0]!.id;
    const view = await (await fetch(`${api}/threads/${thread}/view`)).json() as { messages: UIMessage[] };
    assert.equal(view.messages.length, 1); assert.deepEqual(peeked, ['local-conv-11']);
    assert.equal((await fetch(`${api}/threads/${thread}/history`)).status, 200);
    const refused: [string, string][] = [
      ['POST', '/runs'], ['POST', '/threads'], ['PATCH', `/threads/${thread}`], ['POST', `/threads/${thread}/typing`], ['POST', `/threads/${thread}/rewind`], ['POST', `/threads/${thread}/rewind/preview`], ['GET', `/threads/${thread}/rewind`],
      ['POST', '/runs/r1/answer'], ['POST', '/runs/r1/cancel'], ['POST', `/threads/${thread}/check`], ['POST', `/threads/${thread}/dream`], ['POST', '/decisions/d1/decide'],
      ['GET', '/apps'], ['PATCH', '/apps/a'], ['POST', `/threads/${thread}/apps/instances`], ['POST', '/apps/approvals/x'], ['POST', '/apps/instances/i/call'],
      ['GET', `/threads/${thread}/preview`], ['POST', `/threads/${thread}/preview/revoke`], ['POST', '/uploads'],
      ['POST', '/resources/upload'], ['POST', '/resources/folders'], ['POST', '/resources/move'], ['POST', '/resources/delete'], ['POST', '/resources/restore'], ['PUT', '/memory/reviewer'], ['DELETE', `/threads/${thread}`],
    ];
    for (const [method, path] of refused) {
      const response = await fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal((await response.json() as { error: string }).error, 'view_only', `${method} ${path}`);
    }
    for (const [method, path] of [['GET', '/threads'], ['GET', '/threads/x/view'], ['GET', '/resources'], ['GET', '/memory/reviews'], ['GET', '/memory/reverts'], ['GET', '/changes']] as const) assert.equal(viewOnlyAllowed(method, `/v1${path}`), true, path);
    // The adoption routes too: everything but View only itself.
    assert.equal((await fetch(`${base}/adoption/agents/${record.definitionId}/tools`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: ['files'] }) })).status, 403);
    assert.equal((await fetch(`${base}/adoption/agents/${record.definitionId}/instructions`, { method: 'POST' })).status, 403);
    assert.equal(opened(), 0, 'never opens a session');
    assert.equal((await fetch(`${base}/adoption/agents/${record.definitionId}/view-only`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ viewOnly: false }) })).status, 200);
  } finally { await close(); await registry.close(); rmSync(dir, { recursive: true, force: true }); }
});

/** A fake file system: files with signatures, watchers that fire on demand. */
function fakeFs() {
  const files = new Map<string, { mtimeMs: number; size: number; text?: string }>();
  const dirs = new Map<string, string[]>();
  const watchers = new Map<string, Set<() => void>>();
  const fs: LiveFs = {
    watch: (path, listener) => { let set = watchers.get(path); if (!set) watchers.set(path, set = new Set()); set.add(listener); return { close: () => { set!.delete(listener); } }; },
    stat: path => files.get(path),
    readdir: path => dirs.get(path) ?? [],
    readFile: path => { const f = files.get(path); if (!f?.text) throw new Error('ENOENT'); return f.text; },
  };
  const fire = (path: string) => { for (const listener of watchers.get(path) ?? []) listener(); };
  const open = () => [...watchers.values()].reduce((n, s) => n + s.size, 0);
  return { fs, files, dirs, fire, open };
}

test('live refresh: file events are debounced, the poll catches missed ones, new conversations are found, idle watchers stop', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
  try {
    const { fs, files, dirs, fire, open } = fakeFs();
    const backend = '/b';
    const folder = conversationDirectory(backend, 'local-conv-1');
    files.set(join(folder, 'messages.jsonl'), { mtimeMs: 1, size: 10 });
    dirs.set('/b/conversations', [folder.split('/').pop()!]);
    const changes: string[] = []; let fresh = 0; let idle = 0;
    const live = new LiveConversations({ backendDirectory: backend, agentId: BLOG, fs, debounceMs: 500, pollMs: 5000, idleMs: 120_000, maxConversations: 2, onChange: id => changes.push(id), onNewConversation: () => fresh++, onIdle: () => idle++ });
    live.touch('local-conv-1');
    assert.equal(live.active, true); assert.deepEqual(live.conversations, ['local-conv-1']);
    // Three quick events: one change, after the debounce.
    files.set(join(folder, 'messages.jsonl'), { mtimeMs: 2, size: 20 });
    fire(join(folder, 'messages.jsonl')); mock.timers.tick(200); fire(join(folder, 'messages.jsonl')); mock.timers.tick(200); fire(join(folder, 'conversation.json'));
    assert.deepEqual(changes, []);
    mock.timers.tick(500);
    assert.deepEqual(changes, ['local-conv-1']);
    // An event without a change (same signature) is ignored.
    fire(join(folder, 'messages.jsonl')); mock.timers.tick(600);
    assert.deepEqual(changes, ['local-conv-1']);
    // A missed event: the poll finds it.
    files.set(join(folder, 'messages.jsonl'), { mtimeMs: 3, size: 30 });
    mock.timers.tick(5000); mock.timers.tick(500);
    assert.deepEqual(changes, ['local-conv-1', 'local-conv-1']);
    // A new conversation of this agent (and one of another agent).
    const mine = 'bmV3LW1pbmU'; const theirs = 'bmV3LXRoZWly';
    dirs.set('/b/conversations', [...dirs.get('/b/conversations')!, mine, theirs]);
    files.set(join('/b/conversations', mine, 'conversation.json'), { mtimeMs: 1, size: 1, text: JSON.stringify({ agent_id: BLOG }) });
    files.set(join('/b/conversations', theirs, 'conversation.json'), { mtimeMs: 1, size: 1, text: JSON.stringify({ agent_id: 'agent-local-other' }) });
    fire('/b/conversations'); mock.timers.tick(500);
    assert.equal(fresh, 1);
    mock.timers.tick(5000); assert.equal(fresh, 1, 'found once');
    // Bounded: the least recently viewed conversation is dropped.
    live.touch('local-conv-2'); live.touch('local-conv-3');
    assert.deepEqual(live.conversations, ['local-conv-2', 'local-conv-3']);
    // Idle: everything stops.
    mock.timers.tick(120_000);
    assert.equal(idle, 1); assert.equal(live.active, false); assert.equal(open(), 0); assert.deepEqual(live.conversations, []);
    live.touch('local-conv-1'); assert.equal(live.active, true);
    live.close(); assert.equal(open(), 0); live.touch('local-conv-1'); assert.equal(live.active, false);
  } finally { mock.timers.reset(); }
});

test('live refresh (real files): a message appended in Letta Code bumps the change channel and the thread activity', async () => {
  const backend = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-live-'));
  const { dir, registry, conversations } = fixture(backend);
  const { base, close } = await serve(registry.routes());
  try {
    const folder = conversationDirectory(backend, 'local-conv-11');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'messages.jsonl'), '{}\n');
    writeFileSync(join(folder, 'conversation.json'), JSON.stringify({ id: 'local-conv-11', agent_id: BLOG }));
    const record = await registry.adopt({ agentId: BLOG, viewOnly: true });
    const api = `${base}/agents/${record.definitionId}/v1`;
    const [thread] = await (await fetch(`${api}/threads`)).json() as { id: string }[];
    await fetch(`${api}/threads/${thread!.id}/view`);
    const runtime = registry.runtime(record.definitionId)!;
    const before = runtime.version;
    const waiting = fetch(`${api}/changes?since=${before}`).then(r => r.json() as Promise<{ version: number }>);
    appendFileSync(join(folder, 'messages.jsonl'), '{"more":true}\n');
    const { version } = await waiting;
    assert.ok(version > before);
    // A new conversation made in Letta Code appears in the list.
    const other = conversationDirectory(backend, 'local-conv-12');
    conversations.push({ conversationId: 'local-conv-12', title: 'new one' });
    mkdirSync(other, { recursive: true }); writeFileSync(join(other, 'conversation.json'), JSON.stringify({ id: 'local-conv-12', agent_id: BLOG }));
    for (let i = 0; i < 50 && runtime.list('local-gui').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(runtime.list('local-gui').length, 2);
  } finally { await close(); await registry.close(); rmSync(dir, { recursive: true, force: true }); rmSync(backend, { recursive: true, force: true }); }
});
