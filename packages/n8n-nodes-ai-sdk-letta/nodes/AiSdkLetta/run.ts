/** A decision as the ai-sdk-letta automation API returns it (see `AutomationDecision` in @ai-sdk-letta/server). */
export type AutomationDecision = {
	id: string;
	status: 'pending' | 'decided' | 'stopped' | 'cancelled';
	question: string;
	options: { id: string; label: string; description?: string }[];
	conversation: { id: string };
	decidedBy?: { name: string };
	choice?: { id: string; label: string };
	comment?: string;
	decidedAt?: string;
	cancelReason?: string;
	/** The run that brought the outcome to the agent (it resumed, or stopped, the work). */
	resume?: { runId: string; state: string; error?: string };
};

/** A run as the ai-sdk-letta automation API returns it (see `AutomationRun` in @ai-sdk-letta/server). */
export type AutomationRun = {
	id: string;
	/** `decision_pending`: the agent asked people to decide (`decision`); the work resumes in a new run once someone does. Not a failure. */
	status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'decision_pending';
	decision?: AutomationDecision;
	/** This run brought a decision's outcome to the agent. */
	resumes?: { decisionId: string; outcome: 'decided' | 'stopped'; choice?: { id: string; label: string } };
	conversation?: { id: string; title?: string };
	text?: string;
	listened?: boolean;
	tools?: { name: string; status: string; reason?: string }[];
	files?: { path: string; bytes: number; modifiedAt: string }[];
	error?: { code: string; message: string; tool?: string };
};

/**
 * Why a finished run counts as a failure for the workflow, or `undefined`
 * when it completed (or waits for a decision, which is not a failure). The message starts with the code, so an IF node or the
 * error output can branch on it: `approval_required: publish needs approval…`.
 */
export function runFailure(run: AutomationRun): { code: string; message: string; tool?: string } | undefined {
	if (run.status === 'completed' || run.status === 'decision_pending') return undefined;
	if (run.status === 'queued' || run.status === 'running') return undefined;
	const code = run.error?.code ?? (run.status === 'cancelled' ? 'cancelled' : 'failed');
	const detail = run.error?.message ?? `The run ${run.status}.`;
	return { code, message: `${code}: ${detail}`, ...(run.error?.tool ? { tool: run.error.tool } : {}) };
}

/** Is the run still going (queued or running)? */
export const ongoing = (run: Pick<AutomationRun, 'status'>) => run.status === 'queued' || run.status === 'running';

/**
 * Does the run lead on to another run through a decision it asked for? True
 * while the decision is pending (`decision_pending`), and also once someone
 * decided: the run's own status is then `completed`, and the work went on in
 * `decision.resume.runId`. False for a withdrawn or replaced decision.
 */
export const asksDecision = (run: Pick<AutomationRun, 'status' | 'decision'>) => !!run.decision && run.decision.status !== 'cancelled' && (run.status === 'decision_pending' || run.status === 'completed');
