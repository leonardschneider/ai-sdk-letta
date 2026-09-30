import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyMessages, observedParts } from '../src/messages.js';

test('assistant-ui converters render text and observed tools only, including old history', () => {
  const result = observedParts([
    { sequence: 1, type: 'text', data: { text: 'Hello ' } },
    { sequence: 2, type: 'text', data: { text: 'world' } },
    { sequence: 3, type: 'tool_started', data: { name: 'text_stats', toolCallId: 't1', input: { text: 'hello' } } },
    { sequence: 4, type: 'tool_completed', data: { toolCallId: 't1', output: { words: 1 } } },
  ]);
  assert.equal(result.length, 2); assert.deepEqual(result[0], { type: 'text', text: 'Hello world' });
  assert.equal(result[1].type, 'tool-call');
  const history = historyMessages([{ id: 'old', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'text_stats', toolCallId: 't1', input: { text: 'hello' }, state: 'output-available', output: { words: 1 } }] }]);
  assert.deepEqual(history[0].content, [{ type: 'tool-call', toolCallId: 't1', toolName: 'text_stats', argsText: '{"text":"hello"}', result: { words: 1 }, isError: false }]);
});
