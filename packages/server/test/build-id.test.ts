import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIdRoute } from '../src/index.js';

const call = (route: ReturnType<typeof buildIdRoute>) => new Promise<{ build: string }>(resolve => route({} as never, { json: resolve } as never, () => {}));

test('the build ID changes with a new process or a rebuilt web app, and not otherwise', async () => {
  const assets = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-build-'));
  writeFileSync(join(assets, 'index.html'), '<script src="/assets/index-A.js"></script>');
  const route = buildIdRoute(assets, 'boot1');
  const first = (await call(route)).build;
  assert.match(first, /^boot1-[0-9a-f]{16}$/);
  assert.equal((await call(route)).build, first, 'stable while nothing changes');
  writeFileSync(join(assets, 'index.html'), '<script src="/assets/index-B.js"></script>');
  utimesSync(join(assets, 'index.html'), new Date(), new Date(Date.now() + 5000));
  const rebuilt = (await call(route)).build;
  assert.notEqual(rebuilt, first, 'a rebuilt web app');
  assert.notEqual((await call(buildIdRoute(assets, 'boot2'))).build, rebuilt, 'a restarted server');
  assert.match((await call(buildIdRoute(join(assets, 'missing'), 'b'))).build, /^b-none$/);
});

test('/build.json is served without a session by both apps', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8');
  assert.equal(source.match(/app\.get\('\/build\.json', buildIdRoute\(assets\)\)/g)?.length, 2);
  // Registered outside /api, so the session and CSRF checks never apply.
  assert.ok(source.indexOf("app.get('/build.json'") < source.indexOf("app.use('/api', (req, res, next) =>"));
});
