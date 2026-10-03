import type { SessionDeviceStatus } from '@letta-ai/letta-agent-sdk';
import type { AgentDefinition } from './definition.js';
import { isIndexUpkeep, isProtectedPath, reviewFloor, failedReview } from './memory-guard.js';
import { stricter, type JiminyVerdict, type MemoryReviewer, type Verdict } from './jiminy.js';
import type { TurnProvenance } from './provenance.js';

/**
 * Dreams reviewed **before** they are merged into memory.
 *
 * The Letta harness merges a dream (a reflection branch) into memory on its
 * own (merge mode `auto`). A harness that supports client-approved merges
 * (merge mode `client`; it lists `reflection_merge_request` among its
 * capabilities) instead sends the dream to the SDK client, which answers
 * approve, reject, or approve some paths, within a deadline (no answer is a
 * reject, and the transcript stays unconsumed so the dream can be retried).
 *
 * This module is the client side: detecting the capability, the settings
 * command, and the decision. Without the capability, dreams merge on their
 * own and are reviewed right after (`MemoryGuard.check`); the time between
 * the merge and that review's revert is the exposure window.
 *
 * Merge mode `explicit` (a separate agent conversation integrates the dream)
 * is never used; nor is the SDK's `dreaming` convenience option, which
 * writes the user's global Letta settings.
 *
 * @module
 */

/** The capability a harness lists in `supported_capabilities` (or `supported_commands`) when it can ask the client before merging a dream. */
export const DREAM_HOOK_CAPABILITY = 'reflection_merge_request';

/** Whether the harness behind a session can ask before merging a dream. */
export function dreamHookSupported(status: Pick<SessionDeviceStatus, 'raw'>): boolean {
  const raw = status.raw as { supported_capabilities?: unknown; supported_commands?: unknown; reflection_settings?: { merge_modes?: unknown } } | undefined;
  const lists = [raw?.supported_capabilities, raw?.supported_commands, raw?.reflection_settings?.merge_modes];
  return lists.some(list => Array.isArray(list) && (list.includes(DREAM_HOOK_CAPABILITY) || list.includes('client')));
}

/** The settings command with client-approved merges (project scope only). The harness's deadline applies (no answer: reject). */
export function dreamHookCommand(definition: AgentDefinition, agentId: string, conversationId = 'default') {
  return {
    type: 'set_reflection_settings', runtime: { agent_id: agentId, conversation_id: conversationId },
    scope: 'local_project', settings: { trigger: definition.dreaming.trigger, step_count: definition.dreaming.stepCount, merge: 'client' },
  } as const;
}

/** A dream waiting for approval, as the harness sends it (`reflection_merge_request`). */
export type DreamRequest = {
  type: 'reflection_merge_request'; request_id: string;
  agent_id: string; branch: string; base_head: string; head: string;
  commits: { sha: string; subject: string; author?: string }[];
  diff_stat?: string; diff: string; diff_truncated?: boolean;
  files: { path: string; status: 'A' | 'M' | 'D' }[];
  /** The transcript the dream read (path, and the message range). */
  transcript_payload?: string; message_range?: { start?: string; end?: string };
  /** Reflection payloads mark tool results as untrusted. */
  untrusted_tool_results?: number;
};
/** The client's answer (`reflection_merge_response`). */
export type DreamResponse = { type: 'reflection_merge_response'; request_id: string; decision: 'approve' | 'reject' | 'approve_paths' | 'approve_edits'; approve_paths?: string[];
  /** `approve_edits`: lines removed from the branch before it merges (head line numbers, exact text). */
  drop?: { path: string; start: number; end: number; text: string }[]; reason?: string };

/** Validate a request from the harness (fixed shape; anything else is ignored). */
export function parseDreamRequest(message: unknown): DreamRequest | undefined {
  const m = message as Partial<DreamRequest> | null;
  if (!m || typeof m !== 'object' || m.type !== 'reflection_merge_request' || typeof m.request_id !== 'string' || typeof m.agent_id !== 'string' || typeof m.branch !== 'string' || typeof m.head !== 'string' || typeof m.diff !== 'string' || !Array.isArray(m.files)) return undefined;
  if (m.files.some(f => !f || typeof f.path !== 'string' || !['A', 'M', 'D'].includes(f.status))) return undefined;
  return m as DreamRequest;
}

/**
 * Decide a dream before it merges: protected files are never approved (the
 * harness floor), and Jiminy reviews the rest. `approve_paths` keeps only
 * the unprotected paths when Jiminy accepts the dream but it also touched a
 * protected file. Anything but accept or flag is a reject; a failed review
 * is a reject as well (the dream is retried later, nothing is lost).
 */
