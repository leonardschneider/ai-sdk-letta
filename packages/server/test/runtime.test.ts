import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { LettaAgent, ToolInteractions, type InteractionRequest, type InteractionResponse } from 'ai-sdk-letta';
import { ThreadRuntime, RuntimeFault, tokenApiApp, toolFailureReason, displayRun, type RuntimeHost } from '../src/index.js';
import { tools } from './fixtures.js';

function fixture(deadlineMs?: number, humanWaitMs?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-runtime-'));
  const filename = join(directory, 'state.json');
  const conversations = new Map<string, UIMessage[]>();
  const sent: string[] = [];
  const answers: InteractionResponse[] = [];
  let executions = 0;
  let current: LettaAgent<typeof tools> | undefined;
  const host: RuntimeHost = {
    async close() { current?.close(); current = undefined; },
    async open(options) {
      const conversationId = 'conversationId' in options ? options.conversationId : randomUUID();
      if (!conversations.has(conversationId)) conversations.set(conversationId, []);
      const history = conversations.get(conversationId)!;
      const interactions = new ToolInteractions();
      let input = '';
      const agent = current = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'same-agent', interactions, open: signal => ({
        async send(text) { input = String(text); sent.push(input); history.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: input }] }); },
        async abort() {}, close() {},
        async *stream() {
          if (input === 'fail') throw new Error('secret-provider-key');
          if (input === 'detached') {
            yield { type: 'tool_call', toolCallId: 'tool-1', toolName: 'ask_user', toolInput: {}, uuid: '1' } as SDKMessage;
            void interactions.request({ toolCallId: 'tool-1', tool: 'ask_user', kind: 'question', title: 'Choose', allowFreeText: true }, signal).catch(() => { executions++; });
            await new Promise(resolve => setTimeout(resolve, 5));
            yield { type: 'tool_result', toolCallId: 'tool-1', content: 'External tool ask_user is still running. Its completion will arrive as a task notification.', uuid: '2' } as SDKMessage;
          }
          if (input.startsWith('expiring ')) {
            // A prompt that expires on its own after N ms (as web_search's review does): the tool withdraws it, then the turn ends normally.
            const ms = Number(input.split(' ')[1]);
            yield { type: 'tool_call', toolCallId: 'tool-1', toolName: 'text_stats', toolInput: { text: 'hello' }, uuid: '1' } as SDKMessage;
            const expiry = AbortSignal.timeout(ms);
            const response = await interactions.request({ toolCallId: 'tool-1', tool: 'text_stats', kind: 'approval', title: 'Review', expiresAt: new Date(Date.now() + ms).toISOString() }, AbortSignal.any([signal, expiry]))
              .catch(() => ({ id: '', expired: true } as InteractionResponse & { expired?: boolean }));
            answers.push(response);
            yield { type: 'tool_result', toolCallId: 'tool-1', content: JSON.stringify((response as { expired?: boolean }).expired ? { error: 'review_expired' } : { approved: response.approved }), uuid: '2' } as SDKMessage;
          }
          if (input === 'approve' || input === 'question' || input === 'wait') {
            yield { type: 'tool_call', toolCallId: 'tool-1', toolName: 'text_stats', toolInput: { text: 'hello' }, uuid: '1' } as SDKMessage;
            const response = await interactions.request(input === 'question'
              ? { toolCallId: 'tool-1', tool: 'text_stats', kind: 'question', title: 'Choose', options: [{ id: 'stable-id', label: 'Label, with comma' }], multiSelect: true, allowFreeText: false }
              : { toolCallId: 'tool-1', tool: 'text_stats', kind: 'approval', title: 'Allow?' }, signal);
            answers.push(response);
            if (response.approved === true || response.selected?.length) executions++;
            yield { type: 'tool_result', toolCallId: 'tool-1', content: JSON.stringify({ approved: response.approved ?? true }), uuid: '2' } as SDKMessage;
          }
          yield { type: 'assistant', content: 'Done', uuid: '3' } as SDKMessage;
          history.push({ id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Done' }] });
          yield { type: 'result', success: true, uuid: '4', durationMs: 1, conversationId } as SDKMessage;
        },
      }) });
      return { agent, agentId: 'same-agent', conversationId, history: structuredClone(history) };
    },
  };
  const runtime = new ThreadRuntime(host, filename, 'owner', deadlineMs, humanWaitMs);
  return { runtime, host, filename, sent, answers, counts: () => executions, cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Fixture deadline');
}
const start = (threadId: string, text: string, parentRunId: string | null = null) => ({ id: randomUUID(), threadId, text, parentRunId });

