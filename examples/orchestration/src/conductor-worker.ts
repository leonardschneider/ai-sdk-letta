/**
 * A Conductor worker that runs one turn of an ai-sdk-letta agent: task
 * `ai_sdk_letta_turn` (see conductor/). It starts the turn with the
 * workflow's ID as idempotency key (a re-polled or retried task never starts
 * a second turn), then waits for it in short steps: while the turn runs, the
 * task stays IN_PROGRESS and Conductor calls the worker back, so no thread
 * waits on a long turn and the worker can restart at any time.
 *
 *   CONDUCTOR_SERVER_URL=http://127.0.0.1:8080/api \
 *   AI_SDK_LETTA_URL=http://127.0.0.1:4402 AI_SDK_LETTA_TOKEN=lta_… \
 *   npm run worker --workspace @ai-sdk-letta/example-orchestration
 */
import { TaskHandler, createConductorClient, type ConductorWorker, type Task } from '@io-orkes/conductor-javascript';
import { turnStep, type TurnApi } from './turn.js';

const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`Set ${name}`); return value; };
const serverUrl = required('AI_SDK_LETTA_URL').replace(/\/+$/, '');
const token = required('AI_SDK_LETTA_TOKEN');

/** The automation API of the ai-sdk-letta server. */
const api: TurnApi = async (method, path, body) => {
  const response = await fetch(`${serverUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, body: data };
};

const worker: ConductorWorker = {
  taskDefName: 'ai_sdk_letta_turn',
  concurrency: 2,
  pollInterval: 1000,
  execute: async (task: Task) => turnStep(api, {
    workflowId: String(task.workflowInstanceId),
    text: String(task.inputData?.text ?? ''),
    ...(typeof task.inputData?.title === 'string' && task.inputData.title ? { title: task.inputData.title } : {}),
    ...(typeof task.outputData?.runId === 'string' ? { runId: task.outputData.runId } : {}),
  }),
};

const client = await createConductorClient({ serverUrl: required('CONDUCTOR_SERVER_URL') });
const handler = new TaskHandler({ client, workers: [worker], scanForDecorated: false });
await handler.startWorkers();
console.log(`ai_sdk_letta_turn worker polling ${process.env.CONDUCTOR_SERVER_URL} for ${serverUrl}. Stop with Ctrl-C.`);
const stop = () => { void handler.stopWorkers().finally(() => process.exit(0)); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
