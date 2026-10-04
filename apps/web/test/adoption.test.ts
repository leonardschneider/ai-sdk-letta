import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyMessages } from '../src/messages.js';
import { toolLabel, toolSummary } from '../src/presentation.js';

test('Letta Code tool calls in an adopted agent\'s history render as generic "Used <tool>" lines', () => {
  const messages = historyMessages([
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'check the build' }] },
    { id: 't1', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'Bash', toolCallId: 'c1', state: 'output-available', input: { command: 'npm test' }, output: 'ok… [truncated]' } as never] },
    { id: 't2', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'Agent', toolCallId: 'c2', state: 'output-error', input: {}, errorText: 'failed' } as never] },
    { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
  ]);
  const calls = messages.flatMap(m => (m.content as { type: string; toolName?: string }[]).filter(p => p.type === 'tool-call'));
  assert.deepEqual(calls.map(c => c.toolName), ['Bash', 'Agent']);
  assert.equal(toolLabel('Bash', 'done', 'ok', { command: 'npm test' }), 'Used Bash');
  assert.equal(toolLabel('TodoWrite', 'done', 'ok'), 'Used Todo Write');
  assert.equal(toolLabel('Agent', 'error', 'failed'), 'Agent didn’t complete');
  assert.doesNotThrow(() => toolSummary('Bash', 'plain text output', {}));
  assert.doesNotThrow(() => toolSummary('Read', undefined, {}));
});
