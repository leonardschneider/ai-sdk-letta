import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UIMessage } from 'ai';
import { AdoptionRegistry, guiApp, ThreadRuntime, type AdoptionBackend, type ImportedConversation } from '../src/index.js';

const BLOG = 'agent-local-2cc740f1-9438-4173-9418-aa89a45d258d';
const GENERAL = 'agent-local-d366ac0b-dbaa-49b5-967d-c39e9653b769';

function fakeBackend() {
  const systems = new Map([[BLOG, 'You are blog.\n'], [GENERAL, 'You are general.\n']]);
  const busy = new Set<string>();
  const conversations: Record<string, ImportedConversation[]> = {
    [BLOG]: [{ conversationId: 'default', title: 'Write a post about Lean', lastActivityAt: '2026-09-05T00:00:00.000Z' }, { conversationId: 'local-conv-11', title: 'blog', lastActivityAt: '2026-09-06T00:00:00.000Z' }],
  };
  const deleted: string[] = [];
  const backend: AdoptionBackend = {
    list: async adopted => [BLOG, GENERAL].map(agentId => ({ agentId, name: agentId === BLOG ? 'blog' : 'general', model: 'openai-codex/gpt-6', conversations: 2, ...(adopted.find(a => a.agentId === agentId) ? { adoptedAs: adopted.find(a => a.agentId === agentId)!.definitionId } : {}) })),
    agent: async id => systems.has(id) ? { id, name: id === BLOG ? 'blog' : 'general', model: 'openai-codex/gpt-6', tags: ['origin:letta-code', 'git-memory-enabled'], system: systems.get(id)! } : id === 'agent-local-sub' ? { id, name: 'Letta Code', model: 'x/y', tags: ['role:subagent'], system: '' } : undefined,
    conversations: async id => conversations[id] ?? [],
    setSystem: async (id, system) => { systems.set(id, system); },
    activity: id => busy.has(id) ? { active: true, recent: true, reason: 'running' } : { active: false, recent: false },
  };
  return { backend, systems, busy, deleted, conversations };
}

