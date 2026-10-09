import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdoptionStore } from 'ai-sdk-letta';
import { AdoptionRegistry, ThreadRuntime, agentInfo, anthropicOAuth, effortOf, modelOptions, modelSettings, providerLabel, type AdoptionBackend, type ModelOption } from '../src/index.js';

const BLOG = 'agent-local-2cc740f1-9438-4173-9418-aa89a45d258d';
const CATALOG = [
  { id: 'gpt-5.5-none', handle: 'openai-codex/gpt-5.5', label: 'GPT-5.5', updateArgs: { provider_type: 'chatgpt_oauth', context_window: 272000, reasoning_effort: 'none', enable_reasoner: false } },
  { id: 'gpt-5.5-medium', handle: 'openai-codex/gpt-5.5', label: 'GPT-5.5', updateArgs: { provider_type: 'chatgpt_oauth', context_window: 272000, reasoning_effort: 'medium', enable_reasoner: true } },
  { id: 'gpt-5.5-high', handle: 'openai-codex/gpt-5.5', label: 'GPT-5.5', updateArgs: { provider_type: 'chatgpt_oauth', context_window: 400000, reasoning_effort: 'high', enable_reasoner: true } },
  { id: 'haiku-low', handle: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', updateArgs: { provider_type: 'anthropic', context_window: 200000, reasoning_effort: 'low', enable_reasoner: true } },
  { id: 'haiku-medium', handle: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', updateArgs: { provider_type: 'anthropic', context_window: 200000, reasoning_effort: 'medium', enable_reasoner: true } },
  { id: 'gpt-4o', handle: 'openai/gpt-4o', label: 'GPT-4o', isDefault: true, updateArgs: { context_window: 128000 } },
  { id: 'flash', handle: 'google_ai/gemini-2.5-flash', label: 'Gemini 2.5 Flash', updateArgs: {} },
  { id: 'x', handle: 'xai/grok-4', label: 'Grok 4' },
  { id: 'evil', handle: 'anthropic/../../x', label: 'bad' },
];

test('model options: one per handle, known providers only, friendly provider labels, context window and settings', () => {
  const models = modelOptions(CATALOG);
  assert.deepEqual(models.map(m => [m.handle, m.label, m.providerLabel, m.contextWindow]), [
    ['openai-codex/gpt-5.5', 'GPT-5.5', 'ChatGPT subscription', 272000], ['anthropic/claude-haiku-4-5', 'Claude Haiku 4.5', 'Anthropic', 200000],
    ['openai/gpt-4o', 'GPT-4o', 'OpenAI API', 128000], ['google_ai/gemini-2.5-flash', 'Gemini 2.5 Flash', 'Google', undefined],
  ]);
  assert.deepEqual(models[0]!.settings, { provider_type: 'chatgpt_oauth', parallel_tool_calls: true, reasoning: { reasoning_effort: 'medium' } }, 'the medium tier');
  assert.deepEqual(models[1]!.settings, { provider_type: 'anthropic', parallel_tool_calls: true, effort: 'medium', thinking: { type: 'enabled' } });
  assert.equal(modelOptions(CATALOG, { anthropicOAuth: true })[1]!.providerLabel, 'Claude subscription');
  assert.deepEqual(modelOptions(CATALOG, { available: ['anthropic/claude-haiku-4-5'] }).map(m => m.handle), ['anthropic/claude-haiku-4-5'], 'only available handles');
  assert.equal(providerLabel('openai/gpt-5'), 'OpenAI API'); assert.equal(providerLabel('google_vertex/gemini'), 'Google');
  assert.equal(modelSettings('google_vertex/gemini').provider_type, 'google_vertex');
});

test('model efforts: every tier with a reasoning effort, lowest first, the default marked; none without efforts', () => {
  const models = modelOptions(CATALOG);
  assert.deepEqual(models[0]!.efforts, [{ value: 'none', label: 'None', contextWindow: 272000 }, { value: 'medium', label: 'Medium', contextWindow: 272000, default: true }, { value: 'high', label: 'High', contextWindow: 400000 }]);
  assert.deepEqual(models[1]!.efforts.map(e => [e.value, !!e.default]), [['low', false], ['medium', true]]);
  assert.deepEqual(models[2]!.efforts, [], 'gpt-4o: no effort setting');
  assert.deepEqual(models[3]!.efforts, []);
  // A catalog default wins over medium.
  const flagged = modelOptions([{ handle: 'openai/o9', label: 'o9', updateArgs: { reasoning_effort: 'low' } }, { handle: 'openai/o9', label: 'o9', isDefault: true, updateArgs: { reasoning_effort: 'xhigh' } }, { handle: 'openai/o9', label: 'o9', updateArgs: { reasoning_effort: 'medium' } }]);
  assert.deepEqual(flagged[0]!.efforts.map(e => [e.value, !!e.default]), [['low', false], ['medium', false], ['xhigh', true]]);
  assert.deepEqual(flagged[0]!.settings, { provider_type: 'openai', parallel_tool_calls: true, reasoning: { reasoning_effort: 'xhigh' } });
  assert.deepEqual(models[0]!.tiers.map(t => t.effort), ['none', 'medium', 'high'], 'tier arguments, server side');
});

test('effortOf reads the reasoning effort of model_settings (OpenAI and Anthropic)', () => {
  assert.equal(effortOf({ provider_type: 'chatgpt_oauth', reasoning: { reasoning_effort: 'high' } }), 'high');
  assert.equal(effortOf({ provider_type: 'anthropic', effort: 'low', thinking: { type: 'enabled' } }), 'low');
  assert.equal(effortOf({ provider_type: 'google_ai' }), undefined);
  assert.equal(effortOf(null), undefined); assert.equal(effortOf({ effort: 'Bad Value' }), undefined);
});

test('anthropicOAuth reads only whether the anthropic provider is signed in with OAuth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-models-'));
  try {
    assert.equal(anthropicOAuth(dir), false);
    mkdirSync(join(dir, 'providers'));
    writeFileSync(join(dir, 'providers', 'auth.json'), JSON.stringify({ providers: { anthropic: { provider_type: 'anthropic', auth: { type: 'api_key', key: 'k' } } } }));
    assert.equal(anthropicOAuth(dir), false);
    writeFileSync(join(dir, 'providers', 'auth.json'), JSON.stringify({ providers: { anthropic: { provider_type: 'anthropic', auth: { type: 'oauth', access: 'a' } } } }));
    assert.equal(anthropicOAuth(dir), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-model-'));
  const busy = new Set<string>();
  const calls: { agentId: string; model: string; options: { modelSettings: Record<string, unknown>; contextWindowLimit?: number } }[] = [];
  let model = 'openai-codex/gpt-5.5';
  let effort: string | undefined = 'medium';
  const models: ModelOption[] = modelOptions(CATALOG);
  const backend: AdoptionBackend = {
    list: async () => [],
    agent: async id => id === BLOG ? { id, name: 'blog', model, tags: ['git-memory-enabled'], system: 'You are blog.\n', ...(effort ? { effort } : {}) } : undefined,
    conversations: async () => [],
    setSystem: async () => {},
    setModel: async (agentId, next, options) => { calls.push({ agentId, model: next, options }); model = next; effort = effortOf(options.modelSettings); },
    models: async () => models,
    activity: id => busy.has(id) ? { active: true, recent: true } : { active: false, recent: false },
  };
  let built = 0; let busyRuntime = false;
  const build = (_definition: unknown, folder: string) => {
    built++;
    mkdirSync(folder, { recursive: true });
    const runtime = new ThreadRuntime({ open: async () => { throw new Error('no session'); }, close: async () => {} }, join(folder, 'state.json'), 'local-gui');
    Object.defineProperty(runtime, 'busy', { get: () => busyRuntime });
    return { runtime };
  };
  const registry = new AdoptionRegistry({ stateDirectory: dir, owner: 'local-gui', reserved: { definitionIds: ['example-assistant'] }, backend, build: build as never });
  return { dir, busy, calls, registry, built: () => built, setBusy: (value: boolean) => { busyRuntime = value; }, setEffort: (value?: string) => { effort = value; } };
}

test('setModel: validates the handle, refuses busy / Letta Code / unknown / view only, writes to Letta, updates the record and re-hosts', async () => {
  const { dir, busy, calls, registry, built, setBusy } = fixture();
  try {
    const record = await registry.adopt({ agentId: BLOG });
    const id = record.definitionId;
    assert.equal(registry.agents()[0]!.model, 'openai-codex/gpt-5.5');
    const listed = await registry.model(id);
    assert.equal(listed.model, 'openai-codex/gpt-5.5');
    assert.equal(listed.effort, 'medium', 'read from Letta');
    assert.equal(listed.models.length, 4); assert.equal('settings' in listed.models[0]!, false, 'settings stay on the server'); assert.equal('tiers' in listed.models[0]!, false);
    assert.equal(listed.models[0]!.efforts.length, 3);
    for (const bad of [undefined, 42, 'gpt-5', 'xai/grok-4', 'anthropic/../x', 'anthropic/a b']) await assert.rejects(registry.setModel(id, { model: bad }), (e: { code?: string }) => e.code === 'invalid_input', String(bad));
    await assert.rejects(registry.setModel(id, { model: 'anthropic/claude-opus-9' }), (e: { code?: string }) => e.code === 'model_unknown');
    setBusy(true);
    await assert.rejects(registry.setModel(id, { model: 'anthropic/claude-haiku-4-5' }), (e: { code?: string }) => e.code === 'runtime_busy');
    setBusy(false); busy.add(BLOG);
    await assert.rejects(registry.setModel(id, { model: 'anthropic/claude-haiku-4-5' }), (e: { code?: string }) => e.code === 'letta_code_active');
    busy.delete(BLOG);
    assert.equal(calls.length, 0);
    const builtBefore = built();
    assert.deepEqual(await registry.setModel(id, { model: 'anthropic/claude-haiku-4-5' }), { model: 'anthropic/claude-haiku-4-5', effort: 'medium' });
    assert.deepEqual(calls, [{ agentId: BLOG, model: 'anthropic/claude-haiku-4-5', options: { modelSettings: { provider_type: 'anthropic', parallel_tool_calls: true, effort: 'medium', thinking: { type: 'enabled' } }, contextWindowLimit: 200000 } }]);
    assert.equal(new AdoptionStore(join(dir, 'adopted.json')).get(id)?.model, 'anthropic/claude-haiku-4-5', 'the record');
    assert.equal(registry.agents()[0]!.adopted?.model, 'anthropic/claude-haiku-4-5'); assert.equal(registry.agents()[0]!.model, 'anthropic/claude-haiku-4-5');
    assert.equal(built(), builtBefore + 1, 're-hosted');
    // The same model: nothing changes.
    await registry.setModel(id, { model: 'anthropic/claude-haiku-4-5' });
    assert.equal(calls.length, 1); assert.equal(built(), builtBefore + 1);
    // View only: refused.
    await registry.setViewOnly(id, { viewOnly: true });
    await assert.rejects(registry.setModel(id, { model: 'openai-codex/gpt-5.5' }), (e: { code?: string }) => e.code === 'view_only');
  } finally { await registry.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('model routes: GET lists, PUT changes; the main agent info carries its definition model', async () => {
  const { dir, registry } = fixture();
  const server = registry.routes().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const { definitionId } = await registry.adopt({ agentId: BLOG });
    const listed = await (await fetch(`${base}/adoption/agents/${definitionId}/model`)).json() as { model: string; models: { handle: string; providerLabel: string }[] };
    assert.equal(listed.model, 'openai-codex/gpt-5.5'); assert.equal(listed.models[0]!.providerLabel, 'ChatGPT subscription');
    const put = (model: unknown) => fetch(`${base}/adoption/agents/${definitionId}/model`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
    const unknown = await put('openai/gpt-9');
    assert.equal(unknown.status, 400); assert.equal((await unknown.json() as { error: string }).error, 'model_unknown');
    const ok = await put('openai/gpt-4o');
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { model: 'openai/gpt-4o' });
    const info = agentInfo({ id: 'example-assistant', name: 'Example Assistant', model: 'openai-codex/gpt-5.5', permissions: {}, tools: {}, memory: { reviewer: 'off' } } as never);
    assert.equal(info.model, 'openai-codex/gpt-5.5');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await registry.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setModel with an effort: validated against the model\'s tiers, settings per provider, the tier\'s context window; same model and effort is a no-op, another effort re-hosts', async () => {
  const { dir, calls, registry, built } = fixture();
  try {
    const { definitionId: id } = await registry.adopt({ agentId: BLOG });
    assert.equal(new AdoptionStore(join(dir, 'adopted.json')).get(id)?.effort, 'medium', 'adopted with its Letta effort');
    for (const bad of [42, 'Very High', '', 'a'.repeat(30)]) await assert.rejects(registry.setModel(id, { model: 'openai-codex/gpt-5.5', effort: bad }), (e: { code?: string }) => e.code === 'invalid_input', String(bad));
    await assert.rejects(registry.setModel(id, { model: 'openai-codex/gpt-5.5', effort: 'max' }), (e: { code?: string }) => e.code === 'effort_unknown');
    await assert.rejects(registry.setModel(id, { model: 'openai/gpt-4o', effort: 'high' }), (e: { code?: string }) => e.code === 'effort_unknown', 'a model without efforts');
    // The same model and effort: nothing.
    const before = built();
    assert.deepEqual(await registry.setModel(id, { model: 'openai-codex/gpt-5.5', effort: 'medium' }), { model: 'openai-codex/gpt-5.5', effort: 'medium' });
    assert.deepEqual(await registry.setModel(id, { model: 'openai-codex/gpt-5.5' }), { model: 'openai-codex/gpt-5.5', effort: 'medium' }, 'no effort: keep the current one');
    assert.equal(calls.length, 0); assert.equal(built(), before);
    // The same model, another effort: updates Letta (the tier's window) and re-hosts.
    assert.deepEqual(await registry.setModel(id, { model: 'openai-codex/gpt-5.5', effort: 'high' }), { model: 'openai-codex/gpt-5.5', effort: 'high' });
    assert.deepEqual(calls.at(-1), { agentId: BLOG, model: 'openai-codex/gpt-5.5', options: { modelSettings: { provider_type: 'chatgpt_oauth', parallel_tool_calls: true, reasoning: { reasoning_effort: 'high' } }, contextWindowLimit: 400000 } });
    assert.equal(built(), before + 1, 're-hosted');
    assert.equal(new AdoptionStore(join(dir, 'adopted.json')).get(id)?.effort, 'high');
    // Anthropic: `effort`.
    await registry.setModel(id, { model: 'anthropic/claude-haiku-4-5', effort: 'low' });
    assert.deepEqual(calls.at(-1)!.options, { modelSettings: { provider_type: 'anthropic', parallel_tool_calls: true, effort: 'low', thinking: { type: 'enabled' } }, contextWindowLimit: 200000 });
    // A model without efforts: the effort is dropped from the record.
    await registry.setModel(id, { model: 'openai/gpt-4o' });
    assert.deepEqual(calls.at(-1)!.options, { modelSettings: { provider_type: 'openai', parallel_tool_calls: true }, contextWindowLimit: 128000 });
    assert.equal(new AdoptionStore(join(dir, 'adopted.json')).get(id)?.effort, undefined);
    assert.equal(calls.length, 3); assert.equal(built(), before + 3);
  } finally { await registry.close(); rmSync(dir, { recursive: true, force: true }); }
});
