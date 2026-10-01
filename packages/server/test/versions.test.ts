import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guiApp, packageVersion, runtimeVersions, ThreadRuntime } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const version = (path: string) => (JSON.parse(readFileSync(join(root, path), 'utf8')) as { version: string }).version;

/** Writes `files` (path → contents; objects as JSON) under `dir`. */
function tree(dir: string, files: Record<string, unknown>) {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
}

test('source checkout: versions are the workspace packages’ and the Letta SDK ai-sdk-letta resolves', () => {
  assert.deepEqual(runtimeVersions(), {
    aiSdkLetta: version('packages/ai-sdk-letta/package.json'),
    server: version('packages/server/package.json'),
    lettaSdk: (JSON.parse(readFileSync(join(root, 'node_modules/@letta-ai/letta-agent-sdk/package.json'), 'utf8')) as { version: string }).version,
  });
});

test('npm install layout: resolved like Node does, nested copies win, packages without an exported package.json still read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-versions-'));
  try {
    tree(dir, {
      'node_modules/@ai-sdk-letta/server/package.json': { name: '@ai-sdk-letta/server', version: '9.1.0', type: 'module', exports: { '.': './dist/index.js', './package.json': './package.json' } },
      'node_modules/ai-sdk-letta/package.json': { name: 'ai-sdk-letta', version: '9.2.0', type: 'module', exports: { '.': { import: './dist/index.js', default: './dist/index.js' }, './package.json': './package.json' } },
      'node_modules/ai-sdk-letta/dist/index.js': '',
      // The real SDK exports only "." (no ./package.json): found from its entry point.
      'node_modules/ai-sdk-letta/node_modules/@letta-ai/letta-agent-sdk/package.json': { name: '@letta-ai/letta-agent-sdk', version: '9.3.0', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } },
      'node_modules/ai-sdk-letta/node_modules/@letta-ai/letta-agent-sdk/dist/index.js': '',
      // A hoisted copy of another version, used by someone else: not the one ai-sdk-letta runs.
      'node_modules/@letta-ai/letta-agent-sdk/package.json': { name: '@letta-ai/letta-agent-sdk', version: '0.0.1', main: 'index.js' },
      'node_modules/@letta-ai/letta-agent-sdk/index.js': '',
    });
    assert.deepEqual(runtimeVersions(join(dir, 'node_modules/@ai-sdk-letta/server/package.json')), { aiSdkLetta: '9.2.0', server: '9.1.0', lettaSdk: '9.3.0' });
    assert.equal(packageVersion('@letta-ai/letta-agent-sdk', join(dir, 'package.json')), '0.0.1');
    assert.equal(packageVersion('missing-package', join(dir, 'package.json')), null);
    // Unreadable or unexpected manifests give null, never a guess.
    tree(dir, { 'other/node_modules/ai-sdk-letta/package.json': { name: 'ai-sdk-letta', version: '<script>' }, 'other/server/package.json': { name: 'something-else', version: '1.0.0' } });
    // (That ai-sdk-letta still resolves the hoisted SDK, which is reported.)
    assert.deepEqual(runtimeVersions(join(dir, 'other/server/package.json')), { aiSdkLetta: null, server: null, lettaSdk: '0.0.1' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const empty = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-versions-empty-'));
  try { assert.deepEqual(runtimeVersions(join(empty, 'package.json')), { aiSdkLetta: null, server: null, lettaSdk: null }); }
  finally { rmSync(empty, { recursive: true, force: true }); }
});

test('GET /api/session returns the installed versions, under the same origin checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-versions-gui-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const runtime = new ThreadRuntime({ open: async () => { throw new Error('not opened'); }, close: async () => {} }, join(dir, 'state.json'), 'owner');
  const server = guiApp(runtime, 'owner', 0, assets, { id: 'sandbox', name: 'Sandbox' }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const data = await (await fetch(`${base}/api/session`)).json() as { versions: unknown };
    assert.deepEqual(data.versions, runtimeVersions());
    assert.equal((data.versions as { server: string }).server, version('packages/server/package.json'));
    assert.equal((await fetch(`${base}/api/session`, { headers: { origin: 'https://evil.test' } })).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
