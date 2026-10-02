import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiSdkLetta } from '../nodes/AiSdkLetta/AiSdkLetta.node.js';
import { AiSdkLettaApi } from '../credentials/AiSdkLettaApi.credentials';
import { runFailure, type AutomationRun } from '../nodes/AiSdkLetta/run';

type Request = { method: string; url: string; body?: Record<string, unknown> };

/** A minimal IExecuteFunctions for one item, recording the requests the node makes. */
function context(parameters: Record<string, unknown>, replies: ((request: Request) => unknown)[], options: { continueOnFail?: boolean } = {}) {
	const requests: Request[] = [];
	const self = {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({ serverUrl: 'http://host.docker.internal:4402/', token: 'lta_x' }),
		getNodeParameter: (name: string, _index: number, fallback?: unknown) => (name in parameters ? parameters[name] : fallback),
		getNode: () => ({ name: 'ai-sdk-letta', type: 'n8n-nodes-ai-sdk-letta.aiSdkLetta', typeVersion: 1, parameters: {} }),
		continueOnFail: () => !!options.continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async (credential: string, request: Request & { json: boolean }) => {
				assert.equal(credential, 'aiSdkLettaApi');
				requests.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
				const reply = replies.shift();
				if (!reply) throw new Error('unexpected request');
				return reply(request);
			},
		},
	};
	return { self, requests };
}
const run = (overrides: Partial<AutomationRun>): AutomationRun => ({ id: 'run-1', status: 'running', conversation: { id: 'thread-1', title: 'Nightly' }, ...overrides });

test('Run Turn and Wait: starts with the idempotency key, waits in bounded polls, and returns the reply', async () => {
	const { self, requests } = context({ operation: 'run', text: 'Summarise', conversation: 'title', title: 'Nightly', idempotencyKey: 'exec-1-0-0', waitSeconds: 600, options: {} }, [
		() => run({}),
		() => run({}),
		() => run({ status: 'completed', text: 'All green.', tools: [] }),
	]);
	const [items] = await new AiSdkLetta().execute.call(self as never);
	assert.equal(items!.length, 1);
	assert.equal(items![0]!.json.text, 'All green.');
	assert.deepEqual(requests[0], { method: 'POST', url: 'http://host.docker.internal:4402/v1/automation/runs', body: { text: 'Summarise', idempotencyKey: 'exec-1-0-0', title: 'Nightly' } });
	assert.match(requests[1]!.url, /\/v1\/automation\/runs\/run-1\?wait=50$/);
	assert.equal(requests.length, 3);
});

test('approval_required fails the node with the code first; with "continue (error output)" it becomes an error item for the branch', async () => {
	const failed = run({ status: 'failed', text: 'I could not publish.', error: { code: 'approval_required', tool: 'publish', message: 'publish needs approval, and nobody can approve it in an unattended run.' } });
	const { self } = context({ operation: 'run', text: 'Publish', conversation: 'new', title: '', idempotencyKey: 'k', waitSeconds: 60, options: { replyMode: 'always' } }, [() => failed]);
	await assert.rejects(new AiSdkLetta().execute.call(self as never), (error: Error & { description?: string }) => error.message.startsWith('approval_required: publish needs approval') && error.description === 'approval_required');
	const branch = context({ operation: 'run', text: 'Publish', conversation: 'new', title: '', idempotencyKey: 'k', waitSeconds: 60, options: {} }, [() => failed], { continueOnFail: true });
	const [items] = await new AiSdkLetta().execute.call(branch.self as never);
	assert.deepEqual(Object.keys(items![0]!.json), ['error'], 'only an error key: n8n routes it to the error output');
	assert.deepEqual(items![0]!.json.error, { code: 'approval_required', message: 'approval_required: publish needs approval, and nobody can approve it in an unattended run.', tool: 'publish', runId: 'run-1', conversationId: 'thread-1', text: 'I could not publish.' });
	assert.deepEqual(branch.requests[0]!.body, { text: 'Publish', idempotencyKey: 'k', newConversation: true });
	// Opting out: the failed run is a normal item.
	const plain = context({ operation: 'run', text: 'Publish', conversation: 'id', threadId: 'thread-1', idempotencyKey: 'k', waitSeconds: 60, options: { failOnError: false } }, [() => failed]);
	const [same] = await new AiSdkLetta().execute.call(plain.self as never);
	assert.equal(same![0]!.json.status, 'failed');
	assert.deepEqual(plain.requests[0]!.body, { text: 'Publish', idempotencyKey: 'k', threadId: 'thread-1' });
});

