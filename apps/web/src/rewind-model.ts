/** Pure model of the rewind confirmation (no I/O): the summary the server returns, as the sections the dialog shows. */
import type { RewindSummary } from '@ai-sdk-letta/server';

export type { RewindSummary };
type FilePlan = NonNullable<RewindSummary['resources']>['files'][number];

/** One line of a section. `tone`: how it reads (`danger` for what is lost, `warn` for what stays despite the rewind). */
export type RewindLine = { key: string; text: string; detail?: string; tone?: 'danger' | 'warn' };
/** A section of the confirmation, in order. Empty sections are left out. */
export type RewindSection = { id: 'turns' | 'files' | 'memory' | 'conflicts' | 'kept' | 'external' | 'cancel'; title: string; lines: RewindLine[]; note?: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** What happens to a file the rewound turns changed. */
export function fileAction(file: Pick<FilePlan, 'change'>): string {
  return file.change === 'created' ? 'Deleted (created by these turns)' : file.change === 'deleted' ? 'Restored (deleted by these turns)' : 'Restored to how it was';
}
const conflictText = (file: FilePlan) => file.reason === 'uncommitted' ? 'Kept as it is: it is being changed right now'
  : `Kept as it is now: changed later${file.by?.length ? ` by “${file.by[0]!.subject}”` : ' by something else'}`;

/** The sections of the confirmation dialog, from a preview. */
export function rewindSections(summary: RewindSummary): RewindSection[] {
  const sections: RewindSection[] = [];
  sections.push({ id: 'turns', title: `Removed from this conversation (${plural(summary.turns.length, 'turn')})`,
    lines: summary.turns.map(turn => ({ key: turn.runId, text: turn.kind === 'decision' ? `Decision: ${turn.input}` : turn.input || '(attachments only)', ...(turn.attachments ? { detail: plural(turn.attachments, 'attachment') } : {}) })),
    ...(summary.message.attachments ? { note: `The ${plural(summary.message.attachments, 'attachment')} of the message you edit ${summary.message.attachments === 1 ? 'is' : 'are'} not sent again; attach ${summary.message.attachments === 1 ? 'it' : 'them'} again after the rewind if needed.` } : {}) });
  const resources = summary.resources?.files.filter(f => f.status === 'revert') ?? [];
  if (resources.length) sections.push({ id: 'files', title: `Resources reverted (${plural(resources.length, 'file')})`, lines: resources.map(f => ({ key: `r:${f.path}`, text: f.path, detail: fileAction(f) })) });
  const memory = summary.memory?.files.filter(f => f.status === 'revert') ?? [];
  if (memory.length) sections.push({ id: 'memory', title: `Memory reverted (${plural(memory.length, 'file')})`, lines: memory.map(f => ({ key: `m:${f.path}`, text: f.path, detail: fileAction(f) })) });
  const conflicts = [...(summary.resources?.files ?? []).filter(f => f.status === 'conflict').map(f => ({ key: `rc:${f.path}`, text: f.path, detail: conflictText(f), tone: 'warn' as const })),
    ...(summary.memory?.files ?? []).filter(f => f.status === 'conflict').map(f => ({ key: `mc:${f.path}`, text: `Memory: ${f.path}`, detail: conflictText(f), tone: 'warn' as const }))];
  if (conflicts.length) sections.push({ id: 'conflicts', title: `Can’t be reverted cleanly (${conflicts.length})`, lines: conflicts, note: 'Another change touched the same lines after these turns. These files are left as they are now; review them after the rewind.' });
  const kept: RewindLine[] = [
    ...(summary.resources?.kept ?? []).map(c => ({ key: `k:${c.commit}`, text: c.subject, detail: c.kind === 'shared' ? 'Made while another conversation ran too; kept' : 'Not made by these turns; kept' })),
    ...(summary.memory?.kept ?? []).map(c => ({ key: `km:${c.commit}`, text: `Memory: ${c.subject}`, detail: c.kind === 'shared' ? 'Made while another conversation ran too; kept' : 'Background memory work (dreaming); kept' })),
  ];
  if (kept.length) sections.push({ id: 'kept', title: `Kept (${kept.length})`, lines: kept, note: 'Changes since then that these turns did not make alone (your own in the Resources panel, other conversations’, dreaming) stay.' });
  if (summary.external.length) sections.push({ id: 'external', title: `Can’t be undone (${summary.external.length})`, lines: summary.external.map((e, i) => ({ key: `x:${i}`, text: e.label, ...(e.detail ? { detail: e.detail } : {}), tone: 'danger' as const })), note: 'These happened outside the app; a rewind cannot take them back.' });
  const cancel: RewindLine[] = [
    ...summary.cancel.decisions.map(d => ({ key: `d:${d.id}`, text: d.kind === 'web-research' ? `Web research review: ${d.question}` : `Decision: ${d.question}`, detail: 'Withdrawn' })),
    ...summary.cancel.schedules.map(s => ({ key: `s:${s.id}`, text: `Scheduled task: ${s.prompt}`, detail: `Cancelled (was due ${new Date(s.at).toLocaleString()})` })),
  ];
  if (cancel.length) sections.push({ id: 'cancel', title: `Withdrawn (${cancel.length})`, lines: cancel });
  return sections;
}

/** Wording for a refused or failed rewind (fixed server codes). */
export function rewindError(code: string): string {
  return ({
    rewind_not_solo: 'Rewind works in conversations only you wrote in. Others have written here, so earlier messages can’t be edited.',
    rewind_not_editable: 'Only your own messages can be edited.',
    rewind_automation: 'An automation or a scheduled task sent a message after this one, so it can’t be rewound.',
    rewind_legacy_conversation: 'This older conversation can’t be rewound.',
    rewind_too_old: 'This message was sent before rewind was available, so what its turn changed isn’t recorded. It can’t be rewound.',
    rewind_unavailable: 'This agent can’t rewind conversations.',
    rewind_in_progress: 'A rewind of this conversation is in progress. Wait a moment.',
    runtime_busy: 'Wait until the agent has finished (and nothing waits to be sent), then try again.',
    delivery_uncertain: 'A later turn didn’t finish cleanly, so this conversation can’t be rewound.',
    thread_archived: 'This conversation is archived.',
    rewind_incomplete: 'The rewind started but didn’t finish. It will finish when the server restarts; refresh to see where it stands.',
    rewind_failed: 'The rewind failed before anything changed. Try again.',
    resources_busy: 'The resources are busy. Try again in a moment.',
    not_found: 'That message is no longer in this conversation. Refresh.',
  } as Record<string, string>)[code] ?? 'Couldn’t rewind. Nothing was changed.';
}
