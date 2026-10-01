import { createInterface } from 'node:readline/promises';
import type { LettaConversation } from '@letta-ai/letta-agent-sdk';
import { sanitizeText, titleText, type ConversationChoice, type Identity } from 'ai-sdk-letta';

/** Parsed terminal command-line options. */
export type TerminalArgs = { list?: boolean; resume?: boolean; newTitle?: string; conversationId?: string; stateDirectory?: string };

/** Parse `--list | --resume | --new [title] | --conversation ID` plus `--state-dir PATH`. */
export function parseTerminalArgs(args: string[]): TerminalArgs {
  const result: TerminalArgs = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--list') result.list = true;
    else if (arg === '--resume') result.resume = true;
    else if (arg === '--conversation') {
      const id = args[++index];
      if (!id || id.startsWith('--')) throw new Error('--conversation requires an ID');
      result.conversationId = id;
    } else if (arg === '--state-dir') {
      const dir = args[++index];
      if (!dir || dir.startsWith('--')) throw new Error('--state-dir requires a path');
      result.stateDirectory = dir;
    } else if (arg === '--new') {
      result.newTitle = args[index + 1] && !args[index + 1]!.startsWith('--') ? args[++index] : `Conversation ${new Date().toISOString()}`;
    } else throw new Error(`Unknown option: ${arg}. Use --list, --new [title], --conversation ID, --resume, or --state-dir PATH.`);
  }
  if ([result.list, result.resume, result.newTitle !== undefined, result.conversationId !== undefined].filter(Boolean).length > 1) throw new Error('Choose only one of --list, --resume, --new or --conversation');
  return result;
}

/** Rows shown by `--list` and the startup picker: `default` first, then non-archived conversations. */
export function conversationRows(identity: Identity, conversations: LettaConversation[]) {
  return [{ id: 'default', agent_id: identity.agentId, summary: 'Default conversation', last_message_at: null }, ...conversations.filter(c => c.id !== 'default' && !c.archived)]
    .map(c => ({ id: c.id, title: titleText(sanitizeText(c.summary ?? '')) || 'Untitled conversation', activity: c.last_message_at ?? (c as LettaConversation).updated_at ?? (c as LettaConversation).created_at ?? 'unavailable (default backend thread)' }));
}

export function printConversations(identity: Identity, conversations: LettaConversation[]) {
  console.log(`${identity.name} | logical: ${identity.definitionId}\nLetta: ${identity.agentId} | last selected: ${identity.conversationId}`);
  const rows = conversationRows(identity, conversations);
  rows.forEach((row, index) => console.log(`${index + 1}. ${row.id === identity.conversationId ? '* ' : ''}${row.title} | activity: ${row.activity} | ${row.id}`));
  return rows;
}

/** Interactive startup picker. */
export async function pickConversation(identity: Identity, conversations: LettaConversation[]): Promise<ConversationChoice> {
  const rows = printConversations(identity, conversations);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await input.question('Enter = resume last | number = select | n = new | q = quit: ')).trim();
      if (!answer) return { conversationId: identity.conversationId };
      if (answer === 'q') return null;
      if (answer === 'n') {
        const title = (await input.question('New conversation title: ')).trim();
        if (title && title.length <= 120) return { newTitle: title };
        console.log('Please enter 1–120 characters.'); continue;
      }
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && rows[index]) return { conversationId: rows[index]!.id };
      console.log('Choose a listed number, n, q, or Enter.');
    }
  } finally { input.close(); }
}
