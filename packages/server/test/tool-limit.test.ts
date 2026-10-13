import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefinitionToolLimit } from '../src/index.js';

test('the app\'s own agent keeps its tool call limit in a private file; unset means the definition\'s', () => {
  const state = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-tool-limit-'));
  const limit = new DefinitionToolLimit('my-agent', state, 100);
  assert.equal(limit.get(), 100);
  assert.deepEqual(limit.view(), { toolCallLimit: null, default: 100, min: 10, max: 1000 });
  limit.set({ toolCallLimit: 250 });
  assert.equal(limit.get(), 250);
  assert.equal(statSync(limit.file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(limit.file, 'utf8')), { toolCallLimit: 250 });
  assert.equal(new DefinitionToolLimit('my-agent', state, 100).get(), 250, 'kept across restarts');
  for (const bad of [{ toolCallLimit: 5 }, { toolCallLimit: 1001 }, { toolCallLimit: '50' }, {}]) assert.throws(() => limit.set(bad), /invalid_input/, JSON.stringify(bad));
  limit.set({ toolCallLimit: null });
  assert.equal(limit.get(), 100);
});

test('adopted agents: GET/PUT tool-limit routes exist and the runtime reads the record live', async () => {
  const source = readFileSync(new URL('../src/adoption.ts', import.meta.url), 'utf8');
  assert.match(source, /app\.get\('\/adoption\/agents\/:id\/tool-limit'/);
  assert.match(source, /app\.put\('\/adoption\/agents\/:id\/tool-limit'/);
  assert.match(source, /runtime\.toolCallLimit = \(\) => this\.hosted\.get\(record\.definitionId\)\?\.record\.toolCallLimit/);
});
