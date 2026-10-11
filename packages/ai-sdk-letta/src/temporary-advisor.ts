import { join } from 'node:path';
import { LettaAgentClient, type LettaCodeClientSessionOptions } from '@letta-ai/letta-agent-sdk';
import { privateDirectory, removeTemporaryAgent, TemporaryAgentRecord, validLocalAgentId, type TemporaryAgentKind, type TemporaryAgentPlaces } from './temporary-agents.js';

/**
 * A temporary advisor: a fresh, hidden Letta agent for one structured answer
 * (Jiminy's memory reviews, the inner voices Ambition and Prudence). No tools
 * (only the SDK's `StructuredOutput` answer tool when the model needs it), no
 * memory, a stateless session, a JSON-schema answer (`outputFormat`), deleted
 * afterwards with its memory repository and transcripts (see
 * `temporary-agents.ts`; a crash leaves a record the kind's sweep removes).
 *
 * @module
 */

/* ------------------------------------------------------------------ */
/* Which model advises                                                 */
/* ------------------------------------------------------------------ */

/** The model family of a handle (`anthropic/claude-…` → `anthropic`, `openai-codex/gpt-…` → `openai`). */
export function modelFamily(handle: string): string {
  const [provider = '', model = ''] = handle.toLowerCase().split('/');
  if (/claude/.test(model) || provider.includes('anthropic') || provider.includes('claude')) return 'anthropic';
  if (/^(gpt|o\d|codex|chatgpt)/.test(model) || provider.startsWith('openai')) return 'openai';
  if (/gemini/.test(model) || provider.includes('google') || provider.includes('gemini')) return 'google';
  return provider || model;
}
/** Preferred reviewers per family, best first (the first available is used). */
export const REVIEWER_PREFERENCES: Readonly<Record<string, readonly RegExp[]>> = Object.freeze({
  anthropic: [/^anthropic\/claude-sonnet-5$/, /^anthropic\/claude-sonnet-4-6$/, /^anthropic\/claude-sonnet-4-5$/, /^anthropic\/claude-haiku-4-5$/, /^anthropic\/claude-sonnet/, /^anthropic\/claude/],
  openai: [/^openai-codex\/gpt-5\.5$/, /^openai\/gpt-5\.5$/, /^openai(-codex)?\/gpt-5/, /^openai(-codex)?\/gpt/],
  google: [/^google[^/]*\/gemini-.*pro/, /^google[^/]*\/gemini/],
});
/**
 * An advisor's model: `configured` when it is a handle; for `'auto'` (the
 * default), a model of a different family than the agent's when one is
 * available (two families rarely share the same blind spots), else the
 * agent's own model.
 */
export function chooseReviewerModel(agentModel: string, available: readonly string[], configured: string = 'auto'): { model: string; reason: 'configured' | 'other-family' | 'same-model' } {
  if (configured !== 'auto') return { model: configured, reason: 'configured' };
  const own = modelFamily(agentModel);
  for (const family of ['anthropic', 'openai', 'google'].filter(f => f !== own)) {
    for (const pattern of REVIEWER_PREFERENCES[family] ?? []) {
      const found = available.find(handle => pattern.test(handle));
      if (found) return { model: found, reason: 'other-family' };
    }
  }
  return { model: agentModel, reason: 'same-model' };
}

/* ------------------------------------------------------------------ */
/* One answer from a temporary hidden agent                            */
/* ------------------------------------------------------------------ */

/** Text as inert data: angle brackets escaped, so nothing in it can close or open a tag of the prompt. */
export const inert = (text: string) => text.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

/** Session options of an advisor: no tools, no skills, no memory; every permission request denied; the answer follows `schema`. */
export function advisorSessionOptions(cwd: string, schema: Readonly<Record<string, unknown>>): LettaCodeClientSessionOptions {
  return {
    stateless: true, cwd, toolset: { base: 'none' }, allowedTools: [], tools: [], skillSources: [], permissionMode: 'strict',
    canUseTool: async () => ({ behavior: 'deny', message: 'No tools are available.' }),
    outputFormat: { type: 'json_schema', schema: schema as unknown as Record<string, unknown>, maxRetries: 2 },
  } as LettaCodeClientSessionOptions;
}