test('a run still going after the wait fails with "timeout"; Start, Get and Cancel', async () => {
	const { self } = context({ operation: 'run', text: 'x', conversation: 'title', title: '', idempotencyKey: 'k', waitSeconds: 0, options: {} }, [() => run({})]);
	await assert.rejects(new AiSdkLetta().execute.call(self as never), (error: Error & { description?: string }) => error.description === 'timeout' && /still running/.test(error.message));
	const started = context({ operation: 'start', text: 'x', conversation: 'title', title: '', idempotencyKey: 'k', options: {} }, [() => run({ status: 'queued' })]);
	assert.equal((await new AiSdkLetta().execute.call(started.self as never))[0]![0]!.json.status, 'queued');
	const got = context({ operation: 'get', runId: 'run-1', getWaitSeconds: 0 }, [() => run({ status: 'failed', error: { code: 'question_required', message: 'm', tool: 'ask_user' } })]);
	assert.equal((await new AiSdkLetta().execute.call(got.self as never))[0]![0]!.json.status, 'failed', 'Get returns failed runs as items');
	const cancelled = context({ operation: 'cancel', runId: 'run-1' }, [() => ({ accepted: true }), () => run({ status: 'cancelled' })]);
	assert.equal((await new AiSdkLetta().execute.call(cancelled.self as never))[0]![0]!.json.status, 'cancelled');
	assert.equal(cancelled.requests[0]!.url, 'http://host.docker.internal:4402/v1/automation/runs/run-1/cancel');
});

test('runFailure, credentials and the package follow n8n conventions', () => {
	assert.equal(runFailure(run({ status: 'completed' })), undefined);
	assert.deepEqual(runFailure(run({ status: 'cancelled' })), { code: 'cancelled', message: 'cancelled: The run cancelled.' });
	const credentials = new AiSdkLettaApi();
	assert.equal(credentials.name, 'aiSdkLettaApi');
	assert.equal(credentials.properties.find(p => p.name === 'token')?.typeOptions?.password, true, 'the token is a password field');
	assert.equal(credentials.authenticate.properties.headers!.Authorization, '=Bearer {{$credentials.token}}');
	assert.equal(credentials.test.request.url, '/v1/automation/whoami');
	const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { name: string; private: boolean; keywords: string[]; license: string; n8n: { nodes: string[]; credentials: string[] }; dependencies?: unknown };
	assert.match(manifest.name, /^n8n-nodes-/);
	assert.ok(manifest.keywords.includes('n8n-community-node-package'));
	assert.equal(manifest.license, 'MIT');
	assert.equal(manifest.private, true, 'not published yet');
	assert.equal(manifest.dependencies, undefined, 'no runtime dependencies');
	assert.deepEqual(manifest.n8n.nodes, ['dist/nodes/AiSdkLetta/AiSdkLetta.node.js']);
	const workflow = JSON.parse(readFileSync(join(__dirname, '..', 'examples', 'nightly-report.workflow.json'), 'utf8')) as { nodes: { type: string; onError?: string; parameters: Record<string, unknown> }[] };
	assert.ok(workflow.nodes.some(node => node.type === 'n8n-nodes-base.scheduleTrigger'));
	assert.equal(workflow.nodes.find(node => node.type === 'n8n-nodes-ai-sdk-letta.aiSdkLetta')?.onError, 'continueErrorOutput');
});

const pending = (overrides: Partial<AutomationRun> = {}): AutomationRun => run({ status: 'decision_pending', text: 'Which format should I use?', decision: { id: 'd-1', status: 'pending', question: 'Which format?', options: [{ id: 'md', label: 'Markdown' }], conversation: { id: 'thread-1' } }, ...overrides });

test('decision_pending is not a failure: Run Turn and Wait returns it with the decision', async () => {
	assert.equal(runFailure(pending()), undefined);
	const { self, requests } = context({ operation: 'run', text: 'Report', conversation: 'title', title: '', idempotencyKey: 'k', waitSeconds: 60, options: {} }, [() => pending()]);
	const [items] = await new AiSdkLetta().execute.call(self as never);
	assert.equal(items![0]!.json.status, 'decision_pending');
	assert.equal((items![0]!.json.decision as { id: string }).id, 'd-1');
	assert.equal(requests.length, 1);
});

