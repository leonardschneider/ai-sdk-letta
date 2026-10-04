/**
 * Real-container checks of web app development. Opt-in:
 *
 *   AI_SDK_LETTA_SANDBOX_TEST=docker,apple-container npm run test:sandbox --workspace ai-sdk-letta
 *
 * Builds the web development image the first time (a few minutes). A tiny
 * Node server stands in for the dev server (no npm install, no network).
 * Every container is labelled and removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_TOOL_SPECS, SANDBOX_LABEL, SandboxManager, WEBDEV_IMAGE, WebDevRegistry, prepareSandbox, resolveSandboxConfig, resolveWebDevConfig, type SandboxProviderName,
} from '../src/index.js';

const wanted = (process.env.AI_SDK_LETTA_SANDBOX_TEST ?? '').split(',').map(s => s.trim()).filter(Boolean) as SandboxProviderName[];
const listOurs = (provider: SandboxProviderName): string[] => {
  if (provider === 'docker') return execFileSync('docker', ['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}.pid=${process.pid}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const all = JSON.parse(execFileSync('container', ['list', '--all', '--format', 'json'], { encoding: 'utf8' }) || '[]') as { configuration?: { id?: string; labels?: Record<string, string> } }[];
  return all.filter(c => c.configuration?.labels?.[`${SANDBOX_LABEL}.pid`] === String(process.pid)).map(c => c.configuration!.id!);
};
const spec = (name: string) => BROWSER_TOOL_SPECS.find(s => s.name === name)!;
const text = (result: { content: { type: string; text?: string }[] }) => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

const APP = `const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/hdr') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(req.headers)); }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>t</title><h1 id="h">Hello preview</h1><script>console.error("deliberate bug: " + (typeof window.config));fetch("https://example.com/").catch(e => console.log("egress blocked: " + e.message))</script>');
}).listen(5173, '127.0.0.1', () => console.log('listening on 5173'));`;

for (const provider of ['docker', 'apple-container'] as const) {
  test(`${provider}: services container, dev server, preview tunnel, browser, no egress, cleanup`, { skip: !wanted.includes(provider) && `set AI_SDK_LETTA_SANDBOX_TEST=${provider}`, timeout: 900_000 }, async () => {
    await prepareSandbox({ provider, image: WEBDEV_IMAGE }, line => console.log(line));
    const root = realpathSync(mkdtempSync(join(tmpdir(), `ai-sdk-letta-webdev-${provider}-`)));
    const workspace = join(root, 'ws');
    mkdirSync(join(workspace, 'Chat', 'app'), { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, 'Chat', 'app', 'server.js'), APP);
    const sandbox = new SandboxManager(resolveSandboxConfig({ provider, image: WEBDEV_IMAGE }), { workspace: () => workspace, folder: () => 'Chat', owner: 'webdev-test' });
    const registry = new WebDevRegistry({ directory: join(root, 'webdev') });
    const services = registry.attach('agent', 'conv', sandbox, resolveWebDevConfig({ idleTimeoutMs: 600_000 }));
    try {
      assert.deepEqual(listOurs(provider), [], 'nothing before the first call');
      let started = Date.now();
      const wrong = await services.startDevServer({ cwd: 'nope', command: 'node server.js' });
      console.log(`container start + folder check: ${Date.now() - started} ms`);
      assert.equal(wrong.ok, false);
      assert.match(wrong.text, /\/workspace\/Chat\/nope does not exist/);
      assert.match(wrong.text, /app\//);
      started = Date.now();
      const ok = await services.startDevServer({ cwd: 'app', command: 'node server.js' });
      console.log(`dev server ready: ${Date.now() - started} ms`);
      assert.equal(ok.ok, true, ok.text);
      assert.match(ok.text, /Folder: \/workspace\/Chat\/app/);
      assert.match(ok.text, /listening on 5173/);
      assert.equal(listOurs(provider).length, 1, 'one services container');

      // The preview tunnel reaches the dev server; credentials never do.
      const stream = services.connectPreview();
      assert.ok(stream);
      const body = await new Promise<string>((resolve, reject) => {
        const req = request({ method: 'GET', path: '/hdr', headers: { host: '127.0.0.1:5173', connection: 'close' }, createConnection: () => stream as never }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b)); });
        req.on('error', reject); req.end();
      });
      assert.equal(JSON.parse(body).host, '127.0.0.1:5173');

      // The browser: navigate, console (the deliberate bug, egress blocked), snapshot, screenshot.
      started = Date.now();
      const nav = await services.callBrowser(spec('navigate_page'), { type: 'url', url: 'http://127.0.0.1:5173/' });
      console.log(`first browser call (MCP + Chromium start + navigate): ${Date.now() - started} ms`);
      assert.ok(!nav.isError, text(nav));
      await new Promise(resolve => setTimeout(resolve, 1500));
      const consoleText = text(await services.callBrowser(spec('list_console_messages'), {}));
      assert.match(consoleText, /deliberate bug: undefined/);
      assert.match(consoleText, /egress blocked/);
      assert.match(text(await services.callBrowser(spec('take_snapshot'), {})), /Hello preview/);
      started = Date.now();
      const shot = await services.callBrowser(spec('take_screenshot'), {});
      console.log(`screenshot: ${Date.now() - started} ms`);
      assert.ok(shot.content.some(c => c.type === 'image' && /image\/(webp|png)/.test(c.mimeType ?? '')));
      // Other origins are not loaded.
      const away = await services.callBrowser(spec('navigate_page'), { type: 'url', url: 'https://example.com/' });
      assert.ok(away.isError || /not allowed|blocked|ERR_/i.test(text(away)), text(away));

      // Egress: an approved origin loads (through the tunnel and the host-side check), a revoked one no longer does.
      const probe = '() => fetch("https://cdn.jsdelivr.net/npm/left-pad@1.3.0/package.json").then(r => r.json()).then(j => "loaded " + j.name).catch(e => "blocked " + e.message)';
      await services.approveOrigin('https://cdn.jsdelivr.net');
      await services.callBrowser(spec('navigate_page'), { type: 'url', url: 'http://127.0.0.1:5173/' });
      started = Date.now();
      assert.match(text(await services.callBrowser(spec('evaluate_script'), { function: probe })), /loaded left-pad/);
      console.log(`fetch through egress: ${Date.now() - started} ms`);
      assert.match(text(await services.callBrowser(spec('evaluate_script'), { function: probe.replace('cdn.jsdelivr.net', 'unpkg.com') })), /blocked/);
      await services.revokeOrigin('https://cdn.jsdelivr.net');
      await services.callBrowser(spec('navigate_page'), { type: 'url', url: 'http://127.0.0.1:5173/' });
      assert.match(text(await services.callBrowser(spec('evaluate_script'), { function: probe })), /blocked/);
      // Two restarts later, only one browser runs in the container (old ones are stopped, not just disconnected).
      const container = await (services as unknown as { container: Promise<{ exec(argv: string[]): Promise<{ stdout: string }> }> }).container;
      const browsers = (await container.exec(['sh', '-c', 'ps -eo args | grep -c "^chrome-devtools-mcp"'])).stdout.trim();
      assert.equal(browsers, '1', 'one chrome-devtools-mcp');

      // Stop: the dev server, then everything; no container left.
      assert.match(await services.stopDevServer(), /stopped/);
      assert.match(await services.devServerLogs(), /not running/);
      await registry.close();
      assert.deepEqual(listOurs(provider), [], 'no container left');
    } finally {
      await registry.close();
      await sandbox.close();
      for (const name of listOurs(provider)) execFileSync(provider === 'docker' ? 'docker' : 'container', provider === 'docker' ? ['rm', '-f', name] : ['delete', '--force', name]);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
