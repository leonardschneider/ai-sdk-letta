import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
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
    setModel: async () => {},
    models: async () => [],
    activity: id => busy.has(id) ? { active: true, recent: true, reason: 'running' } : { active: false, recent: false },
  };
  return { backend, systems, busy, deleted, conversations };
}

/** A registry whose agents never open a session: history is read with `peek`, sending fails. */
function fixture(environment?: { sandbox?: { provider: 'docker'; git: { name: string; email: string } } }) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-adoption-'));
  const fake = fakeBackend();
  const peeked: string[] = [];
  let opened = 0;
  const built: { id: string; sandbox?: { project?: { path: string } } }[] = [];
  const closed: string[] = [];
  const build = (definition: { id: string; sandbox?: { project?: { path: string } } }, folder: string) => {
    built.push(definition);
    mkdirSync(folder, { recursive: true });
    const runtime = new ThreadRuntime({
      open: async () => { opened++; throw new Error('no session in tests'); }, close: async () => {},
      peek: async (conversationId: string): Promise<UIMessage[]> => { peeked.push(conversationId); return [{ id: 'h1', role: 'user', parts: [{ type: 'text', text: `hello ${conversationId}` }] }, { id: 'h2', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'Bash', toolCallId: 'c', state: 'output-available', input: {}, output: 'ok' } as never] }]; },
    }, join(folder, 'state.json'), 'local-gui');
    const tools = (definition as { tools?: object }).tools ?? {};
    return { runtime, ...('dev_server_start' in tools ? { webDev: true } : {}), ...('app_dev_start' in tools ? { apps: true } : {}), close: async () => { closed.push(definition.id); } };
  };
  const options = { stateDirectory: dir, owner: 'local-gui', reserved: { definitionIds: ['example-assistant'], agentIds: () => [] as string[] }, backend: fake.backend, build, ...(environment ? { environment } : {}) };
  const registry = new AdoptionRegistry(options as never);
  return { dir, fake, registry, options, peeked, built, closed, opened: () => opened };
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
  const server = guiApp(runtime, 'local-gui', 0, assets, { id: 'example-assistant', name: 'Example Assistant' }, undefined, undefined, undefined, undefined, registry.gui()).listen(0, '127.0.0.1');
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

const SANDBOX = { sandbox: { provider: 'docker' as const, git: { name: 'Test', email: 'test@example.com' } } };
const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

test('project folder: set (as given, mounted at its real path), refused with a reason, cleared; persisted; the runtime restarts', async () => {
  const { dir, registry, options, built } = fixture(SANDBOX);
  const projects = realpathSync(mkdtempSync(join(tmpdir(), 'ai-sdk-letta-project-')));
  try {
    const blog = join(projects, 'blog'); mkdirSync(join(blog, 'content'), { recursive: true }); gitIn(blog, 'init', '-q');
    const link = join(projects, 'iCloud-blog'); symlinkSync(blog, link);
    await registry.adopt({ agentId: BLOG, tools: ['files'] });
    const before = built.length;
    const set = await registry.setProject('blog-2cc740f1', { path: link });
    assert.deepEqual(set, { project: link, tools: ['files', 'sandbox'] }, 'kept as given; the sandbox tools are turned on');
    assert.equal(built.length, before + 1, 'the runtime restarted with the new definition');
    assert.equal(built.at(-1)!.sandbox?.project?.path, link);
    assert.equal(registry.agents()[0]!.adopted?.project, link);
    assert.equal(JSON.parse(readFileSync(join(dir, 'adopted.json'), 'utf8')).agents[0].project, link);
    // Refusals carry their reason and change nothing.
    const refuses = async (path: unknown, code: string, pattern?: RegExp) => assert.rejects(registry.setProject('blog-2cc740f1', { path }), (e: { code?: string; message?: string }) => e.code === code && (!pattern || pattern.test(e.message ?? '')));
    await refuses(join(projects, 'missing'), 'project_unsafe', /does not exist/);
    await refuses(homedir(), 'project_unsafe', /home folder/);
    await refuses(join(homedir(), '.letta'), 'project_unsafe');
    await refuses('/', 'project_unsafe', /root/);
    await refuses('relative/blog', 'project_unsafe', /absolute/);
    await refuses(42, 'invalid_input');
    gitIn(blog, 'remote', 'add', 'origin', 'https://me:ghp_secret@github.com/me/blog.git');
    const other = join(projects, 'other'); mkdirSync(other); gitIn(other, 'init', '-q'); gitIn(other, 'config', 'credential.helper', 'store');
    await refuses(other, 'project_has_credentials', /credential/);
    assert.equal(registry.store.get('blog-2cc740f1')?.project, link, 'unchanged after refusals');
    // A folder that became unsafe is not mounted on restart, but the agent still opens and the path stays.
    await registry.close();
    const again = new AdoptionRegistry(options as never);
    again.start();
    assert.equal(built.at(-1)!.sandbox?.project, undefined);
    assert.equal(again.agents()[0]!.adopted?.project, link);
    const cleared = await again.setProject('blog-2cc740f1', { path: null });
    assert.deepEqual(cleared, { project: null, tools: ['files', 'sandbox'] });
    assert.equal(again.store.get('blog-2cc740f1')?.project, undefined);
    await again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(projects, { recursive: true, force: true }); }
});

