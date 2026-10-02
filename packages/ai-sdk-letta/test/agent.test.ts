import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertToModelMessages, readUIMessageStream, type UIMessage, type ModelMessage } from 'ai';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { LettaAgent, foregroundToolsCommand, speakerNote } from '../src/index.js';
import { bridge as createBridge, registry } from './fixtures.js';

test('GUI foreground tool policy is runtime scoped and covers SDK human-wait timeout', () => {
  const bridge = createBridge();
  const command = foregroundToolsCommand(bridge, 'agent-test', 'conversation-test');
  assert.equal(command.type, 'runtime_external_tools_update');
  assert.deepEqual(command.updates[0].runtimes, [{ agent_id: 'agent-test', conversation_id: 'conversation-test' }]);
  const tools = command.updates[0].external_tools[0].tools;
  assert.deepEqual(tools.map(t => t.name), bridge.allowedTools);
  assert.ok(tools.every(t => t.auto_background === false && t.timeout_ms === 300_000));
});

function fixture(withTool = false, fail = false, invalidTool = false) {
  const sent: string[] = [];
  const activities: string[] = [];
  let closed = 0;
  let aborted = 0;
  const agent = new LettaAgent({ id: 'test', tools: registry, open: signal => ({
    send: async (text: unknown) => { sent.push(String(text)); },
    abort: async () => { aborted++; },
    close: () => { closed++; },
    async *stream() {
      if (withTool) {
        const bridge = createBridge({ allowedTools: ['text_stats'], signal, persist: event => activities.push(event.status) });
        yield { type: 'tool_call', toolCallId: 'call', toolName: 'text_stats', toolInput: { text: 'hello world' }, uuid: '1' } as SDKMessage;
        const result = await bridge.execute('text_stats', 'call', invalidTool ? { text: 42 } : { text: 'hello world' });
        yield { type: 'tool_result', toolCallId: 'call', content: result.content[0].text, isError: result.isError, uuid: '2' } as SDKMessage;
      }
      yield { type: 'assistant', content: 'Hello ', uuid: '3' } as SDKMessage;
      if (fail) throw new Error('delivery lost');
      yield { type: 'assistant', content: 'world', uuid: '4' } as SDKMessage;
      yield { type: 'result', success: true, uuid: '5', durationMs: 1, conversationId: 'test' } as SDKMessage;
    },
  }) });
  return { agent, sent, activities, counts: () => ({ closed, aborted }) };
}

test('generate returns genuine SDK result; only new turns sent, no replay', async () => {
  const f = fixture();
  const first = await f.agent.generate({ prompt: 'first' });
  assert.equal(first.text, 'Hello world');
  assert.equal(first.steps.length, 1);
  const history: ModelMessage[] = [{ role: 'user', content: 'first' }, ...first.response.messages];
  await f.agent.generate({ messages: [...history, { role: 'user', content: 'second' }] });
  assert.deepEqual(f.sent, ['first', 'second']);
  await assert.rejects(f.agent.generate({ messages: [{ role: 'user', content: 'first' }] }), /History/);
  assert.equal(f.counts().closed, 2);
});

test('generate exposes tool calls/results but executes the registry only once', async (context) => {
  const execution = context.mock.method(registry.text_stats, 'execute');
  const f = fixture(true);
  const result = await f.agent.generate({ prompt: 'count' });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolCalls[0].providerExecuted, true);
  assert.equal(result.steps.length, 1);
  assert.equal(execution.mock.callCount(), 1);
});

test('stream creates real provider-executed tool cards and UI history round-trips', async (context) => {
  const execution = context.mock.method(registry.text_stats, 'execute');
  const f = fixture(true);
  const result = await f.agent.stream({ prompt: [{ role: 'user', content: 'count' }] });
  const ui: UIMessage[] = [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'count' }] }];
  let response: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: result.toUIMessageStream() })) response = message;
  assert.ok(response);
  ui.push(response);
  const card = response.parts.find(p => p.type === 'tool-text_stats');
  assert.ok(card && 'state' in card && card.state === 'output-available');
  assert.equal((card as { providerExecuted?: boolean }).providerExecuted, true);
  assert.deepEqual(f.activities, ['start', 'completion']);
  ui.push({ id: 'next', role: 'user', parts: [{ type: 'text', text: 'next' }] });
  const next = await f.agent.stream({ prompt: await convertToModelMessages(ui, { tools: f.agent.tools }) });
  await next.consumeStream();
  assert.deepEqual(f.sent, ['count', 'next']);
  assert.deepEqual(f.activities, ['start', 'completion', 'start', 'completion']);
  assert.equal(execution.mock.callCount(), 2); // Once per Letta turn, never dispatched by AI SDK.
});

