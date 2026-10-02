/**
 * Register the example definitions with a Conductor server (OSS: no
 * authentication): the task `ai_sdk_letta_turn` and both workflows.
 *
 *   CONDUCTOR_URL=http://127.0.0.1:8080 npm run register --workspace @ai-sdk-letta/example-orchestration
 */
import { readFileSync } from 'node:fs';

const base = (process.env.CONDUCTOR_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const file = (name: string) => JSON.parse(readFileSync(new URL(`../conductor/${name}`, import.meta.url), 'utf8')) as unknown;
async function call(method: string, path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
}
await call('POST', '/api/metadata/taskdefs', file('ai_sdk_letta_turn.taskdef.json'));
// PUT creates or updates.
await call('PUT', '/api/metadata/workflow', [file('ai_sdk_letta_run_turn.json'), file('ai_sdk_letta_run_turn_worker.json')]);
console.log(`Registered ai_sdk_letta_turn, ai_sdk_letta_run_turn and ai_sdk_letta_run_turn_worker on ${base}.`);
