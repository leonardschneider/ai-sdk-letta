/** `@` mentions in the composer: pure helpers, no DOM. */
import { mentionNames } from 'ai-sdk-letta/listening';

/** The `@word` being typed just before the caret: where its `@` is, and what follows it so far. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
  if (caret < 1 || caret > text.length) return undefined;
  const match = /(^|[\s([{"'“‘])@([\p{L}\p{N}_.-]{0,40})$/u.exec(text.slice(0, caret));
  if (!match) return undefined;
  return { start: caret - match[2]!.length - 1, query: match[2]! };
}

/** The name a mention inserts for the agent ("Team Desk (throwaway)" → "Team Desk"). */
export function mentionName(agentName: string): string { return mentionNames(agentName)[0] ?? agentName.trim(); }

/** Does the agent's name (any of its words) start with what was typed after `@`? */
export function mentionMatches(query: string, agentName: string): boolean {
  const name = mentionName(agentName).toLowerCase();
  const typed = query.toLowerCase();
  return !typed || name.startsWith(typed) || name.split(/\s+/).some(word => word.startsWith(typed));
}

/** Replace the `@query` at `start` (up to the caret) with `@Name ` and put the caret after it. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  const rest = text.slice(caret).replace(/^[\p{L}\p{N}_.-]*/u, '').replace(/^ /, '');
  return { text: `${text.slice(0, start)}${inserted}${rest}`, caret: start + inserted.length };
}
