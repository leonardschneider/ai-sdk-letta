/** Display logic of the Automations dialog (pure, tested). */

export type Via = 'n8n' | 'conductor' | 'api';
export const VIA_LABEL: Record<Via, string> = { n8n: 'n8n', conductor: 'Conductor', api: 'API' };
export type TokenView = { id: string; name: string; via: Via; hint: string; actor: { name: string; login?: string }; preApproved: string[]; replyMode: string;
  /** Starting verdict of its runs' memory changes after reading untrusted content (absent on older servers: flag). */
  memoryFloor?: MemoryFloor; createdAt: string; createdBy: { name: string }; lastUsedAt?: string; active: boolean;
  lastRun?: { id: string; threadId: string; status: string; error?: string } };
export type ScheduleView = { id: string; at: string; prompt: string; conversation: 'current' | 'new'; threadId?: string; title?: string; actor: { name: string }; orchestrator: string; state: 'scheduling' | 'scheduled' | 'fired' | 'cancelled' | 'failed'; createdAt: string; firedAt?: string;
  run?: { id: string; threadId: string; status: string; error?: string } };
export type AutomationsData = { tokens: TokenView[]; schedules: ScheduleView[]; tools: string[]; replyModes: boolean; endpoint?: { url: string; docker?: string; scheduler?: Via } };

/** Toast and form wording for the routes' fixed codes. */
export function automationError(code: string): string {
  return ({
    admin_required: 'Only admins of this agent manage automations.', not_found: 'That is gone already. The list is up to date now.',
    capacity_reached: 'This agent has reached its token limit (50). Revoke one you no longer use.', invalid_input: 'Check the name and the tools.',
    scheduler_unreachable: 'Couldn’t reach the orchestrator to remove the job. Try again.', schedule_unavailable: 'That task already ran or was cancelled.',
    session_required: 'The local server restarted. Refresh the page.', csrf_required: 'The local server restarted. Refresh the page.', network: 'Couldn’t reach the server.',
  } as Record<string, string>)[code] ?? 'That didn’t work. Nothing was changed.';
}

/** "3 minutes ago", "in 2 hours", "yesterday"; dates beyond a week. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const minutes = Math.round(diff / 60_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return format.format(days, 'day');
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/** One line about a scheduled task's state. */
export function scheduleState(task: Pick<ScheduleView, 'state' | 'at' | 'run' | 'firedAt'>, now = Date.now()): string {
  if (task.state === 'scheduled' || task.state === 'scheduling') return `Runs ${relativeTime(task.at, now)}`;
  if (task.state === 'cancelled') return 'Cancelled';
  if (task.state === 'failed') return 'Couldn’t be scheduled';
  if (!task.run) return `Ran ${relativeTime(task.firedAt ?? task.at, now)}`;
  if (task.run.error === 'approval_required') return 'Ran, but needed approval';
  if (task.run.error === 'question_required') return 'Ran, but needed an answer';
  if (task.run.status === 'running' || task.run.status === 'queued') return 'Running now';
  if (task.run.status === 'decision_pending') return 'Ran; waiting for a decision';
  return task.run.status === 'completed' ? `Ran ${relativeTime(task.firedAt ?? task.at, now)}` : `Ran, ${task.run.status}`;
}

/** The small label on a message an automation started: "via n8n", "via Conductor", "via API", "scheduled · n8n". */
export function sourceLabel(source: { kind?: string; via?: string } | undefined): string | undefined {
  if (!source?.via) return undefined;
  const via = VIA_LABEL[source.via as Via] ?? 'API';
  return source.kind === 'schedule' ? `scheduled · ${via}` : `via ${via}`;
}

/** The starting verdict of an automation's memory changes when its run read untrusted content. */
export type MemoryFloor = 'accept' | 'flag' | 'ask_human';
/** The memory floor choices, as the Automations dialog lists them. */
export const MEMORY_FLOOR_CHOICES: readonly { value: MemoryFloor; label: string; help: string }[] = [
  { value: 'accept', label: 'Keep (reviewer decides)', help: 'Kept unless the reviewer objects.' },
  { value: 'flag', label: 'Keep, flagged (default)', help: 'Kept and marked for people to look at; the reviewer can still revert it.' },
  { value: 'ask_human', label: 'Hold for approval', help: 'Removed until someone approves it in the bell.' },
];
/** Short label of a token's memory floor: "memory: flagged". */
export function memoryFloorLabel(floor: MemoryFloor | undefined): string {
  return floor === 'accept' ? 'memory: reviewer decides' : floor === 'ask_human' ? 'memory: held for approval' : 'memory: flagged';
}
