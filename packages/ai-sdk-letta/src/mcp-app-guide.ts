/**
 * The MCP App development guide: the text `mcp_app_guide` returns, and the
 * short note added to the instructions of agents with the dev app tools.
 *
 * Adapted from the official ext-apps skill `create-mcp-app` (v2.0.3,
 * https://github.com/modelcontextprotocol/ext-apps), whose code is under
 * Apache-2.0 and documentation under CC-BY-4.0; changed for this host
 * (Streamable HTTP dev apps in a services container without network, the
 * `ask` policy of view calls, a single-file view). The example was checked
 * against `@modelcontextprotocol/ext-apps` 2.0.3 and
 * `@modelcontextprotocol/server` 2.0.0 (`createMcpHandler` behind plain
 * `node:http`, no `@modelcontextprotocol/node`), and against the ext-apps
 * `basic-server-vanillajs` example. The FastMCP note was not run here.
 *
 * @module
 */

/** Added to the instructions of agents with the dev app tools (the example app adds it with MCP_APP_DEV=1). */
export const MCP_APP_DEV_NOTE = 'MCP Apps: you can build MCP Apps (MCP servers whose tools show interactive views in the chat). Call mcp_app_guide once before you build or change one, and follow it. Persist app server state (games, documents) as files under $STATE_DIR and reload it on start, since memory is lost on restart; in views, save small UI state with ui/state/save when the host advertises io.ai-sdk-letta/viewState. Keep ui/message text short and human-readable.';

