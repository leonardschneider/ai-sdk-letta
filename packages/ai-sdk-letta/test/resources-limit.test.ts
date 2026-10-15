import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceStore, RESOURCES_GITIGNORE, RESOURCE_LIMITS } from '../src/index.js';

test('generated output and tool caches are never versioned', () => {
  for (const folder of ['node_modules/', '.next/', '.svelte-kit/', '.output/', 'target/', '.lake/', '.venv/', 'venv/', '.cache/']) assert.ok(RESOURCES_GITIGNORE.includes(`\n${folder}\n`), folder);
  // Ambiguous names that may hold real work are left alone.
  for (const folder of ['dist/', 'build/', 'public/']) assert.ok(!RESOURCES_GITIGNORE.includes(`\n${folder}\n`), folder);
});

test('a workspace over the file limit still opens and lists; versioning resumes when it is back under', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-res-limit-'));
  const store = ResourceStore.open(root, 'agent-limit-test');
  const files = join(root, 'agent-limit-test', 'files');
  mkdirSync(join(files, 'big'), { recursive: true });
  const many = RESOURCE_LIMITS.maxEntries + 5;
  for (let i = 0; i < many; i++) writeFileSync(join(files, 'big', `f${i}.txt`), 'x');
  writeFileSync(join(files, 'note.md'), 'keep');
  await store.init();
  assert.equal(store.overLimit, true, 'opened, snapshot skipped');
  const tree = store.tree();
  assert.ok(tree.children.some(n => n.name === 'big'), 'still listed');
  assert.equal(tree.truncated, true, 'the display cap applies as usual');
  assert.equal(await store.commitAll('turn'), undefined);
  assert.equal(store.overLimit, true);
  rmSync(join(files, 'big'), { recursive: true, force: true });
  assert.ok(await store.commitAll('cleanup'), 'versioning resumes');
  assert.equal(store.overLimit, false);
  rmSync(root, { recursive: true, force: true });
});
