import type { CommitInfo, FilePlan, HistoryRecord } from 'ai-sdk-letta';
import type { Run, RunAuthor } from './runtime.js';

/**
 * Rewind: edit one of your earlier messages in a conversation. The
 * conversation continues from the edited message (its later turns are gone
 * from it), and what those turns changed in the agent's resources and memory
 * is reverted. See `ThreadRuntime.rewindPreview` and `ThreadRuntime.rewind`.
 *
 * This module holds the pure parts: which turns a rewind removes, whether
 * the conversation is solo, where the backend history is forked, and the
 * side effects that cannot be undone.
 */

/** A turn a rewind removes, as the confirmation lists it. */
export type RewindTurn = { runId: string; input: string; startedAt?: string; kind: 'message' | 'decision' | 'automation'; author?: { id: string; name: string }; attachments?: number };
/** A side effect outside the app that a rewind cannot undo. */
export type ExternalEffect = { runId: string; tool: string; label: string; detail?: string };
/** A decision or web research review a rewind withdraws. */
export type RewindDecision = { id: string; question: string; kind?: 'web-research' | 'memory-review' | 'claim-confirmation' | 'memory-notice' };
/** A task the agent scheduled that a rewind cancels (`pending`), or that already ran (`fired`: listed as an external effect). */
export type RewindSchedule = { id: string; at: string; prompt: string; state: 'pending' | 'fired' };
/** What a rewind would do (`POST /v1/threads/:id/rewind/preview`). */
export type RewindSummary = {
  /** The message being edited. */
  message: { runId: string; input: string; attachments?: number };
  /** Turns removed from the conversation, oldest first (the edited message's turn included). */
  turns: RewindTurn[];
  /** Resources: files reverted or kept on conflict, and later commits that are kept (yours in the panel, other conversations'). `null`: the agent has no resources. */
  resources: { files: FilePlan[]; kept: (CommitInfo & { kind?: 'shared' })[] } | null;
  /**
   * Memory: files reverted or kept on conflict, commits kept (dreaming and
   * other background work, or turns of several conversations at once), and
   * the rewound turns' own memory commits with their provenance and review.
   */
  memory: { files: FilePlan[]; kept: (CommitInfo & { kind: 'background' | 'shared'; provenance?: string; review?: string })[]; commits?: (CommitInfo & { provenance?: string; review?: string })[] } | null;
  /** Side effects outside the app that stay. */
  external: ExternalEffect[];
  /** Withdrawn when the rewind runs. */
  cancel: { decisions: RewindDecision[]; schedules: RewindSchedule[] };
};

/** Why a conversation cannot be rewound (fixed codes). */
export const REWIND_REFUSALS = Object.freeze({
  rewind_not_solo: 'Rewind works in conversations only you wrote in.',
  rewind_automation: 'An automation or scheduled task sent a message after this one.',
  rewind_not_editable: 'Only your own messages can be edited.',
  rewind_too_old: 'This message was sent before rewind was available, or its turn is no longer recorded.',
  rewind_legacy_conversation: 'This older conversation can\u2019t be rewound.',
  rewind_unavailable: 'This agent cannot rewind conversations.',
  runtime_busy: 'Wait until the agent has finished (and nothing waits to be sent).',
  delivery_uncertain: 'A later turn did not finish cleanly; it cannot be rewound.',
});

/**
 * The turns a rewind of `runId` removes: that turn and every later one the
 * agent received in the conversation (`delivered`, oldest first). The
 * other messages of a combined turn belong to it.
 * @throws a refusal code
 */
export function rewoundSpan(delivered: readonly Run[], runId: string): Run[] {
  const target = delivered.find(r => r.id === runId);
  if (!target) throw new Error('not_found');
  const lead = target.batchOf ? delivered.find(r => r.id === target.batchOf) ?? target : target;
  const index = delivered.indexOf(lead);
  return delivered.slice(index);
}

/**
 * Whether `who` may rewind the conversation at `span` (see the module
 * comment): the edited message is theirs (an ordinary message, not a
 * decision's outcome or an automation's), every message anyone wrote in
 * the conversation is theirs (a team server; in the single-user app there
 * is only you), no automation or scheduled task sent a message in the
 * rewound turns, and every rewound turn finished and was recorded with its
 * changes (`tagged`).
 * @returns a refusal code, or undefined when it may
 */
export function soloRefusal(all: readonly Run[], span: readonly Run[], who: RunAuthor | undefined, shared: boolean): string | undefined {
  const lead = span[0];
  if (!lead) return 'not_found';
  if (lead.source || lead.decision) return 'rewind_not_editable';
  if (shared) {
    if (!who || lead.author?.id !== who.id) return 'rewind_not_editable';
    // Solo: every message a person wrote here (outcomes of decisions included: their decider) is yours.
    if (all.some(r => !r.notSent && r.author && r.author.id !== who.id)) return 'rewind_not_solo';
  }
  if (span.some(r => r.source)) return 'rewind_automation';
  // A turn stopped with a known outcome (or settled by Check and unlock) is a finished turn; an uncertain one is not.
  if (span.some(r => r.status !== 'completed' && r.status !== 'stopped' && !r.checked)) return 'delivery_uncertain';
  if (span.some(r => !r.tagged)) return 'rewind_too_old';
  return undefined;
}