test('two threads share one identity, new-input-only turns, history and durable idempotency', async () => {
  const f = fixture();
  try {
    const first = randomUUID(), second = randomUUID();
    await f.runtime.create('owner', first, 'First'); await f.runtime.create('owner', second, 'Second');
    const a = start(first, 'one'); await f.runtime.start('owner', a);
    await until(() => f.runtime.events('owner', a.id, 0).status === 'completed');
    const b = start(second, 'two'); await f.runtime.start('owner', b);
    await until(() => f.runtime.events('owner', b.id, 0).status === 'completed');
    const c = start(first, 'three', a.id); await f.runtime.start('owner', c);
    await until(() => f.runtime.events('owner', c.id, 0).status === 'completed');
    await f.runtime.start('owner', a);
    assert.deepEqual(f.sent, ['one', 'two', 'three']);
    assert.equal((await f.runtime.history('owner', first)).messages.length, 4);
    assert.equal((await f.runtime.history('owner', second)).messages.length, 2);
    const state = JSON.parse(readFileSync(f.filename, 'utf8'));
    assert.deepEqual(state.threads.map((t: { agentId: string }) => t.agentId), ['same-agent', 'same-agent']);
    await f.runtime.close();
    const restored = new ThreadRuntime(f.host, f.filename, 'owner');
    await restored.start('owner', a); assert.equal(f.sent.length, 3);
    assert.equal((await restored.history('owner', first)).lastRunId, c.id);
    await assert.rejects(restored.start('owner', start(first, 'replay')), /history_conflict/);
    await assert.rejects(restored.start('owner', { ...a, text: 'changed' }), /id_conflict/);
    await restored.close();
  } finally { await f.cleanup(); }
});

test('approve, deny and structured question preserve IDs and execute at most once', async () => {
  const f = fixture();
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Interactions');
    let parent: string | null = null;
    const cases: [string, Omit<InteractionResponse, 'id'>][] = [['approve', { approved: true }], ['approve', { approved: false }], ['question', { selected: ['stable-id'] }]];
    for (const [text, response] of cases) {
      const run = start(thread, text, parent); await f.runtime.start('owner', run);
      await until(() => f.runtime.events('owner', run.id, 0).events.some(e => e.type === 'interaction'));
      const request = f.runtime.events('owner', run.id, 0).events.find(e => e.type === 'interaction')!.data as InteractionRequest;
      if (text === 'question') assert.throws(() => f.runtime.answer('owner', run.id, { id: request.id, selected: ['Label, with comma'] }), /invalid_response/);
      f.runtime.answer('owner', run.id, { id: request.id, ...response });
      assert.throws(() => f.runtime.answer('owner', run.id, { id: request.id, approved: true }), /stale_interaction/);
      await until(() => f.runtime.events('owner', run.id, 0).status === 'completed');
      const events = f.runtime.events('owner', run.id, 0).events;
      assert.equal(events.filter(e => e.type === 'tool_started').length, 1);
      assert.equal(events.filter(e => e.type === 'tool_completed').length, 1);
      assert.equal(events.find(e => e.type === 'tool_started')?.data.execution, 'external');
      parent = run.id;
    }
    assert.equal(f.counts(), 2);
    assert.deepEqual(f.answers[2].selected, ['stable-id']);
  } finally { await f.cleanup(); }
});

test('ownership, cancellation and uncertain delivery fail closed', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.runtime.list('other'), (e: unknown) => e instanceof RuntimeFault && e.status === 403);
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Cancel');
    const run = start(thread, 'wait'); await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).events.some(e => e.type === 'interaction'));
    await assert.rejects(f.runtime.start('owner', start(thread, 'parallel', run.id)), /delivery_uncertain/);
    f.runtime.cancel('owner', run.id);
    await until(() => f.runtime.events('owner', run.id, 0).status === 'cancelled');
    assert.equal(f.counts(), 0);
    await assert.rejects(f.runtime.start('owner', start(thread, 'retry', run.id)), /delivery_uncertain/);
    const other = randomUUID(); await f.runtime.create('owner', other, 'Failure');
    const failed = start(other, 'fail'); await f.runtime.start('owner', failed);
    await until(() => f.runtime.events('owner', failed.id, 0).status === 'failed');
    assert.ok(!JSON.stringify(f.runtime.events('owner', failed.id, 0)).includes('secret-provider-key'));
  } finally { await f.cleanup(); }
});

