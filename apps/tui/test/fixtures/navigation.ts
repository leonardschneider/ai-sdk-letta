/** Real TUI + real local navigation + real LettaAgent; no backend or inference. */
import { runAgentTUI } from '@ai-sdk/tui';
import type { SDKMessage, ListMessagesResult } from '@letta-ai/letta-agent-sdk';
import { LettaAgent, type NavigationSource } from 'ai-sdk-letta';
import { localCommandMatches, navigate } from '../../src/index.js';
import { tools } from './tools.js';
const sent: string[] = [];
const visits: string[] = [];
let current = 'default';
const entries = [{ id: 'default', title: 'Original conversation', date: '2026-09-28' }, { id: 'local-conv-2', title: 'Planning fixture', date: '2026-09-29' }];
while (true) {
  visits.push(current);
  const agent = new LettaAgent({ id: 'navigation-fixture', tools, open: () => ({
    send: async message => { sent.push(`${current}:${String(message)}`); }, abort: async () => {}, close: () => {},
    async *stream() {
      yield { type: 'assistant', content: 'LIVEONLYREPLY', uuid: 'a' } as SDKMessage;
      yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId: current } as SDKMessage;
    },
  }) });
  const source: NavigationSource = {
    agentId: 'agent-local-fixture', currentId: current,
    list: async () => ({ entries, limited: false }),
    page: async id => ({ hasMore: false, messages: [{ id: 'one', message_type: 'assistant_message', content: id === 'default' ? 'needle ORIGINALCONTEXT details' : 'needle PLANNINGCONTEXT details' }] as ListMessagesResult['messages'] }),
    validate: async id => { if (!entries.some(entry => entry.id === id)) throw new Error('Wrong agent'); },
  };
  let next: string | undefined;
  await runAgentTUI({ agent, title: `Navigation ${current}`, initialMessages: [{ id: 'restored', role: 'assistant', parts: [{ type: 'text', text: current === 'default' ? 'ORIGINALRESTORED' : 'PLANNINGRESTORED' }] }], localCommand: { matches: localCommandMatches, run: async text => { next = await navigate(text, source); return next ? 'exit' : undefined; } } });
  agent.close();
  if (!next) break;
  current = next;
}
console.log(`SENT=${JSON.stringify(sent)}`);
console.log(`VISITS=${JSON.stringify(visits)}`);
