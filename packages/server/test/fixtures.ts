/** Minimal tool set for offline runtime tests. Handlers never run here: the fake Letta stream reports results. */
import { tool, jsonSchema } from 'ai';
import { askUserTool } from 'ai-sdk-letta';

export const tools = {
  ask_user: askUserTool,
  text_stats: tool({ inputSchema: jsonSchema<{ text: string }>({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }), execute: async ({ text }) => ({ words: text.split(/\s+/).length }) }),
};
