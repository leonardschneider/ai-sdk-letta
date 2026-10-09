import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_APP_SCHEMA_VERSION, lintMcpApp, type McpAppClient, type McpAppLintFinding, type McpToolDefinition } from '../src/index.js';
import schema from '../src/mcp-app-schema.json' with { type: 'json' };

const URI = 'ui://demo/view.html';
const MIME = 'text/html;profile=mcp-app';
const GOOD_HTML = `<script type="module">import { App } from '@modelcontextprotocol/ext-apps'; const app = new App({ name: 'demo', version: '1' }); await app.connect(); await app.callServerTool({ name: 'refresh', arguments: {} });</script>`;

type Resource = { uri: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> };
function fakeClient({ tools, resources = [{ uri: URI, mimeType: MIME, text: GOOD_HTML }], listed }: { tools: McpToolDefinition[]; resources?: Resource[]; listed?: string[] }): McpAppClient {
  return {
    listTools: async () => ({ tools }),
    callTool: async () => ({ content: [] }),
    readResource: async uri => {
      const found = resources.find(r => r.uri === uri);
      if (!found) throw new Error(`Resource ${uri} not found`);
      return { contents: [found] };
    },
    ...(listed ? { listResources: async () => ({ resources: listed.map(uri => ({ uri })) }) } : {}),
    close: async () => {},
  };
}
const tool = (name: string, meta?: Record<string, unknown>): McpToolDefinition => ({ name, inputSchema: { type: 'object' }, ...(meta ? { _meta: meta } : {}) });
const viewTool = (ui: Record<string, unknown> = {}) => tool('show', { ui: { resourceUri: URI, ...ui } });
const rules = (findings: McpAppLintFinding[], level?: 'error' | 'warning') => findings.filter(f => !level || f.level === level).map(f => f.rule);

test('lint: the vendored schema version matches MCP_APP_SCHEMA_VERSION', () => {
  assert.equal(schema.version, MCP_APP_SCHEMA_VERSION);
});

test('lint: a good app has no findings', async () => {
  const findings = await lintMcpApp(fakeClient({
    tools: [viewTool({ visibility: ['model', 'app'] }), tool('refresh', { ui: { visibility: ['app'] } }), tool('plain')],
    resources: [{ uri: URI, mimeType: MIME, text: GOOD_HTML, _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] }, permissions: { clipboardWrite: {} }, prefersBorder: true } } }],
    listed: [URI],
  }));
  assert.deepEqual(findings, []);
});

test('lint: flat ui.resourceUri / ui/resourceUri keys', async () => {
  const findings = await lintMcpApp(fakeClient({ tools: [tool('a', { 'ui.resourceUri': URI }), tool('b', { 'ui/resourceUri': URI })] }));
  const flat = findings.filter(f => f.rule === 'flat-resource-uri');
  assert.deepEqual(flat.map(f => f.tool), ['a', 'b']);
  assert.equal(flat[0]!.level, 'error');
  assert.match(flat[0]!.fix!, /ui: \{ resourceUri: "ui:\/\/demo\/view\.html" \}/);
  assert.ok(!rules(findings).includes('no-ui-tools'), 'the flat key still points at a view, which is linted');
});

test('lint: tool _meta.ui failing McpUiToolMeta', async () => {
  const findings = await lintMcpApp(fakeClient({ tools: [viewTool({ csp: { connectDomains: [] } })] }));
  assert.deepEqual(rules(findings), ['tool-meta-schema']);
  assert.match(findings[0]!.message, /McpUiToolMeta/);
});

test('lint: string-form callServerTool', async () => {
  for (const quote of [`'`, `"`, '`']) {
    const html = `<script>import { App } from '@modelcontextprotocol/ext-apps'; app.callServerTool(${quote}refresh${quote}, {});</script>`;
    const findings = await lintMcpApp(fakeClient({ tools: [viewTool()], resources: [{ uri: URI, mimeType: MIME, text: html }] }));
    assert.deepEqual(rules(findings), ['call-server-tool-string'], quote);
    assert.equal(findings[0]!.level, 'error');
  }
});

