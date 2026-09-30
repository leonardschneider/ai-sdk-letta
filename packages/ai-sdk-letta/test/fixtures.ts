/** Shared offline test fixtures: a demo definition with three tools. No backend or model. */
import { tool, jsonSchema } from 'ai';
import { askUserTool, createToolBridge, defineAgent, type ToolActivity, type ToolBridgeOptions } from '../src/index.js';

export const registry = {
  approval_demo: tool({
    description: 'Demonstrate per-call approval. Only returns an acknowledgement; no external side effects.',
    inputSchema: jsonSchema<{ message: string }>({ type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['message'], additionalProperties: false }),
    execute: async ({ message }) => ({ acknowledged: message, sideEffects: false }),
  }),
  ask_user: askUserTool,
  text_stats: tool({
    description: 'Count Unicode code points, whitespace-separated words, and lines in text. No external actions.',
    inputSchema: jsonSchema<{ text: string }>({ type: 'object', properties: { text: { type: 'string', maxLength: 8000 } }, required: ['text'], additionalProperties: false }),
    execute: async ({ text }) => ({ characters: [...text].length, words: text.trim() ? text.trim().split(/\s+/u).length : 0, lines: text.split('\n').length }),
  }),
};

export const definition = defineAgent({
  id: 'test-assistant', name: 'Test Assistant', model: 'test/model',
  instructions: 'You are a test assistant.', tools: registry,
  permissions: { text_stats: 'allow', approval_demo: 'ask', ask_user: 'allow' },
});

/** Bridge over the demo registry with the default demo policy. */
export function bridge(options: Partial<ToolBridgeOptions> & { persist?: (event: ToolActivity) => void } = {}) {
  return createToolBridge({ tools: registry, permissions: definition.permissions, persist: () => {}, ...options });
}
