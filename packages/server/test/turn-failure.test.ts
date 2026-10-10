import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { LettaAgent, ToolInteractions } from 'ai-sdk-letta';
import { ThreadRuntime, redactSecrets, type RuntimeHost } from '../src/index.js';
import { tools } from './fixtures.js';

const REJECTED = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits."},"request_id":"req_1"}';
const rejected = [
  { type: 'error', message: REJECTED, errorCode: 'llm_api_error', stopReason: 'llm_api_error', recoverable: false },
  { type: 'result', success: false, error: 'error', errorCode: 'llm_api_error', stopReason: 'llm_api_error', durationMs: 1, conversationId: 'c' },
] as SDKMessage[];

/** A host whose turns follow the message: "reject" (Letta rejects it before any output), "partial" (fails after some text), "boom sk-…" (an exception), else a reply. */
function fixture(options: { settle?: 'ok' | 'busy' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-turn-failure-'));
  const lines: string[] = [];
  const settled: string[] = [];
  const host: RuntimeHost = {
    async close() {},
    async open(opened) {
      const conversationId = 'conversationId' in opened ? opened.conversationId : randomUUID();
      let input = '';
      const agent = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'agent', interactions: new ToolInteractions(),
        delivery: { begin: () => {}, complete: () => {}, settle: async ({ outcome }) => {
          if (options.settle === 'busy') throw new Error('still running');
          settled.push(String(outcome)); return { delivered: true };
        } },
        open: () => ({ async send(text) { input = String(text); }, async abort() {}, close() {},
          async *stream() {
            if (input === 'reject') { yield* rejected; return; }
            if (input === 'partial') { yield { type: 'assistant', content: 'Half', uuid: 'a' } as SDKMessage; yield* rejected; return; }
            if (input.startsWith('boom')) throw new Error(`exploded with ${input.slice(5)}`);
            yield { type: 'assistant', content: 'Done', uuid: 'a' } as SDKMessage;
            yield { type: 'result', success: true, durationMs: 1, conversationId } as SDKMessage;
          } }) });
      return { agent, agentId: 'agent', conversationId, history: [] };
    },
  };
  const runtime = new ThreadRuntime(host, join(directory, 'state.json'), 'owner', { log: line => lines.push(line), logLabel: 'probe' });
  return { runtime, lines, settled, cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Fixture deadline');
}
const ended = (runtime: ThreadRuntime, id: string) => () => !['running', 'queued'].includes(runtime.events('owner', id, 0).status);

test('a turn Letta rejected before any output: logged with the real error, recorded, and the conversation stays usable', async () => {
  const f = fixture();
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'T');
    const run = { id: randomUUID(), threadId: thread, text: 'reject', parentRunId: null };
    await f.runtime.start('owner', run);
    await until(ended(f.runtime, run.id));
    const events = f.runtime.events('owner', run.id, 0);
    assert.equal(events.status, 'failed');
    const failed = events.events.find(e => e.type === 'failed')!;
    assert.equal(failed.data.code, 'runtime_failed');
    assert.equal(failed.data.usable, true);
    assert.match(String(failed.data.error), /^llm_api_error · HTTP 400 · Third-party apps now draw from your extra usage/);
    assert.deepEqual(f.settled, ['failed']);
    assert.equal(f.lines.length, 1);
    assert.match(f.lines[0]!, new RegExp(`^\\[turn-failed\\] probe ${thread} runtime_failed: llm_api_error · HTTP 400 · Third-party apps`));
    const view = await f.runtime.view('owner', thread) as { usable?: boolean; failed?: { runId: string; error?: string } };
    assert.equal(view.usable, true);
    assert.equal(view.failed?.runId, run.id);
    assert.match(String(view.failed?.error), /Third-party apps/);
    // The next message is sent (nothing was replayed).
    const next = { id: randomUUID(), threadId: thread, text: 'hello', parentRunId: run.id };
    await f.runtime.start('owner', next);
    await until(ended(f.runtime, next.id));
    assert.equal(f.runtime.events('owner', next.id, 0).status, 'completed');
  } finally { await f.cleanup(); }
});

test('a failure after output, or one whose settlement fails, still locks the conversation (with the error shown)', async () => {
  for (const [text, settle] of [['partial', 'ok'], ['reject', 'busy']] as const) {
    const f = fixture({ settle });
    try {
      const thread = randomUUID(); await f.runtime.create('owner', thread, 'T');
      const run = { id: randomUUID(), threadId: thread, text, parentRunId: null };
      await f.runtime.start('owner', run);
      await until(ended(f.runtime, run.id));
      const failed = f.runtime.events('owner', run.id, 0).events.find(e => e.type === 'failed')!;
      assert.equal(failed.data.usable, undefined, text);
      assert.match(String(failed.data.error), /Third-party apps/);
      const view = await f.runtime.view('owner', thread) as { usable?: boolean; error?: string };
      assert.equal(view.usable, false);
      assert.match(String(view.error), /Third-party apps/);
      await assert.rejects(f.runtime.start('owner', { id: randomUUID(), threadId: thread, text: 'again', parentRunId: run.id }), /delivery_uncertain/);
    } finally { await f.cleanup(); }
  }
});

test('other exceptions are logged (secrets redacted) but never recorded for the browser', async () => {
  const f = fixture();
  try {
    const thread = randomUUID(); await f.runtime.create('owner', thread, 'T');
    const run = { id: randomUUID(), threadId: thread, text: 'boom sk-ant-api03-abcdefghijklmnopqrstuvwxyz', parentRunId: null };
    await f.runtime.start('owner', run);
    await until(ended(f.runtime, run.id));
    assert.ok(!JSON.stringify(f.runtime.events('owner', run.id, 0)).includes('exploded'));
    assert.equal(f.lines.length, 1);
    assert.match(f.lines[0]!, /runtime_failed: exploded with \[redacted\]/);
    assert.ok(!f.lines[0]!.includes('abcdefghijklmnop'));
  } finally { await f.cleanup(); }
});

test('redactSecrets hides key-like tokens', () => {
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer [redacted]');
  assert.equal(redactSecrets('key sk-proj-1234567890abcdef1234'), 'key [redacted]');
  assert.equal(redactSecrets('400 invalid_request_error'), '400 invalid_request_error');
});
