import test from 'node:test';
import assert from 'node:assert/strict';
import { tool, jsonSchema } from 'ai';
import { ToolInteractions, validateResponse, createToolBridge, defineAgent, type InteractionRequest, type ToolActivity } from '../src/index.js';
import { bridge as createBridge, registry } from './fixtures.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const approval = (toolCallId: string) => ({ toolCallId, tool: 'approval_demo', kind: 'approval' as const, title: 'Approve?' });
const decode = (result: Awaited<ReturnType<ReturnType<typeof createToolBridge>['execute']>>) => JSON.parse(result.content[0]!.text);

test('policy is fail-closed: every tool needs a permission; deny and unknown tools cannot prompt', async () => {
  assert.throws(() => defineAgent({ id: 'x', name: 'X', model: 'a/b', instructions: 'i', tools: registry, permissions: { text_stats: 'allow' } }), /Missing permission/);
  assert.throws(() => defineAgent({ id: 'x', name: 'X', model: 'a/b', instructions: 'i', tools: registry, permissions: { text_stats: 'all', approval_demo: 'ask' } as never }), /Invalid permission/);
  assert.throws(() => defineAgent({ id: 'x', name: 'X', model: 'a/b', instructions: 'i', tools: registry, permissions: { text_stats: 'allow', approval_demo: 'ask', Bash: 'allow' } as never }), /unknown tool/);
  assert.throws(() => defineAgent({ id: 'Bad ID', name: 'X', model: 'a/b', instructions: 'i', tools: {} }), /id/);
  // Untyped callers that omit tools fail at definition time, not later inside the tool bridge.
  assert.throws(() => defineAgent({ id: 'x', name: 'X', model: 'a/b', instructions: 'i' } as never), /tools must be an object/);
  assert.deepEqual(defineAgent({ id: 'x', name: 'X', model: 'a/b', instructions: 'i', tools: {} }).permissions, {});
  assert.equal(defineAgent({ id: 'x', name: 'X', model: 'a/b', instructions: 'i', tools: registry, permissions: { text_stats: 'deny', approval_demo: 'deny' } }).permissions.ask_user, 'allow');
  const interactions = new ToolInteractions();
  let prompts = 0;
  interactions.connect(async request => { prompts++; return { id: request.id, approved: true }; });
  const bridge = createBridge({ allowedTools: ['approval_demo', 'text_stats'], interactions, permissions: { approval_demo: 'deny' } });
  assert.deepEqual(bridge.allowedTools, []);
  assert.equal(decode(await bridge.execute('approval_demo', 'deny', { message: 'no' })).error, 'tool_denied');
  assert.equal(decode(await bridge.execute('Unknown', 'unknown', {})).error, 'tool_denied');
  assert.equal(prompts, 0);
  const browser = createBridge();
  assert.equal(decode(await browser.execute('approval_demo', 'browser-approval', { message: 'no renderer' })).error, 'interaction_unavailable');
  assert.equal(decode(await browser.execute('ask_user', 'browser-question', { question: 'No renderer?', allowFreeText: true })).error, 'interaction_unavailable');
  assert.equal((await browser.execute('text_stats', 'browser-stats', { text: 'hello' })).isError, false);
});

test('approval validates first, binds snapshot and exact call, executes only once, safe audit', async () => {
  const interactions = new ToolInteractions();
  let resolve!: (value: unknown) => void;
  let request!: InteractionRequest;
  let executions = 0;
  const events: ToolActivity[] = [];
  interactions.connect(value => { request = value; return new Promise(r => { resolve = r; }); });
  const definitions = { approval_demo: tool({ inputSchema: jsonSchema<{ message: string }>({ type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }), execute: async ({ message }) => { executions++; return { message }; } }) };
  const bridge = createToolBridge({ tools: definitions, interactions, permissions: { approval_demo: 'ask' }, persist: event => events.push(event) });
  assert.equal(decode(await bridge.execute('approval_demo', 'bad', { message: 1 })).error, 'invalid_arguments');
  assert.equal(Boolean(request), false);
  const args = { message: 'private original' };
  const result = bridge.execute('approval_demo', 'exact-call', args);
  args.message = 'mutated';
  await tick();
  assert.equal(executions, 0);
  assert.equal(request.toolCallId, 'exact-call');
  assert.match(request.details!, /private original/);
  resolve({ id: request.id, approved: true });
  assert.deepEqual(decode(await result), { message: 'private original' });
  assert.equal(executions, 1);
  assert.equal(decode(await bridge.execute('approval_demo', 'exact-call', args)).error, 'duplicate_or_limit');
  assert.equal(executions, 1);
  assert(events.some(e => e.status === 'approved'));
  assert(!JSON.stringify(events).includes('private original'));
  assert(!JSON.stringify(events).includes('exact-call'));
});