test('provider tool failures are streamed as tool error cards without local reexecution', async () => {
  const f = fixture(true, false, true);
  const result = await f.agent.stream({ prompt: 'invalid tool' });
  let response: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: result.toUIMessageStream() })) response = message;
  const card = response?.parts.find(p => p.type === 'tool-text_stats');
  assert.ok(card && 'state' in card && card.state === 'output-error');
  assert.deepEqual(f.activities, ['denied']);
  assert.ok(response);
  const history: UIMessage[] = [{ id: 'first', role: 'user', parts: [{ type: 'text', text: 'invalid tool' }] }, response, { id: 'next', role: 'user', parts: [{ type: 'text', text: 'continue after denial' }] }];
  const next = await f.agent.stream({ messages: await convertToModelMessages(history, { tools: f.agent.tools }) });
  await next.consumeStream();
  assert.deepEqual(f.sent, ['invalid tool', 'continue after denial']);
});

test('ordinary clarification is normal assistant text followed by a new user turn, no interactive tool', async () => {
  const sent: string[] = [];
  const agent = new LettaAgent({ id: 'clarification', tools: registry, open: () => ({
    send: async message => { sent.push(String(message)); }, abort: async () => {}, close: () => {},
    async *stream() {
      yield { type: 'assistant', content: sent.length === 1 ? 'Which audience?' : 'Written for beginners.', uuid: 'text' } as SDKMessage;
      yield { type: 'result', success: true, uuid: 'done', durationMs: 1, conversationId: 'test' } as SDKMessage;
    },
  }) });
  const first = await agent.generate({ prompt: 'Write a guide' });
  assert.equal(first.text, 'Which audience?');
  assert.equal(first.toolCalls.length, 0);
  const next = await agent.generate({ prompt: 'Beginners' });
  assert.equal(next.text, 'Written for beginners.');
  assert.deepEqual(sent, ['Write a guide', 'Beginners']);
});

test('failure emits error and poisons delivery, without retry', async () => {
  const f = fixture(false, true);
  const result = await f.agent.stream({ prompt: 'fail' });
  const parts = [];
  for await (const part of result.fullStream) parts.push(part);
  assert.ok(parts.some(p => p.type === 'error'));
  await assert.rejects(f.agent.generate({ prompt: 'retry' }), /uncertain/);
  assert.deepEqual(f.sent, ['fail']);
  assert.equal(f.counts().closed, 1);
});

test('pre-aborted and malformed calls never deliver', async () => {
  const f = fixture();
  await assert.rejects(f.agent.generate({ prompt: 'no', abortSignal: AbortSignal.abort() }));
  await assert.rejects(f.agent.generate({ messages: [{ role: 'assistant', content: 'edited' }] }));
  await assert.rejects(f.agent.generate({ prompt: '', timeout: 100 }));
  assert.deepEqual(f.sent, []);
  assert.equal((await f.agent.generate({ prompt: 'ok' })).text, 'Hello world');
});

test('cancellation closes active resources and disables continuation', async () => {
  const f = fixture();
  const control = new AbortController();
  const result = await f.agent.stream({ prompt: 'cancel', abortSignal: control.signal });
  for await (const part of result.fullStream) { if (part.type === 'text-delta') control.abort(); }
  await assert.rejects(f.agent.generate({ prompt: 'again' }), /uncertain/);
  assert.ok(f.counts().closed >= 1);
});

test('otid and speaker: the turn is tagged and prefaced; transcript and validation unaffected', async () => {
  const sent: { message: unknown; otid?: string }[] = [];
  const agent = new LettaAgent({ id: 'test', tools: registry, open: () => ({
    send: async (message: unknown, options?: { otid?: string }) => { sent.push({ message, otid: options?.otid }); },
    abort: async () => {}, close: () => {},
    async *stream() {
      yield { type: 'assistant', content: 'Hi', uuid: '1' } as SDKMessage;
      yield { type: 'result', success: true, uuid: '2', durationMs: 1, conversationId: 'c' } as SDKMessage;
    },
  }) });
  await agent.generate({ prompt: 'plain' });
  await agent.generate({ prompt: 'hello', otid: 'run-1', speaker: { name: 'Alice <b>Example</b>\u202e', login: 'alice@example.com' } });
  assert.deepEqual(sent[0], { message: 'plain', otid: undefined });
  assert.equal(sent[1]!.otid, 'run-1');
  assert.equal(sent[1]!.message, `${speakerNote({ name: 'Alice <b>Example</b>\u202e', login: 'alice@example.com' })}hello`);
  assert.match(String(sent[1]!.message), /^<system-reminder>\nThis message is from Alice bExample\/b \(alice@example\.com\)\./);
  // The retained transcript holds the user's text only, so the next turn extends it unchanged.
  assert.deepEqual(agent.transcript.filter(m => m.role === 'user').map(m => m.content), ['plain', 'hello']);
  await assert.rejects(agent.generate({ prompt: 'x', otid: 'bad otid!' }), /Invalid otid/);
  await assert.rejects(agent.generate({ prompt: 'x', speaker: {} as never }), /Invalid speaker/);
  assert.equal(speakerNote({ name: '   ' }).includes('A team member'), true);
});
