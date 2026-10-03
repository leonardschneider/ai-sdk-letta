import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, mkdirSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { acquireIdentity, creationOptions, dreamingCommand, INTERNAL_MEMORY_TOOLS, allowMemoryTool, memoryCommitCommand, LettaAgent, sessionOptions } from '../src/index.js';
import { bridge as createBridge, definition, registry } from './fixtures.js';

function fixture(context: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-persistence-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let creates = 0;
  const api = { create: async () => { creates++; return 'agent-local-test-id'; }, validate: async () => {} };
  const acquire = (backend = '/backend') => acquireIdentity(directory, definition, backend, api);
  return { directory, api, acquire, creates: () => creates };
}

test('definition controls logical identity, registry and supported creation options', () => {
  assert.equal(definition.id, 'test-assistant');
  assert.equal(definition.tools, registry);
  const options = creationOptions(definition, '/private-state');
  assert.equal(options.name, definition.name);
  assert.ok(String(options.systemPrompt).startsWith(definition.instructions));
  assert.match(String(options.systemPrompt), /after 25 steps/);
  assert.equal(options.model, definition.model);
  assert.equal(options.memfs, true);
  assert.equal(options.dreaming, undefined); // SDK convenience option mutates global defaults.
  assert.deepEqual(dreamingCommand(definition, 'agent-local-test'), {
    type: 'set_reflection_settings', runtime: { agent_id: 'agent-local-test', conversation_id: 'default' },
    scope: 'local_project', settings: { trigger: 'step-count', step_count: 25, merge: 'auto' },
  });
  assert.deepEqual(options.baseTools, []);
  assert.deepEqual(options.skillSources, []);
  assert.equal(options.cwd, '/private-state');
});

test('sessions load MemFS, inherit dreaming and expose only app tools plus scoped memory operations', async () => {
  const bridge = createBridge();
  const options = sessionOptions(bridge, () => undefined, '/private-state');
  assert.equal(options.stateless, false);
  assert.equal(options.cwd, '/private-state');
  assert.equal(options.dreaming, undefined);
  assert.equal(options.permissionMode, 'strict');
  assert.deepEqual(options.toolset, { base: 'none', include: [...INTERNAL_MEMORY_TOOLS] });
  assert.deepEqual(options.allowedTools, [...Object.keys(definition.tools), ...INTERNAL_MEMORY_TOOLS]);
  assert.deepEqual(options.tools?.map(tool => tool.name), Object.keys(definition.tools));
  assert.equal((await options.canUseTool!('text_stats', { text: 123 })).behavior, 'deny');
  assert.equal((await options.canUseTool!('text_stats', { text: 'hello' })).behavior, 'allow');
  assert.equal((await options.canUseTool!('Bash', { command: 'pwd' })).behavior, 'deny');
  assert.equal((await options.canUseTool!('Read', { file_path: '/etc/passwd' })).behavior, 'deny');
  assert.equal((await options.canUseTool!('Unknown', {})).behavior, 'deny');
});

test('mapping persists SDK-generated physical ID across two launches, with private permissions; a new agent never selects the default conversation', async context => {
  const f = fixture(context);
  const first = await f.acquire();
  assert.notEqual(first.identity.agentId, first.identity.definitionId);
  assert.equal(first.identity.conversationId, undefined, 'no conversation until the first named one is created');
  assert.equal(first.identity.namedOnly, true);
  first.release(); first.release();
  const second = await f.acquire();
  assert.deepEqual(second.identity, first.identity);
  assert.equal(second.identity.conversationId, undefined);
  assert.equal(f.creates(), 1);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.directory, 'test-assistant.json')).mode & 0o777, 0o600);
  second.release();
});

test('live lock prevents a second process and releases on normal close', async context => {
  const f = fixture(context);
  const first = await f.acquire();
  await assert.rejects(f.acquire(), /locked/);
  assert.equal(f.creates(), 1);
  first.release();
  const second = await f.acquire(); second.release();
});

test('backend mismatch, invalid mapping and missing physical agent never recreate', async context => {
  const f = fixture(context);
  (await f.acquire()).release();
  await assert.rejects(f.acquire('/different-backend'), /mismatch/);
  f.api.validate = async () => { throw new Error('Agent not found'); };
  await assert.rejects(f.acquire(), /not found/);
  writeFileSync(join(f.directory, 'test-assistant.json'), '{}');
  await assert.rejects(f.acquire(), /Invalid/);
  assert.equal(f.creates(), 1);
});

test('uncertain create leaves durable pending intent and blocks duplication', async context => {
  const f = fixture(context);
  let attempts = 0;
  f.api.create = async () => { attempts++; throw new Error('lost after creation'); };
  await assert.rejects(f.acquire(), /lost/);
  assert.match(readFileSync(join(f.directory, 'test-assistant.pending.json'), 'utf8'), /creation-uncertain/);
  await assert.rejects(f.acquire(), /Unresolved/);
  assert.equal(attempts, 1);
});

test('stale lock and pending intent alongside mapping both fail closed', async context => {
  const f = fixture(context);
  (await f.acquire()).release();
  const lock = join(f.directory, 'test-assistant.lock');
  writeFileSync(lock, '{"pid":99999999}');
  await assert.rejects(f.acquire(), /locked/);
  rmSync(lock);
  writeFileSync(join(f.directory, 'test-assistant.pending.json'), '{}');
  await assert.rejects(f.acquire(), /Unresolved/);
  assert.equal(f.creates(), 1);
});

