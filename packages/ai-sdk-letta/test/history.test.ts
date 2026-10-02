import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListMessagesResult, LettaCodeSession, SessionDeviceStatus } from '@letta-ai/letta-agent-sdk';
import { loadHistory, historyPage, projectHistory, assertHistorySettled, listConversations, acquireIdentity, validConversationId, dreamingCommand, assertIdle } from '../src/index.js';
import { definition } from './fixtures.js';
const rows = (...messages: Record<string, unknown>[]) => messages as unknown as ListMessagesResult['messages'];
const text = (id: string, role = 'user', content: unknown = id) => ({ id, message_type: `${role}_message`, content, date: 'same timestamp' });

test('descending history uses authoritative before cursor and preserves equal-timestamp order', async () => {
  const queries: unknown[] = [];
  const pages: ListMessagesResult[] = [
    { messages: rows(text('4', 'assistant'), text('3')), nextBefore: 'opaque-3', hasMore: true },
    { messages: rows(text('2', 'assistant'), text('1')), nextBefore: null, hasMore: false },
  ];
  const history = await loadHistory(async query => { queries.push(query); return pages.shift()!; });
  assert.deepEqual(history.messages.map(m => m.id), ['1', '2', '3', '4']);
  assert.deepEqual(queries, [{ order: 'desc', limit: 100 }, { order: 'desc', limit: 100, before: 'opaque-3' }]);
  assert.equal(history.truncated, false);
});
test('missing pagination metadata probes by last ID rather than silently assuming complete', async () => {
  let calls = 0;
  const history = await loadHistory(async query => { calls++; if (calls === 1) return { messages: rows(text('1')) }; assert.equal(query.before, '1'); return { messages: [] }; });
  assert.equal(calls, 2); assert.equal(history.messages.length, 1);
});
test('bounds explicitly flag newest history only; errors and stuck cursors fail closed', async () => {
  const history = await loadHistory(async () => ({ messages: rows(text('2'), text('1')), hasMore: true }), 2);
  assert.equal(history.truncated, true);
  await assert.rejects(loadHistory(async () => ({ messages: rows(text('1')), hasMore: true })), /duplicate/);
  await assert.rejects(loadHistory(async () => ({ messages: [], hasMore: true })), /no messages/);
  await assert.rejects(loadHistory(async () => { throw new Error('backend down'); }), /backend down/);
});
test('default history protocol carries exact agent ID; named history uses SDK pagination, no send', async () => {
  const calls: unknown[] = [];
  const session = {
    listMessages: async (query: unknown) => { calls.push(query); return { messages: [] }; },
    sendCommand: async (query: unknown) => { calls.push(query); return { success: true, messages: [], has_more: false, next_before: null }; },
    send: () => assert.fail('history must not send'),
  } as unknown as LettaCodeSession;
  await historyPage(session, 'agent-local-1', 'default', { limit: 10, before: 'cursor', order: 'desc' });
  assert.deepEqual(calls[0], { type: 'conversation_messages_list', conversation_id: 'default', query: { limit: 10, before: 'cursor', order: 'desc', agent_id: 'agent-local-1' } });
  await historyPage(session, 'agent-local-1', 'local-conv-2', { limit: 10 });
  assert.deepEqual(calls[1], { limit: 10, conversationId: 'local-conv-2' });
});
test('navigation history escape hatch scopes named conversation and applies explicit read timeout', async () => {
  const session = {
    listMessages: () => assert.fail('navigation uses bounded command'),
    sendCommand: async (command: unknown, options: unknown) => {
      assert.deepEqual(command, { type: 'conversation_messages_list', conversation_id: 'local-conv-2', query: { agent_id: 'agent-local-1', limit: 100, order: 'desc' } });
      assert.deepEqual(options, { responseType: 'conversation_messages_list_response', timeoutMs: 10_000 });
      return { success: true, messages: [], has_more: false };
    },
  } as unknown as LettaCodeSession;
  assert.deepEqual(await historyPage(session, 'agent-local-1', 'local-conv-2', { limit: 100, order: 'desc' }, 10_000), { messages: [], hasMore: false });
});
test('projection omits reasoning, memory, system reminders, heartbeat, unknown and incomplete tools', () => {
  const history = rows(
    text('u', 'user', [{ type: 'text', text: '<system-reminder>MEMORY SECRET</system-reminder>' }, { type: 'text', text: 'hello\u001b[31m' }, { type: 'image', image: 'private' }]),
    text('envelope', 'user', '{"type":"user_message","message":"human"}'),
    text('heartbeat', 'user', '{"type":"heartbeat","message":"secret"}'),
    text('system', 'system', 'secret'), { id: 'r', message_type: 'reasoning_message', reasoning: 'secret' },
    { id: 'a', message_type: 'approval_request_message', tool_call: { tool_call_id: 'c', name: 'text_stats', arguments: '{"text":"hello"}' } },
    { id: 'duplicate', message_type: 'tool_call_message', tool_call: { tool_call_id: 'c', name: 'text_stats', arguments: '{"text":"hello"}' } },
    { id: 'ret', message_type: 'tool_return_message', tool_call_id: 'c', status: 'success', tool_return: '{"words":1}' },
    { id: 'memory', message_type: 'tool_call_message', tool_call: { tool_call_id: 'm', name: 'Read', arguments: '{}' } },
    { id: 'mr', message_type: 'tool_return_message', tool_call_id: 'm', status: 'success', tool_return: 'secret' },
    { id: 'pending', message_type: 'approval_request_message', tool_call: { tool_call_id: 'p', name: 'text_stats', arguments: '{}' } },
    text('answer', 'assistant', [{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'secret' }]),
  );
  const display = projectHistory(history, ['text_stats']);
  assert.equal(display.length, 4);
  assert.equal(display[0].parts[0].type, 'text');
  assert.equal(JSON.stringify(display).includes('secret'), false);
  assert.equal(JSON.stringify(display).includes('MEMORY'), false);
  assert.equal(JSON.stringify(display).includes('approval-requested'), false);
  assert.deepEqual(display[2].parts[0], { type: 'dynamic-tool', toolName: 'text_stats', toolCallId: 'c', input: { text: 'hello' }, providerExecuted: true, state: 'output-available', output: { words: 1 } });
});
test('failed app tool becomes inert error card; malformed arguments are omitted', () => {
  const display = projectHistory(rows(
    { id: 'c', message_type: 'tool_call_message', tool_call: { tool_call_id: 'x', name: 'text_stats', arguments: '{}' } },
    { id: 'r', message_type: 'tool_return_message', tool_call_id: 'x', status: 'error', tool_return: [{ type: 'text', text: 'Failed' }] },
    { id: 'bad', message_type: 'tool_call_message', tool_call: { tool_call_id: 'y', name: 'text_stats', arguments: '{' } },
    { id: 'br', message_type: 'tool_return_message', tool_call_id: 'y', status: 'success', tool_return: 'Done' },
  ), ['text_stats']);
  assert.equal(display.length, 1); assert.match(JSON.stringify(display), /output-error/);
});
test('idle and settled gates reject offline, active, approvals, queues and abandoned turns', () => {
  const idle = { isOnline: true, isProcessing: false, pendingControlRequests: [], raw: {} } as unknown as SessionDeviceStatus;
  assertIdle(idle);
  for (const status of [{ ...idle, isOnline: undefined }, { ...idle, isProcessing: undefined }, { ...idle, pendingControlRequests: undefined }, { ...idle, isOnline: false }, { ...idle, isProcessing: true }, { ...idle, raw: { queue: [1] } }, { ...idle, pendingControlRequests: [{}] }]) assert.throws(() => assertIdle(status as SessionDeviceStatus), /unfinished/);
  assertHistorySettled(rows(text('u'), text('a', 'assistant')));
  assert.throws(() => assertHistorySettled(rows(text('u'))), /uncertain/);
  assert.throws(() => assertHistorySettled(rows({ id: 'c', message_type: 'tool_call_message', tool_call: { tool_call_id: 'x' } })), /uncertain/);
});
test('conversation enumeration pages until exhausted and never crosses agent boundaries', async () => {
  let count = 0;
  const result = await listConversations(async query => {
    count++;
    assert.equal(query.agentId, 'agent-local-1');
    if (count === 1) return [{ id: 'local-conv-1', agent_id: query.agentId }];
    assert.equal(query.after, 'local-conv-1'); return [];
  }, 'agent-local-1');
  assert.equal(result.length, 1); assert.equal(count, 2);
  await assert.rejects(listConversations(async () => [{ id: 'local-conv-1', agent_id: 'wrong' }], 'agent-local-1'), /wrong agent/);
  await assert.rejects(listConversations(async () => [{ id: 'local-conv-1', agent_id: 'agent-local-1' }], 'agent-local-1'), /non-advancing/);
});
function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-sessions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const api = { create: async () => 'agent-local-fixture', validate: async () => {} };
  return { directory, api, acquire: () => acquireIdentity(directory, definition, '/backend', api) };
}
test('v1 mapping migrates in place without agent creation; selection persists same physical ID', async t => {
  const f = fixture(t);
  const first = await f.acquire(); first.release();
  const file = join(f.directory, 'test-assistant.json');
  writeFileSync(file, JSON.stringify({ ...first.identity, version: 1 }));
  f.api.create = async () => assert.fail('must not recreate');
  const migrated = await f.acquire();
  assert.equal(migrated.identity.version, 2);
  migrated.selectConversation('local-conv-1'); migrated.release();
  const resumed = await f.acquire();
  assert.equal(resumed.identity.agentId, first.identity.agentId);
  assert.equal(resumed.identity.conversationId, 'local-conv-1');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
  resumed.selectConversation('default'); resumed.release();
});
test('new conversations receive exactly the mapped agent and uncertain creates block future launch', async t => {
  const f = fixture(t);
  const first = await f.acquire();
  const id = await first.createConversation(async agentId => { assert.equal(agentId, 'agent-local-fixture'); return 'local-conv-2'; });
  assert.equal(id, 'local-conv-2'); first.release();
  const next = await f.acquire(); assert.equal(next.identity.conversationId, id);
  await assert.rejects(next.createConversation(async () => { throw new Error('uncertain'); }), /uncertain/);
  next.release();
  await assert.rejects(f.acquire(), /Unresolved conversation/);
  assert.match(readFileSync(join(f.directory, 'test-assistant.conversation.pending.json'), 'utf8'), /agent-local-fixture/);
});
test('released lock cannot create or switch sessions; local and cloud ID forms are explicit', async t => {
  const f = fixture(t); const lease = await f.acquire(); lease.release();
  assert.throws(() => lease.selectConversation('default'), /released/);
  await assert.rejects(lease.createConversation(async () => assert.fail('must not create')), /released/);
  for (const id of ['default', 'local-conv-123', 'conv-abc-def']) assert.equal(validConversationId(id), true);
  for (const id of ['', '../default', 'agent-local-1']) assert.equal(validConversationId(id), false);
});
test('uncertain delivery survives restart and blocks only that conversation, never another session', async t => {
  const f = fixture(t); const first = await f.acquire();
  first.beginTurn('default'); first.release();
  const next = await f.acquire();
  assert.throws(() => next.assertNoPendingTurn('default'), /Uncertain prior delivery/);
  next.assertNoPendingTurn('local-conv-2');
  next.beginTurn('local-conv-2'); next.completeTurn('local-conv-2');
  next.assertNoPendingTurn('local-conv-2');
  assert.throws(() => next.beginTurn('default'), /Uncertain/);
  next.release();
});

