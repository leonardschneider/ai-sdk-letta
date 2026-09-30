/** Demo tools for offline TUI fixtures. */
import { tool, jsonSchema } from 'ai';
import { askUserTool, type ToolPermission } from 'ai-sdk-letta';

export const tools = {
  approval_demo: tool({
    description: 'Demonstrate per-call approval. Only returns an acknowledgement; no external side effects.',
    inputSchema: jsonSchema<{ message: string }>({ type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['message'], additionalProperties: false }),
    execute: async ({ message }) => ({ acknowledged: message, sideEffects: false }),
  }),
  ask_user: askUserTool,
  text_stats: tool({
    description: 'Count words.',
    inputSchema: jsonSchema<{ text: string }>({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }),
    execute: async ({ text }) => ({ words: text.trim() ? text.trim().split(/\s+/u).length : 0 }),
  }),
};
export const permissions: Record<string, ToolPermission> = { approval_demo: 'ask', ask_user: 'allow', text_stats: 'allow' };
