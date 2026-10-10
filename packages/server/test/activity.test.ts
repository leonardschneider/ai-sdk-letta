import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { LettaAgent, ToolInteractions } from 'ai-sdk-letta';
import { ThreadRuntime, activityState, activitySummary, activitySummaryRoute, agentActivity, runtimeRoutes, stepLabel, turnStep, type RuntimeHost } from '../src/index.js';
import { tools } from './fixtures.js';

/** A runtime whose turns call text_stats and wait for approval ('approve'), or stream text until released ('slow'). */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-activity-'));
  let release = () => {};
  const host: RuntimeHost = {
    async close() {},
    async open(options) {
      const conversationId = 'conversationId' in options ? options.conversationId : randomUUID();
      const interactions = new ToolInteractions();
      let input = '';
      const agent = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'agent-a', interactions, open: signal => ({
        async send(text) { input = String(text); }, async abort() {}, close() {},
        async *stream() {
          if (input === 'approve') {
            yield { type: 'tool_call', toolCallId: 'tool-1', toolName: 'text_stats', toolInput: { text: 'hi' }, uuid: '1' } as SDKMessage;
            const response = await interactions.request({ toolCallId: 'tool-1', tool: 'text_stats', kind: 'approval', title: 'Allow text_stats?' }, signal);
            yield { type: 'tool_result', toolCallId: 'tool-1', content: JSON.stringify({ approved: response.approved }), uuid: '2' } as SDKMessage;
          }
          if (input === 'slow') {
            yield { type: 'assistant', content: 'Working', uuid: '1' } as SDKMessage;
            await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
          }
          yield { type: 'assistant', content: 'Done', uuid: '3' } as SDKMessage;
          yield { type: 'result', success: true, uuid: '4', durationMs: 1, conversationId } as SDKMessage;
        },
      }) });
      return { agent, agentId: 'agent-a', conversationId, history: [] };
    },
  };
  const runtime = new ThreadRuntime(host, join(directory, 'state.json'), 'owner');
  return { runtime, release: () => release(), cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Fixture deadline');
}

test('state model: waiting wins over working; services alone are idle', () => {
  assert.deepEqual(activityState([]), { state: 'idle', working: 0, waiting: 0 });
  assert.deepEqual(activityState([{ group: 'services', kind: 'dev-server' }, { group: 'services', kind: 'app' }]), { state: 'idle', working: 0, waiting: 0 });
  assert.deepEqual(activityState([{ group: 'turns', kind: 'turn' }, { group: 'turns', kind: 'queued' }]), { state: 'working', working: 2, waiting: 0 });
  assert.deepEqual(activityState([{ group: 'turns', kind: 'turn' }, { group: 'waiting', kind: 'approval' }]), { state: 'waiting', working: 1, waiting: 1 });
  assert.deepEqual(activityState([{ group: 'background', kind: 'jiminy' }, { group: 'background', kind: 'schedule' }]), { state: 'working', working: 1, waiting: 0 });
});

test('turn step: the open tool, thinking, writing, waiting', () => {
  const ev = (type: string, data: Record<string, unknown> = {}) => ({ sequence: 0, type, data });
  assert.equal(turnStep({ events: [ev('started')] }), 'starting');
  assert.equal(turnStep({ events: [ev('started'), ev('reasoning', { text: 'x' })] }), 'thinking');
  assert.equal(turnStep({ events: [ev('tool_started', { toolCallId: 'a', name: 'run_command' })] }), 'tool:run_command');
  assert.equal(turnStep({ events: [ev('tool_started', { toolCallId: 'a', name: 'run_command' }), ev('tool_completed', { toolCallId: 'a' })] }), 'thinking');
  assert.equal(turnStep({ events: [ev('tool_started', { toolCallId: 'a', name: 'x' }), ev('tool_completed', { toolCallId: 'a' }), ev('text', { text: 'hi' })] }), 'writing');
  assert.equal(turnStep({ events: [ev('tool_started', { toolCallId: 'a', name: 'x' }), ev('interaction')] }), 'waiting');
  assert.equal(turnStep({ events: [ev('tool_started', { toolCallId: 'a', name: 'x' }), ev('interaction'), ev('interaction_resolved')] }), 'tool:x');
  assert.equal(stepLabel('tool:web_search'), 'Searching the web (summarizing)');
  assert.equal(stepLabel('tool:run_command'), 'Running run_command');
  assert.equal(stepLabel(undefined), 'Starting');
});

