import { jsonSchema, tool, type Tool } from 'ai';
import type { ToolPermission } from './definition.js';
import type { TurnActor } from './credentials.js';
import { withPreparation, type PreparedCall } from './tools.js';

/**
 * Agent self-scheduling: the `schedule_task` tool asks the server's
 * orchestrator (n8n or Conductor) to run a prompt once, later. Nothing here
 * keeps a timer: the orchestrator owns the schedule and calls the server's
 * automation API when it is due. The tool is opt-in per definition and asks
 * the user by default.
 */

/** Name of the scheduling tool. */
export const SCHEDULE_TASK_TOOL = 'schedule_task';
/** Key under which the runtime passes the {@link SchedulerContext} to tools (`options.context[SCHEDULER_CONTEXT]`). Never from the model. */
export const SCHEDULER_CONTEXT = 'ai-sdk-letta.scheduler';
/** Bounds of a scheduled task. */
export const SCHEDULE_LIMITS = Object.freeze({
  /** Earliest: this long from now (orchestrators fire on the minute). */
  minDelayMs: 60_000,
  /** Latest: this long from now. */
  maxDelayMs: 366 * 24 * 60 * 60_000,
  maxPromptCharacters: 4000,
  maxTitleCharacters: 120,
});

/** What the agent asks for, validated (`at` in UTC, on a whole minute). */
export type ScheduleRequest = {
  /** When to run, ISO 8601 UTC, rounded up to the next whole minute. */
  at: string;
  /** The message the agent receives then. */
  prompt: string;
  /** `'current'`: the conversation the agent was in; `'new'`: a new conversation (titled `title`). */
  conversation: 'current' | 'new';
  title?: string;
};
/** A task the orchestrator now holds. */
export type ScheduledTask = { id: string; at: string; orchestrator: string; conversation: 'current' | 'new'; title?: string };
/**
 * Creates one-off jobs in an orchestrator. The server implements it for the
 * conversation and person of the running turn (see `SchedulerContext`).
 */
export interface TaskScheduler {
  /** @throws an `Error` whose message is a fixed code (`scheduler_unavailable`, `scheduler_failed`, `schedule_limit`, ...) */
  schedule(request: ScheduleRequest, turn: { conversationId: string; actor?: TurnActor }): Promise<ScheduledTask>;
}
/** What the runtime binds for a turn. */
export type SchedulerContext = { scheduler: TaskScheduler; conversationId: string; actor?: TurnActor };

const UNITS: Record<string, number> = { minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000, hour: 3_600_000, hours: 3_600_000, h: 3_600_000, day: 86_400_000, days: 86_400_000, week: 604_800_000, weeks: 604_800_000 };

/**
 * When a task runs: an ISO 8601 date and time with a time zone
 * (`2026-10-03T08:00:00+02:00`, `...Z`), or `in <n> minutes|hours|days|weeks`.
 * Rounded up to the next whole minute, at least a minute from `now`, at most a year.
 * @throws `Error('invalid_when')`, `Error('too_soon')` or `Error('too_far')`
 */
export function resolveWhen(when: string, now = Date.now()): string {
  const text = when.trim().toLowerCase();
  let time: number;
  const relative = /^in\s+(\d{1,4})\s*([a-z]+)$/.exec(text);
  if (relative) {
    const unit = UNITS[relative[2]!];
    if (!unit) throw new Error('invalid_when');
    time = now + Number(relative[1]) * unit;
  } else {
    // A time zone is required: a bare local time is ambiguous on a server.
    if (!/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(text)) throw new Error('invalid_when');
    time = Date.parse(when.trim());
    if (!Number.isFinite(time)) throw new Error('invalid_when');
  }
  const minute = Math.ceil(time / 60_000) * 60_000;
  if (minute - now < SCHEDULE_LIMITS.minDelayMs - 1000) throw new Error('too_soon');
  if (minute - now > SCHEDULE_LIMITS.maxDelayMs) throw new Error('too_far');
  return new Date(minute).toISOString();
}

/** Arguments of `schedule_task`. */
export type ScheduleTaskInput = { when: string; prompt: string; conversation?: 'current' | 'new'; title?: string };
type Input = ScheduleTaskInput;
/** Result of `schedule_task`, as the agent sees it. */
export type ScheduleTaskOutput = { scheduled: true; id: string; at: string; orchestrator: string; conversation: 'current' | 'new'; title?: string } | { error: string; message: string };

const WHEN_HELP = 'Use an ISO 8601 date and time with a time zone (for example 2026-10-03T08:00:00+02:00) or "in 30 minutes", "in 2 hours", "in 3 days".';
type Output = ScheduleTaskOutput;
const failure = (code: string): Output => ({ error: code, message: ({
  invalid_when: `"when" is not a time I can schedule. ${WHEN_HELP}`,
  too_soon: 'That is too soon: schedule at least one minute ahead.',
  too_far: 'That is too far ahead: schedule at most a year ahead.',
  invalid_input: 'The prompt must contain 1 to 4,000 characters, and a title at most 120.',
  scheduler_unavailable: 'Scheduling is not set up on this server (no orchestrator is configured). Tell the user; nothing was scheduled.',
  schedule_limit: 'Too many tasks are already scheduled for this agent. Nothing was scheduled.',
} as Record<string, string>)[code] ?? 'The orchestrator could not create the job. Nothing was scheduled.' });

