/**
 * What the app shows when a turn ends without completing (see the server's
 * `RunStatus`): a turn that was stopped with a known outcome keeps the
 * conversation usable; an uncertain one makes it read-only until "Check and
 * unlock" finds it settled in Letta.
 */

/** Last-run statuses that leave the conversation usable (`stopped`: Stop or a turn limit, outcome known). */
export const USABLE_STATUSES: readonly string[] = ['running', 'completed', 'stopped'];
/** Whether a conversation whose last run has this status is read-only. */
export const isLocked = (status: string | null | undefined): boolean => !!status && !USABLE_STATUSES.includes(status);

/** The short line under a stopped reply. */
export function stoppedLine(code: unknown): string {
  switch (code) {
    case 'idle_timeout': return 'Stopped: no progress for a while (idle timeout). You can continue.';
    case 'max_duration': return 'Stopped: the turn reached its time limit. You can continue.';
    case 'timed_out': return 'Stopped: a question or approval waited too long. You can continue.';
    default: return 'Stopped. You can continue.';
  }
}

/** The line under a failed reply. `usable`: Letta rejected it before the model produced anything (nothing ran), so the conversation stays usable. */
export function failedReplyLine(usable: boolean): string {
  return usable ? 'This reply failed before the agent started; nothing ran. You can continue.' : 'This reply failed.';
}

/** The notice over the composer of a read-only conversation (the last turn's outcome is uncertain). */
export function lockedNotice(code?: string): string {
  const why = code === 'delivery_uncertain' ? 'The server restarted while the agent was replying'
    : code === 'cancelled' ? 'The reply was stopped, but Letta didn’t confirm it ended'
    : code === 'timed_out' ? 'The reply timed out and Letta didn’t confirm it ended'
    : code ? `The last reply didn’t finish (${code})` : 'The last reply didn’t finish cleanly';
  return `${why}, so it’s unclear what the agent received. This conversation is read-only. Check and unlock asks Letta (nothing is resent), or start a new chat.`;
}

/** What "Check and unlock" found (`POST /v1/threads/:id/check`). */
export type CheckResult = { unlocked: boolean; active: boolean; delivered?: boolean; reply?: string; tools: { calls: number; unfinished: number }; pending: boolean; status?: string };

/** One line saying what Letta has, after a check. */
export function checkSummary(result: CheckResult): string {
  if (!result.unlocked) return result.active ? 'Letta is still working on that turn. Nothing was changed; check again in a moment.' : 'Couldn’t confirm the conversation is idle. Nothing was changed.';
  const message = result.delivered === true ? 'Letta received your message' : result.delivered === false ? 'Letta never received your message (it was not resent)' : 'Letta is idle';
  const reply = result.reply ? ', and replied (shown below)' : result.delivered === true ? ', but has no reply to it' : '';
  const tools = result.tools.unfinished ? ` ${result.tools.unfinished === 1 ? 'One tool call was' : `${result.tools.unfinished} tool calls were`} interrupted.` : '';
  return `Unlocked. ${message}${reply}.${tools}`;
}
