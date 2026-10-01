import { tool, jsonSchema } from 'ai';

/** Input of {@link dateDiff}: two calendar dates. */
export type DateDiffInput = { from: string; to: string };

/** What {@link dateDiff} returns to the agent. */
export type DateDiffOutput =
  | { days: number; weeks: number; extraDays: number; businessDays: number; fromWeekday: string; toWeekday: string }
  | { error: 'invalid_date'; message: string };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const DAY_MS = 86_400_000;

/** Parse `YYYY-MM-DD` as a UTC calendar date; `undefined` if it is not a real date. */
function parseDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects dates such as 2025-02-30, which Date would roll over to March.
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
}

/** Monday to Friday dates after `start`, up to and including `end` (`start <= end`). */
function businessDaysBetween(start: Date, end: Date): number {
  const total = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  let count = Math.floor(total / 7) * 5;
  for (let offset = Math.floor(total / 7) * 7 + 1; offset <= total; offset++) {
    const weekday = (start.getUTCDay() + offset) % 7;
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

/**
 * Pure date arithmetic, which language models often get wrong. No network,
 * no files, no side effects: safe to `allow` without asking.
 */
export const dateDiff = tool({
  description: 'Count the days between two calendar dates (YYYY-MM-DD): total days, weeks, business days (Monday to Friday after "from", up to and including "to"; no holidays) and the weekday of each date. Negative when "to" is before "from".',
  inputSchema: jsonSchema<DateDiffInput>({
    type: 'object',
    properties: {
      from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Start date, YYYY-MM-DD' },
      to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'End date, YYYY-MM-DD' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  }),
  execute: async ({ from, to }): Promise<DateDiffOutput> => {
    const start = parseDate(from);
    const end = parseDate(to);
    // Return a structured error the model can read and correct. A thrown
    // error reaches the model only as the fixed code "tool_failed".
    if (!start || !end) return { error: 'invalid_date', message: `Not a calendar date: ${!start ? from : to}` };
    const days = Math.round((end.getTime() - start.getTime()) / DAY_MS);
    return {
      days,
      // `+ 0` turns -0 into 0.
      weeks: Math.trunc(days / 7) + 0,
      extraDays: (days % 7) + 0,
      businessDays: days < 0 ? -businessDaysBetween(end, start) + 0 : businessDaysBetween(start, end),
      fromWeekday: WEEKDAYS[start.getUTCDay()]!,
      toWeekday: WEEKDAYS[end.getUTCDay()]!,
    };
  },
});
