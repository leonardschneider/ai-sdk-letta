/** Offline PTY fixture: real patched TUI + real LettaAgent with image attachments; no backend or model. */
import { runAgentTUI } from '@ai-sdk/tui';
import type { UIMessage } from 'ai';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import { LettaAgent } from 'ai-sdk-letta';
import { terminalAttachments } from '../../src/attachments.js';
import { tools } from './tools.js';

const sent: SendMessage[] = [];
// Restored history with an image: display shows [Image], never sent again.
const initialMessages: UIMessage[] = [
  { id: 'old-user', role: 'user', parts: [{ type: 'text', text: 'OLDQUESTION' }, { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }] },
  { id: 'old-assistant', role: 'assistant', parts: [{ type: 'text', text: 'OLDANSWER' }] },
];
const agent = new LettaAgent({ id: 'images-fixture', tools, open: () => ({
  send: async message => { sent.push(message); }, abort: async () => {}, close: () => {},
  async *stream() {
    const last = sent.at(-1)!;
    const images = typeof last === 'string' ? 0 : last.filter(item => item.type === 'image').length;
    yield { type: 'assistant', content: `REPLY images=${images}`, uuid: 'a' } as SDKMessage;
    yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId: 'default' } as SDKMessage;
  },
}) });
// The clipboard is simulated through the exec seam: CLIPBOARD=png|none|text-only.
const png = Buffer.from(process.env.FIXTURE_PNG_B64!, 'base64');
const attachments = terminalAttachments({
  platform: 'darwin',
  exec: async (_command, args) => {
    const mode = process.env.CLIPBOARD_MODE_FILE ? (await import('node:fs')).readFileSync(process.env.CLIPBOARD_MODE_FILE, 'utf8').trim() : 'png';
    if (mode === 'none') return { stdout: Buffer.from('NONE'), code: 0 };
    (await import('node:fs')).writeFileSync(args.at(-1)!, png);
    return { stdout: Buffer.from('IMAGE'), code: 0 };
  },
});
await runAgentTUI({ agent, initialMessages, title: 'Images fixture', tools: 'full', reasoning: 'hidden', attachments });
agent.close();
console.log(`SENT=${JSON.stringify(sent.map(m => typeof m === 'string' ? m : m.map(item => item.type === 'text' ? item.text : `<${item.source.media_type}:${item.source.data.length}>`)))}`);
