/** One step of the `ai_sdk_letta_turn` worker, without Conductor or the network (tested). */

/** A call to the automation API: status and JSON body. */
export type TurnApi = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
/**
 * What the worker knows: the workflow, the message, the run it started, and
 * the decision that run is waiting for (kept in the task's output between steps).
 */
export type TurnInput = { workflowId: string; text: string; title?: string; runId?: string; decisionId?: string };
/** A task result as Conductor expects it. */
export type TurnResult =
  | { status: 'COMPLETED'; outputData: Record<string, unknown> }
  | { status: 'FAILED_WITH_TERMINAL_ERROR' | 'FAILED'; reasonForIncompletion: string; outputData: Record<string, unknown> }
  | { status: 'IN_PROGRESS'; callbackAfterSeconds: number; outputData: Record<string, unknown> };

/** How long one step waits for the run on the server before handing the task back to Conductor. */
export const STEP_WAIT_SECONDS = 25;
/** While people decide (that can take hours), how long Conductor waits before the next step. */
export const DECISION_CALLBACK_SECONDS = 60;

/**
 * Start the turn (first step) or look at it again, waiting up to
 * {@link STEP_WAIT_SECONDS}. A turn that needed a person fails for good
 * (`FAILED_WITH_TERMINAL_ERROR`, reason `approval_required: …`); a refused
 * request (bad token, rate limit) fails so Conductor's retry policy applies.
 *
 * A turn that asked people to decide (`decision_pending`) is not a failure:
 * the task stays `IN_PROGRESS` and checks the decision every
 * {@link DECISION_CALLBACK_SECONDS}; once someone decided in the app, it
 * follows the run that resumed the work, and completes with it (or waits
 * again, if that run asks another decision). "Stop this work" completes the
 * task too, with `resumes.outcome: 'stopped'` for the workflow to branch on.
 */
export async function turnStep(api: TurnApi, input: TurnInput): Promise<TurnResult> {
  if (!input.text.trim()) return { status: 'FAILED_WITH_TERMINAL_ERROR', reasonForIncompletion: 'invalid_input: no text', outputData: {} };
  if (input.decisionId) {
    const answer = await api('GET', `/v1/automation/decisions/${encodeURIComponent(input.decisionId)}?wait=${STEP_WAIT_SECONDS}`);
    const decision = answer.body as { status?: string; resume?: { runId?: string } };
    if (answer.status >= 400) return { status: answer.status === 429 || answer.status >= 500 ? 'FAILED' : 'FAILED_WITH_TERMINAL_ERROR', reasonForIncompletion: String((answer.body as { error?: unknown }).error ?? `http_${answer.status}`), outputData: {} };
    if (decision.status === 'pending') return { status: 'IN_PROGRESS', callbackAfterSeconds: DECISION_CALLBACK_SECONDS, outputData: { runId: input.runId, decisionId: input.decisionId, status: 'decision_pending', decision: answer.body } };
    if (decision.status === 'cancelled' || !decision.resume?.runId) return { status: 'FAILED_WITH_TERMINAL_ERROR', reasonForIncompletion: 'decision_cancelled: the agent withdrew or replaced the decision', outputData: { decision: answer.body } };
    return turnStep(api, { workflowId: input.workflowId, text: input.text, ...(input.title ? { title: input.title } : {}), runId: decision.resume.runId });
  }
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
  const asked = (reply.body as { decision?: { id?: string } }).decision;
  if (run.status === 'decision_pending' && asked?.id) return { status: 'IN_PROGRESS', callbackAfterSeconds: DECISION_CALLBACK_SECONDS, outputData: { runId: run.id, decisionId: asked.id, status: 'decision_pending', decision: asked } };
  if (run.status === 'completed') return { status: 'COMPLETED', outputData: reply.body };
  const code = run.error?.code ?? run.status ?? 'failed';
  return { status: 'FAILED_WITH_TERMINAL_ERROR', reasonForIncompletion: `${code}: ${run.error?.message ?? ''}`.trim(), outputData: reply.body };
}
