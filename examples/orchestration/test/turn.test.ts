import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { turnStep, STEP_WAIT_SECONDS, DECISION_CALLBACK_SECONDS, type TurnApi } from '../src/turn.js';

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
  assert.deepEqual(workflow.tasks.map(t => t.type), ['HTTP', 'DO_WHILE', 'SWITCH'], 'Conductor OSS has no HTTP_POLL task');
  assert.match(JSON.stringify(workflow), /\$\{workflow\.secrets\.AI_SDK_LETTA_TOKEN\}/);
});

test('decisions: decision_pending keeps the task in progress (checking every minute); after the decision it follows the resumed run to the end', async () => {
  const asked = fake([{ status: 200, body: { id: 'run-1', status: 'decision_pending', text: 'Which format?', decision: { id: 'd-1', status: 'pending', question: 'Which format?' } } }]);
  const first = await turnStep(asked.api, { workflowId: 'wf-3', text: 'Report' });
  assert.deepEqual(first, { status: 'IN_PROGRESS', callbackAfterSeconds: DECISION_CALLBACK_SECONDS, outputData: { runId: 'run-1', decisionId: 'd-1', status: 'decision_pending', decision: { id: 'd-1', status: 'pending', question: 'Which format?' } } });
  const still = fake([{ status: 200, body: { id: 'd-1', status: 'pending' } }]);
  assert.equal((await turnStep(still.api, { workflowId: 'wf-3', text: 'Report', runId: 'run-1', decisionId: 'd-1' })).status, 'IN_PROGRESS');
  assert.equal(still.calls[0]!.path, `/v1/automation/decisions/d-1?wait=${STEP_WAIT_SECONDS}`);
  const decided = fake([
    { status: 200, body: { id: 'd-1', status: 'decided', choice: { id: 'md' }, resume: { runId: 'run-2', state: 'delivered' } } },
    { status: 200, body: { id: 'run-2', status: 'completed', text: 'Report in Markdown.', resumes: { decisionId: 'd-1', outcome: 'decided' } } },
  ]);
  const done = await turnStep(decided.api, { workflowId: 'wf-3', text: 'Report', runId: 'run-1', decisionId: 'd-1' });
  assert.equal(done.status, 'COMPLETED');
  assert.equal((done.outputData as { text: string }).text, 'Report in Markdown.');
  assert.equal(decided.calls[1]!.path, `/v1/automation/runs/run-2?wait=${STEP_WAIT_SECONDS}`);
  const withdrawn = fake([{ status: 200, body: { id: 'd-1', status: 'cancelled', cancelReason: 'withdrawn' } }]);
  assert.equal((await turnStep(withdrawn.api, { workflowId: 'wf-3', text: 'Report', runId: 'run-1', decisionId: 'd-1' })).status, 'FAILED_WITH_TERMINAL_ERROR');
});

test('the no-worker decisions workflow polls the decision, then the resumed run, with Conductor\'s own tasks', () => {
  const workflow = JSON.parse(readFileSync(new URL('../conductor/ai_sdk_letta_run_turn_decisions.json', import.meta.url), 'utf8')) as { tasks: { type: string; decisionCases?: Record<string, { type: string; loopOver?: { inputParameters: { uri: string } }[] }[]> }[] };
  assert.deepEqual(workflow.tasks.map(t => t.type), ['HTTP', 'DO_WHILE', 'SWITCH']);
  const branch = workflow.tasks[2]!.decisionCases!.decision!;
  assert.deepEqual(branch.map(t => t.type), ['DO_WHILE', 'DO_WHILE', 'TERMINATE']);
  assert.match(branch[0]!.loopOver![0]!.inputParameters.uri, /\/v1\/automation\/decisions\/\$\{check_ref\.output\.response\.body\.decision\.id\}\?wait=110$/);
  assert.match(branch[1]!.loopOver![0]!.inputParameters.uri, /\/v1\/automation\/runs\/\$\{decision_ref\.output\.response\.body\.resume\.runId\}\?wait=110$/);
});

test('a decision made before the worker looked: the run reads completed, and the worker follows the resumed run', async () => {
  const api = fake([
    { status: 200, body: { id: 'run-1', status: 'completed', text: 'Which tone?', decision: { id: 'd-1', status: 'decided' } } },
    { status: 200, body: { id: 'd-1', status: 'decided', resume: { runId: 'run-2', state: 'delivered' } } },
    { status: 200, body: { id: 'run-2', status: 'completed', text: 'Playful digest.' } },
  ]);
  const result = await turnStep(api.api, { workflowId: 'wf-4', text: 'Digest', runId: 'run-1' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal((result.outputData as { text: string }).text, 'Playful digest.');
  assert.deepEqual(api.calls.map(c => c.path), [`/v1/automation/runs/run-1?wait=${STEP_WAIT_SECONDS}`, `/v1/automation/decisions/d-1?wait=${STEP_WAIT_SECONDS}`, `/v1/automation/runs/run-2?wait=${STEP_WAIT_SECONDS}`]);
});