/** One advisor call. */
export interface AdvisorCall extends TemporaryAgentPlaces {
  kind: TemporaryAgentKind;
  /** Agent description (shown when inspecting the backend). */
  description: string;
  /** Its instructions (system prompt). */
  systemPrompt: string;
  /** The answer's JSON schema. */
  schema: Readonly<Record<string, unknown>>;
  /** The one message it answers. */
  prompt: string;
  model: string;
  /** Most time the call may take. */
  timeoutMs: number;
  signal: AbortSignal;
  /** Error codes: `<prefix>_failed`, `<prefix>_unsafe`, `<prefix>_timeout`. */
  errorPrefix: string;
}
/** What an advisor answered: its structured output (unchecked: the caller validates it), the model, and what it cost. */
export type AdvisorAnswer = { output: unknown; model: string; usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number };

/**
 * Ask a fresh, hidden, tool-less, memory-less Letta agent once and delete it.
 * Fails closed (`<prefix>_unsafe`) unless the session is exactly the agent
 * created, with no tool but the SDK's answer tool.
 */
export async function askTemporaryAdvisor(call: AdvisorCall): Promise<AdvisorAnswer> {
  const { kind, model, errorPrefix } = call;
  const cwd = privateDirectory(join(call.directory, 'sessions'));
  const deadline = AbortSignal.timeout(call.timeoutMs);
  const all = AbortSignal.any([call.signal, deadline]);
  all.throwIfAborted();
  const client = new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', requestTimeoutMs: call.timeoutMs, startupTimeoutMs: 60_000 } });
  const record = new TemporaryAgentRecord(call);
  let agentId: string | undefined;
  let session: ReturnType<LettaAgentClient['resumeSession']> | undefined;
  const abort = () => { void session?.abort().catch(() => {}); };
  all.addEventListener('abort', abort, { once: true });
  try {
    agentId = await client.createAgent({
      name: kind.name, model, cwd, memfs: false, hidden: true, baseTools: [], skillSources: [], tags: [kind.tag],
      description: call.description, systemPrompt: call.systemPrompt,
    });
    if (!validLocalAgentId(agentId)) throw new Error(`${errorPrefix}_failed`);
    record.created(agentId);
    all.throwIfAborted();
    session = client.resumeSession(agentId, advisorSessionOptions(cwd, call.schema));
    const ready = await session.ready();
    const tools = (Array.isArray(ready.tools) ? ready.tools : []).map(t => typeof t === 'string' ? t : (t as { name?: string })?.name);
    if (ready.agentId !== agentId || tools.some(t => t !== 'StructuredOutput')) throw new Error(`${errorPrefix}_unsafe`);
    all.throwIfAborted();
    await session.send(call.prompt);
    let result: { success?: boolean; structuredOutput?: unknown; totalCostUsd?: number; usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
    for await (const message of session.stream()) {
      if (message.type === 'tool_call' && message.toolName !== 'StructuredOutput') throw new Error(`${errorPrefix}_unsafe`);
      if (message.type === 'result') { result = message as typeof result; break; }
    }
    all.throwIfAborted();
    if (!result?.success) throw new Error(`${errorPrefix}_failed`);
    return { output: result.structuredOutput, model, ...(typeof result.totalCostUsd === 'number' ? { costUsd: result.totalCostUsd } : {}),
      ...(result.usage ? { usage: { ...(typeof result.usage.input_tokens === 'number' ? { inputTokens: result.usage.input_tokens } : {}), ...(typeof result.usage.output_tokens === 'number' ? { outputTokens: result.usage.output_tokens } : {}) } } : {}) };
  } catch (error) {
    if (deadline.aborted) throw new Error(`${errorPrefix}_timeout`);
    throw error;
  } finally {
    all.removeEventListener('abort', abort);
    session?.close();
    try { if (agentId) await removeTemporaryAgent(client, agentId, kind, call); record.done(); }
    catch { /* the record stays; the kind's sweep removes it later */ }
    await client.close();
  }
}
