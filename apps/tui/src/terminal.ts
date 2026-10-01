import { runAgentTUI } from '@ai-sdk/tui';
import type { ToolSet } from 'ai';
import { filesEnabled, openLettaAgent, parseAttachmentNote, type AgentDefinition, type LettaRuntime } from 'ai-sdk-letta';
import type { UIMessage } from 'ai';
import { localCommandMatches, navigate, NavigationScreen } from './navigation.js';
import { parseTerminalArgs, pickConversation, printConversations, type TerminalArgs } from './cli.js';
import { terminalAttachments } from './attachments.js';
import { toolView } from './tool-view.js';

const HELP_LINE = 'PgUp/PgDn scroll history · Esc exits · Ctrl+V or drop a file to attach an image · /resume · /search [text] · /help';
const HELP_LINE_FILES = 'PgUp/PgDn scroll history · Esc exits · drop a file (PDF, text, CSV, code, image) or Ctrl+V an image to attach it · /resume · /search [text] · /resources · /help';

/**
 * Restored user messages end with the "Attached: name (...)" note the agent
 * received; show it as `[File: name]` labels instead (images already show as `[Image]`).
 */
export function withFileLabels(messages: UIMessage[]): UIMessage[] {
  return messages.map(message => {
    if (message.role !== 'user') return message;
    const parts = message.parts.flatMap((part): UIMessage['parts'] => {
      if (part.type !== 'text') return [part];
      const { text, files } = parseAttachmentNote(part.text);
      if (!files.length) return [part];
      const images = message.parts.filter(p => p.type === 'file' && /^image\//.test(p.mediaType)).length;
      const labels = files.filter(file => !(images && / image$/.test(file.label))).map(file => ({ type: 'text' as const, text: `[File: ${file.name}]` }));
      return [...labels, ...(text.trim() ? [{ type: 'text' as const, text }] : [])];
    });
    return { ...message, parts };
  });
}

/**
 * Run the interactive terminal UI for an agent definition until the user exits.
 *
 * Supports a startup conversation picker, `/resume` and `/search` (same agent
 * only), approvals and `ask_user` questions, image attachments (Ctrl+V, or a
 * pasted or dropped image path), and restored scrollback that is display-only
 * (never replayed to the agent).
 *
 * @param args Parsed options, or raw `process.argv.slice(2)`.
 * @returns the process exit code to use.
 */
export async function runTerminal<TOOLS extends ToolSet>(definition: AgentDefinition<TOOLS>, args: TerminalArgs | string[] = process.argv.slice(2)): Promise<number> {
  let runtime: LettaRuntime<TOOLS> | undefined;
  let shuttingDown: Promise<void> | undefined;
  const close = () => shuttingDown ??= (async () => { await runtime?.close(); })();
  const stop = () => { void close().finally(() => process.exit(130)); };
  try {
    const options = Array.isArray(args) ? parseTerminalArgs(args) : args;
    if (!options.list && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('The terminal UI requires an interactive terminal (TTY); --list also works without one.');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const open = (conversation: Parameters<typeof openLettaAgent>[1]) => openLettaAgent(definition, { stateDirectory: options.stateDirectory, ...conversation });
    runtime = await open({
      conversationId: options.conversationId, newTitle: options.newTitle,
      choose: options.list ? async (identity, conversations) => { printConversations(identity, conversations); return null; }
        : options.resume || options.newTitle !== undefined || options.conversationId ? undefined : pickConversation,
    });
    while (runtime) {
      const { agent, navigation } = runtime;
      const presentation = agent.presentation!;
      let next: string | undefined;
      const files = filesEnabled(definition);
      const initialMessages = [...withFileLabels(presentation.initialMessages), { id: 'session-status', role: 'assistant' as const, parts: [{ type: 'text' as const, text: `${presentation.status}\n${files ? HELP_LINE_FILES : HELP_LINE}` }] }];
      await runAgentTUI({ agent, title: `${definition.name} · ${presentation.title}`, tools: 'full', reasoning: 'hidden', initialMessages, interaction: agent.interactions, toolView,
        attachments: terminalAttachments({ files }),
        localCommand: { matches: localCommandMatches, run: async text => {
          next = await navigate(text, navigation, undefined, runtime?.resources ? { store: runtime.resources, conversationId: presentation.conversationId } : undefined);
          return next ? 'exit' : undefined;
        } },
      });
      if (!next) break;
      const previous = presentation.conversationId;
      // Graceful close, not abort: no delivered turn or background dream is
      // deliberately cancelled. The identity lock is released after SDK close.
      await runtime.close();
      runtime = undefined;
      try { runtime = await open({ conversationId: next }); }
      catch {
        const screen = new NavigationScreen();
        try { await screen.notice('Selected conversation is unavailable or not safely idle. Returning to previous conversation; no message sent.'); }
        finally { screen.close(); }
        runtime = await open({ conversationId: previous });
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Terminal session failed');
    return 1;
  } finally {
    await close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
