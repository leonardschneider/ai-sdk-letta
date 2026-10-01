/** Offline tests: no Letta backend, no model. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolBridge, ToolInteractions } from 'ai-sdk-letta';
import { agent } from '../src/agent.js';
import { dateDiff, type DateDiffInput } from '../src/tools.js';

const run = (input: DateDiffInput) => dateDiff.execute!(input, { toolCallId: 'test', messages: [], context: {} });

test('date_diff counts days, weeks, business days and weekdays', async () => {
  assert.deepEqual(await run({ from: '2026-01-01', to: '2026-01-15' }), { days: 14, weeks: 2, extraDays: 0, businessDays: 10, fromWeekday: 'Thursday', toWeekday: 'Thursday' });
  assert.deepEqual(await run({ from: '2026-01-02', to: '2026-01-05' }), { days: 3, weeks: 0, extraDays: 3, businessDays: 1, fromWeekday: 'Friday', toWeekday: 'Monday' });
  assert.deepEqual(await run({ from: '2026-01-05', to: '2026-01-02' }), { days: -3, weeks: 0, extraDays: -3, businessDays: -1, fromWeekday: 'Monday', toWeekday: 'Friday' });
  assert.equal((await run({ from: '2024-02-28', to: '2024-03-01' }) as { days: number }).days, 2, 'leap year');
});

test('date_diff returns a readable error for impossible dates', async () => {
  assert.deepEqual(await run({ from: '2025-02-30', to: '2025-03-01' }), { error: 'invalid_date', message: 'Not a calendar date: 2025-02-30' });
});

test('the definition lists every tool with a permission', () => {
  assert.deepEqual(Object.keys(agent.tools).sort(), ['ask_user', 'date_diff']);
  assert.deepEqual(agent.permissions, { date_diff: 'allow', ask_user: 'allow' });
});

test('the tool runs through the same policy the runtime uses: schema first, then the handler', async () => {
  const bridge = createToolBridge({ tools: agent.tools, permissions: agent.permissions, interactions: new ToolInteractions() });
  assert.deepEqual(bridge.allowedTools.sort(), ['ask_user', 'date_diff']);
  const ok = await bridge.execute('date_diff', 'call-1', { from: '2026-03-02', to: '2026-03-09' });
  assert.equal(ok.isError, false);
  assert.deepEqual(ok.content, [{ type: 'text', text: '{"days":7,"weeks":1,"extraDays":0,"businessDays":5,"fromWeekday":"Monday","toWeekday":"Monday"}' }]);
  const invalid = await bridge.execute('date_diff', 'call-2', { from: 'next week', to: '2026-03-09' });
  assert.deepEqual(invalid, { content: [{ type: 'text', text: '{"error":"invalid_arguments"}' }], isError: true });
});

test('ask_user is answered by the connected handler', async () => {
  const interactions = new ToolInteractions();
  interactions.connect(async request => ({ id: request.id, selected: ['b'] }));
  const bridge = createToolBridge({ tools: agent.tools, permissions: agent.permissions, interactions });
  const result = await bridge.execute('ask_user', 'call-3', { question: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  assert.deepEqual(result, { content: [{ type: 'text', text: '{"cancelled":false,"selected":["b"]}' }], isError: false });
});
