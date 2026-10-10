import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { LettaAgent, LettaTurnError, describeTurnError, providerError, MCP_APP_DEV_TOOL_NAMES, type DeliveryHooks } from '../src/index.js';
import { registry } from './fixtures.js';

// What the harness sends when Anthropic rejects the request before the model produced anything.
const REJECTED = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits."},"request_id":"req_1"}';
const errorEvent = { type: 'error', message: REJECTED, errorCode: 'llm_api_error', stopReason: 'llm_api_error', errorDetail: REJECTED, recoverable: false, apiError: { status: 400, message: REJECTED } } as SDKMessage;
const failedResult = { type: 'result', success: false, error: 'error', errorCode: 'llm_api_error', stopReason: 'llm_api_error', durationMs: 1, conversationId: 'c' } as SDKMessage;

function agentWith(events: SDKMessage[], delivery?: DeliveryHooks) {
  return new LettaAgent({ id: 'errors', tools: registry, ...(delivery ? { delivery } : {}), open: () => ({
    send: async () => {}, abort: async () => {}, close: () => {},
    async *stream() { for (const event of events) yield event; },
  }) });
}
async function drain(agent: LettaAgent<typeof registry>, prompt = 'hi') {
  const result = await agent.stream({ prompt });
  const errors: unknown[] = [];
  for await (const part of result.fullStream) if (part.type === 'error') errors.push(part.error);
  return errors;
}

test('the harness error (its message, code and HTTP status) reaches the stream, not just "turn failed"', async () => {
  const agent = agentWith([errorEvent, failedResult]);
  const [error] = await drain(agent);
  assert.ok(error instanceof LettaTurnError);
  assert.equal(error.beforeOutput, true);
  assert.equal(error.info.status, 400);
  assert.equal(error.info.code, 'llm_api_error');
  const line = describeTurnError(error);
  assert.match(line, /^llm_api_error · HTTP 400 · Third-party apps now draw from your extra usage, not your plan limits\. · 400 \{/);
  assert.match(line, /Third-party apps now draw from your extra usage/);
  assert.ok(!line.includes('\n'));
  assert.equal((await agent.lastTurn())?.end, 'failed');
  assert.deepEqual((await agent.lastTurn())?.error?.status, 400);
});

test('describeTurnError is bounded and single-line; falls back to the result or any error', () => {
  const long = new LettaTurnError({ message: `a\n${'x'.repeat(5000)}` }, true);
  const line = describeTurnError(long);
  assert.ok(line.length <= 1000 && !line.includes('\n'));
  assert.equal(describeTurnError(new Error('boom', { cause: new TypeError('inner') })), 'boom · TypeError: inner');
  assert.equal(describeTurnError(undefined), 'unknown error');
});

test('a failed result without an error message still says why', async () => {
  const agent = agentWith([{ ...failedResult, error: 'error', errorDetail: 'Unknown bundled client tool: memory' } as SDKMessage]);
  const [error] = await drain(agent);
  assert.ok(error instanceof LettaTurnError);
  assert.match(describeTurnError(error), /Unknown bundled client tool: memory/);
});

test('a turn rejected before any output is settled (once the backend is idle) and keeps the agent usable', async () => {
  const hooks: string[] = [];
  let turns = 0;
  const agent = new LettaAgent({ id: 'errors', tools: registry,
    delivery: { begin: () => hooks.push('begin'), complete: () => hooks.push('complete'), settle: async ({ outcome }) => { hooks.push(`settle:${outcome}`); return { delivered: true }; } },
    open: () => ({ send: async () => {}, abort: async () => {}, close: () => {},
      async *stream() {
        turns++;
        if (turns === 1) { yield errorEvent; yield failedResult; return; }
        yield { type: 'assistant', content: 'ok', uuid: 'a' } as SDKMessage;
        yield { type: 'result', success: true, durationMs: 1, conversationId: 'c' } as SDKMessage;
      } }) });
  const errors = await drain(agent);
  assert.equal(errors.length, 1);
  const outcome = await agent.lastTurn();
  assert.deepEqual({ end: outcome?.end, settled: outcome?.settled, delivered: outcome?.delivered, status: outcome?.error?.status }, { end: 'failed', settled: true, delivered: true, status: 400 });
  assert.deepEqual(hooks, ['begin', 'settle:failed']);
  // The next turn runs (nothing was replayed).
  const next = await agent.stream({ prompt: 'again' });
  assert.equal(await next.text, 'ok');
});

test('a failure after the model produced output stays uncertain (the agent refuses further turns)', async () => {
  let settled = 0;
  const agent = agentWith([{ type: 'assistant', content: 'partial', uuid: 'a' } as SDKMessage, errorEvent, failedResult],
    { begin: () => {}, complete: () => {}, settle: async () => { settled++; } });
  await drain(agent);
  const outcome = await agent.lastTurn();
  assert.equal(outcome?.end, 'failed');
  assert.notEqual(outcome?.settled, true);
  assert.equal(settled, 0);
  await assert.rejects(agent.stream({ prompt: 'again' }), /delivery uncertain/);
});

test('a pre-output failure whose settlement fails (backend still busy) stays uncertain', async () => {
  const agent = agentWith([errorEvent, failedResult], { begin: () => {}, complete: () => {}, settle: async () => { throw new Error('still running'); } });
  await drain(agent);
  const outcome = await agent.lastTurn();
  assert.equal(outcome?.end, 'failed');
  assert.notEqual(outcome?.settled, true);
  await assert.rejects(agent.stream({ prompt: 'again' }), /delivery uncertain/);
});

test('no agent tool name starts with "mcp_" (Anthropic rejects such requests as third-party apps)', () => {
  assert.ok(MCP_APP_DEV_TOOL_NAMES.length > 0);
  for (const name of MCP_APP_DEV_TOOL_NAMES) assert.ok(!/^mcp_/i.test(name), name);
});

test('the provider status and message are found in the harness error text (as the local backend nests it)', () => {
  const nested = JSON.stringify({ error: { error: { type: 'local_backend_error', message: REJECTED, detail: REJECTED }, run_id: 'local-run-1' } }, null, 1);
  assert.deepEqual(providerError(nested), { status: 400, message: 'Third-party apps now draw from your extra usage, not your plan limits.' });
  const line = describeTurnError(new LettaTurnError({ message: nested, code: 'error' }, true));
  assert.match(line, /^HTTP 400 · Third-party apps now draw from your extra usage, not your plan limits\. · \{/);
  assert.deepEqual(providerError('Unknown bundled client tool: memory'), {});
});