test('aggregation: a running turn waiting for approval, then idle', async () => {
  const f = fixture();
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Deploy blog');
    assert.equal(agentActivity(f.runtime, 'owner').state, 'idle');
    const run = { id: randomUUID(), threadId: thread, text: 'approve', parentRunId: null };
    await f.runtime.start('owner', run);
    await until(() => !!f.runtime.pendingInteraction('owner', run.id));
    const activity = agentActivity(f.runtime, 'owner');
    assert.equal(activity.state, 'waiting');
    const turn = activity.items.find(i => i.kind === 'turn')!;
    assert.equal(turn.title, 'Deploy blog'); assert.equal(turn.threadId, thread); assert.equal(turn.step, 'waiting'); assert.deepEqual(turn.actions, ['stop']); assert.ok(turn.since);
    const prompt = activity.items.find(i => i.kind === 'approval')!;
    assert.equal(prompt.group, 'waiting'); assert.equal(prompt.label, 'Permission: text_stats'); assert.equal(prompt.detail, 'Allow text_stats?'); assert.ok(prompt.since);
    const [summary] = activitySummary([{ id: 'a', name: 'A', runtime: f.runtime, owner: 'owner' }]);
    assert.deepEqual(summary, { id: 'a', name: 'A', state: 'waiting', working: 1, waiting: 1, running: [thread] });
    f.runtime.answer('owner', run.id, { id: f.runtime.pendingInteraction('owner', run.id)!.id, approved: true });
    await until(() => f.runtime.events('owner', run.id, 0).status === 'completed');
    assert.deepEqual(agentActivity(f.runtime, 'owner'), { state: 'idle', working: 0, waiting: 0, items: [] });
  } finally { await f.cleanup(); }
});

test('routes: /v1/activity, stop through the existing cancel route, and the summary long poll wakes on change', async () => {
  const f = fixture();
  const app = express();
  app.get('/summary', activitySummaryRoute(() => [{ id: 'a', name: 'A', runtime: f.runtime, owner: 'owner' }]));
  runtimeRoutes(app, f.runtime, 'owner');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'Slow one');
    const first = await (await fetch(`${base}/summary`)).json() as { version: number; agents: { state: string }[] };
    assert.equal(first.agents[0]!.state, 'idle');
    const waiting = fetch(`${base}/summary?since=${first.version}`).then(r => r.json()) as Promise<{ version: number; agents: { state: string; working: number }[] }>;
    const run = { id: randomUUID(), threadId: thread, text: 'slow', parentRunId: null };
    await f.runtime.start('owner', run);
    const woke = await waiting;
    assert.ok(woke.version > first.version); assert.equal(woke.agents[0]!.state, 'working');
    await until(() => f.runtime.activityNow('owner').turns[0]?.step === 'writing');
    const activity = await (await fetch(`${base}/v1/activity`)).json() as { state: string; items: { kind: string; detail?: string; ref?: string }[] };
    assert.equal(activity.state, 'working');
    assert.equal(activity.items[0]!.detail, 'Writing');
    const stop = await fetch(`${base}/v1/runs/${activity.items[0]!.ref}/cancel`, { method: 'POST' });
    assert.equal(stop.status, 200);
    await until(() => f.runtime.events('owner', run.id, 0).status !== 'running');
    assert.equal((await (await fetch(`${base}/v1/activity`)).json() as { state: string }).state, 'idle');
  } finally { server.close(); await f.cleanup(); }
});
