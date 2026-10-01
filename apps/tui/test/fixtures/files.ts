/** Offline PTY fixture: real patched TUI + real LettaAgent with file attachments (real store, PDF parsing); no backend or model. */
import { runAgentTUI } from '@ai-sdk/tui';
import type { UIMessage } from 'ai';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import { AttachmentStore, LettaAgent, fileTools } from 'ai-sdk-letta';
import { terminalAttachments } from '../../src/attachments.js';
import { withFileLabels } from '../../src/terminal.js';
import { tools } from './tools.js';

const sent: SendMessage[] = [];
const store = new AttachmentStore(process.env.ATTACHMENTS_ROOT!, 'agent-local-fixture', 'conv-fixture');
// Restored history whose turn carried a file: shown as [File: name], never sent again.
const initialMessages: UIMessage[] = withFileLabels([
  { id: 'old-user', role: 'user', parts: [{ type: 'text', text: 'OLDQUESTION\n\nAttached: old-notes.md (Markdown, 3 lines, 40 bytes)' }] },
  { id: 'old-assistant', role: 'assistant', parts: [{ type: 'text', text: 'OLDANSWER' }] },
]);
const agent = new LettaAgent({ id: 'files-fixture', tools: { ...tools, ...fileTools }, attachments: store, open: () => ({
  send: async message => { sent.push(message); }, abort: async () => {}, close: () => {},
  async *stream() {
    yield { type: 'assistant', content: `REPLY stored=${store.list().map(f => f.name).join('|')}`, uuid: 'a' } as SDKMessage;
    yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId: 'conv-fixture' } as SDKMessage;
  },
}) });
await runAgentTUI({ agent, initialMessages, title: 'Files fixture', tools: 'full', reasoning: 'hidden', attachments: terminalAttachments({ files: true, platform: 'linux' }) });
agent.close();
console.log(`SENT=${JSON.stringify(sent)}`);
