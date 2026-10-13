import test from 'node:test';
import assert from 'node:assert/strict';
import { historyMessages, markReflection, observedParts, reflectionOf, withReplyRuns } from '../src/messages.js';

test('each assistant reply carries the run of the message before it (whose review shows under it)', () => {
  const messages = withReplyRuns([
    { id: 'u1', role: 'user', content: 'hi', metadata: { custom: { runId: 'r1' } } },
    { id: 'a1', role: 'assistant', content: 'hello' },
    { id: 'u2', role: 'user', content: 'from history without a run' },
    { id: 'a2', role: 'assistant', content: 'ok' },
  ]);
  assert.equal((messages[1]!.metadata?.custom as { replyRun?: string }).replyRun, 'r1');
  assert.equal((messages[3]!.metadata?.custom as { replyRun?: string } | undefined)?.replyRun, undefined);
});

test('the line under a reply: reviewing, reflecting, then kept or revised (notes alone when the reflection was skipped)', async () => {
  const { voicesLine } = await import('../src/voices.js');
  const counsel = (outcome: 'kept' | 'revised' | 'skipped') => ({ at: 'now', notes: { ambition: { points: ['p'], confidence: 'high' as const } }, outcome });
  assert.equal(voicesLine({ state: 'reviewing' }, undefined), 'reviewing');
  assert.equal(voicesLine({ state: 'reflecting' }, undefined), 'reflecting');
  assert.equal(voicesLine({ state: 'done', outcome: 'revised' }, counsel('revised')), 'revised');
  assert.equal(voicesLine(undefined, counsel('kept')), 'kept');
  assert.equal(voicesLine(undefined, counsel('skipped')), 'notes');
  assert.equal(voicesLine(undefined, { at: 'now', notes: { prudence: { error: 'voice_timeout' } }, outcome: 'skipped' }), 'none');
  assert.equal(voicesLine(undefined, undefined), 'none');
});

const ev = (sequence: number, type: string, data: Record<string, unknown> = {}) => ({ sequence, type, data });

test('live: the draft streams, then reviewing, reflecting, and the final answer replaces the draft (same message)', () => {
  const events = [ev(1, 'started'), ev(2, 'text', { text: 'Your ELO is 1600.' })];
  const base = { id: 'r1-assistant', role: 'assistant' as const };
  const draft = markReflection({ ...base, content: observedParts(events) });
  assert.equal(reflectionOf(draft), undefined);
  events.push(ev(3, 'reflecting', { phase: 'review' }));
  const reviewing = markReflection({ ...base, content: observedParts(events) }, { reviewing: true });
  assert.equal(reflectionOf(reviewing)?.state, 'reviewing');
  assert.deepEqual(reviewing.content, [{ type: 'text', text: 'Your ELO is 1600.' }], 'the draft stays visible');
  events.push(ev(4, 'reflecting', { phase: 'reflect' }), ev(5, 'tool_started', { toolCallId: 't1', name: 'Bash', input: {}, phase: 'reflection' }), ev(6, 'tool_completed', { toolCallId: 't1', name: 'Bash', output: 'ok', phase: 'reflection' }), ev(7, 'text', { text: 'Two games cannot ', phase: 'reflection' }));
  const reflecting = markReflection({ ...base, content: observedParts(events) }, { reviewing: true });
  assert.equal(reflectionOf(reflecting)?.state, 'reflecting');
  assert.deepEqual(reflecting.content, [{ type: 'text', text: 'Your ELO is 1600.' }], 'the reflection is not shown while it is written');
  events.push(ev(8, 'text', { text: 'give an exact ELO.', phase: 'reflection' }), ev(9, 'reflected', { counsel: { outcome: 'revised' } }), ev(10, 'completed'));
  const final = markReflection({ ...base, content: observedParts(events) }, { reviewing: true, outcome: 'revised' });
  assert.equal(final.id, base.id, 'no remount');
  assert.deepEqual(final.content, [{ type: 'text', text: 'Two games cannot give an exact ELO.' }]);
  assert.equal(reflectionOf(final)?.draft, 'Your ELO is 1600.');
  assert.deepEqual(reflectionOf(final)?.tools?.map(t => (t as { toolName: string }).toolName), ['Bash']);
  // Stopped while reflecting: the draft stands.
  const stopped = markReflection({ ...base, content: observedParts(events.slice(0, 7)) }, { reviewing: true, outcome: 'skipped' });
  assert.deepEqual(stopped.content, [{ type: 'text', text: 'Your ELO is 1600.' }]);
});

