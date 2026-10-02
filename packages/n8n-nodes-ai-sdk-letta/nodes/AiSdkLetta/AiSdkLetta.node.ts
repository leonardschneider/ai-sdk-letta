import type { IDataObject, IExecuteFunctions, IHttpRequestMethods, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { runFailure, type AutomationRun } from './run';

/** Longest single request the node makes while waiting (the server answers sooner when the run ends). */
const POLL_SECONDS = 50;

/**
 * Talks to the automation API of an ai-sdk-letta server: start a turn of the
 * agent, wait for the reply, get a run, cancel it. A run that needed a person
 * (approval or question) fails with `approval_required` / `question_required`,
 * so the workflow can branch on it ("On Error → Continue (using error output)").
 */
export class AiSdkLetta implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ai-sdk-letta',
		name: 'aiSdkLetta',
		icon: 'file:aiSdkLetta.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ {"run": "Run turn and wait", "start": "Start turn", "get": "Get run", "cancel": "Cancel run"}[$parameter["operation"]] }}',
		description: 'Run a turn of an ai-sdk-letta agent and get its reply',
		defaults: { name: 'ai-sdk-letta' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'aiSdkLettaApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'run',
				options: [
					{ name: 'Run Turn and Wait', value: 'run', action: 'Run a turn and wait for the reply', description: 'Send a message to the agent and wait until it replied' },
					{ name: 'Start Turn', value: 'start', action: 'Start a turn', description: 'Send a message to the agent without waiting' },
					{ name: 'Get Run', value: 'get', action: 'Get a run', description: 'Get a run, optionally waiting until it ended' },
					{ name: 'Cancel Run', value: 'cancel', action: 'Cancel a run', description: 'Stop a running turn, or withdraw one that waits' },
				],
			},
			{
				displayName: 'Message',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				description: 'What the agent receives, as a new message (up to 8,000 characters)',
				displayOptions: { show: { operation: ['run', 'start'] } },
			},
			{
				displayName: 'Conversation',
				name: 'conversation',
				type: 'options',
				default: 'title',
				options: [
					{ name: 'By Title (Reuse or Create)', value: 'title', description: 'The newest conversation with this title, or a new one' },
					{ name: 'New Conversation', value: 'new', description: 'Always a new conversation with this title' },
					{ name: 'By ID', value: 'id', description: 'An existing conversation, by the ID a previous run returned' },
				],
				displayOptions: { show: { operation: ['run', 'start'] } },
			},
			{
				displayName: 'Conversation Title',
				name: 'title',
				type: 'string',
				default: '',
				placeholder: 'Nightly report',
				description: 'Leave empty to use the token’s name',
				displayOptions: { show: { operation: ['run', 'start'], conversation: ['title', 'new'] } },
			},
			{
				displayName: 'Conversation ID',
				name: 'threadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['run', 'start'], conversation: ['id'] } },
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '={{ $execution.id }}-{{ $runIndex }}-{{ $itemIndex }}',
				description: 'The same key never starts a second turn (n8n retries are safe). The default is unique per execution, node run and item.',
				displayOptions: { show: { operation: ['run', 'start'] } },
			},
			{
				displayName: 'Run ID',
				name: 'runId',
				type: 'string',
				default: '={{ $json.id }}',
				required: true,
				displayOptions: { show: { operation: ['get', 'cancel'] } },
			},
			{
				displayName: 'Wait (Seconds)',
				name: 'waitSeconds',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 3600 },
				default: 600,
				description: 'How long to wait for the run to end. When it is still running after that, the node fails with "timeout" (the run goes on).',
				displayOptions: { show: { operation: ['run'] } },
			},
			{
				displayName: 'Wait (Seconds)',
				name: 'getWaitSeconds',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 3600 },
				default: 0,
				description: 'Wait until the run ended, up to this long (0: answer at once)',
				displayOptions: { show: { operation: ['get'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { operation: ['run', 'start'] } },
				options: [
					{
						displayName: 'Reply Mode',
						name: 'replyMode',
						type: 'options',
						default: 'always',
						description: 'Team servers: whether the agent must reply (the token’s setting by default)',
						options: [
							{ name: 'Always Reply', value: 'always' },
							{ name: 'When Mentioned or Asked', value: 'when-addressed' },
							{ name: 'Agent Decides', value: 'agent-decides' },
						],
					},
					{
						displayName: 'Fail When the Run Fails',
						name: 'failOnError',
						type: 'boolean',
						default: true,
						description: 'Whether a run that did not complete (for example approval_required) fails the node. Off: it is returned as an item with status "failed" and error.code.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('aiSdkLettaApi');
		const base = String(credentials.serverUrl ?? '').replace(/\/+$/, '');
		const request = async (method: IHttpRequestMethods, path: string, body?: IDataObject): Promise<AutomationRun & IDataObject> => {
			try {
				return await this.helpers.httpRequestWithAuthentication.call(this, 'aiSdkLettaApi', {
					method, url: `${base}${path}`, json: true, ...(body ? { body } : {}), timeout: (POLL_SECONDS + 15) * 1000,
				}) as AutomationRun & IDataObject;
			} catch (error) {
				throw new NodeApiError(this.getNode(), error as never, { message: 'The ai-sdk-letta server refused the request' });
			}
		};
		/** Wait for a run to end, `seconds` at most, in requests the server holds up to POLL_SECONDS each. */
		const waitFor = async (run: AutomationRun & IDataObject, seconds: number) => {
			const until = Date.now() + seconds * 1000;
			let current = run;
			while ((current.status === 'queued' || current.status === 'running') && Date.now() < until) {
				const left = Math.max(1, Math.min(POLL_SECONDS, Math.ceil((until - Date.now()) / 1000)));
				current = await request('GET', `/v1/automation/runs/${encodeURIComponent(current.id)}?wait=${left}`);
			}
			return current;
		};
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				let run: AutomationRun & IDataObject;
				let failOnError = true;
				if (operation === 'run' || operation === 'start') {
					const conversation = this.getNodeParameter('conversation', itemIndex) as string;
					const options = this.getNodeParameter('options', itemIndex, {}) as { replyMode?: string; failOnError?: boolean };
					failOnError = options.failOnError !== false;
					const title = conversation === 'id' ? '' : (this.getNodeParameter('title', itemIndex, '') as string).trim();
					const body: IDataObject = {
						text: this.getNodeParameter('text', itemIndex) as string,
						idempotencyKey: this.getNodeParameter('idempotencyKey', itemIndex) as string,
						...(conversation === 'id' ? { threadId: this.getNodeParameter('threadId', itemIndex) as string } : {}),
						...(title ? { title } : {}),
						...(conversation === 'new' ? { newConversation: true } : {}),
						...(options.replyMode ? { replyMode: options.replyMode } : {}),
					};
					run = await request('POST', '/v1/automation/runs', body);
					if (operation === 'run') {
						run = await waitFor(run, this.getNodeParameter('waitSeconds', itemIndex) as number);
						if (run.status === 'queued' || run.status === 'running') throw new NodeOperationError(this.getNode(), `The run is still ${run.status} (timeout). It goes on; get it later with its ID ${run.id}.`, { itemIndex, description: 'timeout' });
					}
				} else if (operation === 'get') {
					const id = this.getNodeParameter('runId', itemIndex) as string;
					run = await waitFor(await request('GET', `/v1/automation/runs/${encodeURIComponent(id)}`), this.getNodeParameter('getWaitSeconds', itemIndex) as number);
					failOnError = false;
				} else {
					const id = this.getNodeParameter('runId', itemIndex) as string;
					await request('POST', `/v1/automation/runs/${encodeURIComponent(id)}/cancel`, {});
					run = await request('GET', `/v1/automation/runs/${encodeURIComponent(id)}?wait=10`);
					failOnError = false;
				}
				const failure = runFailure(run);
				if (failure && failOnError && operation === 'run') {
					// The run, for the error output: its code (approval_required, question_required, ...), tool and conversation.
					const error = new NodeOperationError(this.getNode(), failure.message, { itemIndex, description: failure.code });
					(error as unknown as { run: AutomationRun }).run = run;
					throw error;
				}
				output.push({ json: run, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (this.continueOnFail()) {
					// Only an `error` key: n8n routes the item to the node's error output ("Continue (using error output)").
					const run = (error as { run?: AutomationRun }).run;
					const failure = run ? runFailure(run) : undefined;
					output.push({ json: { error: {
						code: failure?.code ?? (error as { description?: string }).description ?? 'request_failed', message: (error as Error).message,
						...(failure?.tool ? { tool: failure.tool } : {}), ...(run ? { runId: run.id, ...(run.conversation ? { conversationId: run.conversation.id } : {}), ...(run.text ? { text: run.text } : {}) } : {}),
					} } as IDataObject, pairedItem: { item: itemIndex } });
					continue;
				}
				if (error instanceof NodeOperationError || error instanceof NodeApiError) throw error;
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}
		return [output];
	}
}
