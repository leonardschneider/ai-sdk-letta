/** Jobs (visible background work): the model of the job card and the activity bar (pure). */

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export type JobProgress = { percent?: number; ratePerSecond?: number; etaSeconds?: number; elapsedSeconds?: number };
/** A job as the server sends it (`GET /v1/threads/:id/jobs`, and `job` events of a live run). */
export type JobView = {
  id: string; threadId: string; toolCallId: string; goal: string; unit?: string; total?: number; done?: number;
  status: JobStatus; result?: string; lines: string[]; image?: { mediaType: string; version: number };
  startedAt: string; updatedAt: string; endedAt?: string; version: number; progress: JobProgress;
};

/** The job tools: their lines are hidden; `job_start` shows the card. */
export const JOB_TOOLS: ReadonlySet<string> = new Set(['job_start', 'job_update', 'job_end']);

/** "3.1/min", "2.0/s", "4.5/h": the rate in the unit that reads best. */
export function rateText(perSecond: number | undefined): string | undefined {
  if (perSecond === undefined || !Number.isFinite(perSecond) || perSecond <= 0) return undefined;
  const fixed = (n: number) => n >= 10 ? n.toFixed(0) : n.toFixed(1);
  if (perSecond >= 1) return `${fixed(perSecond)}/s`;
  if (perSecond * 60 >= 1) return `${fixed(perSecond * 60)}/min`;
  return `${fixed(perSecond * 3600)}/h`;
}

/** "12 s", "4 min", "1 h 5 min": a duration, rounded the way people read it. */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** A count without noise: integers as is, fractions with one decimal. */
const count = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);

/** The progress line: "9/20 games · 45% · 3.1/min · ETA 4 min" (parts left out when unknown). */
export function progressLine(job: Pick<JobView, 'done' | 'total' | 'unit' | 'status' | 'progress'>): string {
  const parts: string[] = [];
  if (job.done !== undefined || job.total !== undefined) parts.push(`${count(job.done ?? 0)}${job.total !== undefined ? `/${count(job.total)}` : ''}${job.unit ? ` ${job.unit}` : ''}`);
  if (job.progress.percent !== undefined) parts.push(`${Math.floor(job.progress.percent)}%`);
  const rate = rateText(job.progress.ratePerSecond);
  if (rate) parts.push(rate);
  if (job.status === 'running' && job.progress.etaSeconds !== undefined) parts.push(`ETA ${durationText(job.progress.etaSeconds)}`);
  return parts.join(' · ');
}

/** Wording of a job's status. */
export function statusText(job: Pick<JobView, 'status' | 'progress'>): string {
  const took = job.progress.elapsedSeconds !== undefined ? ` in ${durationText(job.progress.elapsedSeconds)}` : '';
  switch (job.status) {
    case 'running': return 'Running';
    case 'done': return `Done${took}`;
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'interrupted': return 'Interrupted (the server restarted)';
  }
}

/** Merge a job into a list (by ID): a newer version replaces an older one; an older one never wins. */
export function mergeJob(list: readonly JobView[], job: JobView): JobView[] {
  const index = list.findIndex(j => j.id === job.id);
  if (index < 0) return [...list, job];
  if (list[index]!.version > job.version) return list as JobView[];
  const next = [...list]; next[index] = job; return next;
}

/** The job a `job_start` call made: by its tool call ID, else by the `jobId` its result names. */
export function jobOfCall(jobs: readonly JobView[], toolCallId: string, result: unknown): JobView | undefined {
  const byCall = jobs.find(j => j.toolCallId === toolCallId);
  if (byCall) return byCall;
  let value = result;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return undefined; } }
  const id = value && typeof value === 'object' ? (value as { jobId?: unknown }).jobId : undefined;
  return typeof id === 'string' ? jobs.find(j => j.id === id) : undefined;
}