/** The guide, returned by `mcp_app_guide` (about 1.5k tokens). */
export const MCP_APP_GUIDE = `# Building MCP Apps here

Adapted from ext-apps skill "create-mcp-app" v2.0.3 (Apache-2.0/CC-BY-4.0).

An MCP App is an MCP server whose tool declares a view: an HTML resource
rendered in a sandboxed iframe when the tool is called.

## Versions (pin them)

@modelcontextprotocol/ext-apps@2.0.3, @modelcontextprotocol/server@2.0.0,
zod@^4.2.0, esbuild@^0.25 (bundles the view). Not @modelcontextprotocol/sdk.

## How this host runs your app

- mcp_app_dev_start runs your server in the services container (no
  network; no build or install). It serves **Streamable HTTP** on
  127.0.0.1:$PORT (PORT=3000, HOST set; "port" to change, not 5173/3128)
  at /mcp ("path"). Output: mcp_app_dev_logs. Or "transport":"stdio".
- Python FastMCP: \`mcp.run(transport="http", host="127.0.0.1", port=3000)\`.
- Install with run_command_online (the user approves): \`npm install\`.
  Then build with run_command (no network).
- Tool visibility (\`_meta.ui.visibility\`): "model" tools become yours as
  dev_<name>__<tool> next turn (calling one renders its view); "app" tools
  only the view may call. Default: both.
- A view's app.callServerTool may ask the user first (a delay).
- View CSP: no network unless granted (declared \`_meta.ui.csp\` domains
  the user approved; dev apps: none). No eval, workers, form submission
  (preventDefault) or external scripts/fonts: inline everything.
- Support light/dark (\`color-scheme: light dark\`) and narrow widths.
- Persist server state (games, documents) as files under $STATE_DIR and
  reload them on start; memory is lost on restart or reload.

## API cheat-sheet

Server (\`@modelcontextprotocol/ext-apps/server\`):
- \`registerAppTool(server, name, { title, description, inputSchema: z.object({...}), _meta: { ui: { resourceUri, visibility? } } }, handler)\`
  The URI is nested (\`_meta.ui.resourceUri\`, "ui://...").
- \`registerAppResource(server, name, uri, { mimeType: RESOURCE_MIME_TYPE }, read)\`
  \`RESOURCE_MIME_TYPE\` is "text/html;profile=mcp-app"; \`read\` returns
  \`{ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }] }\`.
- Return \`{ content: [{ type: 'text', text }], structuredContent }\`

View (\`@modelcontextprotocol/ext-apps\`):
- \`const app = new App({ name, version })\`; set handlers, then
  \`app.connect()\` (no argument: it talks to the host via postMessage).
- \`app.ontoolresult = result => ...\`: the result of the call that opened
  the view.
- \`await app.callServerTool({ name: 'add_note', arguments: { text } })\`:
  object form, one argument; resolves to the tool result.
- ui/message (app.sendMessage): short, human ("I played e2e4."); the
  agent fetches state with tools.

## Minimal example (notes/)

package.json:
\`\`\`json
{ "name": "notes", "private": true, "type": "module",
  "scripts": { "build": "esbuild view.js --bundle --format=iife --minify --outfile=dist/view.js" },
  "dependencies": { "@modelcontextprotocol/ext-apps": "2.0.3", "@modelcontextprotocol/server": "2.0.0", "zod": "^4.2.0", "esbuild": "^0.25.0" } }
\`\`\`

server.js (\`createMcpHandler\` builds a server per request: keep state
outside the factory):
\`\`\`js
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

const uri = 'ui://notes/board.html';
const notes = [];
const board = () => ({ content: [{ type: 'text', text: \`\${notes.length} note(s)\` }], structuredContent: { notes } });

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'notes', version: '0.1.0' });
  registerAppTool(server, 'show_board', { title: 'Notes board', description: 'Show the notes board.',
    inputSchema: z.object({}), _meta: { ui: { resourceUri: uri } } }, async () => board());
  registerAppTool(server, 'add_note', { description: 'Add a note (from the view).',
    inputSchema: z.object({ text: z.string().min(1).max(200) }),
    _meta: { ui: { resourceUri: uri, visibility: ['app'] } } },
    async ({ text }) => { notes.push({ text }); return board(); });
  registerAppResource(server, 'Notes board', uri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    const js = readFileSync(new URL('./dist/view.js', import.meta.url), 'utf8').replaceAll('</script', '<\\\\/script');
    return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text:
      \`<!doctype html><html><body><h1>Notes</h1><ul id="list"></ul>
<form id="f"><input id="t" required><button>Add</button></form><script>\${js}</script></body></html>\` }] };
  });
  return server;
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = Object.entries(req.headers).flatMap(([k, v]) => v === undefined ? [] : [[k, String(v)]]);
  const response = await handler.fetch(new Request(url, { method: req.method, headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}).listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => console.error('listening'));
\`\`\`

view.js:
\`\`\`js
import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'Notes board', version: '0.1.0' });
const render = r => document.getElementById('list').replaceChildren(
  ...(r.structuredContent?.notes ?? []).map(n => Object.assign(document.createElement('li'), { textContent: n.text })));
app.ontoolresult = render;
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const t = document.getElementById('t');
  render(await app.callServerTool({ name: 'add_note', arguments: { text: t.value } }));
  t.value = '';
});
app.connect();
\`\`\`

## Restoring the view

The host keeps a view's state (never seen by the agent: use
ui/update-model-context for that), also for later calls:
\`\`\`js
const K = 'io.ai-sdk-letta/viewState';
await app.connect();
const on = !!app.getHostCapabilities()?.experimental?.[K];
let s = app.getHostContext()?.[K]?.state ?? { n: 0 };
const save = () => on && app.request({ method: 'ui/state/save', params: { state: s } }, z.object({})); // ≤ 64 KB
\`\`\`

## The loop

1. Scaffold the folder (above), run_command_online \`npm install\`,
   run_command \`npm run build\`.
2. mcp_app_dev_start {"name":"notes","cwd":"notes","command":"node server.js"}.
   It checks the contract: fix every error (mcp_app_dev_check again).
   Failed to start: read mcp_app_dev_logs.
3. mcp_app_dev_call tests any tool (also "app" ones) without the user.
4. Call your dev_<name>__<tool> (next turn): the view renders in the chat;
   the user can open it in the side panel.
5. Change, rebuild, mcp_app_dev_reload: open views render again.
`;