function parse(input: Input, now = Date.now()): { request?: ScheduleRequest; error?: string } {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const title = typeof input.title === 'string' ? input.title.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim() : undefined;
  if (!prompt || prompt.length > SCHEDULE_LIMITS.maxPromptCharacters || (title !== undefined && title.length > SCHEDULE_LIMITS.maxTitleCharacters)) return { error: 'invalid_input' };
  let at: string;
  try { at = resolveWhen(input.when, now); } catch (error) { return { error: (error as Error).message }; }
  const conversation = input.conversation === 'new' ? 'new' : 'current';
  return { request: { at, prompt, conversation, ...(conversation === 'new' && title ? { title } : {}) } };
}
const contextOf = (context: Readonly<Record<string, unknown>> | undefined) => context?.[SCHEDULER_CONTEXT] as SchedulerContext | undefined;
const describe = (request: ScheduleRequest) => `${new Date(request.at).toUTCString().replace(':00 GMT', ' UTC')}${request.conversation === 'new' ? ` · in a new conversation${request.title ? ` “${request.title}”` : ''}` : ' · in this conversation'}`;

/**
 * `schedule_task(when, prompt, conversation?, title?)`: run `prompt` once at
 * `when`, as a new message from the person who asked, through the server's
 * orchestrator. The approval card shows the time and the prompt.
 *
 * ```ts
 * tools: { ...schedulingTools }, permissions: { ...SCHEDULING_TOOL_PERMISSIONS } // schedule_task: 'ask'
 * ```
 */
export const scheduleTaskTool: Tool<ScheduleTaskInput, ScheduleTaskOutput> = withPreparation(tool({
  description: 'Schedule a task to run ONCE later: at that time you receive `prompt` as a new message (in this conversation, or a new one) and do it then, unattended (nobody can answer questions or approve actions during that run). '
    + `${WHEN_HELP} Use it when the user asks you to do something later or to remind them. Not for recurring schedules.`,
  inputSchema: jsonSchema<Input>({
    type: 'object',
    properties: {
      when: { type: 'string', minLength: 1, maxLength: 64, description: WHEN_HELP },
      prompt: { type: 'string', minLength: 1, maxLength: SCHEDULE_LIMITS.maxPromptCharacters, description: 'The instruction you will receive at that time; write it so it makes sense on its own.' },
      conversation: { type: 'string', enum: ['current', 'new'], description: 'Where to run it: this conversation (default) or a new one.' },
      title: { type: 'string', maxLength: SCHEDULE_LIMITS.maxTitleCharacters, description: 'Title of the new conversation (with conversation "new").' },
    },
    required: ['when', 'prompt'],
    additionalProperties: false,
  }),
  execute: async (input: Input, options: { toolCallId: string; context?: Readonly<Record<string, unknown>> }): Promise<Output> => {
    const parsed = parse(input);
    if (!parsed.request) return failure(parsed.error!);
    const bound = contextOf(options.context);
    if (!bound) return failure('scheduler_unavailable');
    try {
      const task = await bound.scheduler.schedule(parsed.request, { conversationId: bound.conversationId, ...(bound.actor ? { actor: bound.actor } : {}) });
      return { scheduled: true, id: task.id, at: task.at, orchestrator: task.orchestrator, conversation: task.conversation, ...(task.title ? { title: task.title } : {}) };
    } catch (error) {
      const code = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'scheduler_failed';
      return failure(code);
    }
  },
}), (input, options): PreparedCall => {
  // Problems the agent can fix are answered at once, without asking the user.
  const parsed = parse(input as Input);
  if (!parsed.request) return { output: failure(parsed.error!) };
  if (!contextOf(options.context)) return { output: failure('scheduler_unavailable') };
  const request = parsed.request;
  return { preview: { kind: 'schedule-task', title: `Schedule: ${describe(request)}`, text: `When: ${describe(request)}\n\n${request.prompt}`, data: { ...request } } };
});

/** The scheduling tool, to spread into a definition's `tools`. */
export const schedulingTools: { readonly schedule_task: Tool<ScheduleTaskInput, ScheduleTaskOutput> } = Object.freeze({ [SCHEDULE_TASK_TOOL]: scheduleTaskTool });
/** Default permission: ask the user before each scheduled task. */
export const SCHEDULING_TOOL_PERMISSIONS: Readonly<Record<'schedule_task', ToolPermission>> = Object.freeze({ schedule_task: 'ask' });
/** Does the definition include the scheduling tool (with a permission other than deny)? */
export const schedulingEnabled = (definition: { tools: Record<string, unknown>; permissions: Readonly<Record<string, ToolPermission>> }) =>
  Object.hasOwn(definition.tools, SCHEDULE_TASK_TOOL) && (definition.permissions[SCHEDULE_TASK_TOOL] === 'ask' || definition.permissions[SCHEDULE_TASK_TOOL] === 'allow');
