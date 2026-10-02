import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { turnStep, STEP_WAIT_SECONDS, type TurnApi } from '../src/turn.js';

function fake(replies: { status: number; body: Record<string, unknown> }[]) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const api: TurnApi = async (method, path, body) => { calls.push({ method, path, ...(body ? { body } : {}) }); return replies.shift()!; };
  return { api, calls };
}

test('the worker starts the turn with the workflow as idempotency key, stays in progress while it runs, then completes', async () => {
  const first = fake([{ status: 202, body: { id: 'run-1', status: 'running' } }]);
  assert.deepEqual(await turnStep(first.api, { workflowId: 'wf-1', text: 'Report', title: 'Daily' }), { status: 'IN_PROGRESS', callbackAfterSeconds: 1, outputData: { runId: 'run-1', status: 'running' } });
  assert.deepEqual(first.calls[0], { method: 'POST', path: `/v1/automation/runs?wait=${STEP_WAIT_SECONDS}`, body: { text: 'Report', idempotencyKey: 'conductor-wf-1', title: 'Daily' } });
  const next = fake([{ status: 200, body: { id: 'run-1', status: 'completed', text: 'All green.' } }]);
  const done = await turnStep(next.api, { workflowId: 'wf-1', text: 'Report', runId: 'run-1' });
  assert.equal(done.status, 'COMPLETED'); assert.equal((done.outputData as { text: string }).text, 'All green.');
  assert.equal(next.calls[0]!.path, `/v1/automation/runs/run-1?wait=${STEP_WAIT_SECONDS}`);
});

test('approval_required fails the task for good; rate limits fail so Conductor can retry', async () => {
  const refused = fake([{ status: 200, body: { id: 'run-2', status: 'failed', error: { code: 'approval_required', tool: 'publish', message: 'publish needs approval' } } }]);
  const result = await turnStep(refused.api, { workflowId: 'wf-2', text: 'Publish' });
  assert.equal(result.status, 'FAILED_WITH_TERMINAL_ERROR');
  assert.equal((result as { reasonForIncompletion: string }).reasonForIncompletion, 'approval_required: publish needs approval');
  assert.equal((await turnStep(fake([{ status: 429, body: { error: 'rate_limited' } }]).api, { workflowId: 'w', text: 'x' })).status, 'FAILED');
  assert.equal((await turnStep(fake([{ status: 401, body: { error: 'unauthorized' } }]).api, { workflowId: 'w', text: 'x' })).status, 'FAILED_WITH_TERMINAL_ERROR');
});

test('the Conductor definitions are valid JSON and use the token only through a secret', () => {
  const directory = new URL('../conductor/', import.meta.url);
  for (const name of readdirSync(directory)) {
    const text = readFileSync(new URL(name, directory), 'utf8');
    JSON.parse(text);
    assert.doesNotMatch(text, /lta_[A-Za-z0-9_-]{10,}/, `${name} holds no token`);
  }
  const workflow = JSON.parse(readFileSync(new URL('ai_sdk_letta_run_turn.json', directory), 'utf8')) as { tasks: { type: string; inputParameters: Record<string, unknown> }[] };
  assert.deepEqual(workflow.tasks.map(t => t.type), ['HTTP', 'HTTP_POLL', 'SWITCH']);
  assert.match(JSON.stringify(workflow), /\$\{workflow\.secrets\.AI_SDK_LETTA_TOKEN\}/);
});
