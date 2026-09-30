import test from 'node:test';
import assert from 'node:assert/strict';
import { tool, jsonSchema } from 'ai';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolBridge, fileTraceWriter, type ToolActivity } from '../src/index.js';
import { bridge as createBridge } from './fixtures.js';

test('registry schemas map to SDK and deny unknown, disallowed, invalid and duplicate IDs', async () => {
  const events: ToolActivity[] = [];
  const bridge = createBridge({ allowedTools: ['text_stats'], persist: e => events.push(e) });
  assert.equal(bridge.tools[0].parameters.type, 'object');
  assert.equal((await bridge.execute('Bash', 'secret-id', {})).isError, true);
  assert.equal((await bridge.execute('text_stats', 'bad', { text: 1 })).isError, true);
  const result = await bridge.tools[0].execute('ok', { text: 'private secret words' });
  assert.deepEqual(JSON.parse(result.content[0].text!), { characters: 20, words: 3, lines: 1 });
  assert.equal((await bridge.tools[0].execute('ok', { text: 'different' })).isError, true);
  assert.equal(events.filter(e => e.status === 'start').length, 1);
  assert.equal(JSON.stringify(events).includes('private secret'), false);
  assert.equal(JSON.stringify(events).includes('secret-id'), false);
  assert.equal((await bridge.canUseTool('Bash')).behavior, 'deny');
  assert.equal((await bridge.canUseTool('text_stats')).behavior, 'allow');
  const disabled = createBridge({ allowedTools: [] });
  assert.equal(disabled.tools.length, 0);
  assert.equal((await disabled.execute('text_stats', 'x', { text: 'x' })).isError, true);
  assert.equal(createToolBridge({ tools: {}, permissions: {} }).tools.length, 0);
  assert.equal(createBridge({ permissions: {} }).tools.length, 0, 'tools without a permission are never exposed');
});

test('deadline and cancellation abort handlers; bad args never execute and calls are never retried', async () => {
  let executions = 0; let aborted = false;
  const definitions = { slow: tool({ inputSchema: jsonSchema<{ x: string }>({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false }), execute: async (_, { abortSignal }) => { executions++; abortSignal?.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } }) };
  const dependencies = { tools: definitions, permissions: { slow: 'allow' as const }, timeoutMs: 20, persist: () => {} };
  const bridge = createToolBridge(dependencies);
  await bridge.execute('slow', 'bad', {}); assert.equal(executions, 0);
  const result = await bridge.execute('slow', 'one', { x: 'x' });
  assert.match(result.content[0].text!, /tool_timeout/); assert.equal(aborted, true);
  await bridge.execute('slow', 'one', { x: 'x' }); assert.equal(executions, 1);
  const control = new AbortController();
  const cancelled = createToolBridge({ ...dependencies, signal: control.signal, timeoutMs: 1000 });
  const pending = cancelled.execute('slow', 'two', { x: 'x' });
  setTimeout(() => control.abort(), 5);
  assert.match((await pending).content[0].text!, /tool_cancelled/);
});

test('handler errors are sanitized, and pre-aborted calls do not execute', async () => {
  let executions = 0; const events: ToolActivity[] = [];
  const definitions = { fail: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object' }), execute: async (): Promise<string> => { executions++; throw new Error('credential secret'); } }) };
  const deps = { tools: definitions, permissions: { fail: 'allow' as const }, persist: (e: ToolActivity) => events.push(e) };
  const bridge = createToolBridge(deps);
  const result = await bridge.execute('fail', 'x', {});
  assert.equal(result.isError, true); assert.match(result.content[0].text!, /tool_failed/);
  assert.equal(JSON.stringify([events, result]).includes('credential'), false);
  const cancelled = createToolBridge({ ...deps, signal: AbortSignal.abort() });
  assert.match((await cancelled.execute('fail', 'y', {})).content[0].text!, /tool_cancelled/);
  assert.equal(executions, 1);
});

test('local trace persists only bounded metadata in private files', () => {
  const traceDirectory = join(mkdtempSync(join(tmpdir(), 'ai-sdk-letta-traces-')), 'traces');
  try {
    const event: ToolActivity = { type: 'tool', sessionId: 'test', callId: 'test', tool: 'text_stats', status: 'completion', durationMs: 1, at: new Date().toISOString() };
    fileTraceWriter(traceDirectory)(event);
    const file = join(traceDirectory, `${event.at.slice(0, 10)}.ndjson`);
    assert.ok(readFileSync(file, 'utf8').includes(JSON.stringify(event)));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(traceDirectory).mode & 0o777, 0o700);
  } finally { rmSync(join(traceDirectory, '..'), { recursive: true, force: true }); }
});
