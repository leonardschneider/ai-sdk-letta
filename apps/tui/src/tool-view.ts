import type { TerminalToolPart } from '@ai-sdk/tui';

const COMMAND_TOOLS = new Set(['run_command', 'run_command_online']);
/** Lines of command output shown in a terminal card (cards cannot be expanded in the terminal). */
export const COMMAND_PREVIEW_LINES = 8;

/** A command shortened to one line: "rg budget", "python3 - <<EOF…". */
export function commandPreview(command: string, max = 60): string {
  const lines = command.trim().split('\n').map(line => line.trim()).filter(Boolean);
  const first = (lines[0] ?? '').replace(/\s+/g, ' ');
  if (first.length <= max) return lines.length > 1 ? `${first}…` : first;
  return `${first.slice(0, max).replace(/\s+\S*$/, '') || first.slice(0, max)}…`;
}

const failure = (text: string | undefined) => {
  try { const error = (JSON.parse(text ?? '') as { error?: unknown }).error; return typeof error === 'string' ? error : undefined; } catch { return undefined; }
};
const reasons: Record<string, string> = { user_denied: 'You denied this command.', approval_cancelled: 'The request was cancelled.', tool_timeout: 'The command took too long and was stopped.', tool_cancelled: 'The command was stopped.' };

/**
 * Terminal cards for the sandbox tools: "Ran `rg budget`" with the exit code
 * on the right, then the command and the first lines of output. Other tools
 * keep the default card.
 */
export function toolView(part: TerminalToolPart): { title?: string; rightTitle?: string; content?: string; raw?: boolean } | undefined {
  if (!COMMAND_TOOLS.has(part.toolName)) return undefined;
  const input = part.input as { command?: unknown; cwd?: unknown } | undefined;
  if (typeof input?.command !== 'string') return undefined;
  const online = part.toolName === 'run_command_online';
  const short = commandPreview(input.command);
  const where = typeof input.cwd === 'string' && input.cwd.trim() && input.cwd.trim() !== '.' ? `  (in ${input.cwd.trim()})` : '';
  const commandLines = input.command.trim().split('\n');
  const shown = `$ ${commandLines.slice(0, 6).join('\n  ')}${commandLines.length > 6 ? `\n  … ${commandLines.length - 6} more lines` : ''}${where}`;
  if (part.state === 'output-error') {
    const reason = failure(part.errorText);
    return { title: reason === 'user_denied' ? `Denied: \`${short}\`` : `Couldn’t run \`${short}\``, rightTitle: reason === 'user_denied' ? 'denied' : 'failed', content: `${shown}\n\n${(reason && reasons[reason]) ?? 'The command did not complete.'}`, raw: true };
  }
  if (part.state !== 'output-available') return { title: `Running ${online ? 'with internet ' : ''}\`${short}\``, rightTitle: part.state === 'approval-requested' ? 'approval requested' : 'running', content: shown, raw: true };
  const text = typeof part.output === 'string' ? part.output : '';
  const error = /^Error \(([a-z_]+)\): ([\s\S]*)$/.exec(text);
  if (error) return { title: `Couldn’t run \`${short}\``, rightTitle: 'failed', content: `${shown}\n\n${error[2]!.trim()}`, raw: true };
  const head = /^Exit code: (-?\d+) \(([^)]*)\)\n?/.exec(text);
  if (!head) return { title: `Ran \`${short}\``, content: `${shown}\n\n${text}`, raw: true };
  const timedOut = /^timed out/.test(head[2]!);
  const body = text.slice(head[0].length);
  const lines = body === '(no output)' ? [] : body.replace(/\n\[Output truncated\.[^\n]*$/, '').split('\n');
  const preview = lines.slice(0, COMMAND_PREVIEW_LINES).join('\n');
  const more = lines.length > COMMAND_PREVIEW_LINES ? `\n… ${lines.length - COMMAND_PREVIEW_LINES} more lines` : '';
  return {
    title: `Ran ${online ? 'with internet ' : ''}\`${short}\``,
    rightTitle: timedOut ? 'timed out' : `exit ${head[1]} · ${head[2]}`,
    content: `${shown}\n\n${lines.length ? `${preview}${more}` : '(no output)'}`,
    raw: true,
  };
}
