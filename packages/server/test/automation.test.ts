import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { tool, jsonSchema } from 'ai';
import { LettaAgent, ToolInteractions, askUserTool, createToolBridge, type UnattendedPolicy } from 'ai-sdk-letta';
import {
  AutomationService, AutomationStore, automationApp, createToken, revokeToken, tokenSummary, listenAutomation, guiApp, teamApp, TeamDirectory, ThreadRuntime, AUTOMATION_LIMITS, cronAt, n8nOrchestrator, conductorOrchestrator,
  type AutomationAgent, type Orchestrator, type OrchestratorJob, type RuntimeHost, type RunAuthor, type TeamAgent,
} from '../src/index.js';

/* ------------------------------------------------------------------ */
/* Fixture: a host whose scripted agent calls tools through the real    */
/* tool bridge, so unattended refusals run the actual policy            */
/* ------------------------------------------------------------------ */

const tools = {
  ask_user: askUserTool,
  text_stats: tool({ inputSchema: jsonSchema<{ text: string }>({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }), execute: async ({ text }) => ({ words: text.split(/\s+/).length }) }),
  publish: tool({ inputSchema: jsonSchema<{ what: string }>({ type: 'object', properties: { what: { type: 'string' } }, required: ['what'] }), execute: async ({ what }) => { executions.push(what); return { published: what }; } }),
};
const permissions = { ask_user: 'allow', text_stats: 'allow', publish: 'ask' } as const;
let executions: string[] = [];