test('denial, missing renderer, abort during approval and approval/abort race prevent execution', async () => {
  for (const mode of ['deny', 'missing', 'abort', 'race']) {
    const control = new AbortController();
    const interactions = new ToolInteractions();
    let executions = 0;
    let signalSeen: AbortSignal | undefined;
    if (mode !== 'missing') interactions.connect(async (request, signal) => {
      signalSeen = signal;
      if (mode === 'abort' || mode === 'race') control.abort();
      if (mode === 'abort') return new Promise(() => {});
      return { id: request.id, approved: mode === 'race' };
    });
    const bridge = createToolBridge({ tools: { approval_demo: tool({ inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object' }), execute: async () => { executions++; return {}; } }) }, interactions, signal: control.signal, permissions: { approval_demo: 'ask' }, persist: () => {} });
    assert.equal((await bridge.execute('approval_demo', mode, {})).isError, true);
    assert.equal(executions, 0);
    if (mode === 'abort' || mode === 'race') assert.equal(signalSeen?.aborted, true);
  }
});

test('FIFO prompts serialize, queued cancellation and stale replies never answer another call', async () => {
  const interactions = new ToolInteractions();
  const requests: InteractionRequest[] = [];
  const resolves: ((value: unknown) => void)[] = [];
  interactions.connect(request => { requests.push(request); return new Promise(resolve => resolves.push(resolve)); });
  const firstControl = new AbortController();
  const secondControl = new AbortController();
  const first = interactions.request(approval('first'), firstControl.signal);
  const second = interactions.request(approval('second'), secondControl.signal);
  const third = interactions.request(approval('third'), new AbortController().signal);
  const rejectFirst = assert.rejects(first, /tool_cancelled/);
  const rejectSecond = assert.rejects(second, /tool_cancelled/);
  await tick();
  assert.equal(requests.length, 1);
  secondControl.abort(); firstControl.abort();
  await Promise.all([rejectFirst, rejectSecond]); await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].toolCallId, 'third');
  resolves[0]({ id: requests[0].id, approved: true });
  await tick();
  const rejectThird = assert.rejects(third, /invalid_interaction_response/);
  resolves[1]({ id: requests[0].id, approved: true });
  await rejectThird;
});

test('disconnect closes active and queued prompts without accepting late answers', async () => {
  const interactions = new ToolInteractions();
  let signal: AbortSignal | undefined;
  const disconnect = interactions.connect(async (_request, s) => { signal = s; return new Promise(() => {}); });
  const a = interactions.request(approval('a'), new AbortController().signal);
  const b = interactions.request(approval('b'), new AbortController().signal);
  const rejects = [assert.rejects(a), assert.rejects(b)];
  await tick(); disconnect(); await Promise.all(rejects);
  assert.equal(signal?.aborted, true);
  await assert.rejects(interactions.request(approval('c'), new AbortController().signal), /unavailable/);
});

test('ask_user supports choices, multiselect, free text and cancellation; validates before prompting', async () => {
  const interactions = new ToolInteractions();
  let prompts = 0;
  let response: object = {};
  interactions.connect(async request => { prompts++; return { id: request.id, ...response }; });
  const bridge = createBridge({ allowedTools: ['ask_user'], interactions });
  for (const args of [{ question: 'Empty' }, { question: 'Dup', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, { question: '', allowFreeText: true }]) assert.equal(decode(await bridge.execute('ask_user', `bad-${prompts}-${JSON.stringify(args)}`, args)).error, 'invalid_arguments');
  assert.equal(prompts, 0);
  const question = { question: 'Pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], multiSelect: true, allowFreeText: true };
  response = { selected: ['a', 'b'], text: ' custom ' };
  assert.deepEqual(decode(await bridge.execute('ask_user', 'multi', question)), { cancelled: false, selected: ['a', 'b'], text: 'custom' });
  response = { text: 'own answer' };
  assert.deepEqual(decode(await bridge.execute('ask_user', 'free', { question: 'Say', allowFreeText: true })), { cancelled: false, selected: [], text: 'own answer' });
  response = { cancelled: true };
  assert.deepEqual(decode(await bridge.execute('ask_user', 'cancel', question)), { cancelled: true });
  const request: InteractionRequest = { ...approval('check'), id: 'id', kind: 'question', options: question.options };
  for (const answer of [{ selected: ['a', 'b'] }, { selected: ['a', 'a'] }, { selected: ['unknown'] }, { text: 'not allowed' }, {}, { selected: 3 }]) assert.throws(() => validateResponse(request, { id: 'id', ...answer }));
});
