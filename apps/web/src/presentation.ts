/** Human label for a tool or field name, e.g. `fetchWeather_now` → "Fetch Weather now". */
export function friendlyName(value: string): string {
  return ({ ask_user: 'Question', run_command: 'Command', run_command_online: 'Command with internet access', atlassian_request: 'Atlassian', atlassian_fetch: 'Atlassian fetch', atlassian_update: 'Atlassian update' } as Record<string, string>)[value] ?? value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().replace(/^./, c => c.toUpperCase());
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
/** Page or line part of a file-tool label: "pages 1–3", "page 5", "lines 10–40". */
function rangeLabel(range: unknown, pdf: boolean): string {
  if (typeof range !== 'string' || !range.trim()) return '';
  const clean = range.trim().toLowerCase().replace(/^(pages?|lines?|pp?\.?|l\.?)\s*/, '');
  const match = /^(\d+)\s*(?:(?:-|–|—|\.\.|to)\s*(\d+)?)?$/.exec(clean);
  const unit = pdf ? 'page' : 'line';
  if (!match) return `${unit}s ${range.trim()}`;
  if (match[2] && match[2] !== match[1]) return `${unit}s ${match[1]}–${match[2]}`;
  if (/(-|–|—|\.\.|to)\s*$/.test(clean)) return `${unit}s ${match[1]}–end`;
  return `${unit} ${match[1]}`;
}
const quoted = (value: string) => `“${value.length > 60 ? `${value.slice(0, 59)}…` : value}”`;
/** Natural label for the built-in file tools: "Read report.pdf, pages 1–3", "Searched files for “budget”". */
function fileToolLabel(name: string, phase: ToolPhase, args: Record<string, unknown>): string | undefined {
  const file = typeof args.name === 'string' ? args.name : '';
  if (name === 'list_files') return phase === 'running' ? 'Listing files…' : phase === 'done' ? 'Listed files' : 'Couldn’t list files';
  if (name === 'read_file' && file) {
    const range = rangeLabel(args.range, /\.pdf$/i.test(file));
    const target = `${file}${range ? `, ${range}` : ''}`;
    return phase === 'running' ? `Reading ${target}…` : phase === 'done' ? `Read ${target}` : `Couldn’t read ${target}`;
  }
  if (name === 'search_files' && typeof args.query === 'string') {
    const where = file ? file : 'files';
    return phase === 'running' ? `Searching ${where} for ${quoted(args.query)}…` : phase === 'done' ? `Searched ${where} for ${quoted(args.query)}` : `Couldn’t search ${where} for ${quoted(args.query)}`;
  }
  return undefined;
}
/** Labels of the Atlassian tools: "Fetched KAN-1", "Updated KAN-1", "Searched Jira". */
function atlassianLabel(name: string, phase: ToolPhase, args: Record<string, unknown>, result: unknown): string | undefined {
  const failed = phase === 'error' || (typeof result === 'string' && /^Error \(/.test(result));
  if (name === 'atlassian_fetch' && typeof args.ref === 'string') {
    const ref = args.ref.length > 60 ? `${args.ref.slice(0, 59)}…` : args.ref;
    return phase === 'running' ? `Fetching ${ref} from Atlassian…` : failed ? `Couldn’t fetch ${ref}` : `Fetched ${ref} from Atlassian`;
  }
  if (name === 'atlassian_update' && typeof args.file === 'string') {
    const file = args.file.replace(/\.md$/i, '');
    return phase === 'running' ? `Updating ${file} in Atlassian…` : failed ? `Didn’t update ${file}` : `Updated ${file} in Atlassian`;
  }
  if (name === 'atlassian_request' && typeof args.path === 'string') {
    const what = args.path.startsWith('/wiki/') ? 'Confluence' : 'Jira';
    const verb = args.method === 'GET' ? (/search/.test(args.path) ? 'Searched' : 'Read from') : args.method === 'DELETE' ? 'Deleted in' : 'Changed';
    const running = args.method === 'GET' ? (/search/.test(args.path) ? 'Searching' : 'Reading from') : args.method === 'DELETE' ? 'Deleting in' : 'Changing';
    return phase === 'running' ? `${running} ${what}…` : failed ? `${what} request didn’t complete` : `${verb} ${what}`;
  }
  return undefined;
}
/* ------------------------------------------------------------------ */
/* Shell commands                                                      */
/* ------------------------------------------------------------------ */

/** The built-in sandbox tools. */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['run_command', 'run_command_online']);
/** A command shortened to one line for a label: "rg budget", "python3 stats.py …". */
export function commandPreview(command: unknown, max = 72): string {
  if (typeof command !== 'string') return '';
  const lines = command.trim().split('\n').map(line => line.trim()).filter(Boolean);
  const first = (lines[0] ?? '').replace(/\s+/g, ' ');
  const more = lines.length > 1;
  if (first.length <= max) return more ? `${first}…` : first;
  return `${first.slice(0, max).replace(/\s+\S*$/, '') || first.slice(0, max)}…`;
}
/** A finished command's result as the model saw it: exit code, duration, output. */
export type CommandOutput = { exitCode?: number; duration?: string; timedOut: boolean; output: string; truncated: boolean; error?: string };
export function commandOutput(result: unknown): CommandOutput | undefined {
  if (typeof result !== 'string') return undefined;
  const error = /^Error \(([a-z_]+)\): ([\s\S]*)$/.exec(result);
  if (error) return { timedOut: false, output: '', truncated: false, error: error[2]!.trim() };
  const head = /^Exit code: (-?\d+) \(([^)]*)\)\n?/.exec(result);
  if (!head) return undefined;
  const output = result.slice(head[0].length);
  const timedOut = /^timed out/.test(head[2]!);
  return { exitCode: Number(head[1]), duration: timedOut ? undefined : head[2], timedOut, output: output === '(no output)' ? '' : output, truncated: /\[… [\d.]+ (?:bytes|KB|MB) of output omitted …\]/.test(output) };
}
function commandLabel(name: string, phase: ToolPhase, args: Record<string, unknown>, result: unknown): string | undefined {
  if (!COMMAND_TOOLS.has(name)) return undefined;
  const command = commandPreview(args.command);
  if (!command) return undefined;
  const online = name === 'run_command_online';
  if (phase === 'running') return `Running ${online ? 'with internet ' : ''}\`${command}\`…`;
  if (phase === 'error') return `Couldn’t run \`${command}\``;
  const out = commandOutput(result);
  if (out?.error) return `Couldn’t run \`${command}\``;
  return `Ran ${online ? 'with internet ' : ''}\`${command}\``;
}
/** Short status after a command label: "exit 1", "timed out". Empty for success. */
export function commandStatus(result: unknown): string {
  const out = commandOutput(result);
  if (!out) return '';
  if (out.error) return '';
  if (out.timedOut) return 'timed out';
  return out.exitCode === 0 ? '' : `exit ${out.exitCode}`;
}