test('memory permission allows only own Markdown and fixed commit, rejecting shell, traversal, git metadata, symlinks and hardlinks', context => {
  const f = fixture(context);
  const root = join(f.directory, 'memory'); mkdirSync(root);
  const own = join(root, 'note.md'); writeFileSync(own, 'memory');
  for (const name of ['Read', 'Write', 'Edit']) assert.equal(allowMemoryTool(name, { file_path: own }, root), true);
  for (const path of [join(root, '..', 'outside.md'), join(root, '.git', 'config.md'), 'relative.md', join(root, 'script.sh')]) assert.equal(allowMemoryTool('Write', { file_path: path }, root), false);
  symlinkSync(f.directory, join(root, 'escape'));
  assert.equal(allowMemoryTool('Read', { file_path: join(root, 'escape', 'outside.md') }, root), false);
  linkSync(own, join(root, 'linked.md'));
  assert.equal(allowMemoryTool('Write', { file_path: own }, root), false);
  assert.equal(allowMemoryTool('Read', { file_path: own }), false);
  assert.equal(allowMemoryTool('Unknown', {}, root), false);
  const command = memoryCommitCommand(root);
  assert.equal(allowMemoryTool('Bash', { command }, root), true);
  assert.equal(allowMemoryTool('Bash', { command, run_in_background: true }, root), false);
  assert.equal(allowMemoryTool('Bash', { command: `${command}; touch /tmp/no` }, root), false);
  assert.equal(allowMemoryTool('Bash', { command: 'pwd' }, root), false);
});

test('failed delivery retains its durable intent hook and prevents implicit retry', async () => {
  const hooks: string[] = [];
  let sends = 0;
  const agent = new LettaAgent({ id: 'fixture', tools: registry, lettaAgentId: 'agent-local-test', delivery: { begin: () => hooks.push('begin'), complete: () => hooks.push('complete') }, open: () => ({
    send: async () => { sends++; }, abort: async () => {}, close: () => {},
    async *stream() {
      yield { type: 'assistant', content: 'partial', uuid: 'a' } as SDKMessage;
      yield { type: 'result', success: false, uuid: 'r', durationMs: 1, conversationId: 'default' } as SDKMessage;
    },
  }) });
  await assert.rejects(agent.generate({ prompt: 'new request' }), /failed/);
  assert.deepEqual(hooks, ['begin']);
  await assert.rejects(agent.generate({ prompt: 'retry' }), /uncertain/);
  assert.equal(sends, 1);
});

test('restart starts empty provider guard history and sends only the new user turn; internal memory events never become app cards', async () => {
  const sent: string[] = [];
  const open = () => ({ send: async (text: unknown) => { sent.push(String(text)); }, abort: async () => {}, close: () => {},
    async *stream() {
      yield { type: 'tool_call', toolCallId: 'memory-call', toolName: 'Bash', toolInput: {}, uuid: 'call' } as SDKMessage;
      yield { type: 'tool_result', toolCallId: 'memory-call', content: 'progress', isError: false, uuid: 'synthetic-tool-return-stream-memory-call' } as SDKMessage;
      yield { type: 'tool_result', toolCallId: 'memory-call', content: 'done', isError: false, uuid: 'authoritative' } as SDKMessage;
      yield { type: 'assistant', content: 'remembered', uuid: 'text' } as SDKMessage;
      yield { type: 'result', success: true, uuid: 'result', durationMs: 1, conversationId: 'default' } as SDKMessage;
    },
  });
  const delivery: string[] = [];
  const first = new LettaAgent({ id: definition.id, tools: registry, open, memoryTools: INTERNAL_MEMORY_TOOLS, lettaAgentId: 'agent-local-test', delivery: { begin: () => delivery.push('begin'), complete: () => delivery.push('complete') } });
  await first.generate({ prompt: 'old turn' }); first.close();
  const second = new LettaAgent({ id: definition.id, tools: registry, open, memoryTools: INTERNAL_MEMORY_TOOLS, lettaAgentId: 'agent-local-test' });
  const result = await second.generate({ messages: [{ role: 'user', content: 'new turn' }] });
  assert.deepEqual(sent, ['old turn', 'new turn']);
  assert.deepEqual(delivery, ['begin', 'complete']);
  assert.equal(result.text, 'remembered');
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.toolResults.length, 0);
  assert.equal(first.id, second.id);
  assert.equal(first.lettaAgentId, second.lettaAgentId);
});

test('a mapping written by an earlier version (default conversation) keeps working unchanged', async context => {
  const f = fixture(context);
  const first = await f.acquire(); first.release();
  const file = join(f.directory, 'test-assistant.json');
  const { namedOnly: _named, ...legacy } = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...legacy, conversationId: 'default' }));
  const reopened = await f.acquire();
  assert.equal(reopened.identity.conversationId, 'default');
  assert.equal(reopened.identity.namedOnly, undefined, 'the default conversation stays listed for this agent');
  reopened.release();
  // A mapping with neither a conversation nor the named-only mark is not one this library wrote.
  writeFileSync(file, JSON.stringify(legacy));
  await assert.rejects(f.acquire(), /Invalid identity mapping/);
});