test('sandbox command timeout: set per adopted agent (the runtime restarts with it), validated, cleared back to the host\'s', async () => {
  const { dir, registry, built } = fixture(SANDBOX);
  try {
    await registry.adopt({ agentId: BLOG, tools: ['files', 'sandbox'] });
    assert.equal((built.at(-1) as { sandbox?: { timeoutMs?: number } }).sandbox?.timeoutMs, 120_000, 'the host default');
    assert.equal(registry.agents()[0]!.adopted?.commandTimeoutMs, 120_000);
    const set = await registry.setSandbox('blog-2cc740f1', { commandTimeoutMs: 240_000 });
    assert.deepEqual(set, { commandTimeoutMs: 240_000, effectiveMs: 240_000 });
    assert.equal((built.at(-1) as { sandbox?: { timeoutMs?: number } }).sandbox?.timeoutMs, 240_000);
    assert.equal(registry.agents()[0]!.adopted?.commandTimeoutMs, 240_000);
    for (const bad of [500, 300_000, 1.5, '60000']) await assert.rejects(registry.setSandbox('blog-2cc740f1', { commandTimeoutMs: bad }), (e: { code?: string }) => e.code === 'invalid_input');
    assert.deepEqual(await registry.setSandbox('blog-2cc740f1', { commandTimeoutMs: null }), { commandTimeoutMs: null, effectiveMs: 120_000 });
    await registry.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const plain = fixture();
  try {
    await plain.registry.adopt({ agentId: BLOG });
    await assert.rejects(plain.registry.setSandbox('blog-2cc740f1', { commandTimeoutMs: 60_000 }), (e: { code?: string }) => e.code === 'sandbox_unavailable');
    await plain.registry.close();
  } finally { rmSync(plain.dir, { recursive: true, force: true }); }
});

test('web_dev and mcp_app_dev: validated, reported to the browser, and their services closed when the tools change or the agent goes', async () => {
  const { dir, registry, built, closed } = fixture(SANDBOX);
  try {
    await assert.rejects(registry.adopt({ agentId: BLOG, tools: ['files', 'sandbox', 'mcp_app_dev'] }), (e: { code?: string }) => e.code === 'mcp_app_dev_needs_web_dev');
    await assert.rejects(registry.adopt({ agentId: BLOG, tools: ['files', 'web_dev'] }), (e: { code?: string }) => e.code === 'web_dev_needs_sandbox');
    const record = await registry.adopt({ agentId: BLOG, tools: ['mcp_app_dev', 'web_dev', 'sandbox', 'files'] });
    assert.deepEqual(record.tools, ['files', 'sandbox', 'web_dev', 'mcp_app_dev'], 'stored in their canonical order');
    assert.equal((built.at(-1) as { sandbox?: { image?: string } }).sandbox?.image?.startsWith('ai-sdk-letta-webdev:'), true);
    const info = registry.agents()[0]!;
    assert.equal(info.webDev, true); assert.equal(info.apps, true);
    assert.ok(info.adopted?.available?.includes('mcp_app_dev'));
    const fewer = await registry.setTools('blog-2cc740f1', { tools: ['files', 'sandbox', 'web_dev'] });
    assert.deepEqual(fewer.tools, ['files', 'sandbox', 'web_dev']);
    assert.deepEqual(closed, ['blog-2cc740f1'], 'the old runtime\'s services closed');
    assert.equal(registry.agents()[0]!.webDev, true); assert.equal(registry.agents()[0]!.apps, undefined);
    await registry.setTools('blog-2cc740f1', { tools: ['files'] });
    assert.equal(registry.agents()[0]!.webDev, undefined);
    await registry.remove('blog-2cc740f1');
    assert.deepEqual(closed, ['blog-2cc740f1', 'blog-2cc740f1', 'blog-2cc740f1']);
    await registry.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const plain = fixture();
  try {
    await assert.rejects(plain.registry.adopt({ agentId: BLOG, tools: ['files', 'sandbox', 'web_dev'] }), (e: { code?: string }) => e.code === 'sandbox_unavailable');
    assert.equal((await plain.registry.adopt({ agentId: BLOG })).tools.includes('web_dev'), false);
    assert.equal(plain.registry.agents()[0]!.adopted?.available?.includes('web_dev'), false, 'not offered without a sandbox');
    await plain.registry.close();
  } finally { rmSync(plain.dir, { recursive: true, force: true }); }
});

test('project folder: refused without a sandbox on the server', async () => {
  const { dir, registry } = fixture();
  try {
    await registry.adopt({ agentId: BLOG });
    await assert.rejects(registry.setProject('blog-2cc740f1', { path: tmpdir() }), (e: { code?: string }) => e.code === 'sandbox_unavailable');
    await assert.rejects(registry.setProject('nobody', { path: null }), (e: { code?: string }) => e.code === 'not_found');
    await registry.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PUT /api/adoption/agents/<id>/project needs the session and CSRF token, and returns the refusal reason', async () => {
  const { dir, registry } = fixture(SANDBOX);
  const projects = realpathSync(mkdtempSync(join(tmpdir(), 'ai-sdk-letta-project-')));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const runtime = new ThreadRuntime({ open: async () => { throw new Error('not opened'); }, close: async () => {} }, join(dir, 'own.json'), 'local-gui');
  await registry.adopt({ agentId: BLOG });
  const server = guiApp(runtime, 'local-gui', 0, assets, { id: 'example-assistant', name: 'Example Assistant' }, undefined, undefined, undefined, undefined, registry.gui()).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `${base}/api/adoption/agents/blog-2cc740f1/project`;
  try {
    const blog = join(projects, 'blog'); mkdirSync(blog);
    const body = JSON.stringify({ path: blog });
    assert.equal((await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body })).status, 401);
    const session = await fetch(`${base}/api/session`);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf } = await session.json() as { csrf: string };
    assert.equal((await fetch(url, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body })).status, 403, 'no CSRF token');
    assert.equal((await fetch(url, { method: 'PUT', headers: { cookie, origin: 'http://evil.example', 'x-csrf-token': csrf, 'content-type': 'application/json' }, body })).status, 403, 'wrong origin');
    const headers = { cookie, origin: base, 'x-csrf-token': csrf, 'content-type': 'application/json' };
    const ok = await fetch(url, { method: 'PUT', headers, body });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { project: blog, tools: ['files', 'sandbox', 'decisions', 'ask_user'] });
    const listed = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json() as { agents: { adopted?: { project?: string; sandbox?: boolean } }[] };
    assert.deepEqual(listed.agents[0]!.adopted && { project: listed.agents[0]!.adopted.project, sandbox: listed.agents[0]!.adopted.sandbox }, { project: blog, sandbox: true });
    const refused = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ path: homedir() }) });
    assert.equal(refused.status, 409);
    const reason = await refused.json() as { error: string; message: string };
    assert.equal(reason.error, 'project_unsafe'); assert.match(reason.message, /home folder/);
    const cleared = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ path: null }) });
    assert.deepEqual(await cleared.json(), { project: null, tools: ['files', 'sandbox', 'decisions', 'ask_user'] });
  } finally { server.closeAllConnections(); server.close(); await registry.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); rmSync(projects, { recursive: true, force: true }); }
});
