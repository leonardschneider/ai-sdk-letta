/** One step of the `ai_sdk_letta_turn` worker, without Conductor or the network (tested). */

/** A call to the automation API: status and JSON body. */
export type TurnApi = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
/** What the worker knows: the workflow, the message, and the run it started (kept in the task's output between steps). */
export type TurnInput = { workflowId: string; text: string; title?: string; runId?: string };
/** A task result as Conductor expects it. */
export type TurnResult =
  | { status: 'COMPLETED'; outputData: Record<string, unknown> }
  | { status: 'FAILED_WITH_TERMINAL_ERROR' | 'FAILED'; reasonForIncompletion: string; outputData: Record<string, unknown> }
  | { status: 'IN_PROGRESS'; callbackAfterSeconds: number; outputData: Record<string, unknown> };

/** How long one step waits for the run on the server before handing the task back to Conductor. */
export const STEP_WAIT_SECONDS = 25;

/**
 * Start the turn (first step) or look at it again, waiting up to
 * {@link STEP_WAIT_SECONDS}. A turn that needed a person fails for good
 * (`FAILED_WITH_TERMINAL_ERROR`, reason `approval_required: …`); a refused
 * request (bad token, rate limit) fails so Conductor's retry policy applies.
 */
export async function turnStep(api: TurnApi, input: TurnInput): Promise<TurnResult> {
  if (!input.text.trim()) return { status: 'FAILED_WITH_TERMINAL_ERROR', reasonForIncompletion: 'invalid_input: no text', outputData: {} };
  const reply = input.runId
    ? await api('GET', `/v1/automation/runs/${encodeURIComponent(input.runId)}?wait=${STEP_WAIT_SECONDS}`)
    : await api('POST', `/v1/automation/runs?wait=${STEP_WAIT_SECONDS}`, { text: input.text, idempotencyKey: `conductor-${input.workflowId}`, ...(input.title ? { title: input.title } : {}) });
  const run = reply.body as { id?: string; status?: string; error?: { code?: string; message?: string; tool?: string } };
  if (reply.status >= 400 || !run.id) {
    const code = String((reply.body as { error?: unknown }).error ?? `http_${reply.status}`);
    // Rate limits and busy servers are worth a retry; anything else is not.
    return { status: reply.status === 429 || reply.status >= 500 ? 'FAILED' : 'FAILED_WITH_TERMINAL_ERROR', reasonForIncompletion: code, outputData: {} };
  }
  if (run.status === 'queued' || run.status === 'running') return { status: 'IN_PROGRESS', callbackAfterSeconds: 1, outputData: { runId: run.id, status: run.status } };
  if (run.status === 'completed') return { status: 'COMPLETED', outputData: reply.body };
  const code = run.error?.code ?? run.status ?? 'failed';
  return { status: 'FAILED_WITH_TERMINAL_ERROR', reasonForIncompletion: `${code}: ${run.error?.message ?? ''}`.trim(), outputData: reply.body };
}
