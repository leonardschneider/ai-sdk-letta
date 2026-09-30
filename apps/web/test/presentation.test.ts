import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerLine, conversationTitle, describeArguments, failureReason, friendlyName, metricsLine, parseArgs, resultFields, toolLabel, toolSummary } from '../src/presentation.js';
import { historyMessages, mergeAssistantRuns, observedParts } from '../src/messages.js';

test('tool presentation keeps metrics and human question labels, never selection IDs', () => {
  assert.equal(friendlyName('text_stats'), 'Text stats');
  assert.equal(friendlyName('ask_user'), 'Question');
  assert.equal(friendlyName('fetchWeather_now'), 'Fetch Weather now');
  assert.deepEqual(resultFields('text_stats', { words: 3, lines: 1 }), [{ label: 'Words', value: '3' }, { label: 'Lines', value: '1' }]);
  assert.deepEqual(resultFields('ask_user', { selected: ['internal-a'], text: 'Please' }, { options: [{ id: 'internal-a', label: 'Blue' }] }), [{ label: 'Answer', value: 'Blue · Please' }]);
  assert.equal(resultFields('ask_user', { selected: ['unknown'] })[0]?.value, 'Selected option');
  assert.equal(resultFields('ask_user', { cancelled: true })[0]?.value, 'Cancelled');
});
test('unknown and failed results remain compact data, not raw JSON or HTML rendering', () => {
  assert.equal(resultFields('unknown', { nested: { secret: 'hidden' } })[0]?.value, 'Result received. Technical details are available below.');
  assert.deepEqual(resultFields('unknown', { error: 'Not available', token: 'hidden' }), [{ label: 'Error', value: 'Not available' }]);
  assert.deepEqual(resultFields('unknown', '{"words":2}'), [{ label: 'Words', value: '2' }]);
  assert.deepEqual(resultFields('unknown', ['raw']), [{ label: 'Result', value: 'Result received. Technical details are available below.' }]);
  assert.equal(resultFields('unknown', '<script>alert(1)</script>')[0]?.value, '<script>alert(1)</script>');
  assert.deepEqual(parseArgs('invalid'), {});
  assert.equal(conversationTitle('  A\n short question '), 'A short question');
});
test('tool labels read naturally per phase and explain denials without exposing error text', () => {
  assert.equal(toolLabel('text_stats', 'running'), 'Using Text stats…');
  assert.equal(toolLabel('text_stats', 'done'), 'Used Text stats');
  assert.equal(toolLabel('text_stats', 'error', 'tool_failed'), 'Text stats didn’t complete');
  assert.equal(toolLabel('approval_demo', 'error', '{"error":"user_denied"}'), 'Denied: Approval demo');
  assert.equal(toolLabel('approval_demo', 'error', { error: 'approval_cancelled' }), 'Cancelled: Approval demo');
  assert.equal(toolLabel('search_web', 'running'), 'Using Search web…');
  assert.equal(toolLabel('search_web', 'done'), 'Used Search web');
  assert.equal(toolLabel('search_web', 'error'), 'Search web didn’t complete');
  assert.equal(failureReason('Turn ended: cancelled; execution not confirmed.'), 'cancelled');
  assert.equal(failureReason('{"error":"Some <b>free</b> text"}'), undefined);
});
test('tool summaries are friendly metrics and fields, never raw JSON', () => {
  const stats = toolSummary('text_stats', { characters: 21, words: 3, lines: 1 }, { text: 'hello example text' });
  assert.deepEqual(stats.metrics, [{ label: 'characters', value: '21' }, { label: 'words', value: '3' }, { label: 'line', value: '1' }]);
  assert.equal(metricsLine(stats.metrics!), '21 characters · 3 words · 1 line');
  assert.deepEqual(stats.fields, [{ label: 'Text', value: 'hello example text' }]);
  assert.deepEqual(toolSummary('approval_demo', { acknowledged: 'hi', sideEffects: false }).fields, [{ label: 'Acknowledged', value: 'hi' }, { label: 'Side Effects', value: 'false' }]);
  assert.equal(toolSummary('any_tool', { count: 1, token: 'x' }).metrics, undefined, 'mixed results are fields, not metrics');
  assert.equal(toolSummary('other', { nested: { a: 1 } }).fields[0]?.value, 'Result received. Technical details are available below.');
});
test('answer lines collapse questions to one human-readable outcome', () => {
  const args = { question: 'Which colors?', options: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }] };
  assert.deepEqual(answerLine({ selected: ['red'], text: 'muted shades' }, args), { state: 'answered', text: 'You answered: Red · muted shades' });
  assert.deepEqual(answerLine('{"selected":["blue"]}', args), { state: 'answered', text: 'You answered: Blue' });
  assert.equal(answerLine({ cancelled: true }, args).text, 'You skipped this question');
  assert.equal(answerLine('Turn ended: timed_out; execution not confirmed.', args, true).state, 'closed');
  assert.equal(answerLine('Turn ended: timed_out; execution not confirmed.', args, true).detail, 'The turn timed out before this finished.');
  assert.equal(answerLine('External tool ask_user is still running. Task ID: x.', args).state, 'closed');
  assert.equal(answerLine('Awaiting a result from the tool.', args).state, 'closed');
});
test('approval arguments are fully described, flattened and never hidden', () => {
  assert.deepEqual(describeArguments('{"message":"Delete /tmp/x","options":{"force":true,"paths":["a","b"]},"empty":{}}'), [
    { label: 'Message', value: 'Delete /tmp/x' },
    { label: 'Options › Force', value: 'true' },
    { label: 'Options › Paths', value: 'a, b' },
    { label: 'Empty', value: '(empty)' },
  ]);
  assert.deepEqual(describeArguments('not json'), [{ label: 'Details', value: 'not json' }]);
  assert.deepEqual(describeArguments('{"items":[{"id":1}]}'), [{ label: 'Items 1 › Id', value: '1' }]);
  const long = 'x'.repeat(5000);
  assert.equal(describeArguments(JSON.stringify({ message: long }))[0]?.value, long);
});
test('completed external questions use notification results without displaying transport messages', () => {
  const messages = historyMessages([
    { id: 'assistant', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'ask_user', toolCallId: 'call', state: 'output-available', input: { options: [{ id: 'blue', label: 'Ocean blue' }] }, output: 'External tool ask_user is still running. Task ID: external_123. Its completion will arrive.' }] },
    { id: 'notice', role: 'user', parts: [{ type: 'text', text: '<task-notification><task-id>external_123</task-id><result>{"selected":["blue"]}</result></task-notification>' }] },
  ]);
  assert.equal(messages.length, 1);
  const part = typeof messages[0]?.content !== 'string' ? messages[0]?.content[0] : undefined;
  assert.equal(part?.type, 'tool-call');
  if (part?.type === 'tool-call') assert.deepEqual(resultFields(part.toolName, part.result, parseArgs(part.argsText)), [{ label: 'Answer', value: 'Ocean blue' }]);
});
test('live and restored parts preserve interleaved questions, answers, approvals and text order', () => {
  const input = { question: 'Which color?', options: [{ id: 'blue', label: 'Ocean blue' }] };
  const output = { selected: ['blue'] };
  const events = [
    { type: 'text', data: { text: 'Before' } },
    { type: 'tool_started', data: { toolCallId: 'q', name: 'ask_user', input } },
    { type: 'tool_completed', data: { toolCallId: 'q', output } },
    { type: 'text', data: { text: 'After answer' } },
    { type: 'tool_started', data: { toolCallId: 'a', name: 'approval_demo', input: {} } },
    { type: 'tool_completed', data: { toolCallId: 'a', output: { ok: true } } },
    { type: 'text', data: { text: 'After approval' } },
  ].map((event, i) => ({ ...event, sequence: i + 1, runId: 'run', at: 'now' }));
  const live = observedParts(events);
  // Backend history stores each record separately; the view merges one turn back together.
  const restored = historyMessages([
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Before' }] },
    { id: 'a2', role: 'assistant', parts: [{ type: 'dynamic-tool', toolCallId: 'q', toolName: 'ask_user', state: 'output-available', input, output }] },
    { id: 'a3', role: 'assistant', parts: [{ type: 'text', text: 'After answer' }] },
    { id: 'a4', role: 'assistant', parts: [{ type: 'dynamic-tool', toolCallId: 'a', toolName: 'approval_demo', state: 'output-available', input: {}, output: { ok: true } }] },
    { id: 'a5', role: 'assistant', parts: [{ type: 'text', text: 'After approval' }] },
  ]);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0]!.content, live);
  assert.deepEqual(live.map(p => p.type === 'text' ? p.text : p.type === 'tool-call' ? p.toolCallId : p.type), ['Before', 'q', 'After answer', 'a', 'After approval']);
});
test('merging keeps user turns as boundaries and drops nothing', () => {
  const merged = mergeAssistantRuns([
    { id: 'u1', role: 'user', content: 'one' },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'x' }] },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'y' }] },
    { id: 'u2', role: 'user', content: 'two' },
    { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'z' }] },
  ]);
  assert.deepEqual(merged.map(m => m.id), ['u1', 'a1', 'u2', 'a3']);
  assert.equal(typeof merged[1]!.content !== 'string' && merged[1]!.content.length, 2);
});
test('live denial reasons and recorded times flow into display parts', () => {
  const parts = observedParts([
    { sequence: 1, type: 'tool_started', data: { toolCallId: 'a', name: 'approval_demo', input: { message: 'm' } } },
    { sequence: 2, type: 'tool_failed', data: { toolCallId: 'a', code: 'tool_failed', reason: 'user_denied' } },
  ]);
  assert.deepEqual(parts[0], { type: 'tool-call', toolCallId: 'a', toolName: 'approval_demo', argsText: '{"message":"m"}', result: '{"error":"user_denied"}', isError: true });
  const [message] = historyMessages([{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { createdAt: '2026-09-29T09:00:00.000Z' } }]);
  assert.equal(message!.createdAt?.toISOString(), '2026-09-29T09:00:00.000Z');
  assert.deepEqual(message!.metadata?.custom, { time: '2026-09-29T09:00:00.000Z' });
  const [untimed] = historyMessages([{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]);
  assert.equal(untimed!.createdAt, undefined, 'no invented timestamps for old history');
});
test('system diagnostics stay outside the chat transcript', () => {
  assert.deepEqual(historyMessages([{ id: 'system', role: 'system', parts: [{ type: 'text', text: 'private diagnostic' }] }]), []);
});
