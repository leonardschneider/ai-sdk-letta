/** Human label for a tool or field name, e.g. `fetchWeather_now` → "Fetch Weather now". */
export function friendlyName(value: string): string {
  return ({ ask_user: 'Question' } as Record<string, string>)[value] ?? value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().replace(/^./, c => c.toUpperCase());
}
export function parseArgs(value?: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value ?? '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
export type Field = { label: string; value: string };
const scalar = (value: unknown): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value);
export function resultFields(name: string, result: unknown, args: Record<string, unknown> = {}): Field[] {
  if (result === undefined) return [];
  if (typeof result === 'string' && /^[\s]*[\[{]/.test(result)) {
    try { return resultFields(name, JSON.parse(result), args); } catch { return [{ label: 'Result', value: 'Result received. Technical details are available below.' }]; }
  }
  if (scalar(result)) return [{ label: 'Result', value: String(result) }];
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [{ label: 'Result', value: 'Result received. Technical details are available below.' }];
  const data = result as Record<string, unknown>;
  if (name === 'ask_user') {
    if (data.cancelled) return [{ label: 'Answer', value: 'Cancelled' }];
    const options = Array.isArray(args.options) ? args.options as { id: string; label: string }[] : [];
    const labels = Array.isArray(data.selected) ? data.selected.map(id => options.find(o => o.id === id)?.label ?? 'Selected option') : [];
    return [{ label: 'Answer', value: [...labels, ...(typeof data.text === 'string' ? [data.text] : [])].join(' · ') || 'Answer received' }];
  }
  const fields = Object.entries(data).filter(([key, value]) => !/(^id$|Id$|_id$|token|secret|password)/i.test(key) && scalar(value)).slice(0, 6).map(([key, value]) => ({ label: friendlyName(key), value: String(value) }));
  return fields.length ? fields : [{ label: 'Result', value: 'Result received. Technical details are available below.' }];
}
/** @deprecated Kept for callers of the old helper; new titles use thread-model deriveTitle. */
export function conversationTitle(text: string): string { return text.replace(/\s+/g, ' ').trim().slice(0, 64) || 'New conversation'; }

/* ------------------------------------------------------------------ */
/* Tool activity lines                                                 */
/* ------------------------------------------------------------------ */

export type ToolPhase = 'running' | 'done' | 'error';
/** Fixed application codes (never free-form error text) that explain why a tool did not run. */
export function failureReason(result: unknown): string | undefined {
  let value = result;
  if (typeof value === 'string') {
    const turn = value.match(/^Turn (?:ended: )?(\w+)/)?.[1];
    if (turn) return turn;
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  const error = value && typeof value === 'object' && !Array.isArray(value) ? (value as { error?: unknown }).error : undefined;
  return typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) ? error : undefined;
}
export function toolLabel(name: string, phase: ToolPhase, result?: unknown): string {
  const reason = phase === 'error' ? failureReason(result) : undefined;
  if (reason === 'user_denied') return `Denied: ${friendlyName(name)}`;
  if (reason === 'approval_cancelled') return `Cancelled: ${friendlyName(name)}`;
  const tool = friendlyName(name);
  return phase === 'running' ? `Using ${tool}…` : phase === 'done' ? `Used ${tool}` : `${tool} didn’t complete`;
}
const reasonText: Record<string, string> = {
  user_denied: 'You denied this action, so it did not run.',
  approval_cancelled: 'The permission request was cancelled, so it did not run.',
  tool_timeout: 'The tool took too long and was stopped.',
  tool_cancelled: 'The tool was stopped before it finished.',
  timed_out: 'The turn timed out before this finished.',
  cancelled: 'The turn was stopped before this finished.',
  interrupted: 'The server restarted before this finished; it was not replayed.',
  failed: 'The turn failed before this finished.',
  delivery_uncertain: 'Delivery could not be confirmed; nothing was replayed.',
};
export function failureText(result: unknown): string {
  const reason = failureReason(result);
  return (reason && reasonText[reason]) ?? 'This did not complete. Nothing was retried automatically.';
}

/**
 * Friendly, compact summary of a finished tool. A result made only of numbers
 * (up to six) becomes a metrics line, e.g. "21 characters · 3 words · 1 line";
 * short string arguments are shown alongside it.
 */
export function toolSummary(name: string, result: unknown, args: Record<string, unknown> = {}): { metrics?: Field[]; fields: Field[] } {
  let data = result;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* text */ } }
  if (name !== 'ask_user' && data && typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length && entries.length <= 6 && entries.every(([, value]) => typeof value === 'number')) {
      const metrics = entries.map(([key, value]) => ({ label: value === 1 && key.endsWith('s') ? key.slice(0, -1) : key, value: (value as number).toLocaleString() }));
      const fields = Object.entries(args).filter(([, value]) => typeof value === 'string').slice(0, 3).map(([key, value]) => ({ label: friendlyName(key), value: value as string }));
      return { metrics, fields };
    }
  }
  return { fields: resultFields(name, result, args) };
}
export function metricsLine(metrics: Field[]): string { return metrics.map(m => `${m.value} ${m.label}`).join(' · '); }

/* ------------------------------------------------------------------ */
/* Questions and approvals                                             */
/* ------------------------------------------------------------------ */

export type AnswerLine = { state: 'answered' | 'cancelled' | 'closed' | 'unknown'; text: string; detail?: string };
/** One-line outcome of an ask_user call, e.g. "You answered: Red · muted shades". */
export function answerLine(result: unknown, args: Record<string, unknown>, isError = false): AnswerLine {
  if (isError) return { state: 'closed', text: 'Question closed without an answer', detail: failureText(result) };
  let data = result;
  if (typeof data === 'string') {
    // Legacy detached questions (before foreground tools) never delivered a result to the agent.
    if (/^(Awaiting a result|External tool )/.test(data)) return { state: 'closed', text: 'Question closed without an answer' };
    try { data = JSON.parse(data); } catch { return { state: 'unknown', text: 'Question: no answer was recorded' }; }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const answer = data as { cancelled?: unknown; error?: unknown };
    if (answer.cancelled === true) return { state: 'cancelled', text: 'You skipped this question' };
    if (answer.error !== undefined) return { state: 'closed', text: 'Question closed without an answer', detail: failureText(data) };
    const value = resultFields('ask_user', data, args)[0]?.value ?? 'Answer received';
    return { state: 'answered', text: `You answered: ${value}` };
  }
  return { state: 'unknown', text: 'Question: no answer was recorded' };
}

/** Every argument, flattened into readable label/value rows. Nothing is hidden or truncated. */
export function describeArguments(details: string | undefined): Field[] {
  const args = parseArgs(details);
  const rows: Field[] = [];
  const walk = (value: unknown, label: string) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (!entries.length) rows.push({ label, value: '(empty)' });
      for (const [key, inner] of entries) walk(inner, label ? `${label} › ${friendlyName(key)}` : friendlyName(key));
    } else if (Array.isArray(value)) {
      if (value.every(scalar)) rows.push({ label, value: value.length ? value.map(String).join(', ') : '(none)' });
      else value.forEach((inner, i) => walk(inner, `${label} ${i + 1}`));
    } else rows.push({ label: label || 'Value', value: value === null ? '(none)' : String(value) });
  };
  if (Object.keys(args).length) walk(args, '');
  else if (details?.trim()) rows.push({ label: 'Details', value: details });
  return rows;
}
