import test from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import {
  LettaAgent, ToolInteractions, createToolBridge, defineAgent, decisionTools, decisionsEnabled, parseDecision, decisionMessage, decisionOutcomeNote, pendingDecisionNote, reminderNote, unattendedNote,
  DECISION_TOOL_PERMISSIONS, DECISIONS_CONTEXT, type DecisionDesk, type DecisionRequest, type ToolActivity,
} from '../src/index.js';
import { registry } from './fixtures.js';

const text = (result: { content: { type: string; text?: string }[] }) => JSON.parse(result.content[0]!.text!);
const tools = { ...registry, ...decisionTools };
const permissions = { ...DECISION_TOOL_PERMISSIONS, text_stats: 'allow', approval_demo: 'ask', ask_user: 'allow' } as const;

function desk() {
  const requests: { request: DecisionRequest; conversationId: string; toolCallId: string; actor?: string }[] = [];
  let pending: string | undefined;
  let n = 0;
  const value: DecisionDesk = {
    async request(request, turn) {
      requests.push({ request, conversationId: turn.conversationId, toolCallId: turn.toolCallId, ...(turn.actor ? { actor: turn.actor.id } : {}) });
      const replaced = pending; pending = `d-${++n}`;
      return { id: pending, ...(replaced ? { replaced } : {}) };
    },
    async cancel(_turn, id) { if (!pending || (id && id !== pending)) return undefined; const was = pending; pending = undefined; return was; },
  };
  return { desk: value, requests, pending: () => pending };
}

test('parseDecision cleans and checks what the agent asks', () => {
  assert.deepEqual(parseDecision({ question: '  Which\u202e format?\n', options: [{ id: 'md', label: 'Markdown', description: 'plain' }, { id: 'pdf', label: 'PDF\u0007' }] }),
    { question: 'Which format?', options: [{ id: 'md', label: 'Markdown', description: 'plain' }, { id: 'pdf', label: 'PDF' }], allowComment: true });
  assert.equal(parseDecision({ question: 'Q', options: [] }), undefined, 'at least one option');
  assert.equal(parseDecision({ question: 'Q', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }), undefined, 'unique ids');
  assert.equal(parseDecision({ question: 'Q', options: [{ id: 'a b', label: 'A' }] }), undefined, 'id pattern');
  assert.equal(parseDecision({ question: '   ', options: [{ id: 'a', label: 'A' }] }), undefined);
  assert.equal(parseDecision({ question: 'Q', options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: 'x' })) }), undefined, 'at most 8');
  const context = parseDecision({ question: 'Q', options: [{ id: 'a', label: 'A' }], context: 'Line 1\n\n\n\nLine 2', allowComment: false })!;
  assert.equal(context.context, 'Line 1\n\nLine 2'); assert.equal(context.allowComment, false);
});

