import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tool, jsonSchema } from 'ai';
import {
  adoptedDefinition, adoptedInstructionsSection, adoptedToolControl, applyToolOverrides, checkToolOverrides, defineAgent, LOCKED_PERMISSIONS, sandboxTools, SANDBOX_TOOL_PERMISSIONS, toolControl, ToolOverrideError, toolTokens,
  type AdoptionRecord,
} from '../src/index.js';

const AGENT = 'agent-local-2cc740f1-9438-4173-9418-aa89a45d258d';
const environment = { sandbox: { provider: 'docker' as const, git: { name: 'n', email: 'e@x' } }, webSearch: true };
const record = (extra: Partial<AdoptionRecord> = {}): AdoptionRecord => ({ definitionId: 'blog-2cc740f1', agentId: AGENT, name: 'blog', model: 'openai/gpt-5', tools: ['files', 'sandbox', 'decisions', 'jobs', 'web_search', 'ask_user', 'web_dev'], adoptedAt: '2026-10-10T00:00:00.000Z', ...extra });

test('overrides apply after the sets: off removes the tool and its permission, ask and allow set it', () => {
  const plain = adoptedDefinition(record(), environment);
  assert.equal(plain.permissions.run_command_online, 'ask');
  assert.equal(plain.permissions.browser_click, 'allow');
  const changed = adoptedDefinition(record({ toolOverrides: { run_command_online: 'off', browser_click: 'ask', search_files: 'off', command_stop: 'ask', allow_web_origin: 'ask' } }), environment);
  assert.equal(Object.hasOwn(changed.tools, 'run_command_online'), false);
  assert.equal(Object.hasOwn(changed.permissions, 'run_command_online'), false);
  assert.equal(Object.hasOwn(changed.tools, 'search_files'), false);
  assert.equal(changed.permissions.browser_click, 'ask');
  assert.equal(changed.permissions.command_stop, 'ask');
  // A tool that asks by default can be allowed when it is not locked.
  const allowed = adoptedDefinition(record({ toolOverrides: { command_stop: 'allow', read_file: 'ask' } }), environment);
  assert.equal(allowed.permissions.command_stop, 'allow');
  assert.equal(allowed.permissions.read_file, 'ask');
});

test('locked tools never loosen: checks refuse, and a hand-edited record is ignored', () => {
  const base = adoptedDefinition(record(), environment);
  for (const name of ['run_command_online', 'allow_web_origin', 'web_search']) {
    assert.throws(() => checkToolOverrides({ [name]: 'allow' }, base), (error: unknown) => error instanceof ToolOverrideError && error.code === 'tool_locked');
    assert.deepEqual(checkToolOverrides({ [name]: 'off' }, base), { [name]: 'off' });
  }
  assert.throws(() => checkToolOverrides({ request_decision: 'ask' }, base), /human gate/);
  assert.throws(() => checkToolOverrides({ run_command: 'off' }, base), /whole set/);
  const edited = adoptedDefinition(record({ toolOverrides: { run_command_online: 'allow', web_search: 'allow', allow_web_origin: 'allow' } as never }), environment);
  assert.equal(edited.permissions.run_command_online, 'ask');
  assert.equal(edited.permissions.web_search, 'ask');
  assert.equal(edited.permissions.allow_web_origin, 'ask');
  // defineAgent uses the same rules.
  assert.ok(LOCKED_PERMISSIONS.run_command_online);
  assert.throws(() => defineAgent({ id: 'x', name: 'x', model: 'a/b', instructions: 'x', tools: { ...sandboxTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS, run_command_online: 'allow' }, sandbox: { provider: 'docker' } }), /run_command_online uses the network/);
});

test('unknown tools and defaults are dropped; bad values are refused', () => {
  const base = adoptedDefinition(record({ tools: ['files'] }), environment);
  assert.deepEqual(checkToolOverrides({ nope: 'off', run_command: 'off', read_file: 'allow', list_files: 'ask' }, base), { list_files: 'ask' });
  assert.throws(() => checkToolOverrides({ list_files: 'deny' }, base), (error: unknown) => error instanceof ToolOverrideError && error.code === 'invalid_input');
  assert.throws(() => checkToolOverrides([], base), ToolOverrideError);
  const definition = adoptedDefinition(record({ tools: ['files'], toolOverrides: { nope: 'off', run_command: 'off' } }), environment);
  assert.deepEqual(Object.keys(definition.tools).sort(), ['list_files', 'read_file', 'search_files']);
});

test('the instructions section lists only enabled tools', () => {
  const definition = adoptedDefinition(record({ tools: ['files', 'sandbox'], toolOverrides: { run_command_online: 'off', search_files: 'off' } }), environment);
  const section = adoptedInstructionsSection(Object.keys(definition.tools), 'policy');
  assert.match(section, /read_file/);
  assert.doesNotMatch(section, /run_command_online/);
  assert.doesNotMatch(section, /search_files/);
});

test('the cost estimate: (description + JSON schema) / 4, once per tool, and per set and in total', () => {
  const t = tool({ description: 'x'.repeat(40), inputSchema: jsonSchema({ type: 'object', properties: {} }) });
  const schema = JSON.stringify({ type: 'object', properties: {} });
  assert.equal(toolTokens(t), Math.ceil((40 + schema.length) / 4));
  assert.equal(toolTokens(t), toolTokens(t));
  const control = toolControl([{ set: 'a', enabled: true, base: { tools: { t, u: t }, permissions: { t: 'allow', u: 'ask' } } }, { set: 'b', enabled: false, base: { tools: { v: t }, permissions: { v: 'allow' } } }], { u: 'off' });
  assert.equal(control.sets[0]!.tokens, toolTokens(t));
  assert.equal(control.tokens, toolTokens(t));
  assert.equal(control.sets[0]!.tools[1]!.override, 'off');
  const adopted = adoptedToolControl(record({ toolOverrides: { run_command_online: 'off' } }), ['files', 'sandbox', 'web_search', 'web_dev'], environment);
  const sandbox = adopted.sets.find(s => s.set === 'sandbox')!;
  assert.equal(sandbox.tools.find(x => x.name === 'run_command_online')!.locked?.reason, 'run_command_online uses the network');
  assert.equal(sandbox.tools.find(x => x.name === 'run_command_online')!.default, 'ask');
  assert.ok(adopted.tokens > 1000, `tools cost ${adopted.tokens}`);
});

test('tighten-only (code-defined agents): allow only where the code allows; ask and off always', () => {
  const t = tool({ description: 'd', inputSchema: jsonSchema({ type: 'object' }) });
  const base = { tools: { a: t, b: t, c: t }, permissions: { a: 'allow' as const, b: 'ask' as const, c: 'deny' as const } };
  assert.deepEqual(checkToolOverrides({ a: 'ask', b: 'off' }, base, { tightenOnly: true }), { a: 'ask', b: 'off' });
  assert.deepEqual(checkToolOverrides({ a: 'allow' }, base, { tightenOnly: true }), {});
  assert.throws(() => checkToolOverrides({ b: 'allow' }, base, { tightenOnly: true }), (error: unknown) => error instanceof ToolOverrideError && error.code === 'tighten_only');
  assert.throws(() => checkToolOverrides({ c: 'ask' }, base, { tightenOnly: true }), /tightened/);
  // A stored file asking more is ignored.
  assert.deepEqual(applyToolOverrides(base, { b: 'allow', a: 'off' }, { tightenOnly: true }).permissions, { b: 'ask', c: 'deny' });
});
