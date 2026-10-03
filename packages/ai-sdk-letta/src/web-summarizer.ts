import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LettaAgentClient, type LettaCodeClientSessionOptions } from '@letta-ai/letta-agent-sdk';
import { parseSummaryText, summaryPrompt, WEB_SUMMARIZER_INSTRUCTIONS, type WebSummarizer, type WebSummaryRequest } from './web-search.js';

/**
 * The default {@link WebSummarizer}: an isolated Letta sub-agent.
 *
 * Each search creates a **fresh, hidden Letta agent** on the same local
 * backend and model, sends it one message (the query and the pages' text)
 * and deletes it afterwards. The agent:
 *
 * - has **no tools**: no server tools (`baseTools: []`), no client tools
 *   (toolset `none`, empty allow-list, every permission request denied),
 *   no skills. The session is checked to report no tools before anything
 *   is sent; it can only answer with text.
 * - has **no memory**: created without MemFS, opened `stateless` (nothing
 *   is loaded or written), and it is not the main agent: the main agent's
 *   memory, conversations, resources, sandbox and integrations are out of
 *   its reach.
 * - leaves **nothing behind**: deleting the agent deletes its conversation
 *   (the query and page text). The empty memory repository the local
 *   backend creates for every agent is removed too. A search interrupted by
 *   a crash is cleaned up at the next start ({@link sweepWebSummarizers}).
 *
 * Why a fresh agent rather than one kept agent with a new conversation per
 * search: the SDK can create conversations but not delete them, so a kept
 * agent would accumulate every search's pages on disk.
 *
 * @module
 */

/** Options of {@link lettaSummarizer}. */
export interface LettaSummarizerOptions {
  /** Model handle (the main agent's, by default in the runtime). */
  model: string;
  /** Private working directory for the sub-agents' sessions (and their crash-recovery records, in `pending/`). */
  directory: string;
  /** Local backend directory (to remove each sub-agent's empty memory repository). */
  backendDirectory: string;
  /** Most characters of the answer read. @default 32000 */
  maxAnswerCharacters?: number;
}

/** Name of each summarizer agent (they are hidden; the name only helps when inspecting the backend). */
export const WEB_SUMMARIZER_NAME = 'ai-sdk-letta web research (temporary)';
const TAG = 'ai-sdk-letta:web-research';

const privateDirectory = (path: string) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error('Unsafe web search directory');
  chmodSync(path, 0o700);
  return path;
};
const validAgentId = (id: unknown): id is string => typeof id === 'string' && /^agent-local-[a-zA-Z0-9-]+$/.test(id);

/** Session options that leave the sub-agent no tool, skill or memory. */
export function summarizerSessionOptions(cwd: string): LettaCodeClientSessionOptions {
  return {
    stateless: true, cwd, toolset: { base: 'none' }, allowedTools: [], tools: [], skillSources: [], permissionMode: 'strict',
    canUseTool: async () => ({ behavior: 'deny', message: 'No tools are available.' }),
  };
}

async function remove(client: LettaAgentClient, agentId: string, options: LettaSummarizerOptions, record: string) {
  try { await client.agents.delete(agentId); }
  catch (error) {
    // Already gone is fine; anything else keeps the record for the next sweep.
    if (!/not.?found|404/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  rmSync(join(options.backendDirectory, 'memfs', agentId), { recursive: true, force: true });
  try { unlinkSync(record); } catch { /* already removed */ }
}

/**
 * Delete summarizer agents left by searches a crash interrupted (their
 * records in `<directory>/pending`). Safe to call at any time no search runs.
 * Resolves with how many were removed.
 */
export async function sweepWebSummarizers(options: Pick<LettaSummarizerOptions, 'directory' | 'backendDirectory'>): Promise<number> {
  const pending = join(options.directory, 'pending');
  if (!existsSync(pending)) return 0;
  const records = readdirSync(pending).filter(name => name.endsWith('.json'));
  if (!records.length) return 0;
  const client = new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', requestTimeoutMs: 30_000 } });
  let removed = 0;
  try {
    for (const name of records) {
      const record = join(pending, name);
      let agentId: unknown;
      try { agentId = JSON.parse(readFileSync(record, 'utf8')).agentId; } catch { agentId = undefined; }
      if (agentId === undefined) { unlinkSync(record); continue; } // creation never returned an ID: nothing to delete
      if (!validAgentId(agentId)) continue;
      try {
        const agent = await client.agents.retrieve(agentId).catch(() => undefined);
        // Only ever delete our own temporary agents.
        if (agent && (agent.name !== WEB_SUMMARIZER_NAME || !agent.tags?.includes(TAG))) { unlinkSync(record); continue; }
        await remove(client, agentId, { ...options, model: '' }, record);
        removed++;
      } catch { /* keep the record; try again next time */ }
    }
  } finally { await client.close(); }
  return removed;
}

/** A {@link WebSummarizer} backed by a fresh, tool-less, memory-less Letta agent per search (see the module description). */
export function lettaSummarizer(options: LettaSummarizerOptions): WebSummarizer {
  const maxAnswer = options.maxAnswerCharacters ?? 32_000;
  return async (request: WebSummaryRequest, signal: AbortSignal) => {
    const cwd = privateDirectory(join(options.directory, 'sessions'));
    const pending = privateDirectory(join(options.directory, 'pending'));
    signal.throwIfAborted();
    const client = new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', requestTimeoutMs: 120_000, startupTimeoutMs: 60_000 } });
    // Recorded before the agent exists, so a crash at any point leaves something to clean up.
    const record = join(pending, `${randomUUID()}.json`);
    writeFileSync(record, JSON.stringify({ createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    let agentId: string | undefined;
    let session: ReturnType<LettaAgentClient['resumeSession']> | undefined;
    const abort = () => { void session?.abort().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      agentId = await client.createAgent({
        name: WEB_SUMMARIZER_NAME, model: options.model, cwd, memfs: false, hidden: true, baseTools: [], skillSources: [], tags: [TAG],
        description: 'Temporary: summarizes one web search for ai-sdk-letta, then is deleted. No tools, no memory.',
        systemPrompt: WEB_SUMMARIZER_INSTRUCTIONS,
      });
      if (!validAgentId(agentId)) throw new Error('summary_failed');
      writeFileSync(record, JSON.stringify({ agentId, createdAt: new Date().toISOString() }), { mode: 0o600 });
      signal.throwIfAborted();
      session = client.resumeSession(agentId, summarizerSessionOptions(cwd));
      const ready = await session.ready();
      // Fail closed unless the session is exactly what was asked for: this agent, and no tools at all.
      if (ready.agentId !== agentId || (Array.isArray(ready.tools) && ready.tools.length)) throw new Error('summary_failed');
      signal.throwIfAborted();
      await session.send(summaryPrompt(request));
      let text = '';
      for await (const message of session.stream()) {
        if (message.type === 'tool_call') throw new Error('summary_failed'); // cannot happen with no tools; never tolerated
        if (message.type === 'assistant') { text += message.content; if (text.length > maxAnswer) throw new Error('summary_failed'); }
        if (message.type === 'result') { if (!message.success) throw new Error('summary_failed'); break; }
      }
      signal.throwIfAborted();
      return parseSummaryText(text);
    } finally {
      signal.removeEventListener('abort', abort);
      session?.close();
      try { if (agentId) await remove(client, agentId, options, record); else unlinkSync(record); }
      catch { /* the record stays; sweepWebSummarizers removes the agent later */ }
      await client.close();
    }
  };
}
