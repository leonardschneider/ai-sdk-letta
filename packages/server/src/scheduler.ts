/**
 * Orchestrator adapters for agent self-scheduling (`schedule_task`).
 *
 * The server never keeps a timer of its own: each scheduled task becomes a
 * one-off job in the configured orchestrator, which calls the server's
 * automation API back when it is due (`POST /v1/automation/schedules/<id>/fire`
 * with a single-use token). After it fired (or was cancelled), the job is
 * deleted from the orchestrator.
 */

/** A one-off job to create: call `fireUrl` with `token` at `at` (UTC, a whole minute). */
export type OrchestratorJob = { id: string; at: string; fireUrl: string; token: string; label: string };
/** What the orchestrator gave back, enough to delete the job later. */
export type OrchestratorHandle = { externalId: string; credentialId?: string };

/** Creates and deletes one-off jobs in an orchestrator. Errors are `Error`s with a fixed code as message. */
export interface Orchestrator {
  readonly kind: 'n8n' | 'conductor';
  createJob(job: OrchestratorJob): Promise<OrchestratorHandle>;
  deleteJob(handle: OrchestratorHandle): Promise<void>;
}

/** Options shared by the adapters. */
type AdapterOptions = {
  /** Base URL of the orchestrator as this server reaches it, for example `http://127.0.0.1:5678`. */
  url: string;
  /** Tests: the `fetch` to use. */
  fetch?: typeof fetch;
  /** Request timeout. @default 15000 */
  timeoutMs?: number;
};

const base = (url: string) => {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid orchestrator URL');
  return parsed.href.replace(/\/+$/, '');
};
/** The cron fields (seconds first) of one UTC minute: fires once a year at most, and the job is deleted after it fired. */
export const cronAt = (at: string) => { const d = new Date(at); return `0 ${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`; };

/** `missing`: also accept 404 (and n8n's 404-like answers) as "already gone". */
async function call(options: AdapterOptions, path: string, init: RequestInit & { headers: Record<string, string> }, accept404 = false): Promise<unknown> {
  const control = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  let response: Response;
  try { response = await (options.fetch ?? fetch)(`${base(options.url)}${path}`, { ...init, redirect: 'error', signal: control }); }
  catch { throw new Error('scheduler_unreachable'); }
  if (accept404 && response.status === 404) return undefined;
  // Never surface the orchestrator's error text (it may echo request data); only a fixed code.
  // The status and step (never a body or a secret) help whoever reads the server log.
  const fail = (code: string) => Object.assign(new Error(code), { detail: `HTTP ${response.status} on ${init.method ?? 'GET'} ${path.replace(/\?.*$/, '')}` });
  if (response.status === 401 || response.status === 403) throw fail('scheduler_unauthorized');
  if (!response.ok) throw fail('scheduler_failed');
  const text = await response.text();
  try { return text ? JSON.parse(text) : undefined; } catch { return text; }
}

/** n8n options: its public REST API (Settings → n8n API → Create an API key). */
export type N8nOrchestratorOptions = AdapterOptions & { apiKey: string };

/**
 * n8n: each task is a small workflow (Schedule Trigger with a cron for that
 * minute, in UTC → HTTP Request to the fire URL), activated through n8n's
 * public API. The single-use token is stored as an n8n credential (Header
 * Auth, encrypted by n8n), not in the workflow. Both are deleted after the
 * task fired or was cancelled.
 */
