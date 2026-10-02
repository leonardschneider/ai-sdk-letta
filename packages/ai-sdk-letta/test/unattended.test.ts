import test from 'node:test';
import assert from 'node:assert/strict';
import { tool, jsonSchema } from 'ai';
import { ToolInteractions, createToolBridge, resolveWhen, scheduleTaskTool, unattendedNote, withPreparation, PREPARE_CALL, SCHEDULER_CONTEXT, SCHEDULE_TASK_TOOL, schedulingEnabled, type ToolActivity, type TaskScheduler, type UnattendedPolicy, type PrepareCall } from '../src/index.js';
import { registry, definition } from './fixtures.js';

function counting() {
  let runs = 0;
  const tools = {
    ...registry,
    approval_demo: tool({ inputSchema: jsonSchema<{ message: string }>({ type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }), execute: async ({ message }) => { runs++; return { acknowledged: message }; } }),
    denied_tool: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object' }), execute: async () => { runs++; return {}; } }),
  };
  return { tools, runs: () => runs };
}
const text = (result: { content: { type: string; text?: string }[] }) => JSON.parse(result.content[0]!.text!);

test('unattended turns never prompt: approvals fail with approval_required, questions with question_required, and the tool never runs', async () => {
  const { tools, runs } = counting();
  const interactions = new ToolInteractions();
  let prompts = 0;
  interactions.connect(async request => { prompts++; return { id: request.id, approved: true }; });
  let policy: UnattendedPolicy | undefined = { preApproved: [] };
  const events: ToolActivity[] = [];
  const bridge = createToolBridge({ tools, permissions: { ...definition.permissions, denied_tool: 'deny' }, interactions, unattended: () => policy, persist: e => events.push(e) });
  const refused = await bridge.execute('approval_demo', 'call-1', { message: 'hi' });
  assert.equal(refused.isError, true);
  assert.equal(text(refused).error, 'approval_required');
  assert.equal(text(refused).tool, 'approval_demo');
  assert.match(text(refused).message, /End the turn/);
  assert.equal(runs(), 0); assert.equal(prompts, 0);
  // After a refusal, every later call of the same turn is refused too, even allowed ones.
  assert.equal(text(await bridge.execute('text_stats', 'call-2', { text: 'a b' })).error, 'unattended_stopped');
  // A new turn (a new policy object) starts clean; questions are refused with their own code.
  policy = { preApproved: ['ask_user'] };
  const question = await bridge.execute('ask_user', 'call-3', { question: 'Which?', allowFreeText: true });
  assert.equal(text(question).error, 'question_required', 'ask_user can never be pre-approved');
  assert.equal(prompts, 0);
  // deny stays deny, even when listed.
  policy = { preApproved: ['denied_tool'] };
  assert.equal(text(await bridge.execute('denied_tool', 'call-4', {})).error, 'tool_denied');
  assert.equal(runs(), 0);
  // An attended turn still prompts as before.
  policy = undefined;
  assert.equal(text(await bridge.execute('approval_demo', 'call-5', { message: 'hi' })).acknowledged, 'hi');
  assert.equal(prompts, 1); assert.equal(runs(), 1);
  assert.deepEqual(events.filter(e => e.status === 'denied').map(e => e.code), ['approval_required', 'unattended_stopped', 'question_required', 'tool_denied']);
});