export function toolLabel(name: string, phase: ToolPhase, result?: unknown, args: Record<string, unknown> = {}): string {
  const reason = phase === 'error' ? failureReason(result) : undefined;
  if (reason === 'user_denied') return COMMAND_TOOLS.has(name) && commandPreview(args.command) ? `Denied: \`${commandPreview(args.command)}\`` : `Denied: ${friendlyName(name)}`;
  if (reason === 'approval_cancelled') return `Cancelled: ${friendlyName(name)}`;
  if (reason === 'approval_required') return `Needed approval: ${friendlyName(name)}`;
  if (reason === 'question_required') return 'Needed an answer (unattended)';
  if (reason === 'unattended_stopped') return `Skipped: ${friendlyName(name)}`;
  const shell = commandLabel(name, phase, args, result);
  if (shell) return shell;
  const file = fileToolLabel(name, phase, args);
  if (file) return file;
  const atlassian = atlassianLabel(name, phase, args, result);
  if (atlassian) return atlassian;
  const tool = friendlyName(name);
  return phase === 'running' ? `Using ${tool}…` : phase === 'done' ? `Used ${tool}` : `${tool} didn’t complete`;
}

/** Built-in file tools return text for the model; summarize it in one line for the expanded view. */
export function fileToolSummary(name: string, result: unknown): string | undefined {
  if (name.startsWith('atlassian_') && typeof result === 'string') { const first = result.split('\n', 1)[0]!.trim(); return first.length > 200 ? `${first.slice(0, 199)}…` : first; }
  if (!['list_files', 'read_file', 'search_files'].includes(name) || typeof result !== 'string') return undefined;
  const first = result.split('\n', 1)[0]!.trim();
  if (name === 'read_file') {
    const range = /: ((?:pages|lines) [\d,–]+ of [\d,]+)$/.exec(first)?.[1];
    const truncated = /\[Truncated/.test(result) ? ' · truncated' : '';
    const image = /attached below/.test(result) ? ' · with page image' : '';
    return range ? `${range.replace(/^(pages|lines) (\d+) of/, (_, unit: string, n: string) => `${unit.slice(0, -1)} ${n} of`)}${truncated}${image}` : first.slice(0, 160);
  }
  if (name === 'search_files') {
    const found = /^Found [\d,]+ passages? for ".*?" in [\d,]+ files?/.exec(first)?.[0];
    if (found) return found;
  }
  const line = first.replace(/:$/, '');
  return line.length > 200 ? `${line.slice(0, 199).replace(/\s+\S*$/, '')}…` : line;
}
const reasonText: Record<string, string> = {
  user_denied: 'You denied this action, so it did not run.',
  approval_cancelled: 'The permission request was cancelled, so it did not run.',
  tool_timeout: 'The tool took too long and was stopped.',
  tool_denied: 'This tool is not available in this session.',
  tool_cancelled: 'The tool was stopped before it finished.',
  timed_out: 'The turn timed out before this finished.',
  cancelled: 'The turn was stopped before this finished.',
  interrupted: 'The server restarted before this finished; it was not replayed.',
  failed: 'The turn failed before this finished.',
  delivery_uncertain: 'Delivery could not be confirmed; nothing was replayed.',
  approval_required: 'Not run: this turn was started by an automation and nobody could approve it. Pre-approve the tool for that automation, or do it here.',
  question_required: 'Not asked: this turn was started by an automation and nobody could answer.',
  unattended_stopped: 'Not run: the automation’s turn had already stopped for approval.',
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
  const fileSummary = fileToolSummary(name, result);
  if (fileSummary) return { fields: [{ label: 'Result', value: fileSummary }] };
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

/** Line diff of two short texts (for a changed block): common lines stay, others are marked removed or added. */
export function lineDiff(before: string, after: string): { kind: 'same' | 'removed' | 'added'; text: string }[] {
  const a = before ? before.split('\n') : [], b = after ? after.split('\n') : [];
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: { kind: 'same' | 'removed' | 'added'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: 'same', text: a[i]! }); i++; j++; }
    // Removed lines come before the lines that replace them.
    else if (i < a.length && (j >= b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) { out.push({ kind: 'removed', text: a[i]! }); i++; }
    else { out.push({ kind: 'added', text: b[j]! }); j++; }
  }
  return out;
}

/**
 * The readable reason a tool reported (Atlassian tools answer "Error (code):
 * message" with text written for the user, never secrets), or undefined for
 * other tools, whose errors stay fixed codes.
 */
export function toolErrorText(name: string, result: unknown): string | undefined {
  if (!name.startsWith('atlassian_') || typeof result !== 'string') return undefined;
  const match = /^Error \(([a-z_]+)\): ([\s\S]+)$/.exec(result.trim());
  return match ? match[2]!.slice(0, 1200) : undefined;
}
