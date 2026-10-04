import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { LettaAgent, McpApps, ToolInteractions, resolveMcpApps, type ContentSource } from 'ai-sdk-letta';
import { AppGate, ThreadRuntime, sandboxProxyHtml, startPreviewServer, type RuntimeHost } from '../src/index.js';
import { tools } from './fixtures.js';

const SERVER = join(import.meta.dirname, '..', '..', 'ai-sdk-letta', 'test', 'fixtures', 'mcp-app-server.mjs');
async function until(fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('deadline');
}

/** A runtime whose fake agent records what each turn was sent (text, reminder, sources). */
async function fixture(policies: Record<string, 'allow' | 'ask' | 'deny'> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-apps-'));
  const turns: { text: string; reminder?: string; sources?: ContentSource[] }[] = [];
  const conversations = new Map<string, UIMessage[]>();
  let current: LettaAgent<typeof tools> | undefined;
  const host: RuntimeHost = {
    async close() { current?.close(); current = undefined; },
    async open(options) {
      const conversationId = 'conversationId' in options ? options.conversationId : `conv-${randomUUID()}`;
      if (!conversations.has(conversationId)) conversations.set(conversationId, []);
      let input = '';
      const agent = current = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'agent-1', interactions: new ToolInteractions(),
        beforeTurn: turn => { turns.push({ text: '', ...(turn.sources ? { sources: turn.sources } : {}) }); },
        open: () => ({
          async send(text) { input = String(text); const last = turns.at(-1)!; last.text = input; const reminder = /<system-reminder>\n([\s\S]*?)\n<\/system-reminder>/.exec(input)?.[1]; if (reminder) last.reminder = reminder; },
          async abort() {}, close() {},
          async *stream() { yield { type: 'assistant', content: 'ok', uuid: '1' } as SDKMessage; yield { type: 'result', success: true, uuid: '2', durationMs: 1, conversationId } as SDKMessage; },
        }) });
      void input;
      return { agent, agentId: 'agent-1', conversationId, history: [] };
    },
  };
  const runtime = new ThreadRuntime(host, join(directory, 'state.json'), 'owner');
  const configs = resolveMcpApps([{ id: 'test', command: ['node'], tools: policies, origins: ['https://api.example.org'] }]);
  const apps = new McpApps(configs, { directory: join(directory, 'apps'), launcher: async () => ({ line: { command: process.execPath, args: [SERVER] }, stop: async () => {} }) });
  await apps.ready();
  const gate = new AppGate({ apps, runtime, owner: 'owner', appOrigin: () => 'http://127.0.0.1:4999', sandboxPort: () => 5999, auditFile: join(directory, 'audit.ndjson'), person: () => ({ id: 'local', name: 'You' }) });
  runtime.apps = gate;
  const thread = randomUUID();
  await runtime.create('owner', thread, 'Apps');
  // The agent calls the view tool once (as the tool bridge would), in the thread's conversation.
  const conversationId = runtime.conversationOf('owner', thread)!;
  await apps.callAsAgent('test__show', { label: 'hi' }, { conversationId, toolCallId: 'call-1' });
  // OpenAI-style IDs carry a '|'.
  await apps.callAsAgent('test__show', { label: 'openai' }, { conversationId, toolCallId: 'call_A0Td5zq|fc_05dd421' });
  return { runtime, apps, gate, thread, turns, directory, cleanup: async () => { await runtime.close(); await apps.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('instances: one origin per view, served once, CSP computed on the server', async () => {
  const f = await fixture();
  try {
    const a = await f.gate.instance('owner', f.thread, { toolCallId: 'call-1' }) as { instance: string; sandboxUrl: string; html: string; csp: { connectDomains: string[] }; result: { structuredContent: unknown }; status: string };
    const b = await f.gate.instance('owner', f.thread, { toolCallId: 'call-1', placement: 'panel' }) as { sandboxUrl: string };
    assert.match(a.sandboxUrl, /^http:\/\/s-[a-f0-9]{32}\.localhost:5999\/$/);
    assert.notEqual(new URL(a.sandboxUrl).host, new URL(b.sandboxUrl).host, 'every instance is its own origin');
    assert.match(a.html, /view/);
    assert.deepEqual(a.csp.connectDomains, ['https://api.example.org'], 'declared and approved only');
    assert.equal(a.status, 'done');
    assert.deepEqual(a.result.structuredContent, { label: 'hi', big: '' }, 'the full result, restored from the record');
    const token = /s-([a-f0-9]{32})/.exec(a.sandboxUrl)![1]!;
    const page = f.gate.sandboxPage(token);
    assert.equal(page.status, 200);
    if (page.status === 200) {
      assert.match(page.csp, /connect-src https:\/\/api\.example\.org;/);
      assert.doesNotMatch(page.csp, /evil|unsafe-eval|cdn\.example\.org/);
      assert.match(page.csp, /frame-ancestors http:\/\/127\.0\.0\.1:4999/);
      assert.match(page.html, /const HOST = "http:\/\/127\.0\.0\.1:4999"/);
    }
    assert.equal(f.gate.sandboxPage(token).status, 410, 'single use');
    assert.equal(f.gate.sandboxPage('0'.repeat(32)).status, 404);
    const openai = await f.gate.instance('owner', f.thread, { toolCallId: 'call_A0Td5zq|fc_05dd421' }) as { result: { structuredContent: { label: string } } };
    assert.equal(openai.result.structuredContent.label, 'openai');
    await assert.rejects(f.gate.instance('owner', f.thread, { toolCallId: '../x' }), /invalid_input/);
    // Another thread, or another owner, cannot mint a view of this call.
    const other = randomUUID(); await f.runtime.create('owner', other, 'Other');
    assert.deepEqual(await f.gate.instance('owner', other, { toolCallId: 'call-1' }), { status: 'none' }, 'nothing minted for a call of another thread');
    await assert.rejects(f.gate.instance('intruder', f.thread, { toolCallId: 'call-1' }), /forbidden/);
  } finally { await f.cleanup(); }
});

test('sandbox listener: s-<token>.localhost serves the proxy page once with its CSP; everything else 404', async () => {
  const f = await fixture();
  let port = 0;
  const preview = await startPreviewServer({ port: 0, ipv6: false, frameAncestors: () => ['http://127.0.0.1:4999'], resolve: () => undefined, sandbox: token => f.gate.sandboxPage(token) });
  port = preview.port;
  const get = (host: string, path = '/') => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, res => { let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body })); });
    req.on('error', reject); req.end();
  });
  try {
    const minted = await f.gate.instance('owner', f.thread, { toolCallId: 'call-1' }) as { sandboxUrl: string };
    const host = new URL(minted.sandboxUrl).host.replace(/:\d+$/, `:${port}`);
    // The gate built the URL with its own port; serve it on this listener.
    const first = await get(host);
    assert.equal(first.status, 200);
    assert.match(String(first.headers['content-security-policy']), /default-src 'none'.*connect-src https:\/\/api\.example\.org/);
    assert.match(String(first.headers['permissions-policy']), /camera=\(\)/);
    assert.match(first.body, /sandbox-proxy-ready/);
    assert.equal((await get(host)).status, 410);
    assert.equal((await get(host.replace(/s-[a-f0-9]{32}/, `s-${'1'.repeat(32)}`))).status, 404);
    assert.equal((await get(host, '/api/v1/threads')).status, 404, 'only the page itself');
    assert.equal((await get(`s-${'2'.repeat(32)}.localhost:1`)).status, 404, 'wrong port in Host');
  } finally { preview.close(); await f.cleanup(); }
});