/**
 * Where to fork the backend history: the record just before the edited
 * message (`null` when it is the first: the new conversation starts empty).
 * The edited message is the user message sent with the turn's run ID as its OTID.
 * @throws `rewind_too_old` when it is not in the (loaded) history
 */
export function forkPoint(records: readonly HistoryRecord[], runId: string): { messageId: string | null; index: number } {
  const index = records.findIndex(record => record.type === 'user_message' && record.otid === runId);
  if (index < 0) throw new Error('rewind_too_old');
  // Reminders the harness inserted just before the message (user records with no text of their own) belong to its turn.
  let before = index - 1;
  while (before >= 0 && records[before]!.type === 'user_message' && !records[before]!.text) before--;
  return { messageId: before >= 0 ? records[before]!.id : null, index };
}

/**
 * Tools whose calls change nothing outside the app (or only the resources,
 * which a rewind reverts). Applications add their own with
 * `RuntimeOptions.rewindInternalTools`.
 */
const INTERNAL_TOOLS = new Set(['list_files', 'read_file', 'search_files', 'ask_user', 'stay_silent', 'web_search', 'request_decision', 'cancel_decision', 'atlassian_fetch', 'text_stats', 'schedule_task']);
const clip = (value: unknown, max = 160) => { const text = typeof value === 'string' ? value : JSON.stringify(value ?? ''); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };

/**
 * Side effects of the rewound turns that a rewind cannot undo, from the
 * tool calls they completed: commands with internet access, changes in
 * Jira and Confluence, sandbox commands (they may have changed a mounted
 * project folder, outside the resources), and any other application tool
 * (its effects are its own).
 */
export function externalEffects(span: readonly Run[], internal: ReadonlySet<string> = new Set()): ExternalEffect[] {
  const effects: ExternalEffect[] = [];
  for (const run of span) {
    const inputs = new Map<string, { name: string; input: unknown }>();
    for (const event of run.events) {
      if (event.type === 'tool_started') inputs.set(String(event.data.toolCallId), { name: String(event.data.name), input: event.data.input });
      if (event.type !== 'tool_completed') continue;
      const call = inputs.get(String(event.data.toolCallId)) ?? { name: String(event.data.name), input: undefined };
      const input = (call.input ?? {}) as Record<string, unknown>;
      if (call.name === 'atlassian_request') {
        const method = String(input.method ?? 'GET').toUpperCase();
        if (method !== 'GET') effects.push({ runId: run.id, tool: call.name, label: `Atlassian ${method} request`, detail: clip(input.path) });
        continue;
      }
      if (INTERNAL_TOOLS.has(call.name) || internal.has(call.name)) continue;
      if (call.name === 'run_command_online') effects.push({ runId: run.id, tool: call.name, label: 'Command with internet access', detail: clip(input.command) });
      else if (call.name === 'run_command') effects.push({ runId: run.id, tool: call.name, label: 'Sandbox command (changes outside the resources, such as a mounted project folder, stay)', detail: clip(input.command) });
      else if (call.name === 'atlassian_update') effects.push({ runId: run.id, tool: call.name, label: 'Jira or Confluence update', detail: clip(input.path ?? input.file ?? input.name) });
      else effects.push({ runId: run.id, tool: call.name, label: `${call.name} ran (its effects stay)` });
    }
  }
  // The same effect several times (a tool called repeatedly without details) is one line with a count.
  const merged: ExternalEffect[] = [];
  for (const effect of effects) {
    const same = merged.find(m => m.tool === effect.tool && m.label.replace(/ ×\d+$/, '') === effect.label && !m.detail && !effect.detail);
    if (!same) { merged.push({ ...effect }); continue; }
    const count = Number(/ ×(\d+)$/.exec(same.label)?.[1] ?? 1) + 1;
    same.label = `${effect.label} ×${count}`;
  }
  return merged;
}

/** A rewound turn as the confirmation lists it. */
export function rewindTurn(run: Run): RewindTurn {
  const attachments = (run.images?.length ?? 0) + (run.files?.length ?? 0);
  return { runId: run.id, input: clip(run.decision ? run.decision.question : run.input, 300), ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    kind: run.source ? 'automation' : run.decision ? 'decision' : 'message', ...(run.author ? { author: { id: run.author.id, name: run.author.name } } : {}), ...(attachments ? { attachments } : {}) };
}