test('uncertain creation and interrupted delivery are never retried after restart', async () => {
  const f = fixture();
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Interrupted');
    const input = start(thread, 'one'); await f.runtime.start('owner', input);
    await until(() => f.runtime.events('owner', input.id, 0).status === 'completed');
    await f.runtime.close();
    // Simulate the durable pre-delivery record surviving an abrupt process loss.
    const state = JSON.parse(readFileSync(f.filename, 'utf8'));
    state.runs[0].status = 'running'; state.runs[0].events = [];
    const uncertain = randomUUID();
    state.threads.push({ id: uncertain, owner: 'owner', title: 'Uncertain', state: 'creating' });
    writeFileSync(f.filename, JSON.stringify(state));
    const restored = new ThreadRuntime(f.host, f.filename, 'owner');
    assert.equal((await restored.start('owner', input)).status, 'interrupted');
    assert.equal(f.sent.length, 1);
    await assert.rejects(restored.start('owner', start(thread, 'retry', input.id)), /delivery_uncertain/);
    await assert.rejects(restored.create('owner', uncertain, 'Uncertain'), /creation_uncertain/);
    assert.equal(restored.events('owner', input.id, 0).events.at(-1)?.data.code, 'delivery_uncertain');
    await restored.close();
  } finally { await f.cleanup(); }
});

test('browser refresh reconnects to active run without reopening identity or replaying history', async () => {
  const f = fixture();
  try {
    const id = randomUUID(); await f.runtime.create('owner', id, 'Reconnect');
    const first = start(id, 'one'); await f.runtime.start('owner', first);
    await until(() => f.runtime.events('owner', first.id, 0).status === 'completed');
    const active = start(id, 'wait', first.id); await f.runtime.start('owner', active);
    await until(() => f.runtime.events('owner', active.id, 0).events.some(e => e.type === 'interaction'));
    const view = await f.runtime.view('owner', id);
    assert.equal(view.status, 'running'); assert.deepEqual(view.live, { id: active.id, input: 'wait' });
    assert.equal(view.messages.length, 2); assert.deepEqual(f.sent, ['one', 'wait']);
    assert.equal(f.runtime.events('owner', active.id, 0).events.filter(e => e.type === 'interaction').length, 1);
    f.runtime.cancel('owner', active.id);
    await until(() => f.runtime.events('owner', active.id, 0).status === 'cancelled');
    const cancelled = await f.runtime.view('owner', id);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.live, null);
    assert.equal(cancelled.source, 'transport-observations');
    assert.equal(cancelled.messages.length, 4);
    assert.deepEqual(f.sent, ['one', 'wait']); assert.equal(f.counts(), 0);
  } finally { await f.cleanup(); }
});

test('human wait pauses inference deadline, answer resumes once, abandoned question expires visibly', async () => {
  const f = fixture(100, 350);
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Wait');
    const run = start(thread, 'question'); await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).events.some(e => e.type === 'interaction'));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.runtime.events('owner', run.id, 0).status, 'running');
    const request = f.runtime.events('owner', run.id, 0).events.find(e => e.type === 'interaction')!.data;
    f.runtime.answer('owner', run.id, { id: String(request.id), selected: ['stable-id'] });
    await until(() => f.runtime.events('owner', run.id, 0).status === 'completed');
    assert.equal(f.answers.length, 1); assert.equal(f.counts(), 1);
    const next = start(thread, 'question', run.id); await f.runtime.start('owner', next);
    await until(() => f.runtime.events('owner', next.id, 0).status === 'cancelled');
    const events = f.runtime.events('owner', next.id, 0).events;
    assert.equal(events.at(-1)?.data.code, 'timed_out');
    assert.equal(events.filter(e => e.type === 'interaction_ended').length, 1);
    assert.equal(events.find(e => e.type === 'interaction_ended')?.data.code, 'timed_out');
  } finally { await f.cleanup(); }
});

