/** Offline PTY fixture: real patched TUI + real LettaAgent, no backend or model. */
import { runAgentTUI } from '@ai-sdk/tui';
import type { UIMessage } from 'ai';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { LettaAgent } from 'ai-sdk-letta';
import { tools } from './tools.js';
const sent: string[] = [];
const initialMessages: UIMessage[] = Array.from({ length: 30 }, (_, index) => ({
  id: `old-${index}`, role: index % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: `RESTOREDROW${String(index).padStart(2, '0')}` }],
}));
initialMessages.push({ id: 'old-card', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'text_stats', toolCallId: 'old-call', providerExecuted: true, state: 'output-available', input: { text: 'OLDCARDINPUT' }, output: { words: 1 } }] });
const agent = new LettaAgent({ id: 'history-fixture', tools, open: () => ({
  send: async message => { sent.push(String(message)); }, abort: async () => {}, close: () => {},
  async *stream() {
    yield { type: 'assistant', content: 'LIVEREPLYONLY', uuid: 'a' } as SDKMessage;
    yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId: 'default' } as SDKMessage;
  },
}) });
await runAgentTUI({ agent, initialMessages, title: 'History fixture', tools: 'full', reasoning: 'hidden' });
agent.close();
console.log(`SENT=${JSON.stringify(sent)}`);