test('gate: model-only and hidden tools refused, deny refused, unknown refused (each audited)', async () => {
  const f = await fixture({ plain: 'deny', show: 'allow' });
  try {
    const { instance } = await f.gate.instance('owner', f.thread, { toolCallId: 'call-1' }) as { instance: string };
    for (const [name, pattern] of [['secret', /not available to apps/], ['nobody', /not available to apps/], ['plain', /policy/], ['missing', /Unknown tool/]] as const) {
      const refused = await f.gate.call('owner', instance, { name, arguments: {} });
      assert.ok('error' in refused && pattern.test(refused.error.message), name);
    }
    assert.equal(f.gate.pending('owner', f.thread).length, 0, 'nothing asked for refused calls');
    const allowed = await f.gate.call('owner', instance, { name: 'show', arguments: { label: 'again' } });
    assert.ok('result' in allowed && (allowed.result.structuredContent as { label: string }).label === 'again');
    const outcomes = f.gate.recent.filter(e => e.event === 'app_call').map(e => e.outcome);
    assert.deepEqual(outcomes, ['refused:not_app_visible', 'refused:not_app_visible', 'refused:policy_deny', 'refused:unknown_tool', 'ok']);
  } finally { await f.cleanup(); }
});

test('gate: the default policy is ask; an approval is decided once, out of any turn, and the call runs only when allowed', async () => {
  const f = await fixture({ plain: 'deny' });
  try {
    const { instance } = await f.gate.instance('owner', f.thread, { toolCallId: 'call-1' }) as { instance: string };
    const asked = await f.gate.call('owner', instance, { name: 'record', arguments: { note: 'one' } });
    assert.ok('pending' in asked);
    const pending = f.gate.pending('owner', f.thread);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, 'call');
    assert.equal(pending[0]!.tool, 'record');
    assert.equal(pending[0]!.toolCallId, 'call-1', 'linked to the tool call whose view asked');
    // Deny: the tool never runs.
    await f.gate.decide('owner', (asked as { pending: string }).pending, { approved: false });
    const outcome = await f.gate.approval('owner', (asked as { pending: string }).pending);
    assert.equal(outcome.status, 'denied');
    await assert.rejects(f.gate.decide('owner', (asked as { pending: string }).pending, { approved: true }), /already_decided/);
    // Approve: it runs once, the result is kept for the view.
    const again = await f.gate.call('owner', instance, { name: 'record', arguments: { note: 'two' } }) as { pending: string };
    const waiting = f.gate.approval('owner', again.pending, true);
    await f.gate.decide('owner', again.pending, { approved: true });
    const done = await waiting;
    assert.equal(done.status, 'done');
    assert.deepEqual(done.result?.structuredContent, { count: 1 }, 'the denied call never ran');
    // Every decision is audited: the person, via the app, the originating tool call.
    const audit = readFileSync(join(f.directory, 'audit.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; outcome?: string; via: string; actor: { kind: string; id: string }; toolCallId: string });
    const calls = audit.filter(e => e.event === 'app_call');
    assert.deepEqual(calls.map(e => e.outcome), ['asked', 'denied', 'asked', 'approved', 'ok']);
    assert.ok(calls.every(e => e.via === 'app:test' && e.actor.kind === 'person' && e.actor.id === 'local' && e.toolCallId === 'call-1'));
    // Another owner can neither see nor decide it.
    await assert.rejects(f.gate.decide('intruder', again.pending, { approved: true }), /not_found/);
    // Torn down: the instance accepts nothing more.
    f.gate.closeInstance('owner', instance);
    await assert.rejects(f.gate.call('owner', instance, { name: 'record', arguments: {} }), /not_found/);
  } finally { await f.cleanup(); }
});

test('gate: allow-policy tools run at once; resources/read is limited to ui:// of the same app', async () => {
  const f = await fixture({ record: 'allow' });
  try {
    const { instance } = await f.gate.instance('owner', f.thread, { toolCallId: 'call-1' }) as { instance: string };
    const ran = await f.gate.call('owner', instance, { name: 'record', arguments: { note: 'x' } });
    assert.ok('result' in ran);
    const bad = await f.gate.read('owner', instance, { uri: 'file:///etc/passwd' });
    assert.ok('error' in bad);
    const ok = await f.gate.read('owner', instance, { uri: 'ui://test/view.html' });
    assert.ok('result' in ok);
  } finally { await f.cleanup(); }
});

test('ui/message: always asks; allowed, it becomes a user turn from the app (untrusted); denied, nothing is sent', async () => {
  const f = await fixture();
  try {
    const { instance } = await f.gate.instance('owner', f.thread, { toolCallId: 'call-1' }) as { instance: string };
    const invalid = f.gate.message('owner', instance, { role: 'assistant', content: [{ type: 'text', text: 'x' }] });
    assert.ok('error' in invalid);
    const denied = f.gate.message('owner', instance, { role: 'user', content: [{ type: 'text', text: 'Do not send' }] }) as { pending: string };
    await f.gate.decide('owner', denied.pending, { approved: false });
    assert.equal(f.turns.length, 0);
    const asked = f.gate.message('owner', instance, { role: 'user', content: [{ type: 'text', text: 'Hello from the app' }] }) as { pending: string };
    assert.equal(f.gate.pending('owner', f.thread)[0]!.kind, 'message');
    const decided = await f.gate.decide('owner', asked.pending, { approved: true });
    assert.equal(decided.status, 'done');
    await until(() => f.turns.length === 1 && f.turns[0]!.text.includes('Hello from the app'));
    assert.match(f.turns[0]!.reminder ?? '', /sent by the MCP App "Test App"/);
    assert.match(f.turns[0]!.reminder ?? '', /untrusted/);
    assert.ok(f.turns[0]!.sources?.some(s => s.kind === 'app' && s.label === 'app:test (message)'));
    // The turn is tagged with the app (history shows the "App" badge).
    const latest = f.runtime.latestRun('owner', f.thread)!;
    const run = f.runtime.runRecord('owner', latest.id)!;
    assert.equal(run.app?.id, 'test');
    assert.equal(run.app?.toolCallId, 'call-1');
    assert.equal(run.app?.approvedBy.name, 'You');
  } finally { await f.cleanup(); }
});

test('ui/update-model-context: asks on first use, keeps the latest value per view, reaches the next turn once (untrusted)', async () => {
  const f = await fixture();
  try {
    const { instance } = await f.gate.instance('owner', f.thread, { toolCallId: 'call-1' }) as { instance: string };
    const first = f.gate.context('owner', instance, { content: [{ type: 'text', text: 'v1' }] }) as { pending: string };
    // A newer value replaces the pending one.
    const second = f.gate.context('owner', instance, { content: [{ type: 'text', text: 'v2' }] }) as { pending: string };
    assert.equal(first.pending, second.pending);
    await f.gate.decide('owner', first.pending, { approved: true });
    // Later updates replace it without asking.
    const third = f.gate.context('owner', instance, { content: [{ type: 'text', text: 'v3' }], structuredContent: { selected: 3 } });
    assert.ok('result' in third);
    assert.equal(f.gate.waitingContext('owner', f.thread)[0]!.text, 'v3\n{"selected":3}');
    await f.runtime.start('owner', { id: randomUUID(), threadId: f.thread, text: 'next', parentRunId: null });
    await until(() => f.turns.length === 1 && f.turns[0]!.text.includes('next'));
    assert.match(f.turns[0]!.reminder ?? '', /\[Test App\] v3/);
    assert.doesNotMatch(f.turns[0]!.reminder ?? '', /v1|v2/);
    assert.ok(f.turns[0]!.sources?.some(s => s.kind === 'app'));
    assert.deepEqual(f.gate.waitingContext('owner', f.thread), [], 'consumed');
  } finally { await f.cleanup(); }
});

test('sandbox proxy page: talks to the app origin only, forwards nothing but JSON-RPC, loads the view once', () => {
  const html = sandboxProxyHtml('http://127.0.0.1:4400');
  assert.match(html, /if \(event\.origin !== HOST\) return;/);
  assert.match(html, /if \(loaded\) return;/);
  assert.match(html, /window\.parent\.postMessage\(event\.data, HOST\)/);
  assert.match(html, /startsWith\('ui\/notifications\/sandbox-'\)\) return;/);
  assert.doesNotMatch(html, /postMessage\([^)]*'\*'\)/, 'never to any origin');
  assert.throws(() => sandboxProxyHtml('javascript:alert(1)'), /invalid_host_origin/);
});