test('pre-approved ask tools run without a prompt; calls on someone else\'s account still need them', async () => {
  const { tools, runs } = counting();
  const interactions = new ToolInteractions();
  let prompts = 0;
  interactions.connect(async request => { prompts++; return { id: request.id, approved: true }; });
  let policy: UnattendedPolicy = { preApproved: ['approval_demo'], onBehalfOf: 'u-alice' };
  const bridge = createToolBridge({ tools, permissions: definition.permissions, interactions, unattended: () => policy });
  assert.equal(text(await bridge.execute('approval_demo', 'a', { message: 'go' })).acknowledged, 'go');
  assert.equal(runs(), 1); assert.equal(prompts, 0);
  // A tool that requires approval for a call on a person's own account (as the Atlassian tools do).
  let onBehalfOf = 'u-alice';
  const personal = withPreparation(tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object' }), execute: async () => { runs(); return { wrote: true }; } }), (() => ({ approval: 'required', onBehalfOf })) as PrepareCall);
  assert.equal(typeof (personal as unknown as Record<symbol, unknown>)[PREPARE_CALL], 'function');
  const second = createToolBridge({ tools: { personal }, permissions: { personal: 'allow' }, interactions, unattended: () => policy });
  policy = { preApproved: ['personal'], onBehalfOf: 'u-alice' };
  assert.equal(text(await second.execute('personal', 'p1', {})).wrote, true);
  policy = { preApproved: ['personal'], onBehalfOf: 'u-alice' };
  onBehalfOf = 'u-bob';
  assert.equal(text(await second.execute('personal', 'p2', {})).error, 'approval_required', 'pre-approval by Alice never covers Bob\'s account');
  assert.equal(prompts, 0);
});

test('unattendedNote tells the agent who started the turn, without markup from the source', () => {
  const note = unattendedNote('n8n <b>');
  assert.match(note, /^<system-reminder>\nThis turn was started by an automation \(n8n b\)/);
  assert.match(note, /do not call ask_user/);
  assert.doesNotMatch(unattendedNote(), /\(\)/);
});

test('resolveWhen accepts ISO times with a zone and relative times, rounds up to the minute, and bounds them', () => {
  const now = Date.parse('2026-10-02T10:00:30Z');
  assert.equal(resolveWhen('in 5 minutes', now), '2026-10-02T10:06:00.000Z');
  assert.equal(resolveWhen('in 2 hours', now), '2026-10-02T12:01:00.000Z');
  assert.equal(resolveWhen('2026-10-03T08:00:00+02:00', now), '2026-10-03T06:00:00.000Z');
  assert.equal(resolveWhen('2026-10-02T10:02:10Z', now), '2026-10-02T10:03:00.000Z');
  for (const bad of ['tomorrow', '2026-10-03T08:00:00', 'in 5 fortnights', '', 'in -1 minutes']) assert.throws(() => resolveWhen(bad, now), /invalid_when/, bad);
  assert.throws(() => resolveWhen('2026-10-02T10:00:40Z', now), /too_soon/);
  assert.throws(() => resolveWhen('in 400 days', now), /too_far/);
});

test('schedule_task: fixable mistakes answer at once; valid calls ask with a preview, then call the bound scheduler', async () => {
  const calls: unknown[] = [];
  const scheduler: TaskScheduler = { schedule: async (request, turn) => { calls.push({ request, turn }); return { id: 'job-1', at: request.at, orchestrator: 'n8n', conversation: request.conversation }; } };
  const context = { [SCHEDULER_CONTEXT]: { scheduler, conversationId: 'conv-1', actor: { id: 'u-alice', name: 'Alice' } } };
  const interactions = new ToolInteractions();
  const requests: { preview?: { kind: string; text: string } }[] = [];
  interactions.connect(async request => { requests.push(request); return { id: request.id, approved: true }; });
  const bridge = createToolBridge({ tools: { [SCHEDULE_TASK_TOOL]: scheduleTaskTool }, permissions: { schedule_task: 'ask' }, interactions, context: () => context });
  const early = await bridge.execute('schedule_task', 'x1', { when: 'next tuesday', prompt: 'Summarise' });
  assert.equal(text(early).error, 'invalid_when'); assert.equal(requests.length, 0, 'nobody is asked about a call that cannot run');
  const done = await bridge.execute('schedule_task', 'x2', { when: 'in 10 minutes', prompt: '  Summarise the inbox  ', conversation: 'new', title: 'Inbox' });
  assert.equal(text(done).scheduled, true); assert.equal(text(done).id, 'job-1');
  assert.equal(requests.length, 1); assert.equal(requests[0]!.preview?.kind, 'schedule-task'); assert.match(requests[0]!.preview!.text, /Summarise the inbox/);
  assert.deepEqual((calls[0] as { request: { prompt: string; conversation: string; title: string } }).request.prompt, 'Summarise the inbox');
  assert.deepEqual((calls[0] as { turn: unknown }).turn, { conversationId: 'conv-1', actor: { id: 'u-alice', name: 'Alice' } });
  // Without a scheduler: a clear answer, no prompt.
  const unbound = createToolBridge({ tools: { schedule_task: scheduleTaskTool }, permissions: { schedule_task: 'ask' }, interactions, context: () => ({}) });
  assert.equal(text(await unbound.execute('schedule_task', 'x3', { when: 'in 10 minutes', prompt: 'x' })).error, 'scheduler_unavailable');
  assert.equal(requests.length, 1);
  // Orchestrator errors become fixed codes.
  const failing = createToolBridge({ tools: { schedule_task: scheduleTaskTool }, permissions: { schedule_task: 'allow' }, context: () => ({ [SCHEDULER_CONTEXT]: { conversationId: 'c', scheduler: { schedule: async () => { throw new Error('secret http body'); } } } }) });
  assert.equal(text(await failing.execute('schedule_task', 'x4', { when: 'in 10 minutes', prompt: 'x' })).error, 'scheduler_failed');
  assert.equal(schedulingEnabled({ tools: { schedule_task: scheduleTaskTool }, permissions: { schedule_task: 'ask' } }), true);
  assert.equal(schedulingEnabled({ tools: { schedule_task: scheduleTaskTool }, permissions: { schedule_task: 'deny' } }), false);
});
