import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_APP_DEV_TOOL_NAMES, MCP_APP_DEV_TOOL_PERMISSIONS, MCP_APPS_CONTEXT, McpApps, SandboxManager, WEBDEV_CONTEXT, WEBDEV_IMAGE, WEBDEV_TOOL_PERMISSIONS, WebDevServices, defineAgent, mcpAppDevEnabled, mcpAppDevTools,
  resolveSandboxConfig, resolveWebDevConfig, sandboxTools, SANDBOX_TOOL_PERMISSIONS, webDevEnabled, webDevTools,
  type CommandLine, type McpAppClient, type McpAppConnector, type McpToolDefinition, type ServicesContainer, type ServicesDriver,
} from '../src/index.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `ai-sdk-letta-${prefix}-`));
const URI = 'ui://clock/view.html';
const MIME = 'text/html;profile=mcp-app';
const HTML = `<script type="module">import { App } from '@modelcontextprotocol/ext-apps'; const app = new App({ name: 'clock', version: '1' }); await app.connect();</script>`;

/** A fake services container: folders that exist, commands run, a log file. */
function fakeDriver(folders: string[]) {
  const execs: string[][] = [];
  const lines: CommandLine[] = [];
  const driver: ServicesDriver = {
    kind: 'docker',
    async start() {
      const container: ServicesContainer = {
        name: 'svc-1',
        async exec(argv) {
          execs.push(argv);
          const script = argv.join(' ');
          if (script.includes('if [ -d "$1" ]')) return { code: 0, stdout: folders.includes(argv.at(-2)!) ? 'dir\n' : 'missing\nclock/\n', stderr: '' };
          if (argv[0] === 'tail') return { code: 0, stdout: argv.at(-1) === '/tmp/devapp-clock.log' ? 'listening on stdio\nwarning: \x1b[33myellow\x1b[0m\n' : '', stderr: '' };
          if (script.includes('alive')) return { code: 0, stdout: 'yes\n', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive: argv => { const line = { command: 'docker', args: ['exec', '-i', 'svc-1', ...argv] }; lines.push(line); return line; },
        async stop() {},
      };
      return container;
    },
  };
  return { driver, execs, lines };
}

/** A fake MCP server per launch: its tools can change between launches. */
function fakeConnector(state: { tools: McpToolDefinition[]; html: string; calls: { name: string; args: Record<string, unknown> }[] }): McpAppConnector {
  return async () => {
    const tools = state.tools.map(t => ({ ...t }));
    const html = state.html;
    const client: McpAppClient = {
      serverInfo: { name: 'clock', version: '0.0.1' },
      listTools: async () => ({ tools }),
      callTool: async (name, args) => { state.calls.push({ name, args }); return { content: [{ type: 'text', text: `It is noon (${name})` }], structuredContent: { time: '12:00', zone: args.zone ?? 'UTC' }, _meta: { 'ui/x': 1 } }; },
      readResource: async uri => ({ contents: uri === URI ? [{ uri, mimeType: MIME, text: html }] : [] }),
      listResources: async () => ({ resources: [{ uri: URI, mimeType: MIME }] }),
      close: async () => {},
    };
    return client;
  };
}
const viewTool: McpToolDefinition = { name: 'show_time', description: 'Show the time', inputSchema: { type: 'object', properties: { zone: { type: 'string' } } }, _meta: { ui: { resourceUri: URI, visibility: ['model', 'app'] } } };
const appOnly: McpToolDefinition = { name: 'refresh', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } };

function setup() {
  const workspace = tmp('mcpdev-ws');
  const manager = new SandboxManager(resolveSandboxConfig({ provider: async () => { throw new Error('no sandbox'); }, image: WEBDEV_IMAGE }), { workspace: () => workspace, folder: () => 'Chat', owner: 'agent.conv' });
  const { driver, execs, lines } = fakeDriver(['/workspace/Chat/clock']);
  const services = new WebDevServices(manager, resolveWebDevConfig({}), { driver });
  const state = { tools: [viewTool, appOnly], html: HTML, calls: [] as { name: string; args: Record<string, unknown> }[] };
  const apps = new McpApps([], { directory: join(tmp('mcpdev-state'), 'apps'), connector: fakeConnector(state) });
  const contextFor = (conversationId: string) => ({ [WEBDEV_CONTEXT]: services, [MCP_APPS_CONTEXT]: { apps, conversationId } });
  const run = async (name: keyof typeof mcpAppDevTools, input: Record<string, unknown>, context: Record<string, unknown> = contextFor('conv-a')) =>
    await mcpAppDevTools[name].execute!(input as never, { toolCallId: 'call-1', messages: [], context } as never) as { text: string; isError?: boolean };
  return { services, apps, state, execs, lines, run, contextFor };
}

test('dev tools: names, permissions (all allow)', () => {
  assert.deepEqual(Object.keys(mcpAppDevTools).sort(), [...MCP_APP_DEV_TOOL_NAMES].sort());
  for (const name of MCP_APP_DEV_TOOL_NAMES) assert.equal(MCP_APP_DEV_TOOL_PERMISSIONS[name], 'allow');
});

test('dev tools: start → tools for that conversation only, linter output, stderr to the log file', async () => {
  const { apps, run, lines } = setup();
  const started = await run('mcp_app_dev_start', { name: 'clock', cwd: 'clock', command: 'node server.js', transport: 'stdio' });
  assert.equal(started.isError, undefined, started.text);
  assert.match(started.text, /Dev app "clock" running \(generation 1\): 2 tool\(s\), 1 view\(s\)/);
  assert.match(started.text, /show_time \[visibility: model, app\] → you call it as dev_clock__show_time/);
  assert.match(started.text, /refresh \[visibility: app\] \(not model-visible/);
  assert.match(started.text, /ui:\/\/clock\/view\.html · fingerprint \S{12}/);
  assert.match(started.text, /Check: /, 'the linter ran');
  assert.match(started.text, /Folder: \/workspace\/Chat\/clock/);
  // The command line: env -i, cd into the folder, stderr appended to the log, marked.
  const line = lines.at(-1)!;
  assert.equal(line.args[0], 'exec'); assert.ok(line.args.includes('-i'));
  const argv = line.args.slice(3);
  assert.equal(argv[0], 'env'); assert.equal(argv[1], '-i');
  assert.ok(argv.includes('AI_SDK_LETTA_DEV_APP=clock'));
  assert.deepEqual(argv.slice(-4), ['sh', '/workspace/Chat/clock', 'node server.js', '/tmp/devapp-clock.log']);
  assert.match(argv.at(-5)!, /exec 2>>"\$3".*cd "\$1".*exec \/bin\/bash -c "\$2"/);
  assert.deepEqual([...apps.agentTools('conv-a').names.keys()], ['dev_clock__show_time']);
  assert.deepEqual([...apps.agentTools('conv-b').names.keys()], []);
  assert.deepEqual([...apps.agentTools().names.keys()], []);
  // Another conversation cannot take the name, nor see the app.
  const taken = await run('mcp_app_dev_start', { name: 'clock', cwd: 'clock', command: 'x', transport: 'stdio' }, setupContext(apps, 'conv-b'));
  assert.equal(taken.isError, true); assert.match(taken.text, /another conversation/);
  const foreign = await run('mcp_app_dev_call', { name: 'clock', tool: 'show_time' }, setupContext(apps, 'conv-b'));
  assert.equal(foreign.isError, true); assert.match(foreign.text, /no dev app "clock" in this conversation/);
  await apps.close();
});
// The same services, another conversation (the name check happens before the folder).
const setupContext = (apps: McpApps, conversationId: string) => ({ [WEBDEV_CONTEXT]: new WebDevServices(new SandboxManager(resolveSandboxConfig({ provider: async () => { throw new Error('no'); } }), { workspace: () => tmpdir() }), resolveWebDevConfig({}), { driver: fakeDriver([]).driver }), [MCP_APPS_CONTEXT]: { apps, conversationId } });

test('dev tools: a missing folder is refused with a listing', async () => {
  const { run, apps } = setup();
  const result = await run('mcp_app_dev_start', { name: 'clock', cwd: 'nope', command: 'node server.js', transport: 'stdio' });
  assert.equal(result.isError, true);
  assert.match(result.text, /folder \/workspace\/Chat\/nope does not exist[\s\S]*clock\//);
  assert.deepEqual(apps.devApps('conv-a'), []);
});

test('dev tools: reload reports changes; status; stop removes the tools', async () => {
  const { run, apps, state, execs } = setup();
  await run('mcp_app_dev_start', { name: 'clock', cwd: 'clock', command: 'node server.js', transport: 'stdio' });
  state.tools = [{ ...viewTool, description: 'Show the time, now with zones' }, { name: 'set_alarm', inputSchema: { type: 'object' } }];
  state.html = `${HTML}<!-- v2 -->`;
  const reloading = run('mcp_app_dev_reload', { name: 'clock' });
  assert.deepEqual(apps.devGenerations(), { dev_clock: 1 }, 'while it restarts, open views keep the previous generation');
  const reloaded = await reloading;
  assert.equal(reloaded.isError, undefined, reloaded.text);
  assert.match(reloaded.text, /generation 2/);
  assert.deepEqual(apps.devGenerations(), { dev_clock: 2 }, 'the browser remounts open views on this');
  assert.match(reloaded.text, /added set_alarm; removed refresh; changed show_time; views changed ui:\/\/clock\/view\.html/);
  assert.match(reloaded.text, /reach you at your next turn/);
  assert.deepEqual([...apps.agentTools('conv-a').names.keys()].sort(), ['dev_clock__set_alarm', 'dev_clock__show_time']);
  const status = await run('mcp_app_dev_status', {});
  assert.match(status.text, /clock: running · generation 2 since .* · \/workspace\/Chat\/clock \$ node server\.js/);
  assert.match(status.text, /tool set_alarm \[model, app\] as dev_clock__set_alarm/);
  const before = execs.length;
  const stopped = await run('mcp_app_dev_stop', { name: 'clock' });
  assert.match(stopped.text, /stopped/);
  assert.ok(execs.slice(before).some(argv => argv.join(' ').includes('AI_SDK_LETTA_DEV_APP=clock') && argv.join(' ').includes('kill')), 'its processes are killed in the container');
  assert.deepEqual([...apps.agentTools('conv-a').names.keys()], []);
  assert.match((await run('mcp_app_dev_status', {})).text, /No dev apps/);
  assert.deepEqual(apps.devGenerations(), {});
  assert.equal((await run('mcp_app_dev_reload', { name: 'clock' })).isError, true);
  await apps.close();
});

test('dev tools: call returns content, structuredContent and _meta (also app-only tools)', async () => {
  const { run, apps, state } = setup();
  await run('mcp_app_dev_start', { name: 'clock', cwd: 'clock', command: 'node server.js', transport: 'stdio' });
  const called = await run('mcp_app_dev_call', { name: 'clock', tool: 'refresh', args: { zone: 'CET' } });
  assert.equal(called.isError, undefined, called.text);
  assert.match(called.text, /It is noon \(refresh\)/);
  assert.match(called.text, /structuredContent:\n\{\n {2}"time": "12:00",\n {2}"zone": "CET"/);
  assert.match(called.text, /_meta:\n\{"ui\/x":1\}/);
  assert.deepEqual(state.calls, [{ name: 'refresh', args: { zone: 'CET' } }]);
  const unknown = await run('mcp_app_dev_call', { name: 'clock', tool: 'nope' });
  assert.equal(unknown.isError, true); assert.match(unknown.text, /tool_unknown/);
  await apps.close();
});

test('dev tools: check lists findings with rule, level and fix', async () => {
  const { run, apps, state } = setup();
  state.tools = [{ name: 'show', inputSchema: { type: 'object' }, _meta: { 'ui/resourceUri': URI } }];
  await run('mcp_app_dev_start', { name: 'clock', cwd: 'clock', command: 'node server.js', transport: 'stdio' });
  const checked = await run('mcp_app_dev_check', { name: 'clock' });
  assert.match(checked.text, /Check: \d+ error\(s\)/);
  assert.match(checked.text, /\[error\] flat-resource-uri \(tool show\): .*\n {4}fix: /);
  await apps.close();
});

test('dev tools: logs tail the dev app\'s stderr file', async () => {
  const { run, apps, execs } = setup();
  await run('mcp_app_dev_start', { name: 'clock', cwd: 'clock', command: 'node server.js', transport: 'stdio' });
  const logs = await run('mcp_app_dev_logs', { name: 'clock', lines: 10 });
  assert.match(logs.text, /The dev app "clock" server is running\.\nstderr \(\/tmp\/devapp-clock\.log\):\nlistening on stdio\nwarning: yellow/);
  assert.ok(execs.some(argv => argv[0] === 'tail' && argv[2] === '10' && argv[3] === '/tmp/devapp-clock.log'));
  await apps.close();
});

test('dev tools: unavailable without web development or MCP Apps, or for a failed server', async () => {
  const { run, contextFor, apps } = setup();
  const noWebDev = await run('mcp_app_dev_start', { name: 'clock', command: 'x' }, { [MCP_APPS_CONTEXT]: contextFor('conv-a')[MCP_APPS_CONTEXT] });
  assert.equal(noWebDev.isError, true); assert.match(noWebDev.text, /sandbox_unavailable/);
  const noApps = await run('mcp_app_dev_status', {}, { [WEBDEV_CONTEXT]: contextFor('conv-a')[WEBDEV_CONTEXT] });
  assert.equal(noApps.isError, true); assert.match(noApps.text, /app_unavailable/);
  assert.match((await run('mcp_app_dev_start', { name: 'Bad Name', command: 'x' })).text, /dev app name/);
  // A server that does not speak MCP: the start fails with the error, nothing joins the tools.
  const failing = new McpApps([], { directory: join(tmp('mcpdev-state'), 'apps'), connector: async () => { throw new Error('Connection closed'); } });
  const failed = await run('mcp_app_dev_start', { name: 'clock', cwd: 'clock', command: 'echo hi', transport: 'stdio' }, { [WEBDEV_CONTEXT]: contextFor('conv-a')[WEBDEV_CONTEXT], [MCP_APPS_CONTEXT]: { apps: failing, conversationId: 'conv-a' } });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /did not start \(generation 1\): Connection closed[\s\S]*mcp_app_dev_logs/);
  assert.deepEqual([...failing.agentTools('conv-a').names.keys()], []);
  await failing.close(); await apps.close();
});

test('definition: dev mode needs webDevTools and a built-in sandbox; enables apps', () => {
  const base = { id: 'dev-agent', name: 'Dev', model: 'openai/gpt-test', instructions: 'x' };
  assert.throws(() => defineAgent({ ...base, tools: { ...sandboxTools, ...mcpAppDevTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS, ...MCP_APP_DEV_TOOL_PERMISSIONS }, sandbox: { provider: 'docker' } }), /need webDevTools/);
  const definition = defineAgent({ ...base, tools: { ...sandboxTools, ...webDevTools, ...mcpAppDevTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS, ...WEBDEV_TOOL_PERMISSIONS, ...MCP_APP_DEV_TOOL_PERMISSIONS }, sandbox: { provider: 'docker' } });
  assert.equal(mcpAppDevEnabled(definition, webDevEnabled(definition)), true);
  assert.equal(definition.mcpApps, undefined, 'no installed apps');
  const withoutDev = defineAgent({ ...base, tools: { ...sandboxTools, ...webDevTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS, ...WEBDEV_TOOL_PERMISSIONS }, sandbox: { provider: 'docker' } });
  assert.equal(mcpAppDevEnabled(withoutDev, webDevEnabled(withoutDev)), false);
});

test('mcp_app_guide: bounded, attributed, the object form of callServerTool, and each dev tool points to it', async () => {
  const { run, apps } = setup();
  const guide = await run('mcp_app_guide', {});
  assert.equal(guide.isError, undefined);
  assert.ok(guide.text.length < 7000, `about 1.5k tokens (${guide.text.length} chars)`);
  for (const needle of ['create-mcp-app', 'Apache-2.0', 'CC-BY-4.0', '@modelcontextprotocol/ext-apps@2.0.3', 'registerAppTool', 'registerAppResource', '_meta: { ui: { resourceUri', 'text/html;profile=mcp-app', 'new App(', 'app.connect()', "callServerTool({ name: 'add_note', arguments:", 'run_command_online', 'mcp_app_dev_reload']) assert.ok(guide.text.includes(needle), needle);
  assert.equal(MCP_APP_DEV_TOOL_PERMISSIONS.mcp_app_guide, 'allow');
  assert.match((mcpAppDevTools.mcp_app_dev_start as { description: string }).description, /mcp_app_guide/);
  await apps.close();
});

test('dev apps: calls from their views run without asking by default; asking can be turned back on per conversation (kept)', async () => {
  const { run, apps } = setup();
  await run('mcp_app_dev_start', { name: 'clock', cwd: 'clock', command: 'node server.js', transport: 'stdio' });
  assert.equal(apps.policy('dev_clock', 'refresh'), 'allow', 'the agent\'s own code: runs, like run_command');
  assert.equal(apps.policy('dev_clock', 'show_time', 'agent'), 'allow');
  apps.setDevViewsAsk('dev_clock', true);
  assert.equal(apps.policy('dev_clock', 'refresh'), 'ask', 'back to asking');
  assert.equal(apps.policy('dev_clock', 'show_time', 'agent'), 'allow', 'the agent\'s calls are unchanged');
  assert.equal(apps.status().find(a => a.id === 'dev_clock')!.viewsAsk, true);
  apps.setDevViewsAsk('dev_clock', false);
  assert.equal(apps.policy('dev_clock', 'refresh'), 'allow');
  assert.equal(apps.status().find(a => a.id === 'dev_clock')!.viewsAsk, undefined);
  assert.throws(() => apps.grant('dev_clock', 'refresh'), 'dev apps have no grants (no "Allow always")');
  assert.throws(() => apps.setDevViewsAsk('nope', true));
  await apps.close();
});
