/**
 * Live end-to-end test against the local Letta backend and a connected model.
 * Opt-in: set AI_SDK_LETTA_LIVE=1. It creates (once) a dedicated agent with
 * the logical ID below in a separate state directory; it never opens any
 * other agent. It consumes model usage.
 *
 *   AI_SDK_LETTA_LIVE=1 \
 *   AI_SDK_LETTA_LIVE_MODEL=openai-codex/gpt-5.5 \
 *   AI_SDK_LETTA_LIVE_STATE_DIR=/tmp/ai-sdk-letta-live \
 *   npm run test:live
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLettaAgent, defineAgent, type LettaRuntime } from '../../src/index.js';
import { registry } from '../fixtures.js';

const enabled = process.env.AI_SDK_LETTA_LIVE === '1';
const skip = enabled ? false : 'live test: set AI_SDK_LETTA_LIVE=1 (needs a local Letta backend and a connected model)';
const definition = defineAgent({
  id: process.env.AI_SDK_LETTA_LIVE_ID ?? 'ai-sdk-letta-live-test',
  name: 'ai-sdk-letta live test',
  model: process.env.AI_SDK_LETTA_LIVE_MODEL ?? 'openai-codex/gpt-5.5',
  instructions: 'You are a test agent. Follow tool instructions exactly and answer briefly.',
  tools: registry,
  permissions: { text_stats: 'allow', approval_demo: 'ask', ask_user: 'allow' },
});
const stateDirectory = process.env.AI_SDK_LETTA_LIVE_STATE_DIR ?? join(tmpdir(), 'ai-sdk-letta-live');
const timeout = (ms = 180_000) => AbortSignal.timeout(ms);

test('live: text, tool call, approval (deny then allow) and question on one persistent agent', { skip, timeout: 900_000 }, async () => {
  let runtime: LettaRuntime<typeof registry> | undefined;
  try {
    runtime = await createLettaAgent(definition, { stateDirectory, newTitle: `Live test ${new Date().toISOString()}` });
    const { agent } = runtime;
    let prompts = 0;
    const detach = agent.interactions.connect(async request => {
      prompts++;
      if (request.kind === 'approval') return { id: request.id, approved: prompts !== 1 };
      return { id: request.id, selected: ['second'] };
    });
    const text = await agent.generate({ prompt: 'Reply with exactly the word READY. Do not use tools.', abortSignal: timeout() });
    assert.match(text.text, /READY/);
    const stats = await agent.generate({ prompt: 'Call text_stats exactly once with text "hello world", then report the word count.', abortSignal: timeout() });
    assert.equal(stats.toolResults.filter(r => r.toolName === 'text_stats').length, 1);
    const denied = await agent.generate({ prompt: 'Call approval_demo exactly once with message "live denied". Accept a denial; do not retry. Then reply briefly.', abortSignal: timeout() });
    assert.equal(prompts, 1);
    assert.match(JSON.stringify(denied.content), /user_denied/);
    const approved = await agent.generate({ prompt: 'Call approval_demo exactly once with message "live approved". Then reply briefly.', abortSignal: timeout() });
    assert.equal(prompts, 2);
    assert.equal(approved.toolResults.filter(r => r.toolName === 'approval_demo').length, 1);
    const question = await agent.generate({ prompt: 'Call ask_user exactly once with question "Pick one", options [{"id":"first","label":"First"},{"id":"second","label":"Second"}], multiSelect false. Then tell me which label I picked.', abortSignal: timeout() });
    assert.equal(prompts, 3);
    assert.match(question.text, /second/i);
    detach();
  } finally { await runtime?.close(); }
});