test('request_decision records the decision with the desk, and pauses the rest of the turn', async () => {
  const { desk: bound, requests } = desk();
  let paused = false;
  const events: ToolActivity[] = [];
  const context = { [DECISIONS_CONTEXT]: { desk: bound, conversationId: 'conv-1', actor: { id: 'u-mia', name: 'Mia' }, requested: () => { paused = true; } } };
  const bridge = createToolBridge({ tools, permissions, interactions: new ToolInteractions(), context: () => context, paused: () => paused, persist: e => events.push(e) });
  const result = await bridge.execute('request_decision', 'call-1', { question: 'Which format?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  assert.equal(result.isError, false);
  const output = text(result);
  assert.equal(output.requested, true); assert.equal(output.id, 'd-1');
  assert.match(output.message, /end your turn now/i);
  assert.deepEqual(requests, [{ request: { question: 'Which format?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowComment: true }, conversationId: 'conv-1', toolCallId: 'call-1', actor: 'u-mia' }]);
  assert.equal(paused, true);
  // Every later call of the same turn is refused: the tool never runs, and nobody is asked.
  const refused = await bridge.execute('text_stats', 'call-2', { text: 'a b' });
  assert.equal(refused.isError, true); assert.equal(text(refused).error, 'decision_pending');
  assert.equal(text(await bridge.execute('approval_demo', 'call-3', { message: 'x' })).error, 'decision_pending');
  // The decision tools stay callable: the agent may replace its question in the same turn.
  const again = text(await bridge.execute('request_decision', 'call-4', { question: 'Which colour?', options: [{ id: 'r', label: 'Red' }] }));
  assert.equal(again.replaced, 'd-1');
  assert.deepEqual(events.filter(e => e.status === 'denied').map(e => e.code), ['decision_pending', 'decision_pending']);
});

test('without a desk, or with an invalid request, nothing is recorded and the agent is told why', async () => {
  const bridge = createToolBridge({ tools, permissions, context: () => ({}) });
  assert.equal(text(await bridge.execute('request_decision', 'c1', { question: 'Q', options: [{ id: 'a', label: 'A' }] })).error, 'decisions_unavailable');
  assert.equal(text(await bridge.execute('cancel_decision', 'c2', {})).error, 'decisions_unavailable');
  const { desk: bound, requests } = desk();
  const withDesk = createToolBridge({ tools, permissions, context: () => ({ [DECISIONS_CONTEXT]: { desk: bound, conversationId: 'c' } }) });
  // Schema-valid but duplicate option IDs: refused by the tool, the desk never sees it.
  assert.equal(text(await withDesk.execute('request_decision', 'c3', { question: 'Q', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })).error, 'invalid_input');
  assert.equal(requests.length, 0);
  const failing: DecisionDesk = { request: async () => { throw new Error('decision_limit'); }, cancel: async () => { throw new Error('boom: details'); } };
  const broken = createToolBridge({ tools, permissions, context: () => ({ [DECISIONS_CONTEXT]: { desk: failing, conversationId: 'c' } }) });
  assert.equal(text(await broken.execute('request_decision', 'c4', { question: 'Q', options: [{ id: 'a', label: 'A' }] })).error, 'decision_limit');
  assert.equal(text(await broken.execute('cancel_decision', 'c5', {})).error, 'decision_failed', 'free-form errors never reach the agent');
});

test('cancel_decision withdraws the pending decision', async () => {
  const { desk: bound, pending } = desk();
  const bridge = createToolBridge({ tools, permissions, context: () => ({ [DECISIONS_CONTEXT]: { desk: bound, conversationId: 'c' } }) });
  assert.equal(text(await bridge.execute('cancel_decision', 'x0', {})).cancelled, false);
  await bridge.execute('request_decision', 'x1', { question: 'Q', options: [{ id: 'a', label: 'A' }] });
  assert.equal(text(await bridge.execute('cancel_decision', 'x2', { id: 'd-9' })).cancelled, false, 'another ID is not this conversation\'s');
  assert.deepEqual(text(await bridge.execute('cancel_decision', 'x3', {})), { cancelled: true, id: 'd-1', message: 'Decision d-1 withdrawn.' });
  assert.equal(pending(), undefined);
});

test('unattended turns may request decisions (they are not questions); the turn then pauses', async () => {
  const { desk: bound } = desk();
  let paused = false;
  const interactions = new ToolInteractions();
  let prompts = 0;
  interactions.connect(async request => { prompts++; return { id: request.id, approved: true }; });
  const bridge = createToolBridge({ tools, permissions, interactions, unattended: () => ({ preApproved: [] }), paused: () => paused,
    context: () => ({ [DECISIONS_CONTEXT]: { desk: bound, conversationId: 'c', requested: () => { paused = true; } } }) });
  assert.equal(text(await bridge.execute('request_decision', 'u1', { question: 'Q', options: [{ id: 'a', label: 'A' }] })).requested, true);
  assert.equal(text(await bridge.execute('approval_demo', 'u2', { message: 'x' })).error, 'decision_pending');
  assert.equal(prompts, 0);
  assert.match(unattendedNote('n8n', { decisions: true }), /call request_decision/);
  assert.doesNotMatch(unattendedNote('n8n'), /request_decision/);
});

test('definitions: decisions are opt-in, and request_decision cannot ask for approval', () => {
  const base = { id: 'd', name: 'D', model: 'm/x', instructions: 'i' };
  assert.equal(decisionsEnabled(defineAgent({ ...base, tools: registry, permissions: { text_stats: 'allow', approval_demo: 'ask', ask_user: 'allow' } })), false);
  assert.equal(decisionsEnabled(defineAgent({ ...base, tools, permissions })), true);
  assert.equal(decisionsEnabled(defineAgent({ ...base, tools, permissions: { ...permissions, request_decision: 'deny' } })), false);
  assert.throws(() => defineAgent({ ...base, tools, permissions: { ...permissions, request_decision: 'ask' } }), /human gate/);
});

test('outcome messages and notes: what the agent reads, without markup from people', () => {
  assert.equal(decisionMessage({ id: 'd-1', question: 'Which format?', outcome: 'decided', by: 'Mia', choice: { id: 'b', label: 'B: <b>PDF</b>' }, comment: 'Keep it short' }),
    '[Decision] Mia chose “B: bPDF/b” (option b) for “Which format?” (decision d-1).\nComment: Keep it short');
  assert.equal(decisionMessage({ id: 'd-2', question: 'Go on?', outcome: 'stopped', by: '' }), '[Decision] Someone decided to stop this work: “Go on?” (decision d-2).');
  assert.match(decisionOutcomeNote('decided'), /Resume the paused work/);
  assert.match(decisionOutcomeNote('stopped'), /Do not continue/);
  assert.match(pendingDecisionNote({ id: 'd-3', question: 'Q?', options: [{ id: 'a', label: 'A' }] }), /still pending \(decision d-3\).*options: a: A/);
  assert.equal(reminderNote('a <b> c'), '<system-reminder>\na b c\n</system-reminder>\n');
  assert.equal(reminderNote('  '), '');
});

test('a turn that requested a decision is a reply, never "listened", and the reminder reaches the agent', async () => {
  const sent: string[] = [];
  const agent = new LettaAgent({ id: 't', tools, listening: true,
    open: () => ({
      async send(message) { sent.push(typeof message === 'string' ? message : JSON.stringify(message)); },
      async abort() {}, close() {},
      async *stream() {
        yield { type: 'tool_call', toolCallId: 'k1', toolName: 'request_decision', toolInput: { question: 'Q', options: [{ id: 'a', label: 'A' }] }, uuid: 'u1' } as SDKMessage;
        yield { type: 'tool_result', toolCallId: 'k1', content: JSON.stringify({ requested: true, id: 'd-1' }), isError: false, uuid: 'u2' } as SDKMessage;
        yield { type: 'result', success: true, uuid: 'u3', durationMs: 1, conversationId: 'c' } as SDKMessage;
      },
    }) });
  const result = await agent.generate({ prompt: 'Write the report', replyMode: 'agent-decides', reminder: 'A decision is pending.' });
  assert.equal((result.providerMetadata?.letta as { listened?: boolean } | undefined)?.listened, undefined);
  assert.match(sent[0]!, /<system-reminder>\nA decision is pending\.\n<\/system-reminder>\n/);
  await assert.rejects(agent.generate({ prompt: 'x', reminder: 3 as unknown as string }), /Invalid reminder/);
});
