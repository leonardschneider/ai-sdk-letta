import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolInteractions, createToolBridge, defineAgent, TOOL_CALL_LIMITS, toolCallLimitOf, CALL_LIMIT_PROMPT, type InteractionRequest } from '../src/index.js';
import { registry } from './fixtures.js';

const decode = (result: { content: { text?: string }[] }) => JSON.parse(result.content[0]!.text!);
const ok = (result: { isError: boolean }) => !result.isError;

/** A bridge over text_stats with a per-turn limit; `answer` picks the person's reply to "more?" prompts. */
function setup(limit: number, answer: (request: InteractionRequest) => string | 'cancel' = () => 'more', extra: Record<string, unknown> = {}) {
  const interactions = new ToolInteractions();
  const asked: InteractionRequest[] = [];
  interactions.connect(async request => { asked.push(request); const a = answer(request); return a === 'cancel' ? { id: request.id, cancelled: true } : { id: request.id, selected: [a] }; });
  let turn: object = {};
  const bridge = createToolBridge({ tools: registry, permissions: { text_stats: 'allow', approval_demo: 'ask' }, interactions, callLimit: () => limit, turn: () => turn, ...extra });
  let n = 0;
  const call = (name = 'text_stats') => bridge.execute(name, `c${++n}`, { text: 'hi' });
  return { bridge, asked, call, newTurn: () => { turn = {}; } };
}

test('the limit is per turn: a new turn starts again from zero', async () => {
  const s = setup(10, () => 'stop');
  for (let i = 0; i < 10; i++) assert.ok(ok(await s.call()));
  assert.equal(decode(await s.call()).error, 'call_limit_reached');
  s.newTurn();
  for (let i = 0; i < 10; i++) assert.ok(ok(await s.call()), `turn 2, call ${i + 1}`);
});

test('at the limit the person is asked; "Allow N more" grants another block, repeatably; "Stop here" ends it for the turn', async () => {
  let reply = 'more';
  const s = setup(10, () => reply);
  for (let i = 0; i < 10; i++) await s.call();
  assert.equal(s.asked.length, 0);
  assert.ok(ok(await s.call()), 'the 11th call runs after "Allow 10 more"');
  assert.equal(s.asked.length, 1);
  const prompt = s.asked[0]!;
  assert.equal(prompt.kind, 'question');
  assert.equal(prompt.tool, CALL_LIMIT_PROMPT);
  assert.match(prompt.title, /used 10 tool calls in this turn\. Allow 10 more\?/);
  assert.deepEqual(prompt.options, [{ id: 'more', label: 'Allow 10 more' }, { id: 'stop', label: 'Stop here' }]);
  for (let i = 0; i < 9; i++) assert.ok(ok(await s.call()));
  assert.equal(s.asked.length, 1, 'no new question within the granted block');
  reply = 'stop';
  const stopped = decode(await s.call());
  assert.equal(stopped.error, 'call_limit_reached');
  assert.equal(stopped.limit, 20);
  assert.match(stopped.message, /summarize where you are/);
  assert.equal(decode(await s.call()).error, 'call_limit_reached', 'not asked again in the same turn');
  assert.equal(s.asked.length, 2);
});

test('nobody to ask (no renderer, a cancelled prompt, an unattended turn) stops at the limit', async () => {
  const cancelled = setup(10, () => 'cancel');
  for (let i = 0; i < 10; i++) await cancelled.call();
  assert.equal(decode(await cancelled.call()).error, 'call_limit_reached');
  const unattended = setup(10, () => 'more', { unattended: () => ({ preApproved: [], source: 'api', kind: 'x', token: 't', name: 'n' }) });
  for (let i = 0; i < 10; i++) await unattended.call();
  assert.equal(decode(await unattended.call()).error, 'call_limit_reached');
  assert.equal(unattended.asked.length, 0, 'never prompts in an unattended turn');
});

test('uncounted tools never count; the setting is validated; the default is 100', async () => {
  const s = setup(10, () => 'stop', { uncounted: ['approval_demo'], permissions: { text_stats: 'allow', approval_demo: 'allow' } });
  for (let i = 0; i < 25; i++) assert.ok(ok(await s.bridge.execute('approval_demo', `u${i}`, { message: 'x' })));
  for (let i = 0; i < 10; i++) assert.ok(ok(await s.call()));
  assert.equal(decode(await s.call()).error, 'call_limit_reached');
  assert.equal(TOOL_CALL_LIMITS.default, 100);
  assert.deepEqual([toolCallLimitOf(250), toolCallLimitOf(5), toolCallLimitOf(1001), toolCallLimitOf('50'), toolCallLimitOf(undefined)], [250, 100, 100, 100, 100]);
  const base = { id: 'x', name: 'X', model: 'a/b', instructions: 'i', tools: {} };
  assert.equal(defineAgent(base).toolCallLimit, 100);
  assert.equal(defineAgent({ ...base, toolCallLimit: 300 }).toolCallLimit, 300);
  assert.throws(() => defineAgent({ ...base, toolCallLimit: 5 }), /toolCallLimit must be 10–1000/);
});