test('history: only the final answer shows; the hidden prompt is never a user message; KEEP keeps the draft', () => {
  const user = { id: 'u', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Exact ELO?' }], metadata: { otid: '00000000-0000-4000-8000-000000000001' } };
  const marker = (outcome?: string) => ({ id: 'm', role: 'assistant' as const, parts: [{ type: 'data-reflection' as const, data: { otid: '00000000-0000-4000-8000-000000000001:reflect', ...(outcome ? { outcome } : {}) } }] });
  const revised = historyMessages([user, { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Your ELO is 1600.' }] }, marker('revised'), { id: 'b', role: 'assistant', parts: [{ type: 'text', text: 'Two games are too few.' }] }]);
  assert.deepEqual(revised.map(m => m.role), ['user', 'assistant']);
  assert.deepEqual(revised[1]!.content, [{ type: 'text', text: 'Two games are too few.' }]);
  assert.equal(reflectionOf(revised[1]!)?.outcome, 'revised');
  assert.equal(reflectionOf(revised[1]!)?.draft, 'Your ELO is 1600.');
  const kept = historyMessages([user, { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Your ELO is 1600.' }] }, marker(), { id: 'b', role: 'assistant', parts: [{ type: 'text', text: 'KEEP' }] }]);
  assert.deepEqual(kept[1]!.content, [{ type: 'text', text: 'Your ELO is 1600.' }]);
  assert.equal(reflectionOf(kept[1]!)?.outcome, 'kept', 'inferred from KEEP without a record');
  assert.ok(!JSON.stringify(kept).includes('inner voices'));
});

test('rounds in history: only the last revision shows; each round is in the collapsed section; KEEP with a rebuttal keeps the latest', () => {
  const run = '00000000-0000-4000-8000-000000000002';
  const user = { id: 'u', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Exact ELO?' }], metadata: { otid: run } };
  const marker = (suffix: string, outcome?: string) => ({ id: `m${suffix}`, role: 'assistant' as const, parts: [{ type: 'data-reflection' as const, data: { otid: `${run}${suffix}`, ...(outcome ? { outcome } : {}) } }] });
  const text = (id: string, value: string) => ({ id, role: 'assistant' as const, parts: [{ type: 'text' as const, text: value }] });
  const messages = historyMessages([user, text('a', 'Your ELO is 1600.'), marker(':reflect', 'revised'), text('b', 'About 1600 ± 400.'), marker(':reflect2'), text('c', 'About 1600 ± 400 from 2 games.'), marker(':reflect3'), text('d', 'KEEP — two games are all we have.')]);
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant']);
  assert.deepEqual(messages[1]!.content, [{ type: 'text', text: 'About 1600 ± 400 from 2 games.' }]);
  assert.equal(reflectionOf(messages[1]!)?.outcome, 'revised');
  assert.equal(reflectionOf(messages[1]!)?.revisions, 2);
  assert.equal(reflectionOf(messages[1]!)?.draft, 'Your ELO is 1600.');
  assert.ok(!JSON.stringify(messages).includes('KEEP'));
});

test('the collapsed line: revised 2×, kept, debate (older records keep the agent\'s reason or skip); settings bounds', async () => {
  const { voicesLine, voicesLabel, validPolicy } = await import('../src/voices.js');
  const notes = { ambition: { points: ['p'], confidence: 'high' as const } };
  const revised = { at: 'now', notes, outcome: 'revised' as const, revisions: 2, mode: 'debate' as const };
  assert.equal(voicesLabel(voicesLine(undefined, revised), revised), 'Revised 2× after Ambition & Prudence · Debate');
  const kept = { at: 'now', notes, outcome: 'kept' as const, mode: 'calibrated' as const };
  assert.equal(voicesLabel(voicesLine(undefined, kept), kept), 'Kept after Ambition & Prudence');
  // Older records (the removed per-turn choice) still read.
  const old = { ...revised, choice: { mode: 'debate', reason: 'a factual claim' } };
  assert.equal(voicesLabel(voicesLine(undefined, old), old), 'Revised 2× after Ambition & Prudence · Debate: a factual claim');
  const skipped = { at: 'now', notes: {}, outcome: 'skipped' as const, reason: 'agent_skipped' as const, mode: 'skip' as const, choice: { mode: 'skip', reason: 'a greeting' } };
  assert.equal(voicesLine(undefined, skipped), 'skipped');
  assert.equal(voicesLabel('skipped', skipped), 'Skipped review: a greeting');
  assert.equal(validPolicy({ minimum: 'calibrated', maximum: 'debate', maxRevisions: 2, maxConsults: 30 }), true);
  assert.equal(validPolicy({ minimum: 'debate', maximum: 'debate', maxRevisions: 1, maxConsults: 30 }), true);
  assert.equal(validPolicy({ minimum: 'debate', maximum: 'calibrated', maxRevisions: 1, maxConsults: 30 }), false);
  assert.equal(validPolicy({ minimum: 'none', maximum: 'calibrated', maxRevisions: 1, maxConsults: 30 }), true);
  assert.equal(validPolicy({ minimum: 'calibrated_if_tools', maximum: 'debate', maxRevisions: 1, maxConsults: 30 }), true);
});

test('a consultation\'s line: asking, then who was asked and the question; one voice; failures; JSON text results', async () => {
  const { consultLabel, parseConsultResult } = await import('../src/voices.js');
  const result = { ok: true, mode: 'debate', question: 'Is 4.c3 sound?', notes: { prudence: { points: ['c3 is legal.'], confidence: 'high' } } };
  assert.equal(consultLabel({ question: 'Is 4.c3 sound?' }, undefined, true), 'Asking Ambition & Prudence…');
  assert.equal(consultLabel({ question: 'Is 4.c3 sound?', voices: ['prudence'] }, parseConsultResult(JSON.stringify(result)), false), 'Asked Prudence: Is 4.c3 sound? · Debate');
  assert.equal(consultLabel({ question: 'q' }, parseConsultResult({ ok: false, error: 'limit_reached' }), false), 'Couldn’t ask Ambition & Prudence (limit for this turn reached)');
  assert.equal(consultLabel({ question: 'x'.repeat(200) }, parseConsultResult({ ...result, mode: 'calibrated' }), false).length, 'Asked Ambition & Prudence: '.length + 90);
  assert.equal(parseConsultResult('not json'), undefined);
  assert.deepEqual(parseConsultResult({ ok: false, error: 'limit_reached', of: 30 }), { ok: false, error: 'limit_reached', of: 30 });
  assert.equal(consultLabel({ question: 'q' }, parseConsultResult({ ok: false, error: 'limit_reached', of: 30 }), false), 'Couldn’t ask Ambition & Prudence (limit for this turn reached)');
  assert.equal((parseConsultResult({ ...result, left: 7, of: 30 }) as { left?: number }).left, 7);
  assert.deepEqual(parseConsultResult(result), { ok: true, mode: 'debate', question: 'Is 4.c3 sound?', notes: result.notes });
});
