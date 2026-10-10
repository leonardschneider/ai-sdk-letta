import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, CircleAlert, CircleSlash, Hourglass, LoaderCircle } from 'lucide-react';
import { api, apiPath } from './api.js';
import { useLightbox } from './images.js';
import { jobOfCall, mergeJob, progressLine, statusText, type JobView } from './jobs-model.js';

/** The open conversation's jobs, for the job cards. */
export type JobsState = { jobs: readonly JobView[]; threadId?: string };
export const JobsContext = createContext<JobsState>({ jobs: [] });

/**
 * The jobs of the open conversation: read when it opens and whenever
 * `trigger` changes, merged with live `job` events ({@link merge}), and read
 * again every 2 s while a job runs without a live turn (a job may outlive
 * the turn that started it).
 */
export function useThreadJobs(threadId: string | undefined, trigger: unknown, live: boolean): [JobsState, (job: JobView) => void] {
  const [state, setState] = useState<JobsState>({ jobs: [] });
  const current = useRef(threadId); current.current = threadId;
  const load = useCallback((id: string) => api<{ jobs: JobView[] }>(`/v1/threads/${encodeURIComponent(id)}/jobs`, undefined, 'GET')
    .then(({ jobs }) => { if (current.current === id) setState(prev => ({ threadId: id, jobs: prev.threadId === id ? jobs.reduce((list, job) => mergeJob(list, job), prev.jobs.filter(j => jobs.some(n => n.id === j.id))) : jobs })); }, () => {}), []);
  useEffect(() => { if (threadId) void load(threadId); else setState({ jobs: [] }); }, [threadId, trigger, load]);
  const running = state.threadId === threadId && state.jobs.some(j => j.status === 'running');
  useEffect(() => {
    if (!threadId || !running || live) return;
    const timer = setInterval(() => void load(threadId), 2000);
    return () => clearInterval(timer);
  }, [threadId, running, live, load]);
  const merge = useCallback((job: JobView) => { setState(prev => job.threadId === current.current ? { threadId: job.threadId, jobs: mergeJob(prev.threadId === job.threadId ? prev.jobs : [], job) } : prev); }, []);
  return [state, merge];
}

const ICON = { running: LoaderCircle, done: Check, failed: CircleAlert, cancelled: CircleSlash, interrupted: Hourglass } as const;

/**
 * The card of a job, where `job_start` was called: goal, a progress bar
 * ("9/20 games · 45% · 3.1/min · ETA 4 min"), the latest log line (the tail
 * expands), the live image (click to enlarge), and the status. It updates in
 * place: the same elements change, nothing remounts.
 */
export function JobCard({ toolCallId, result }: { toolCallId: string; result: unknown }) {
  const { jobs } = useContext(JobsContext);
  const job = jobOfCall(jobs, toolCallId, result);
  if (!job) {
    // Not recorded (yet): a quiet line while the call runs; nothing once it failed.
    if (result !== undefined) return null;
    return <div className="line job-line" data-tone="running"><span className="line-summary static"><LoaderCircle size={14} className="line-icon spin" aria-hidden="true"/><span className="line-label shimmer">Starting a job…</span></span></div>;
  }
  return <JobBody job={job}/>;
}

function JobBody({ job }: { job: JobView }) {
  const [open, setOpen] = useState(false);
  const lightbox = useLightbox();
  const Icon = ICON[job.status];
  const line = progressLine(job);
  const percent = job.progress.percent;
  const last = job.lines.at(-1);
  const imageUrl = job.image ? apiPath(`/v1/threads/${encodeURIComponent(job.threadId)}/jobs/${encodeURIComponent(job.id)}/image?v=${job.image.version}`) : undefined;
  // The previous picture stays until the next one has loaded (no flicker).
  const [shown, setShown] = useState(imageUrl);
  useEffect(() => { if (!imageUrl || imageUrl === shown) return; const img = new Image(); img.onload = () => setShown(imageUrl); img.onerror = () => setShown(imageUrl); img.src = imageUrl; }, [imageUrl, shown]);
  const tailId = `job-tail-${job.id}`;
  return <section className="job-card" data-status={job.status} data-job-id={job.id} aria-label={`Job: ${job.goal}`}>
    <header className="job-head">
      <span className="job-icon" data-status={job.status} aria-hidden="true"><Icon size={14} className={job.status === 'running' ? 'spin' : undefined}/></span>
      <strong className="job-goal">{job.goal}</strong>
      <span className="job-status" data-status={job.status}>{statusText(job)}</span>
    </header>
    {(percent !== undefined || line) && <div className="job-progress">
      {percent !== undefined
        ? <div className="job-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label="Progress"><span style={{ width: `${percent}%` }}/></div>
        : job.status === 'running' && <div className="job-bar indeterminate" role="progressbar" aria-label="In progress"><span/></div>}
      {line && <span className="job-meta">{line}</span>}
    </div>}
    {last && <div className="job-log">
      {job.lines.length > 1
        ? <button type="button" className="job-last" aria-expanded={open} aria-controls={tailId} onClick={() => setOpen(o => !o)} title={open ? 'Hide the log' : 'Show the log'}>
            <ChevronRight size={12} className="chev" aria-hidden="true"/><code>{last}</code></button>
        : <span className="job-last"><code>{last}</code></span>}
      {open && <pre id={tailId} className="job-tail">{job.lines.join('\n')}</pre>}
    </div>}
    {shown && <button type="button" className="job-image" aria-label={`Enlarge the image of ${job.goal}`} title="Click to enlarge" onClick={() => lightbox({ url: shown, name: job.goal })}>
      <img src={shown} alt={`Live image: ${job.goal}`}/>
    </button>}
    {job.result && <p className="job-result">{job.result}</p>}
  </section>;
}

/** A small bar for the Activity popover. */
export function ActivityJobBar({ percent }: { percent?: number }) {
  if (percent === undefined) return null;
  return <span className="job-bar small" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label="Progress"><span style={{ width: `${percent}%` }}/></span>;
}