test('"Wait Through Decisions" waits for the decision, then for the run that resumed the work', async () => {
	const decided = { id: 'd-1', status: 'decided', question: 'Which format?', options: [], conversation: { id: 'thread-1' }, decidedBy: { name: 'Mia' }, choice: { id: 'md', label: 'Markdown' }, resume: { runId: 'run-2', state: 'delivered' } };
	const { self, requests } = context({ operation: 'run', text: 'Report', conversation: 'title', title: '', idempotencyKey: 'k', waitSeconds: 600, options: { waitDecisions: true } }, [
		() => pending(),
		() => ({ ...decided, status: 'pending', resume: undefined }),
		() => decided,
		() => run({ id: 'run-2', status: 'running' }),
		() => run({ id: 'run-2', status: 'completed', text: 'Here is the report in Markdown.', resumes: { decisionId: 'd-1', outcome: 'decided', choice: { id: 'md', label: 'Markdown' } } }),
	]);
	const [items] = await new AiSdkLetta().execute.call(self as never);
	assert.equal(items![0]!.json.id, 'run-2');
	assert.equal(items![0]!.json.text, 'Here is the report in Markdown.');
	assert.equal((items![0]!.json.decided as { decidedBy: { name: string } }).decidedBy.name, 'Mia');
	assert.deepEqual(requests.map(r => r.url.replace('http://host.docker.internal:4402', '')), [
		'/v1/automation/runs', '/v1/automation/decisions/d-1', '/v1/automation/decisions/d-1?wait=50', '/v1/automation/runs/run-2', '/v1/automation/runs/run-2?wait=50',
	]);
});

test('Wait for Decision: returns the resumed run, the decision alone, a stopped run, or fails with timeout while nobody decided', async () => {
	const decided = (status: string) => ({ id: 'd-1', status, question: 'Which format?', options: [], conversation: { id: 'thread-1' }, decidedBy: { name: 'Mia' }, resume: { runId: 'run-2', state: 'delivered' } });
	const follow = context({ operation: 'decision', decisionId: 'd-1', decisionWaitSeconds: 60, followRun: true }, [() => decided('stopped'), () => run({ id: 'run-2', status: 'completed', text: 'Stopped as asked.', resumes: { decisionId: 'd-1', outcome: 'stopped' } })]);
	const [items] = await new AiSdkLetta().execute.call(follow.self as never);
	assert.equal(items![0]!.json.text, 'Stopped as asked.');
	assert.equal((items![0]!.json.resumes as { outcome: string }).outcome, 'stopped');
	const only = context({ operation: 'decision', decisionId: 'd-1', decisionWaitSeconds: 60, followRun: false }, [() => decided('decided')]);
	assert.equal((await new AiSdkLetta().execute.call(only.self as never))[0]![0]!.json.status, 'decided');
	const waiting = context({ operation: 'decision', decisionId: 'd-1', decisionWaitSeconds: 0, followRun: true }, [() => ({ ...decided('pending'), resume: undefined })]);
	await assert.rejects(new AiSdkLetta().execute.call(waiting.self as never), (error: Error & { description?: string }) => error.description === 'timeout' && /Nobody has decided/.test(error.message));
	const description = new AiSdkLetta().description;
	assert.ok(description.properties.find(p => p.name === 'operation')!.options!.some(o => (o as { value: string }).value === 'decision'));
});

test('a decision made before the node looked: the run reads completed with a decided decision, and the node still follows the resumed run', async () => {
	const decided = { id: 'd-1', status: 'decided', question: 'Which cuisine?', options: [], conversation: { id: 'thread-1' }, decidedBy: { name: 'Leonard' }, choice: { id: 'thai', label: 'Thai' }, resume: { runId: 'run-2', state: 'delivered' } };
	const { self, requests } = context({ operation: 'run', text: 'Lunch', conversation: 'new', title: '', idempotencyKey: 'k', waitSeconds: 600, options: { waitDecisions: true } }, [
		() => run({ status: 'queued' }),
		() => run({ status: 'completed', text: 'Which cuisine?', decision: decided as never }),
		() => decided,
		() => run({ id: 'run-2', status: 'completed', text: 'Thai at noon.', resumes: { decisionId: 'd-1', outcome: 'decided' } }),
	]);
	const [items] = await new AiSdkLetta().execute.call(self as never);
	assert.equal(items![0]!.json.id, 'run-2'); assert.equal(items![0]!.json.text, 'Thai at noon.');
	assert.equal(requests.length, 4);
	// Without the option, the first run is returned as it is.
	const plain = context({ operation: 'run', text: 'Lunch', conversation: 'new', title: '', idempotencyKey: 'k', waitSeconds: 600, options: {} }, [() => run({ status: 'completed', text: 'Which cuisine?', decision: decided as never })]);
	assert.equal((await new AiSdkLetta().execute.call(plain.self as never))[0]![0]!.json.id, 'run-1');
});