/** A registry whose agents never open a session: history is read with `peek`, sending fails. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-adoption-'));
  const fake = fakeBackend();
  const peeked: string[] = [];
  let opened = 0;
  const build = (definition: { id: string }, folder: string) => {
    mkdirSync(folder, { recursive: true });
    const runtime = new ThreadRuntime({
      open: async () => { opened++; throw new Error('no session in tests'); }, close: async () => {},
      peek: async (conversationId: string): Promise<UIMessage[]> => { peeked.push(conversationId); return [{ id: 'h1', role: 'user', parts: [{ type: 'text', text: `hello ${conversationId}` }] }, { id: 'h2', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'Bash', toolCallId: 'c', state: 'output-available', input: {}, output: 'ok' } as never] }]; },
    }, join(folder, 'state.json'), 'local-gui');
    return { runtime };
  };
  const options = { stateDirectory: dir, owner: 'local-gui', reserved: { definitionIds: ['example-assistant'], agentIds: () => [] as string[] }, backend: fake.backend, build };
  const registry = new AdoptionRegistry(options);
  return { dir, fake, registry, options, peeked, opened: () => opened };
}

test('adopting lists existing conversations (default included) read-only, persists across restarts, and removing never deletes the agent', async () => {
  const { dir, fake, registry, options, peeked, opened } = fixture();
  try {
    const record = await registry.adopt({ agentId: BLOG });
    assert.equal(record.definitionId, 'blog-2cc740f1');
    assert.deepEqual(record.tools, ['files', 'decisions', 'ask_user']);
    assert.deepEqual(registry.agents().map(a => [a.id, a.name, a.adopted?.agentId]), [['blog-2cc740f1', 'blog', BLOG]]);
    const app = registry.routes();
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const threads = await (await fetch(`${base}/agents/blog-2cc740f1/v1/threads`)).json() as { id: string; title: string }[];
      assert.deepEqual(threads.map(t => t.title).sort(), ['Write a post about Lean', 'blog']);
      const view = await (await fetch(`${base}/agents/blog-2cc740f1/v1/threads/${threads.find(t => t.title === 'blog')!.id}/view`)).json() as { messages: UIMessage[] };
      assert.equal(view.messages[0]!.parts[0]!.type, 'text');
      assert.deepEqual(peeked, ['local-conv-11']);
      assert.equal(opened(), 0, 'viewing never opens a session');
      // A new conversation in Letta Code shows up the next time threads are listed.
      fake.conversations[BLOG]!.push({ conversationId: 'local-conv-12', title: 'New in Letta Code' });
      assert.equal((await (await fetch(`${base}/agents/blog-2cc740f1/v1/threads`)).json() as unknown[]).length, 3);
      // Letta Code active: sending and new conversations are refused with a clear code; viewing stays allowed.
      fake.busy.add(BLOG);
      const refused = await fetch(`${base}/agents/blog-2cc740f1/v1/threads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), title: 'x' }) });
      assert.equal(refused.status, 409); assert.equal((await refused.json() as { error: string }).error, 'letta_code_active');
      fake.busy.delete(BLOG);
      assert.equal((await fetch(`${base}/agents/unknown/v1/threads`)).status, 404);
    } finally { server.closeAllConnections(); server.close(); }
    await registry.close();
    // Restart: the adoption is back, with its threads.
    const again = new AdoptionRegistry(options);
    again.start();
    assert.deepEqual(again.agents().map(a => a.id), ['blog-2cc740f1']);
    assert.ok(readFileSync(join(dir, 'server', 'blog-2cc740f1', 'gui', 'state.json'), 'utf8').includes('local-conv-11'));
    const removed = await again.remove('blog-2cc740f1');
    assert.deepEqual(removed, { removed: true, agentId: BLOG });
    assert.deepEqual(again.agents(), []);
    assert.deepEqual(again.store.read(), []);
    assert.ok(fake.systems.has(BLOG), 'the Letta agent is untouched');
    await again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('adoption refusals: twice, missing, hidden subagents, Letta Code running', async () => {
  const { dir, fake, registry } = fixture();
  try {
    await registry.adopt({ agentId: BLOG });
    await assert.rejects(registry.adopt({ agentId: BLOG }), (e: { code?: string }) => e.code === 'agent_claimed');
    await assert.rejects(registry.adopt({ agentId: 'agent-local-gone' }), (e: { code?: string }) => e.code === 'agent_missing');
    await assert.rejects(registry.adopt({ agentId: 'agent-local-sub' }), (e: { code?: string }) => e.code === 'agent_hidden');
    await assert.rejects(registry.adopt({ agentId: '../x' }), (e: { code?: string }) => e.code === 'invalid_input');
    fake.busy.add(GENERAL);
    await assert.rejects(registry.adopt({ agentId: GENERAL }), (e: { code?: string }) => e.code === 'letta_code_active');
    assert.equal(existsSync(join(dir, 'server', 'general-d366ac0b')), false);
    fake.busy.delete(GENERAL);
    await assert.rejects(registry.adopt({ agentId: GENERAL, tools: ['shell'] }), (e: { code?: string }) => e.code === 'invalid_input');
    const general = await registry.adopt({ agentId: GENERAL, tools: ['files'] });
    assert.deepEqual(general.tools, ['files']);
    await registry.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('instructions: preview shows a diff, apply only on request, revert restores the original prompt', async () => {
  const { dir, fake, registry } = fixture();
  try {
    await registry.adopt({ agentId: BLOG });
    const preview = await registry.instructions('blog-2cc740f1');
    assert.equal(preview.applied, false); assert.ok(preview.changed);
    assert.match(preview.diff, /\+ ## In the ai-sdk-letta app/);
    assert.match(preview.diff, /read_file/);
    assert.equal(fake.systems.get(BLOG), 'You are blog.\n', 'nothing changes on adoption or preview');
    await registry.applyInstructions('blog-2cc740f1');
    assert.match(fake.systems.get(BLOG)!, /^You are blog\.\n\n<!-- ai-sdk-letta: begin -->/);
    assert.equal((await registry.instructions('blog-2cc740f1')).revertible, true);
    await registry.revertInstructions('blog-2cc740f1');
    assert.equal(fake.systems.get(BLOG), 'You are blog.\n');
    await registry.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the single-user session lists adopted agents next to the app\'s own one, behind the session cookie', async () => {
  const { dir, registry } = fixture();
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const runtime = new ThreadRuntime({ open: async () => { throw new Error('not opened'); }, close: async () => {} }, join(dir, 'own.json'), 'local-gui');
  await registry.adopt({ agentId: BLOG });
  const server = guiApp(runtime, 'local-gui', 0, assets, { id: 'example-assistant', name: 'Example Assistant' }, undefined, undefined, undefined, registry.gui()).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${base}/api/adoption/agents`)).status, 401);
    const session = await fetch(`${base}/api/session`);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const data = await session.json() as { csrf: string; agents: { id: string; adopted?: { agentId: string } }[]; adoption: boolean };
    assert.equal(data.adoption, true);
    assert.deepEqual(data.agents.map(a => [a.id, a.adopted?.agentId]), [['blog-2cc740f1', BLOG]]);
    const picker = await (await fetch(`${base}/api/adoption/agents`, { headers: { cookie } })).json() as { agents: { name: string; adoptedAs?: string }[]; tools: { available: string[] } };
    assert.deepEqual(picker.agents.map(a => [a.name, a.adoptedAs]), [['blog', 'blog-2cc740f1'], ['general', undefined]]);
    assert.deepEqual(picker.tools.available, ['files', 'decisions', 'ask_user']);
    // Mutations need the CSRF token and the origin.
    assert.equal((await fetch(`${base}/api/adoption/agents`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ agentId: GENERAL }) })).status, 403);
    const adopted = await fetch(`${base}/api/adoption/agents`, { method: 'POST', headers: { cookie, origin: base, 'x-csrf-token': data.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ agentId: GENERAL }) });
    assert.equal(adopted.status, 200);
    const again = await fetch(`${base}/api/adoption/agents`, { method: 'POST', headers: { cookie, origin: base, 'x-csrf-token': data.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ agentId: GENERAL }) });
    assert.equal(again.status, 409);
    assert.match((await again.json() as { message: string }).message, /already in the app/);
    assert.equal((await fetch(`${base}/api/agents/general-d366ac0b/v1/threads`, { headers: { cookie } })).status, 200);
  } finally { server.closeAllConnections(); server.close(); await registry.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