test('reflection command targets selected conversation, app-private local_project only', () => {
  assert.deepEqual(dreamingCommand(definition, 'agent-local-1', 'local-conv-2'), { type: 'set_reflection_settings', runtime: { agent_id: 'agent-local-1', conversation_id: 'local-conv-2' }, scope: 'local_project', settings: { trigger: 'step-count', step_count: 25 } });
});
test('projection carries valid backend message dates as display metadata only', () => {
  const display = projectHistory(rows(
    { id: 'u', message_type: 'user_message', content: 'hello', date: '2026-09-28T10:00:00Z' },
    { id: 'a', message_type: 'assistant_message', content: 'hi', date: 'not a date' },
  ), []);
  assert.deepEqual(display[0].metadata, { createdAt: '2026-09-28T10:00:00.000Z' });
  assert.equal(display[1].metadata, undefined);
});
test('user turns keep their OTID (when well formed) so applications can match them; assistant turns never carry one', () => {
  const display = projectHistory(rows(
    { ...text('u1', 'user', 'tagged'), otid: 'run-123', date: '2026-10-01T10:00:00Z' },
    { ...text('u2', 'user', 'weird'), otid: 'has spaces <x>' },
    { ...text('a1', 'assistant', 'reply'), otid: 'assistant-otid' },
  ), []);
  assert.deepEqual(display.map(m => m.metadata), [{ createdAt: '2026-10-01T10:00:00.000Z', otid: 'run-123' }, undefined, undefined]);
});