test('lint: wrong mime type', async () => {
  const findings = await lintMcpApp(fakeClient({ tools: [viewTool()], resources: [{ uri: URI, mimeType: 'text/html', text: GOOD_HTML }] }));
  assert.deepEqual(rules(findings), ['resource-mime']);
  assert.equal(findings[0]!.resource, URI);
});

test('lint: bad CSP shape and permissions on the resource', async () => {
  const csp = await lintMcpApp(fakeClient({ tools: [viewTool()], resources: [{ uri: URI, mimeType: MIME, text: GOOD_HTML, _meta: { ui: { csp: { connectDomains: 'https://api.example.com' } } } }] }));
  assert.deepEqual(rules(csp), ['resource-meta-schema']);
  assert.match(csp[0]!.message, /connectDomains/);
  const permissions = await lintMcpApp(fakeClient({ tools: [viewTool()], resources: [{ uri: URI, mimeType: MIME, text: GOOD_HTML, _meta: { ui: { permissions: { camera: true } } } }] }));
  assert.deepEqual(rules(permissions), ['resource-meta-schema']);
});

test('lint: bad and empty visibility', async () => {
  const bad = await lintMcpApp(fakeClient({ tools: [viewTool({ visibility: ['model', 'user'] })] }));
  assert.deepEqual(rules(bad), ['visibility']);
  assert.match(bad[0]!.message, /"user"/);
  const empty = await lintMcpApp(fakeClient({ tools: [viewTool({ visibility: [] })] }));
  assert.deepEqual(rules(empty), ['visibility']);
  assert.match(empty[0]!.message, /empty/);
});

test('lint: missing resource (unreadable: error; unlisted: warning)', async () => {
  const unreadable = await lintMcpApp(fakeClient({ tools: [viewTool()], resources: [] }));
  assert.deepEqual(unreadable.map(f => [f.rule, f.level]), [['resource-missing', 'error']]);
  const unlisted = await lintMcpApp(fakeClient({ tools: [viewTool()], listed: [] }));
  assert.deepEqual(unlisted.map(f => [f.rule, f.level]), [['resource-missing', 'warning']]);
});

test('lint: HTML without the app SDK is a warning; an inline bundle with ui/initialize passes', async () => {
  const missing = await lintMcpApp(fakeClient({ tools: [viewTool()], resources: [{ uri: URI, mimeType: MIME, text: '<h1>hello</h1>' }] }));
  assert.deepEqual(missing.map(f => [f.rule, f.level]), [['app-sdk-missing', 'warning']]);
  const inline = await lintMcpApp(fakeClient({ tools: [viewTool()], resources: [{ uri: URI, mimeType: MIME, text: '<script>parent.postMessage({ jsonrpc: "2.0", method: "ui/initialize" }, "*")</script>' }] }));
  assert.deepEqual(inline, []);
  const blob = await lintMcpApp(fakeClient({ tools: [viewTool()], resources: [{ uri: URI, mimeType: MIME, blob: Buffer.from(GOOD_HTML).toString('base64') }] }));
  assert.deepEqual(blob, []);
});

test('lint: no UI tools is a warning', async () => {
  const findings = await lintMcpApp(fakeClient({ tools: [tool('plain')] }));
  assert.deepEqual(findings.map(f => [f.rule, f.level]), [['no-ui-tools', 'warning']]);
});

test('lint: findings are capped at 50; an aborted signal rejects', async () => {
  const tools = Array.from({ length: 80 }, (_, i) => tool(`t${i}`, { 'ui/resourceUri': URI }));
  assert.equal((await lintMcpApp(fakeClient({ tools }))).length, 50);
  const hung: McpAppClient = { ...fakeClient({ tools: [viewTool()] }), readResource: () => new Promise(() => {}) };
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('stop')), 20);
  await assert.rejects(lintMcpApp(hung, { signal: controller.signal }), /stop/);
});
