// A minimal MCP App server for offline tests (newline-delimited JSON-RPC over stdio, no dependencies).
// Tools: show (model+app, with a view), record (app only), secret (model only), plain (no _meta), bad_view (view with a wrong MIME type).
// Writes its PID to the file named by argv[2] (if any), so tests can check it was killed.
import { writeFileSync } from 'node:fs';
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));
const VIEW = 'ui://test/view.html';
const tools = [
  { name: 'show', title: 'Show', description: 'Shows the view.', inputSchema: { type: 'object', properties: { label: { type: 'string' } } }, _meta: { ui: { resourceUri: VIEW } } },
  { name: 'record', description: 'App only.', inputSchema: { type: 'object', properties: { note: { type: 'string' } } }, _meta: { ui: { resourceUri: VIEW, visibility: ['app'] } } },
  { name: 'secret', description: 'Model only.', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { visibility: ['model'] } } },
  { name: 'plain', description: 'No metadata.', inputSchema: { type: 'object', properties: {} } },
  { name: 'nobody', description: 'Empty visibility.', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { visibility: [] } } },
];
const records = [];
let buffer = '';
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const { id, method, params } = message;
    if (method === 'initialize' && process.argv[2]) writeFileSync(`${process.argv[2]}.init.json`, JSON.stringify(params));
    if (method === 'initialize') send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'Test App', version: '1.2.3' }, _seen: params.capabilities } });
    else if (method === 'tools/list') send({ id, result: { tools } });
    else if (method === 'resources/read') {
      if (params.uri === VIEW) send({ id, result: { contents: [{ uri: VIEW, mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><html><body>view</body></html>', _meta: { ui: { csp: { connectDomains: ['https://api.example.org', 'https://evil.example.net', "'unsafe-eval'", 'http://insecure.example.org'], resourceDomains: ['https://cdn.example.org'] }, prefersBorder: true } } }] } });
      else send({ id, error: { code: -32002, message: 'not found' } });
    } else if (method === 'tools/call') {
      if (params.name === 'show') send({ id, result: { content: [{ type: 'text', text: `shown ${params.arguments?.label ?? ''}`.trim() }], structuredContent: { label: params.arguments?.label ?? null, big: 'x'.repeat(Number(params.arguments?.size ?? 0)) } } });
      else if (params.name === 'record') { records.push(params.arguments?.note); send({ id, result: { content: [{ type: 'text', text: `recorded ${records.length}` }], structuredContent: { count: records.length } } }); }
      else if (params.name === 'secret') send({ id, result: { content: [{ type: 'text', text: 'SECRET' }] } });
      else if (params.name === 'hang') { /* never answers */ }
      else send({ id, result: { content: [{ type: 'text', text: 'ok' }] } });
    } else if (method === 'ping') send({ id, result: {} });
    else send({ id, error: { code: -32601, message: 'method not found' } });
  }
});
setInterval(() => {}, 1 << 30);
