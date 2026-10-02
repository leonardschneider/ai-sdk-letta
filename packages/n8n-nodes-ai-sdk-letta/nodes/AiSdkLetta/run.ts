/** A run as the ai-sdk-letta automation API returns it (see `AutomationRun` in @ai-sdk-letta/server). */
export type AutomationRun = {
	id: string;
	status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
	conversation?: { id: string; title?: string };
	text?: string;
	listened?: boolean;
	tools?: { name: string; status: string; reason?: string }[];
	files?: { path: string; bytes: number; modifiedAt: string }[];
	error?: { code: string; message: string; tool?: string };
};

/**
 * Why a finished run counts as a failure for the workflow, or `undefined`
 * when it completed. The message starts with the code, so an IF node or the
 * error output can branch on it: `approval_required: publish needs approval…`.
 */
export function runFailure(run: AutomationRun): { code: string; message: string; tool?: string } | undefined {
	if (run.status === 'completed') return undefined;
	if (run.status === 'queued' || run.status === 'running') return undefined;
	const code = run.error?.code ?? (run.status === 'cancelled' ? 'cancelled' : 'failed');
	const detail = run.error?.message ?? `The run ${run.status}.`;
	return { code, message: `${code}: ${detail}`, ...(run.error?.tool ? { tool: run.error.tool } : {}) };
}
