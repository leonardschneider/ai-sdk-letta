import { tool, jsonSchema } from 'ai';
import { askUserTool, defineAgent } from 'ai-sdk-letta';

/**
 * One custom tool: pure, no side effects. It runs in this process when the
 * Letta agent calls it, after schema validation and the permission policy.
 */
export const textStats = tool({
  description: 'Count Unicode code points, whitespace-separated words, and lines in text. No external actions.',
  inputSchema: jsonSchema<{ text: string }>({
    type: 'object',
    properties: { text: { type: 'string', maxLength: 8000 } },
    required: ['text'],
    additionalProperties: false,
  }),
  execute: async ({ text }) => ({
    characters: [...text].length,
    words: text.trim() ? text.trim().split(/\s+/u).length : 0,
    lines: text.split('\n').length,
  }),
});

/**
 * The example agent. `id` is your stable logical identity: the first run
 * creates a Letta agent and records its generated ID in the state directory;
 * later runs reopen the same agent, memory and conversations.
 *
 * Override the model with LETTA_MODEL, and the logical ID with AGENT_ID (for
 * example, a throwaway ID for smoke tests).
 */
export const agent = defineAgent({
  id: process.env.AGENT_ID ?? 'example-assistant',
  name: process.env.AGENT_NAME ?? 'Example Assistant',
  model: process.env.LETTA_MODEL ?? 'openai-codex/gpt-5.5',
  instructions: 'You are a helpful, concise assistant. Use text_stats when asked to count text. When a decision needs the user\'s input, you may call ask_user with clear options.',
  tools: { text_stats: textStats, ask_user: askUserTool },
  // Fail-closed: every tool is listed. Try 'ask' to require approval per call.
  permissions: { text_stats: process.env.TEXT_STATS_PERMISSION === 'ask' ? 'ask' : 'allow', ask_user: 'allow' },
  dreaming: { trigger: 'step-count', stepCount: 25 },
});
