import { backgroundNotice, backgroundRunId, commandJob, JOBS_CONTEXT, type BackgroundCommands, type BackgroundRecord, type JobDesk } from 'ai-sdk-letta';
import { RuntimeFault, type ThreadRuntime } from './runtime.js';

/**
 * Background commands of one agent in a server runtime: when one ends, the
 * agent gets a notification turn in its conversation (unless the call said
 * `notify: false`, or the agent stopped it), sent like a decision's outcome:
 * through the runtime's normal queue, never behind an uncertain turn, at
 * most once (its run ID is derived from the command, so a restart never
 * sends it twice). After a restart, commands still running get their live
 * card back.
 */
export class BackgroundNotifier {
  private readonly delivering = new Set<string>();
  private readonly offs: (() => void)[] = [];
  private closed = false;

  constructor(private readonly runtime: ThreadRuntime, private readonly commands: BackgroundCommands, private readonly owner: string, private readonly desk?: JobDesk, private readonly options: { pauseMs?: number; giveUpMs?: number } = {}) {
    runtime.background = commands;
    this.offs.push(commands.onEnded(record => { if (this.mine(record)) void this.deliver(record.id); }));
    this.offs.push(commands.onChange(() => runtime.appsChanged()));
  }
  /** Is the record one of this runtime's conversations? */
  private mine(record: BackgroundRecord): boolean { return !!this.runtime.threadOfConversationAny(record.conversationId); }

  /** After a restart: owed notifications are sent; running commands get a live card again. */
  resumeAll() {
    for (const record of this.commands.pendingNotifications()) if (this.mine(record)) void this.deliver(record.id);
    if (!this.desk) return;
    for (const record of this.commands.list({ state: 'running' })) {
      if (!this.mine(record) || !record.toolCallId) continue;
      const job = commandJob({ [JOBS_CONTEXT]: { desk: this.desk, conversationId: record.conversationId } }, record.toolCallId, record.command);
      if (job) this.commands.reattach(record.id, job);
    }
  }

  /** Send the notification turn of an ended command (retrying while the conversation is busy). */
  async deliver(id: string) {
    if (this.delivering.has(id)) return;
    this.delivering.add(id);
    const giveUp = Date.now() + (this.options.giveUpMs ?? 24 * 3600_000);
    try {
      while (!this.closed) {
        const record = this.commands.get(id);
        if (!record || record.state === 'running' || !record.notify || record.notified) return;
        const threadId = this.runtime.threadOfConversationAny(record.conversationId);
        const thread = threadId ? this.runtime.threadSummary(this.owner, threadId) : undefined;
        // The conversation is gone or archived: nobody to tell.
        if (!threadId || !thread || thread.archived) { this.commands.markNotified(id); return; }
        const runId = backgroundRunId(id);
        // Already accepted (queued, sent or withdrawn): never again.
        if (this.runtime.runRecord(this.owner, runId)) { this.commands.markNotified(id); return; }
        const latest = this.runtime.latestRun(this.owner, threadId);
        // Never behind an uncertain turn; wait while one runs (single-user).
        if (latest && !latest.usable && latest.status !== 'running') { if (Date.now() > giveUp) { this.commands.markNotified(id); return; } await this.runtime.waitForChange(this.runtime.version, 5000); continue; }
        if (!this.runtime.queueing && latest?.status === 'running') { await this.runtime.waitForChange(this.runtime.version, 2000); continue; }
        try {
          await this.runtime.start(this.owner, { id: runId, threadId, text: backgroundNotice(record), parentRunId: latest?.id ?? null }, undefined, undefined,
            { background: { jobId: record.id, command: record.command, state: record.state, ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}) } });
          this.commands.markNotified(id);
          return;
        } catch (error) {
          const code = error instanceof RuntimeFault ? error.code : 'runtime_failed';
          if (['runtime_busy', 'history_conflict', 'queue_full', 'capacity_reached', 'rewind_in_progress'].includes(code) && Date.now() < giveUp) { await new Promise(resolve => { const t = setTimeout(resolve, this.options.pauseMs ?? 1500); t.unref?.(); }); continue; }
          if (code === 'id_conflict') { this.commands.markNotified(id); return; }
          if (code === 'delivery_uncertain' && Date.now() < giveUp) { await this.runtime.waitForChange(this.runtime.version, 5000); continue; }
          // Anything else (archived, rewinding forever): given up, never retried blindly.
          this.commands.markNotified(id);
          return;
        }
      }
    } finally { this.delivering.delete(id); }
  }
  close() { this.closed = true; for (const off of this.offs) off(); }
}
