import { runAgentTUI } from '@ai-sdk/tui';
import type { ToolSet } from 'ai';
import { openLettaAgent, type AgentDefinition, type LettaRuntime } from 'ai-sdk-letta';
import { localCommandMatches, navigate, NavigationScreen } from './navigation.js';
import { parseTerminalArgs, pickConversation, printConversations, type TerminalArgs } from './cli.js';

const HELP_LINE = 'PgUp/PgDn scroll history · Esc exits · /resume · /search [text] · /help';

/**
 * Run the interactive terminal UI for an agent definition until the user exits.
 *
 * Supports a startup conversation picker, `/resume` and `/search` (same agent
 * only), approvals and `ask_user` questions, and restored scrollback that is
 * display-only (never replayed to the agent).
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
      const initialMessages = [...presentation.initialMessages, { id: 'session-status', role: 'assistant' as const, parts: [{ type: 'text' as const, text: `${presentation.status}\n${HELP_LINE}` }] }];
      await runAgentTUI({ agent, title: `${definition.name} · ${presentation.title}`, tools: 'full', reasoning: 'hidden', initialMessages, interaction: agent.interactions,
        localCommand: { matches: localCommandMatches, run: async text => {
          next = await navigate(text, navigation);
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