type Sent = { conversationId: string; text: string; unattended?: UnattendedPolicy; actor?: string };
function fixture(options: { parallel?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-automation-'));
  const conversations = new Map<string, UIMessage[]>();
  const sent: Sent[] = [];
  const gates: (() => void)[] = [];
  let prompts = 0;
  let current: LettaAgent<typeof tools> | undefined;
  const host: RuntimeHost = {
    ...(options.parallel ? { parallel: true } : {}),
    async close() { if (!options.parallel) { current?.close(); current = undefined; } },
    async open(target) {
      const conversationId = 'conversationId' in target ? target.conversationId : `local-conv-${randomUUID()}`;
      if (!conversations.has(conversationId)) conversations.set(conversationId, []);
      const history = conversations.get(conversationId)!;
      // The runtime connects its own renderer to the broker; prompts are counted on the way.
      const interactions = new ToolInteractions();
      const counted = { request: (...args: Parameters<ToolInteractions['request']>) => { prompts++; return interactions.request(...args); } } as unknown as ToolInteractions;
      let unattended: UnattendedPolicy | undefined;
      let input = '';
      const bridge = createToolBridge({ tools, permissions, interactions: counted, unattended: () => unattended });
      const agent = current = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'agent-local-automation', interactions, ...(options.parallel ? { listening: true, name: 'Desk' } : {}),
        open: (signal, turn) => {
          unattended = turn.unattended;
          return {
            async send(message: SendMessage, sendOptions?: { otid?: string }) {
              const full = typeof message === 'string' ? message : message.map(item => item.type === 'text' ? item.text : '').join('');
              // The scripted agent reacts to the message only, never to the notes before it.
              input = full.replace(/^(<system-reminder>[\s\S]*?<\/system-reminder>\n)+/, '');
              sent.push({ conversationId, text: full, ...(turn.unattended ? { unattended: turn.unattended } : {}), ...(turn.actor ? { actor: turn.actor.id } : {}) });
              history.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: input }], metadata: { otid: sendOptions?.otid } });
            },
            async abort() {}, close() {},
            async *stream() {
              if (input.includes('hold')) await new Promise<void>(resolve => { gates.push(resolve); signal.addEventListener('abort', () => resolve(), { once: true }); });
              signal.throwIfAborted();
              for (const [word, name, args] of [['publish', 'publish', { what: 'report' }], ['question', 'ask_user', { question: 'Which one?', allowFreeText: true }]] as const) {
                if (!input.includes(word)) continue;
                const id = `call-${randomUUID()}`;
                yield { type: 'tool_call', toolCallId: id, toolName: name, toolInput: args, uuid: `${id}-a` } as SDKMessage;
                const result = await bridge.execute(name, id, args, signal);
                yield { type: 'tool_result', toolCallId: id, content: result.content[0]!.text!, isError: result.isError, uuid: `${id}-b` } as SDKMessage;
                if (result.isError) {
                  // The agent follows the tool's instruction: it ends the turn with one sentence.
                  yield { type: 'assistant', content: `I could not ${name} without a person.`, uuid: `${id}-c` } as SDKMessage;
                  history.push({ id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: `I could not ${name} without a person.` }] });
                  yield { type: 'result', success: true, uuid: `${id}-d`, durationMs: 1, conversationId } as SDKMessage;
                  return;
                }
              }
              const reply = `Done: ${input.slice(0, 40)}`;
              yield { type: 'assistant', content: reply, uuid: 'r1' } as SDKMessage;
              history.push({ id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: reply }] });
              yield { type: 'result', success: true, uuid: 'r2', durationMs: 1, conversationId } as SDKMessage;
            },
          };
        } });
      return { agent, agentId: 'agent-local-automation', conversationId, history: structuredClone(history), ...(options.parallel ? { reload: async () => structuredClone(history), close: async () => { agent.close(); } } : {}) };
    },
  };
  const runtime = options.parallel
    ? new ThreadRuntime(host, join(directory, 'state.json'), 'team', { queue: true, parallel: true, replyMode: 'auto', agentName: 'Desk', members: () => 2 })
    : new ThreadRuntime(host, join(directory, 'state.json'), 'owner');
  const store = new AutomationStore(join(directory, 'automation.json'));
  const agent: AutomationAgent = { id: 'desk', name: 'Desk', runtime, owner: options.parallel ? 'team' : 'owner', store, preApprovable: ['publish'], replyModes: !!options.parallel };
  return { directory, runtime, store, agent, sent, gates, prompts: () => prompts, release: () => gates.shift()?.(),
    cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean | Promise<boolean>, label = 'condition') {
  for (let i = 0; i < 600; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Fixture deadline: ${label}`);
}
async function serve(app: ReturnType<typeof automationApp>) {
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
const local = { id: 'local', name: 'You' };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(url: string, path: string, secret: string | undefined, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${url}${path}`, { method: init.method ?? (init.body ? 'POST' : 'GET'), headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
  return { status: response.status, body: await response.json() as Json };
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

test('tokens: the secret is shown once and stored only as a hash (0600); revoked tokens stop working', async () => {
  const f = fixture();
  try {
    const { token, secret } = createToken(f.store, { name: ' Nightly  report ', via: 'n8n', preApproved: ['publish'] }, { actor: local, createdBy: local, preApprovable: ['publish'] });
    assert.match(secret, /^lta_[A-Za-z0-9_-]{43}$/);
    assert.equal(token.name, 'Nightly report');
    const file = readFileSync(f.store.filename, 'utf8');
    assert.equal(file.includes(secret), false, 'the secret is never stored');
    assert.equal(file.includes(secret.slice(4, 20)), false);
    assert.equal(statSync(f.store.filename).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(tokenSummary(token)).includes('hash'), false);
    assert.equal(tokenSummary(token).hint, `…${secret.slice(-4)}`);
    const service = new AutomationService({ agents: [f.agent] });
    assert.equal(service.authenticate(secret)?.token.id, token.id);
    assert.equal(service.authenticate(`${secret}x`), undefined);
    assert.equal(service.authenticate(secret.replace(/.$/, c => c === 'A' ? 'B' : 'A')), undefined);
    assert.equal(service.authenticate(undefined), undefined);
    // Only tools that can ask may be pre-approved; unknown via or names are refused.
    for (const input of [{ name: 'x', preApproved: ['text_stats'] }, { name: 'x', preApproved: ['ask_user'] }, { name: '', via: 'api' }, { name: 'x', via: 'zapier' }, { name: 'x', replyMode: 'sometimes' }]) {
      assert.throws(() => createToken(f.store, input, { actor: local, createdBy: local, preApprovable: ['publish'] }), /invalid_input/, JSON.stringify(input));
    }
    assert.equal(revokeToken(f.store, token.id), true);
    assert.equal(service.authenticate(secret), undefined);
    assert.equal(revokeToken(f.store, token.id), false);
  } finally { await f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

test('run API: authenticated, browser requests refused, idempotent on retries, waits, reuses a conversation by title', async () => {
  const f = fixture();
  const service = new AutomationService({ agents: [f.agent] });
  const http = await serve(automationApp(service));
  try {
    const { secret } = createToken(f.store, { name: 'Daily digest', via: 'n8n' }, { actor: local, createdBy: local, preApprovable: ['publish'] });
    assert.equal((await call(http.url, '/v1/automation/whoami', undefined)).status, 401);
    assert.equal((await call(http.url, '/v1/automation/whoami', 'lta_wrong')).status, 401);
    assert.equal((await call(http.url, '/v1/automation/whoami', secret, { headers: { Origin: 'http://127.0.0.1:4400' } })).status, 403, 'never from a browser page');
    assert.equal((await call(http.url, '/v1/automation/whoami', secret, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await call(http.url, '/v1/automation/whoami', secret, { headers: { 'Tailscale-Funnel-Request': '?1' } })).status, 403);
    const me = await call(http.url, '/v1/automation/whoami', secret);
    assert.equal(me.body.agent.id, 'desk'); assert.equal(me.body.token.name, 'Daily digest'); assert.equal(JSON.stringify(me.body).includes(secret), false);
    assert.equal((await call(http.url, '/v1/automation/runs', secret, { body: { text: 'hello' } })).body.error, 'idempotency_key_required');
    assert.equal((await call(http.url, '/v1/automation/runs', secret, { body: { text: 'hello', idempotencyKey: 'k1', unknown: 1 } })).status, 400);
    const first = await call(http.url, '/v1/automation/runs?wait=10', secret, { body: { text: 'Summarise the day', idempotencyKey: 'run-2026-10-02' } });
    assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.status, 'completed', JSON.stringify(first.body)); assert.equal(first.body.text, 'Done: Summarise the day');
    assert.equal(first.body.conversation.title, 'Daily digest', 'the token name titles its conversation by default');
    assert.deepEqual(first.body.source, { via: 'n8n', name: 'Daily digest' });
    assert.ok(first.body.startedAt && first.body.endedAt);
    // The orchestrator retries the same request: the same run, nothing sent twice.
    const retry = await call(http.url, '/v1/automation/runs?wait=10', secret, { body: { text: 'Summarise the day', idempotencyKey: 'run-2026-10-02' } });
    assert.equal(retry.body.id, first.body.id);
    assert.equal(f.sent.length, 1);
    assert.equal((await call(http.url, '/v1/automation/runs', secret, { body: { text: 'Something else', idempotencyKey: 'run-2026-10-02' } })).status, 409);
    // The Idempotency-Key header works too; the same title reuses the conversation.
    const second = await call(http.url, '/v1/automation/runs?wait=10', secret, { body: { text: 'And tomorrow?' }, headers: { 'Idempotency-Key': 'run-2' } });
    assert.equal(second.body.conversation.id, first.body.conversation.id);
    const fresh = await call(http.url, '/v1/automation/runs?wait=10', secret, { body: { text: 'Fresh', idempotencyKey: 'run-3', newConversation: true, title: 'Fresh start' } });
    assert.notEqual(fresh.body.conversation.id, first.body.conversation.id); assert.equal(fresh.body.conversation.title, 'Fresh start');
    const into = await call(http.url, '/v1/automation/runs?wait=10', secret, { body: { text: 'Continue', idempotencyKey: 'run-4', threadId: fresh.body.conversation.id } });
    assert.equal(into.body.conversation.id, fresh.body.conversation.id); assert.equal(into.body.status, 'completed');
    assert.equal((await call(http.url, '/v1/automation/runs', secret, { body: { text: 'x', idempotencyKey: 'run-5', threadId: randomUUID() } })).status, 404);
    // Poll by ID; another token cannot see it.
    const polled = await call(http.url, `/v1/automation/runs/${first.body.id}`, secret);
    assert.equal(polled.body.status, 'completed');
    const other = createToken(f.store, { name: 'Other' }, { actor: local, createdBy: local, preApprovable: [] });
    assert.equal((await call(http.url, `/v1/automation/runs/${first.body.id}`, other.secret)).status, 404);
    // The turns are ordinary turns of the conversation, marked with their source.
    const history = await f.runtime.history('owner', first.body.conversation.id);
    assert.deepEqual(history.messages.filter(m => m.role === 'user').map(m => (m.metadata as { source?: unknown }).source), [{ kind: 'automation', via: 'n8n', name: 'Daily digest' }, { kind: 'automation', via: 'n8n', name: 'Daily digest' }]);
    assert.equal(JSON.stringify(f.runtime.list('owner')).includes('tokenId'), false);
  } finally { await http.close(); await f.cleanup(); }
});

test('unattended: an approval fails the run with approval_required, the tool never runs, and the conversation stays usable', async () => {
  executions = [];
  const f = fixture();
  const service = new AutomationService({ agents: [f.agent] });
  const http = await serve(automationApp(service));
  try {
    const { secret } = createToken(f.store, { name: 'Publisher' }, { actor: local, createdBy: local, preApprovable: ['publish'] });
    const run = await call(http.url, '/v1/automation/runs?wait=10', secret, { body: { text: 'Please publish the report', idempotencyKey: 'p1' } });
    assert.equal(run.status, 200);
    assert.equal(run.body.status, 'failed');
    assert.equal(run.body.error.code, 'approval_required'); assert.equal(run.body.error.tool, 'publish');
    assert.match(run.body.error.message, /^publish needs approval/);
    assert.deepEqual(run.body.tools, [{ name: 'publish', status: 'failed', reason: 'approval_required' }]);
    assert.equal(run.body.text, 'I could not publish without a person.');
    assert.deepEqual(executions, [], 'the tool never ran'); assert.equal(f.prompts(), 0, 'nobody was asked');
    assert.equal(f.sent[0]!.unattended?.preApproved.length, 0);
    assert.match(f.sent[0]!.text, /^<system-reminder>\nThis turn was started by an automation \(api\)/);
    // The turn itself ended cleanly: the conversation is not blocked, in the app or for the next run.
    const view = await f.runtime.view('owner', run.body.conversation.id);
    assert.equal(view.status, 'completed');
    const next = await call(http.url, '/v1/automation/runs?wait=10', secret, { body: { text: 'Just say hi', idempotencyKey: 'p2', threadId: run.body.conversation.id } });
    assert.equal(next.body.status, 'completed');
    // A question fails the same way.
    const asked = await call(http.url, '/v1/automation/runs?wait=10', secret, { body: { text: 'Ask me a question', idempotencyKey: 'p3' } });
    assert.equal(asked.body.error.code, 'question_required'); assert.equal(asked.body.error.tool, 'ask_user');
    assert.equal(f.prompts(), 0);
    // A token with the tool pre-approved runs it, still without asking anyone.
    const trusted = createToken(f.store, { name: 'Trusted publisher', preApproved: ['publish'] }, { actor: local, createdBy: local, preApprovable: ['publish'] });
    const done = await call(http.url, '/v1/automation/runs?wait=10', trusted.secret, { body: { text: 'Please publish the report', idempotencyKey: 'p4' } });
    assert.equal(done.body.status, 'completed'); assert.deepEqual(done.body.tools, [{ name: 'publish', status: 'completed' }]);
    assert.deepEqual(executions, ['report']); assert.equal(f.prompts(), 0);
    // A turn from the app is attended as before: it asks.
    const thread = randomUUID();
    await f.runtime.create('owner', thread, 'Manual');
    const manual = { id: randomUUID(), threadId: thread, text: 'publish please', parentRunId: null };
    await f.runtime.start('owner', manual);
    await until(() => f.runtime.events('owner', manual.id, 0).events.some(e => e.type === 'interaction'), 'prompt');
    const prompt = f.runtime.events('owner', manual.id, 0).events.find(e => e.type === 'interaction')!.data as { id: string };
    f.runtime.answer('owner', manual.id, { id: prompt.id, approved: true });
    await until(() => f.runtime.events('owner', manual.id, 0).status === 'completed');
    assert.equal(f.prompts(), 1); assert.deepEqual(executions, ['report', 'report']);
  } finally { await http.close(); await f.cleanup(); }
});

test('wait, poll and cancel; a run waits for a busy single-user runtime; rate and concurrency limits', async () => {
  const f = fixture();
  const service = new AutomationService({ agents: [f.agent] });
  const http = await serve(automationApp(service));
  try {
    const { secret } = createToken(f.store, { name: 'Holder' }, { actor: local, createdBy: local, preApprovable: [] });
    // A turn from the app is running: the automation's run waits (queued), then is sent after it.
    const thread = randomUUID();
    await f.runtime.create('owner', thread, 'Manual');
    const manual = { id: randomUUID(), threadId: thread, text: 'hold on', parentRunId: null };
    await f.runtime.start('owner', manual);
    await until(() => f.gates.length === 1, 'manual holds');
    const queued = await call(http.url, '/v1/automation/runs?wait=0.3', secret, { body: { text: 'After that', idempotencyKey: 'q1', threadId: thread } });
    assert.equal(queued.status, 202); assert.equal(queued.body.status, 'queued');
    f.release();
    const done = await call(http.url, `/v1/automation/runs/${queued.body.id}?wait=10`, secret);
    assert.equal(done.body.status, 'completed');
    assert.deepEqual(f.sent.map(s => s.text.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\n/, '')), ['hold on', 'After that']);
    // Cancel a running turn.
    const held = await call(http.url, '/v1/automation/runs', secret, { body: { text: 'hold this', idempotencyKey: 'c1' } });
    await until(() => f.gates.length === 1, 'run holds');
    // The second concurrent run of this token is allowed; a third is refused.
    const second = await call(http.url, '/v1/automation/runs', secret, { body: { text: 'second', idempotencyKey: 'c2' } });
    assert.equal(second.status, 202);
    const third = await call(http.url, '/v1/automation/runs', secret, { body: { text: 'third', idempotencyKey: 'c3' } });
    assert.equal(third.status, 429); assert.equal(third.body.error, 'concurrency_limit');
    assert.equal((await call(http.url, `/v1/automation/runs/${held.body.id}/cancel`, secret, { body: {} })).body.accepted, true);
    const cancelled = await call(http.url, `/v1/automation/runs/${held.body.id}?wait=10`, secret);
    assert.equal(cancelled.body.status, 'cancelled');
    // The waiting one can be withdrawn too (it never reaches the agent).
    await call(http.url, `/v1/automation/runs/${second.body.id}/cancel`, secret, { body: {} });
    assert.equal((await call(http.url, `/v1/automation/runs/${second.body.id}?wait=10`, secret)).body.status, 'cancelled');
    assert.equal(f.sent.some(s => s.text.endsWith('second')), false);
    // Rate limit: at most runsPerMinute new runs per token (5 started above).
    const results: number[] = [];
    for (let i = 0; i < AUTOMATION_LIMITS.runsPerMinute; i++) results.push((await call(http.url, '/v1/automation/runs', secret, { body: { text: `r${i}`, idempotencyKey: `r${i}`, newConversation: true } })).status);
    await until(async () => (await call(http.url, '/v1/automation/runs', secret)).body.runs.every((r: Json) => !['queued', 'running'].includes(r.status)), 'runs settle');
    assert.ok(results.includes(429), `rate limited: ${results.join(',')}`);
    // Failed sign-ins from one address are limited.
    let refused = 0;
    for (let i = 0; i < AUTOMATION_LIMITS.failedAuthPer5Minutes + 2; i++) if ((await call(http.url, '/v1/automation/whoami', 'lta_nope')).status === 429) refused++;
    assert.ok(refused >= 1);
    assert.equal((await call(http.url, '/v1/automation/whoami', secret)).status, 429, 'an address that keeps failing is held back for a while');
  } finally { await http.close(); await f.cleanup(); }
});

test('the API never listens on all interfaces', async () => {
  const f = fixture();
  try {
    const service = new AutomationService({ agents: [f.agent] });
    await assert.rejects(listenAutomation(service, { port: 0, host: '0.0.0.0' }), /never listens on all interfaces/);
    await assert.rejects(listenAutomation(service, { port: 0, host: '::' }), /never listens on all interfaces/);
    const listening = await listenAutomation(service, { port: 0 });
    assert.match(listening.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    listening.server.close();
  } finally { await f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* Team servers                                                        */
/* ------------------------------------------------------------------ */

test('team: a token acts for its member (author, actor, reply mode always, never batched); removed members stop it; admins only manage tokens', async () => {
  const f = fixture({ parallel: true });
  const directoryDir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-automation-team-'));
  try {
    const directory = new TeamDirectory(join(directoryDir, 'team.json'), ['owner@example.com']);
    directory.bootstrap(['desk']);
    const owner = directory.signIn({ login: 'owner@example.com', name: 'Olivia Owner' })!;
    directory.addMember('desk', owner, { login: 'mia@example.com' });
    const mia = directory.signIn({ login: 'mia@example.com', name: 'Mia Member' })!;
    const members = (agentId: string, userId: string): RunAuthor | undefined => { const user = directory.user(userId); return user && directory.role(agentId, userId) ? { id: user.id, login: user.login, name: user.name } : undefined; };
    const service = new AutomationService({ agents: [f.agent], members });
    const agents = new Map<string, TeamAgent>([['desk', { info: { id: 'desk', name: 'Desk', automations: true }, runtime: f.runtime }]]);
    const app = teamApp({ port: 0, assets: directoryDir, agents, directory, origins: [], automation: { service, endpoint: { url: 'http://127.0.0.1:1' } } });
    const web = await serve(app as unknown as ReturnType<typeof automationApp>);
    const names: Record<string, string> = { 'owner@example.com': 'Olivia Owner', 'mia@example.com': 'Mia Member', 'eve@example.com': 'Eve' };
    const as = async (login: string, path: string, init: { method?: string; body?: unknown } = {}) => {
      const who = { 'Tailscale-User-Login': login, 'Tailscale-User-Name': names[login]! };
      const session = await (await fetch(`${web.url}/api/session`, { headers: who })).json() as { csrf?: string };
      const response = await fetch(`${web.url}${path}`, { method: init.method ?? (init.body ? 'POST' : 'GET'), headers: { ...who, Origin: web.url, 'X-CSRF-Token': session.csrf ?? '', ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
      return { status: response.status, body: await response.json() as Json };
    };
    // Members who are not admins cannot see or create tokens; strangers do not see the agent at all.
    assert.equal((await as('mia@example.com', '/api/agents/desk/automations')).status, 403);
    assert.equal((await as('mia@example.com', '/api/agents/desk/automations/tokens', { body: { name: 'Mine' } })).status, 403);
    assert.equal((await as('eve@example.com', '/api/agents/desk/automations')).status, 404);
    // CSRF: a mutation without the person's token is refused before it reaches the routes.
    const noCsrf = await fetch(`${web.url}/api/agents/desk/automations/tokens`, { method: 'POST', headers: { 'Tailscale-User-Login': 'owner@example.com', Origin: web.url, 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(noCsrf.status, 403);
    directory.setRole('desk', owner, mia.id, { role: 'admin' });
    const created = await as('mia@example.com', '/api/agents/desk/automations/tokens', { body: { name: 'Mia nightly', via: 'conductor', preApproved: ['publish'] } });
    assert.equal(created.status, 201); assert.match(created.body.secret, /^lta_/);
    assert.equal(created.body.token.actor.name, 'Mia Member', 'a token acts for the admin who creates it');
    const listed = await as('owner@example.com', '/api/agents/desk/automations');
    assert.equal(JSON.stringify(listed.body).includes(created.body.secret), false, 'listing never shows a secret');
    assert.deepEqual(listed.body.tools, ['publish']); assert.equal(listed.body.replyModes, true);
    const http = await serve(automationApp(service));
    try {
      // A person's turn holds the conversation; the automation's turn queues behind it and is sent on its own.
      const thread = randomUUID();
      await f.runtime.create('team', thread, 'Shared', { id: owner.id, login: owner.login, name: owner.name });
      const human = { id: randomUUID(), threadId: thread, text: 'hold please', parentRunId: null };
      await f.runtime.start('team', human, { id: owner.id, login: owner.login, name: owner.name });
      await until(() => f.gates.length === 1);
      const automated = await call(http.url, '/v1/automation/runs', created.body.secret, { body: { text: 'nightly summary', idempotencyKey: 'n1', threadId: thread } });
      const later = { id: randomUUID(), threadId: thread, text: 'and me', parentRunId: null };
      await f.runtime.start('team', later, { id: owner.id, login: owner.login, name: owner.name });
      f.release();
      const result = await call(http.url, `/v1/automation/runs/${automated.body.id}?wait=10`, created.body.secret);
      assert.equal(result.body.status, 'completed');
      await until(() => f.runtime.events('team', later.id, 0).status === 'completed');
      const sentAutomation = f.sent.find(s => s.text.includes('nightly summary'))!;
      assert.equal(sentAutomation.actor, mia.id, 'tools act as the token\'s member');
      assert.match(sentAutomation.text, /This message is from Mia Member/);
      assert.match(sentAutomation.text, /Reply mode: always/);
      assert.equal(sentAutomation.text.includes('and me'), false, 'an automation turn is never combined with others');
      assert.deepEqual(sentAutomation.unattended?.preApproved, ['publish']);
      assert.equal(sentAutomation.unattended?.onBehalfOf, mia.id);
      const record = f.runtime.runRecord('team', automated.body.id)!;
      assert.equal(record.author?.id, mia.id); assert.equal(record.source?.via, 'conductor');
      // Removed from the agent: the token stops working (and the app shows it as inactive).
      directory.removeMember('desk', owner, mia.id);
      const refused = await call(http.url, '/v1/automation/runs', created.body.secret, { body: { text: 'again', idempotencyKey: 'n2' } });
      assert.equal(refused.status, 403); assert.equal(refused.body.error, 'actor_not_member');
      assert.equal((await as('owner@example.com', '/api/agents/desk/automations')).body.tokens[0].active, false);
      // Revoke from the app.
      assert.equal((await as('owner@example.com', `/api/agents/desk/automations/tokens/${created.body.token.id}`, { method: 'DELETE' })).body.revoked, true);
      assert.equal((await call(http.url, '/v1/automation/whoami', created.body.secret)).status, 401);
    } finally { await http.close(); await web.close(); }
  } finally { await f.cleanup(); rmSync(directoryDir, { recursive: true, force: true }); }
});

test('single-user GUI: Automations routes need the session, the exact origin and the CSRF token', async () => {
  const f = fixture();
  const assets = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-assets-'));
  try {
    const service = new AutomationService({ agents: [f.agent] });
    const server = guiApp(f.runtime, 'owner', 0, assets, { id: 'desk', name: 'Desk', automations: true }, undefined, undefined, { service, endpoint: { url: 'http://127.0.0.1:4402', docker: 'http://host.docker.internal:4402' } }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    try {
      const session = await fetch(`${origin}/api/session`);
      const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
      const { csrf, agent } = await session.json() as { csrf: string; agent: { automations?: boolean } };
      assert.equal(agent.automations, true);
      assert.equal((await fetch(`${origin}/api/automations`)).status, 401, 'no session');
      const post = (headers: Record<string, string>) => fetch(`${origin}/api/automations/tokens`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ name: 'From the app', via: 'n8n' }) });
      assert.equal((await post({ Origin: origin })).status, 403, 'no CSRF token');
      assert.equal((await post({ Origin: 'http://evil.example', 'X-CSRF-Token': csrf })).status, 403, 'foreign origin');
      const created = await post({ Origin: origin, 'X-CSRF-Token': csrf });
      assert.equal(created.status, 201);
      const { secret, token } = await created.json() as { secret: string; token: { id: string; actor: { name: string } } };
      assert.equal(token.actor.name, 'You');
      const listed = await (await fetch(`${origin}/api/automations`, { headers: { Cookie: cookie } })).json() as { tokens: Json[]; endpoint: Json };
      assert.equal(listed.tokens.length, 1); assert.equal(JSON.stringify(listed).includes(secret), false);
      assert.equal(listed.endpoint.docker, 'http://host.docker.internal:4402');
      // The app's own API never accepts the automation token.
      assert.equal((await fetch(`${origin}/api/v1/threads`, { headers: { Authorization: `Bearer ${secret}` } })).status, 401);
      const revoked = await fetch(`${origin}/api/automations/tokens/${token.id}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf } });
      assert.equal(revoked.status, 200);
    } finally { server.closeAllConnections(); server.close(); }
  } finally { await f.cleanup(); rmSync(assets, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ */
/* Tasks the agent schedules                                           */
/* ------------------------------------------------------------------ */

test('schedule_task: the orchestrator gets a one-off job with a single-use token; firing runs the prompt once, unattended; cancel removes the job', async () => {
  const f = fixture();
  const jobs: OrchestratorJob[] = [];
  const deleted: string[] = [];
  const orchestrator: Orchestrator = { kind: 'n8n', async createJob(job) { jobs.push(job); return { externalId: `wf-${jobs.length}`, credentialId: `cred-${jobs.length}` }; }, async deleteJob(handle) { deleted.push(handle.externalId); } };
  const service = new AutomationService({ agents: [f.agent], scheduler: { orchestrator, callbackUrl: 'http://host.docker.internal:4402/' } });
  const http = await serve(automationApp(service));
  try {
    // The conversation the agent was in when it scheduled the task.
    const thread = randomUUID();
    await f.runtime.create('owner', thread, 'Planning');
    const conversationId = (f.runtime as unknown as { state: { threads: { id: string; conversationId: string }[] } }).state.threads.find(t => t.id === thread)!.conversationId;
    const scheduler = service.schedulerFor('desk')!;
    const at = new Date(Date.now() + 60_000).toISOString();
    const task = await scheduler.schedule({ at, prompt: 'Check the build and report', conversation: 'current' }, { conversationId });
    assert.equal(task.orchestrator, 'n8n'); assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.fireUrl, `http://host.docker.internal:4402/v1/automation/schedules/${task.id}/fire`);
    assert.match(jobs[0]!.token, /^lta_/);
    assert.equal(readFileSync(f.store.filename, 'utf8').includes(jobs[0]!.token), false, 'the fire token is stored only as a hash');
    // The single-use token is not an automation token, and only fires its own task.
    assert.equal((await call(http.url, '/v1/automation/whoami', jobs[0]!.token)).status, 401);
    assert.equal((await call(http.url, `/v1/automation/schedules/${task.id}/fire`, 'lta_wrong', { body: {} })).status, 401);
    const fired = await call(http.url, `/v1/automation/schedules/${task.id}/fire?wait=10`, jobs[0]!.token, { body: {} });
    assert.equal(fired.status, 200); assert.equal(fired.body.status, 'completed');
    assert.equal(fired.body.conversation.id, thread, 'runs in the conversation it was scheduled from');
    assert.deepEqual(fired.body.source, { via: 'n8n', name: 'Scheduled task' });
    const sent = f.sent.find(s => s.text.includes('Check the build'))!;
    assert.deepEqual(sent.unattended?.preApproved, [], 'scheduled tasks pre-approve nothing');
    // The orchestrator retries: the same run, not a second turn.
    const again = await call(http.url, `/v1/automation/schedules/${task.id}/fire`, jobs[0]!.token, { body: {} });
    assert.equal(again.body.id, fired.body.id);
    assert.equal(f.sent.filter(s => s.text.includes('Check the build')).length, 1);
    // A second task, cancelled before it fires: its job is removed.
    const second = await scheduler.schedule({ at, prompt: 'Never mind', conversation: 'new', title: 'Later' }, { conversationId });
    assert.equal(jobs.length, 2);
    await service.cancelSchedule(f.agent, second.id);
    assert.ok(deleted.includes('wf-2'));
    assert.equal((await call(http.url, `/v1/automation/schedules/${second.id}/fire`, jobs[1]!.token, { body: {} })).status, 410);
    // Too early: refused.
    const third = await scheduler.schedule({ at: new Date(Date.now() + 10 * 60_000).toISOString(), prompt: 'Later', conversation: 'new' }, { conversationId });
    assert.equal((await call(http.url, `/v1/automation/schedules/${third.id}/fire`, jobs[2]!.token, { body: {} })).status, 425);
    const listed = service.schedules(f.agent);
    assert.deepEqual(listed.map(s => s.state).sort(), ['cancelled', 'fired', 'scheduled']);
    // Orchestrator failure: a fixed code, nothing left scheduled.
    const failing = new AutomationService({ agents: [f.agent], scheduler: { orchestrator: { kind: 'conductor', createJob: async () => { throw new Error('scheduler_unreachable'); }, deleteJob: async () => {} }, callbackUrl: 'http://127.0.0.1:1' } });
    await assert.rejects(failing.schedulerFor('desk')!.schedule({ at, prompt: 'x', conversation: 'new' }, { conversationId }), /scheduler_unreachable/);
  } finally { await http.close(); await f.cleanup(); }
});

test('orchestrator adapters: n8n creates a credential, a workflow and activates it (and cleans up on failure); Conductor registers its workflow and a bounded schedule', async () => {
  assert.equal(cronAt('2026-10-03T06:05:00.000Z'), '0 5 6 3 10 *');
  const job: OrchestratorJob = { id: 'task-1', at: '2026-10-03T06:05:00.000Z', fireUrl: 'http://host.docker.internal:4402/v1/automation/schedules/task-1/fire', token: 'lta_secret', label: 'Check the build' };
  const requests: { method: string; url: string; body?: Json; headers: Record<string, string> }[] = [];
  let failActivate = false;
  const fake: typeof fetch = async (input, init) => {
    const url = String(input); const method = init?.method ?? 'GET';
    requests.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), headers: init?.headers as Record<string, string> });
    if (url.endsWith('/activate') && failActivate) return new Response('{"message":"boom lta_secret"}', { status: 500 });
    if (url.endsWith('/api/v1/credentials') && method === 'POST') return Response.json({ id: 'cred-9' });
    if (url.endsWith('/api/v1/workflows') && method === 'POST') return Response.json({ id: 'wf-9' });
    return Response.json({});
  };
  const n8n = n8nOrchestrator({ url: 'http://127.0.0.1:5678/', apiKey: 'n8n-key', fetch: fake });
  assert.deepEqual(await n8n.createJob(job), { externalId: 'wf-9', credentialId: 'cred-9' });
  const [credential, workflow, activate] = requests;
  assert.equal(credential!.headers['X-N8N-API-KEY'], 'n8n-key');
  assert.deepEqual(credential!.body!.data, { name: 'Authorization', value: 'Bearer lta_secret' });
  assert.equal(JSON.stringify(workflow!.body).includes('lta_secret'), false, 'the token lives in the n8n credential, not the workflow');
  assert.equal(workflow!.body!.nodes[0].parameters.rule.interval[0].expression, '0 5 6 3 10 *');
  assert.equal(workflow!.body!.settings.timezone, 'UTC');
  assert.equal(workflow!.body!.nodes[1].parameters.url, `${job.fireUrl}?wait=110`);
  assert.equal(activate!.url, 'http://127.0.0.1:5678/api/v1/workflows/wf-9/activate');
  requests.length = 0; failActivate = true;
  await assert.rejects(n8n.createJob(job), (error: Error) => error.message === 'scheduler_failed' && !error.message.includes('lta_secret'));
  assert.deepEqual(requests.filter(r => r.method === 'DELETE').map(r => r.url), ['http://127.0.0.1:5678/api/v1/workflows/wf-9', 'http://127.0.0.1:5678/api/v1/credentials/cred-9']);
  requests.length = 0;
  await n8n.deleteJob({ externalId: 'wf-9', credentialId: 'cred-9' });
  assert.deepEqual(requests.map(r => `${r.method} ${r.url.replace('http://127.0.0.1:5678', '')}`), ['POST /api/v1/workflows/wf-9/deactivate', 'DELETE /api/v1/workflows/wf-9', 'DELETE /api/v1/credentials/cred-9'], 'n8n refuses to delete a published workflow');
  requests.length = 0;
  const conductor = conductorOrchestrator({ url: 'http://127.0.0.1:8080', fetch: fake });
  assert.deepEqual(await conductor.createJob(job), { externalId: 'ai_sdk_letta_task_task1' });
  assert.equal(requests[0]!.url, 'http://127.0.0.1:8080/api/metadata/workflow'); assert.equal(requests[0]!.method, 'PUT');
  assert.deepEqual(requests[0]!.body![0].maskedFields, ['token']);
  const schedule = requests[1]!.body!;
  assert.equal(schedule.cronExpression, '0 5 6 3 10 *'); assert.equal(schedule.zoneId, 'UTC');
  assert.equal(schedule.scheduleEndTime - schedule.scheduleStartTime, 120_000, 'fires at most once');
  assert.equal(schedule.startWorkflowRequest.input.fireUrl, job.fireUrl);
  await conductor.createJob({ ...job, id: 'task-2' });
  assert.equal(requests.filter(r => r.url.endsWith('/api/metadata/workflow')).length, 1, 'the workflow is registered once');
  await assert.rejects(conductorOrchestrator({ url: 'http://127.0.0.1:1', fetch: async () => { throw new Error('ECONNREFUSED'); } }).createJob(job), /scheduler_unreachable/);
});

test('single-user runtimes forget their oldest finished runs instead of refusing new turns', async () => {
  const f = fixture();
  try {
    const thread = randomUUID();
    await f.runtime.create('owner', thread, 'Busy');
    let parent: string | null = null;
    for (let i = 0; i < ThreadRuntime.MAX_RUNS + 5; i++) {
      const run: { id: string; threadId: string; text: string; parentRunId: string | null } = { id: randomUUID(), threadId: thread, text: `t${i}`, parentRunId: parent };
      await f.runtime.start('owner', run);
      await until(() => f.runtime.events('owner', run.id, 0).status === 'completed');
      parent = run.id;
    }
    const state = JSON.parse(readFileSync(join(f.directory, 'state.json'), 'utf8')) as { runs: unknown[] };
    assert.ok(state.runs.length <= ThreadRuntime.MAX_RUNS);
    assert.equal(f.runtime.latestRun('owner', thread)?.id, parent, 'the latest turn is always kept');
  } finally { await f.cleanup(); }
});
