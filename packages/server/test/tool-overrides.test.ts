import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool, jsonSchema } from 'ai';
import { defineAgent, fileTools, FILE_TOOL_PERMISSIONS, sandboxTools, SANDBOX_TOOL_PERMISSIONS, statePaths, INSTRUCTIONS_BEGIN, INSTRUCTIONS_END, type ToolControl } from 'ai-sdk-letta';
import { AdoptionRegistry, DefinitionToolOverrides, ThreadRuntime, type AdoptionBackend } from '../src/index.js';

const AGENT = 'agent-local-c4e55000-9438-4173-9418-aa89a45d258d';
const ID = 'chess-c4e55000';
const environment = { sandbox: { provider: 'docker' as const, git: { name: 'n', email: 'e@x' } }, webSearch: true };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-pertool-'));
  const systems = new Map([[AGENT, 'You are chess.\n']]);
  const backend: AdoptionBackend = {
    list: async () => [], conversations: async () => [], setModel: async () => {}, models: async () => [],
    agent: async id => systems.has(id) ? { id, name: 'chess', model: 'openai-codex/gpt-6', tags: ['git-memory-enabled'], system: systems.get(id)! } : undefined,
    setSystem: async (id, system) => { systems.set(id, system); },
    activity: () => ({ active: false, recent: false }),
  };
  const built: { tools: Record<string, unknown>; permissions: Record<string, string> }[] = [];
  const build = (definition: { tools: Record<string, unknown>; permissions: Record<string, string> }, folder: string) => {
    built.push(definition); mkdirSync(folder, { recursive: true });
    return { runtime: new ThreadRuntime({ open: async () => { throw new Error('no session'); }, close: async () => {} }, join(folder, 'state.json'), 'local-gui') };
  };
  const registry = new AdoptionRegistry({ stateDirectory: dir, owner: 'local-gui', reserved: { definitionIds: [] }, backend, build: build as never, environment, instructionsPollMs: 20 });
  return { dir, registry, built, systems };
}
async function serve(app: import('express').Express | import('express').Router) {
  const express = (await import('express')).default;
  const server = express().use(app).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, body?: unknown, method = 'PUT') => { const r = await fetch(`${base}${path}`, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
  return { call, close: () => new Promise(resolve => server.close(resolve)) };
}

test('PUT tools with overrides: validated, stored, re-hosted, and the instructions list only enabled tools', async () => {
  const f = fixture();
  const http = await serve(f.registry.routes());
  try {
    await f.registry.adopt({ agentId: AGENT, tools: ['files', 'sandbox', 'web_search', 'web_dev'] });
    await f.registry.applyInstructions(ID);
    // GET: every set the host offers, tools with defaults, locks and costs.
    const before = (await http.call(`/adoption/agents/${ID}/tools`)).body as unknown as ToolControl;
    const sandbox = before.sets.find(s => s.set === 'sandbox')!;
    assert.equal(sandbox.enabled, true);
    assert.equal(sandbox.tools.find(t => t.name === 'run_command_online')!.locked!.reason, 'run_command_online uses the network');
    assert.ok(before.sets.find(s => s.set === 'decisions')!.enabled === false);
    assert.ok(before.tokens > 0 && sandbox.tokens > 0);
    // Locked: refused with the reason; nothing changed.
    const locked = await http.call(`/adoption/agents/${ID}/tools`, { tools: ['files', 'sandbox', 'web_search', 'web_dev'], overrides: { web_search: 'allow' } });
    assert.equal(locked.status, 400); assert.equal(locked.body.error, 'tool_locked'); assert.match(String(locked.body.message), /reviewed by a person/);
    const invalid = await http.call(`/adoption/agents/${ID}/tools`, { tools: ['files'], overrides: { read_file: 'deny' } });
    assert.equal(invalid.status, 400); assert.equal(invalid.body.error, 'invalid_input');
    // Off, ask; unknown dropped.
    const builds = f.built.length;
    const saved = await http.call(`/adoption/agents/${ID}/tools`, { tools: ['files', 'sandbox', 'web_search', 'web_dev'], overrides: { run_command_online: 'off', browser_click: 'ask', nope: 'off', read_file: 'allow' } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.toolOverrides, { run_command_online: 'off', browser_click: 'ask' });
    assert.equal(f.built.length, builds + 1, 're-hosted');
    const definition = f.built.at(-1)!;
    assert.equal(Object.hasOwn(definition.tools, 'run_command_online'), false);
    assert.equal(definition.permissions.browser_click, 'ask');
    const after = (await http.call(`/adoption/agents/${ID}/tools`)).body as unknown as ToolControl;
    assert.equal(after.sets.find(s => s.set === 'sandbox')!.tools.find(t => t.name === 'run_command_online')!.override, 'off');
    assert.ok(after.tokens < before.tokens);
    assert.ok(f.registry.agents()[0]!.approvalTools!.includes('browser_click'));
    // Auto instructions: the section lists only enabled tools.
    await f.registry.instructionsSettled();
    const system = f.systems.get(AGENT)!;
    const section = system.slice(system.indexOf(INSTRUCTIONS_BEGIN), system.indexOf(INSTRUCTIONS_END));
    assert.doesNotMatch(section, /run_command_online/);
    assert.match(section, /run_command,/);
    // Without overrides, the current ones stay; an empty object clears them.
    assert.deepEqual((await http.call(`/adoption/agents/${ID}/tools`, { tools: ['files', 'sandbox', 'web_search', 'web_dev'] })).body.toolOverrides, { run_command_online: 'off', browser_click: 'ask' });
    assert.equal((await http.call(`/adoption/agents/${ID}/tools`, { tools: ['files', 'sandbox', 'web_search', 'web_dev'], overrides: {} })).body.toolOverrides, undefined);
  } finally { await http.close(); await f.registry.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a code-defined agent: tighten only, stored per definition, applied to the effective definition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-defoverrides-'));
  const textStats = tool({ description: 'Count words', inputSchema: jsonSchema({ type: 'object', properties: { text: { type: 'string' } } }), execute: async () => ({}) });
  const definition = defineAgent({ id: 'example-assistant', name: 'Example Assistant', model: 'a/b', instructions: 'x', tools: { text_stats: textStats, ...fileTools, ...sandboxTools }, permissions: { text_stats: 'ask', ...FILE_TOOL_PERMISSIONS, ...SANDBOX_TOOL_PERMISSIONS }, sandbox: { provider: 'docker' } });
  const changes: string[][] = [];
  const overrides = new DefinitionToolOverrides(definition, dir, d => changes.push(Object.keys(d.tools)));
  const http = await serve(overrides.routes());
  try {
    const control = (await http.call('/tools')).body as unknown as ToolControl;
    assert.equal(control.tightenOnly, true);
    assert.deepEqual(control.sets.map(s => [s.set, s.fixed]), [['files', true], ['sandbox', true], ['custom', true]]);
    // allow refused where the code asks; locked refused; ask and off accepted.
    const loosen = await http.call('/tools', { overrides: { text_stats: 'allow' } });
    assert.equal(loosen.status, 400); assert.equal(loosen.body.error, 'tighten_only');
    assert.equal((await http.call('/tools', { overrides: { run_command_online: 'allow' } })).body.error, 'tool_locked');
    const saved = await http.call('/tools', { overrides: { search_files: 'off', read_file: 'ask', list_files: 'allow' } });
    assert.equal(saved.status, 200);
    assert.ok(existsSync(join(statePaths(dir).server('example-assistant'), 'tool-overrides.json')));
    assert.deepEqual(JSON.parse(readFileSync(overrides.file, 'utf8')).overrides, { search_files: 'off', read_file: 'ask' });
    const effective = overrides.effective();
    assert.equal(Object.hasOwn(effective.tools, 'search_files'), false);
    assert.equal(effective.permissions.read_file, 'ask');
    assert.equal(overrides.version, 1);
    assert.equal(changes.length, 1);
    // A restart reads them back.
    assert.equal(new DefinitionToolOverrides(definition, dir).effective().permissions.read_file, 'ask');
  } finally { await http.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('during a reply, a tools change is stored and applies when the reply ends', async () => {
  const f = fixture();
  try {
    await f.registry.adopt({ agentId: AGENT, tools: ['files', 'sandbox'] });
    const runtime = f.registry.runtime(ID)!;
    const turn = { busy: true };
    Object.defineProperty(runtime, 'busy', { get: () => turn.busy });
    const builds = f.built.length;
    const result = await f.registry.setTools(ID, { tools: ['files', 'sandbox'], overrides: { run_command_online: 'off' } }) as { queued?: boolean };
    assert.equal(result.queued, true);
    assert.equal(f.built.length, builds, 'not restarted mid-reply');
    assert.equal(f.registry.toolControl(ID).sets.find(s => s.set === 'sandbox')!.tools.find(t => t.name === 'run_command_online')!.override, 'off');
    turn.busy = false; (runtime as unknown as { changed(): void }).changed();
    for (let i = 0; i < 50 && f.built.length === builds; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.built.length, builds + 1);
    assert.equal(Object.hasOwn(f.built.at(-1)!.tools, 'run_command_online'), false);
  } finally { await f.registry.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