test('SDK detached result cannot silently complete a pending human question or leak broker requests', async () => {
  const f = fixture();
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Detached');
    const run = start(thread, 'detached'); await f.runtime.start('owner', run);
    await until(() => f.runtime.events('owner', run.id, 0).status !== 'running');
    const { events, status } = f.runtime.events('owner', run.id, 0);
    assert.equal(status, 'failed'); assert.equal(events.at(-1)?.data.code, 'interaction_incomplete');
    assert.equal(events.filter(e => e.type === 'interaction_ended').length, 1);
    assert.equal(events.some(e => e.type === 'completed'), false);
    await until(() => f.counts() === 1);
    const request = events.find(e => e.type === 'interaction')!.data;
    assert.throws(() => f.runtime.answer('owner', run.id, { id: String(request.id), text: 'late' }), /stale_interaction/);
  } finally { await f.cleanup(); }
});

test('HTTP rejects missing auth, wrong owner, browser origins and cross-site requests', async () => {
  const f = fixture();
  const token = 'a'.repeat(64);
  const app = tokenApiApp(f.runtime, token, 'owner', 0);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1/capabilities`;
  const headers = { authorization: `Bearer ${token}`, 'x-runtime-owner': 'owner' };
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers })).status, 200);
    assert.equal((await fetch(url, { headers: { ...headers, 'x-runtime-owner': 'other' } })).status, 403);
    assert.equal((await fetch(url, { headers: { ...headers, origin: 'http://localhost:3080' } })).status, 401);
    assert.equal((await fetch(url, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test('tool failure reasons expose only fixed application codes, never free-form error text', () => {
  assert.deepEqual(toolFailureReason('{"error":"user_denied"}'), { reason: 'user_denied' });
  assert.deepEqual(toolFailureReason({ error: 'approval_cancelled' }), { reason: 'approval_cancelled' });
  for (const value of ['{"error":"secret-provider-key"}', 'plain text', { error: 42 }, ['user_denied'], null, undefined]) assert.deepEqual(toolFailureReason(value), {});
});

test('reconnect display keeps fixed denial reasons and the run start time', () => {
  const [user, assistant] = displayRun({ id: 'r', threadId: 't', input: 'hi', parentRunId: null, status: 'completed', startedAt: '2026-09-29T09:00:00.000Z', events: [
    { sequence: 1, type: 'tool_started', data: { toolCallId: 'a', name: 'approval_demo', input: { message: 'x' } } },
    { sequence: 2, type: 'tool_failed', data: { toolCallId: 'a', name: 'approval_demo', code: 'tool_failed', reason: 'user_denied' } },
    { sequence: 3, type: 'tool_started', data: { toolCallId: 'b', name: 'text_stats', input: {} } },
    { sequence: 4, type: 'tool_failed', data: { toolCallId: 'b', name: 'text_stats', code: 'tool_failed' } },
  ] });
  assert.deepEqual(user.metadata, { createdAt: '2026-09-29T09:00:00.000Z' });
  assert.deepEqual(assistant.parts.map(p => p.type === 'dynamic-tool' && p.state === 'output-error' ? p.errorText : null), ['{"error":"user_denied"}', 'tool_failed']);
});

test('a prompt that expires on its own waits past the shared human-wait budget, can be answered, and its expiry ends the turn cleanly', async () => {
  // Shared budget 50 ms; the prompt expires after 400 ms (plus the margin the runtime adds).
  const f = fixture(2000, 50);
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Expiring');
    const answered = start(thread, 'expiring 400'); await f.runtime.start('owner', answered);
    await until(() => f.runtime.events('owner', answered.id, 0).events.some(e => e.type === 'interaction'));
    await new Promise(resolve => setTimeout(resolve, 200)); // longer than the shared budget
    assert.equal(f.runtime.events('owner', answered.id, 0).status, 'running');
    const request = f.runtime.events('owner', answered.id, 0).events.find(e => e.type === 'interaction')!.data as InteractionRequest;
    f.runtime.answer('owner', answered.id, { id: request.id, approved: true });
    await until(() => f.runtime.events('owner', answered.id, 0).status === 'completed');
    // Nobody answers: the prompt expires, the turn completes and the conversation takes the next message.
    const expired = start(thread, 'expiring 150', answered.id); await f.runtime.start('owner', expired);
    for (let i = 0; i < 100 && f.runtime.events('owner', expired.id, 0).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const { status, events } = f.runtime.events('owner', expired.id, 0);
    assert.equal(status, 'completed');
    assert.equal(events.find(e => e.type === 'interaction_ended')?.data.code, 'expired');
    const next = start(thread, 'one', expired.id); await f.runtime.start('owner', next);
    await until(() => f.runtime.events('owner', next.id, 0).status === 'completed');
  } finally { await f.cleanup(); }
});