export async function reviewDreamRequest(request: DreamRequest, options: { protected: readonly string[]; reviewer?: MemoryReviewer; directives: string; signal: AbortSignal;
  /** Reads a file at the branch head (so Jiminy can name lines to drop). Without it, no lines are dropped. */
  read?: (head: string, path: string) => Promise<string | undefined> }): Promise<{ response: DreamResponse; verdict: Verdict; jiminy?: JiminyVerdict & { model?: string }; error?: string; files: { path: string; protected: boolean; change: 'created' | 'modified' | 'deleted'; upkeep?: boolean }[] }> {
  // MEMORY.md changed only by link lines (index upkeep) is reviewed with the rest, as after a merge (see isIndexUpkeep).
  const fileDiff = (path: string) => { const start = request.diff.indexOf(`diff --git a/${path} b/${path}\n`); if (start < 0) return ''; const next = request.diff.indexOf('\ndiff --git ', start + 1); return request.diff.slice(start, next < 0 ? undefined : next); };
  const files = request.files.map(f => {
    const isProtected = isProtectedPath(f.path, options.protected);
    const upkeep = isProtected && !request.diff_truncated && f.status === 'M' && isIndexUpkeep(f.path, fileDiff(f.path));
    return { path: f.path, protected: isProtected, change: f.status === 'A' ? 'created' as const : f.status === 'D' ? 'deleted' as const : 'modified' as const, ...(upkeep ? { upkeep: true } : {}) };
  });
  const provenance: Omit<TurnProvenance, 'conversationId'> = { actor: { kind: 'dreaming' }, sources: request.untrusted_tool_results ? [{ kind: 'tool', label: 'tool results in the reflected transcript' }] : [], writer: 'reflection' };
  const unprotected = files.filter(f => !f.protected || f.upkeep);
  const floor = reviewFloor(unprotected, provenance).floor;
  let verdict: Verdict = floor;
  let jiminy: (JiminyVerdict & { model?: string }) | undefined;
  let error: string | undefined;
  if (options.reviewer && unprotected.length) {
    const numbered: { path: string; text: string }[] = [];
    if (options.read) for (const f of unprotected.filter(f => f.change !== 'deleted').slice(0, 10)) { const text = await options.read(request.head, f.path).catch(() => undefined); if (text !== undefined) numbered.push({ path: f.path, text: text.slice(0, 8000) }); }
    try { jiminy = await options.reviewer({ files, diff: request.diff, provenance, directives: options.directives, ...(numbered.length ? { numbered } : {}) }, options.signal); verdict = stricter(floor, jiminy.verdict); }
    catch (e) { error = e instanceof Error && /^[a-z_]{1,40}$/.test(e.message) ? e.message : 'review_failed'; verdict = 'reject'; }
  } else if (!unprotected.length) verdict = 'reject';
  if (files.some(f => f.protected && !f.upkeep) && verdict !== 'reject') verdict = stricter(verdict, failedReview([])); // at least flag
  // Lines Jiminy dropped: only in unprotected files (the harness checks they are added lines with this exact text).
  const drop = jiminy?.drop?.filter(d => unprotected.some(f => f.path === d.path)) ?? [];
  // One decision per merge: a dream that touched a protected file and also needs lines dropped is rejected (it is retried later).
  if (drop.length && files.some(f => f.protected && !f.upkeep)) verdict = 'reject';
  const ok = verdict === 'accept' || verdict === 'flag';
  const reason = (jiminy?.reason ?? error ?? (files.some(f => f.protected && !f.upkeep) ? 'protected memory files cannot change in a dream' : '')).slice(0, 300);
  const response: DreamResponse = !ok ? { type: 'reflection_merge_response', request_id: request.request_id, decision: 'reject', ...(reason ? { reason } : {}) }
    : drop.length ? { type: 'reflection_merge_response', request_id: request.request_id, decision: 'approve_edits', drop, ...(reason ? { reason } : {}) }
    : files.some(f => f.protected && !f.upkeep) ? { type: 'reflection_merge_response', request_id: request.request_id, decision: 'approve_paths', approve_paths: unprotected.map(f => f.path), ...(reason ? { reason } : {}) }
      : { type: 'reflection_merge_response', request_id: request.request_id, decision: 'approve', ...(reason ? { reason } : {}) };
  return { response, verdict: ok && files.some(f => f.protected && !f.upkeep) ? 'flag' : verdict, ...(jiminy ? { jiminy } : {}), ...(error ? { error } : {}), files };
}