export function n8nOrchestrator(options: N8nOrchestratorOptions): Orchestrator {
  const headers = { 'X-N8N-API-KEY': options.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  return {
    kind: 'n8n',
    async createJob(job) {
      const credential = await call(options, '/api/v1/credentials', { method: 'POST', headers, body: JSON.stringify({ name: `ai-sdk-letta task ${job.id}`, type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${job.token}` } }) }) as { id?: string };
      if (!credential?.id) throw new Error('scheduler_failed');
      try {
        const workflow = await call(options, '/api/v1/workflows', { method: 'POST', headers, body: JSON.stringify({
          name: `ai-sdk-letta: ${job.label}`.slice(0, 128),
          nodes: [
            { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'At the scheduled time', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: 'cronExpression', expression: cronAt(job.at) }] } } },
            { id: 'a1b2c3d4-0000-4000-8000-000000000002', name: 'Run the scheduled task', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [240, 0],
              // Waits for the turn's outcome (up to 120 s), so the execution shows it; a run that needed approval fails it.
              parameters: { method: 'POST', url: `${job.fireUrl}?wait=110`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: '{}', options: { timeout: 125000 } },
              credentials: { httpHeaderAuth: { id: credential.id, name: `ai-sdk-letta task ${job.id}` } } },
          ],
          connections: { 'At the scheduled time': { main: [[{ node: 'Run the scheduled task', type: 'main', index: 0 }]] } },
          settings: { timezone: 'UTC', executionOrder: 'v1' },
        }) }) as { id?: string };
        if (!workflow?.id) throw new Error('scheduler_failed');
        try { await call(options, `/api/v1/workflows/${encodeURIComponent(workflow.id)}/activate`, { method: 'POST', headers }); }
        catch (error) { await call(options, `/api/v1/workflows/${encodeURIComponent(workflow.id)}`, { method: 'DELETE', headers }, true).catch(() => {}); throw error; }
        return { externalId: workflow.id, credentialId: credential.id };
      } catch (error) {
        await call(options, `/api/v1/credentials/${encodeURIComponent(credential.id)}`, { method: 'DELETE', headers }, true).catch(() => {});
        throw error;
      }
    },
    async deleteJob(handle) {
      // n8n refuses to delete a published (active) workflow: deactivate it first.
      await call(options, `/api/v1/workflows/${encodeURIComponent(handle.externalId)}/deactivate`, { method: 'POST', headers }, true);
      await call(options, `/api/v1/workflows/${encodeURIComponent(handle.externalId)}`, { method: 'DELETE', headers }, true);
      if (handle.credentialId) await call(options, `/api/v1/credentials/${encodeURIComponent(handle.credentialId)}`, { method: 'DELETE', headers }, true);
    },
  };
}

/** Name of the Conductor workflow the adapter registers to fire tasks. */
export const CONDUCTOR_FIRE_WORKFLOW = 'ai_sdk_letta_fire_task';
/** Conductor options. `headers`: extra headers for its API (for example `X-Authorization` on Orkes); OSS Conductor has no API authentication. */
export type ConductorOrchestratorOptions = AdapterOptions & { headers?: Record<string, string> };

/**
 * Conductor OSS: each task is a schedule of Conductor's scheduler (cron of
 * that minute, in UTC, bounded by `scheduleStartTime`/`scheduleEndTime` to
 * a two-minute window, so it fires once), starting a small workflow
 * (`ai_sdk_letta_fire_task`, registered on first use) whose HTTP task calls
 * the fire URL. The single-use token is in the schedule's workflow input
 * (Conductor OSS keeps secrets only in its environment); the workflow masks
 * it in the UI (`maskedFields`). The schedule is deleted after it fired or
 * was cancelled.
 */
export function conductorOrchestrator(options: ConductorOrchestratorOptions): Orchestrator {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...options.headers };
  let registered: Promise<void> | undefined;
  const register = () => registered ??= (async () => {
    const definition = { name: CONDUCTOR_FIRE_WORKFLOW, version: 1, description: 'Runs one task scheduled by an ai-sdk-letta agent (calls the server back).', schemaVersion: 2, inputParameters: ['fireUrl', 'token'], maskedFields: ['token'], timeoutSeconds: 300, timeoutPolicy: 'TIME_OUT_WF', ownerEmail: 'ai-sdk-letta@example.invalid',
      // Waits for the turn's outcome (up to 120 s), so the execution shows it; a run that needed approval fails it.
      tasks: [{ name: 'fire_task', taskReferenceName: 'fire', type: 'HTTP', inputParameters: { uri: '${workflow.input.fireUrl}?wait=110', method: 'POST', headers: { Authorization: 'Bearer ${workflow.input.token}' }, body: {}, accept: 'application/json', contentType: 'application/json', connectionTimeOut: 5000, readTimeOut: 125000 } }],
      outputParameters: { run: '${fire.output.response.body}' } };
    // Create, or update in place when it already exists.
    await call(options, '/api/metadata/workflow', { method: 'PUT', headers, body: JSON.stringify([definition]) });
  })().catch(error => { registered = undefined; throw error; });
  const name = (id: string) => `ai_sdk_letta_task_${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  return {
    kind: 'conductor',
    async createJob(job) {
      await register();
      const at = Date.parse(job.at);
      await call(options, '/api/scheduler/schedules', { method: 'POST', headers, body: JSON.stringify({
        name: name(job.id), description: `ai-sdk-letta: ${job.label}`.slice(0, 200), cronExpression: cronAt(job.at), zoneId: 'UTC',
        scheduleStartTime: at - 60_000, scheduleEndTime: at + 60_000, runCatchupScheduleInstances: false, paused: false,
        startWorkflowRequest: { name: CONDUCTOR_FIRE_WORKFLOW, version: 1, correlationId: job.id, input: { fireUrl: job.fireUrl, token: job.token } },
      }) });
      return { externalId: name(job.id) };
    },
    async deleteJob(handle) { await call(options, `/api/scheduler/schedules/${encodeURIComponent(handle.externalId)}`, { method: 'DELETE', headers }, true); },
  };
}
