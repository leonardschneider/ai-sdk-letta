import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';

/**
 * Temporary hidden Letta agents (the web search summarizer, the memory
 * reviewer): created for one job, then deleted with everything the local
 * backend and the harness keep for them, namely the agent and its
 * conversation, its (empty) memory repository
 * (`<backend>/memfs/<agentId>`), and the transcripts the harness writes
 * for reflection (`~/.letta/transcripts/<agentId>`, or
 * `$LETTA_TRANSCRIPT_ROOT/<agentId>`).
 *
 * Each job records the agent before it exists (`<directory>/pending/*.json`),
 * so a crash at any point leaves something the next start cleans up
 * ({@link sweepTemporaryAgents}). Only agents with the expected name and tag
 * are ever deleted.
 *
 * @module
 */

/** What identifies one kind of temporary agent. */
export interface TemporaryAgentKind {
  /** Display name of every such agent. */
  name: string;
  /** Tag every such agent carries. */
  tag: string;
}
/** Where a kind of temporary agent keeps its crash records, and the local backend. */
export interface TemporaryAgentPlaces {
  /** Private working directory: sessions run in `sessions/`, records live in `pending/`. */
  directory: string;
  /** Local backend directory (for the memory repositories). */
  backendDirectory: string;
  /** Root of the harness's transcripts. @default `$LETTA_TRANSCRIPT_ROOT`, else `~/.letta/transcripts` */
  transcriptsDirectory?: string;
}

/** Root of the Letta harness's reflection transcripts (`$LETTA_TRANSCRIPT_ROOT`, else `~/.letta/transcripts`). */
export function transcriptsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.LETTA_TRANSCRIPT_ROOT?.trim();
  return resolve(root || join(homedir(), '.letta', 'transcripts'));
}

/** A local agent ID (never a path). */
export const validLocalAgentId = (id: unknown): id is string => typeof id === 'string' && /^agent-local-[a-zA-Z0-9-]{1,100}$/.test(id);

/** A private directory (0700, never a link). */
export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error('Unsafe temporary agent directory');
  chmodSync(path, 0o700);
  return path;
}

/** Remove what the backend and harness keep for a deleted agent: its memory repository and its transcripts. */
export function removeAgentFolders(agentId: string, places: Pick<TemporaryAgentPlaces, 'backendDirectory' | 'transcriptsDirectory'>): void {
  if (!validLocalAgentId(agentId)) return;
  rmSync(join(places.backendDirectory, 'memfs', agentId), { recursive: true, force: true });
  rmSync(join(places.transcriptsDirectory ?? transcriptsDirectory(), agentId), { recursive: true, force: true });
}

/**
 * Delete one temporary agent (only if it is still ours: name and tag match;
 * already gone is fine), then its folders. Throws when the backend refused,
 * so the caller keeps the crash record.
 */
export async function removeTemporaryAgent(client: LettaAgentClient, agentId: string, kind: TemporaryAgentKind, places: TemporaryAgentPlaces): Promise<void> {
  if (!validLocalAgentId(agentId)) return;
  const agent = await client.agents.retrieve(agentId).catch(() => undefined);
  if (agent && (agent.name !== kind.name || !agent.tags?.includes(kind.tag))) return; // not ours: never touched
  if (agent) {
    try { await client.agents.delete(agentId); }
    catch (error) { if (!/not.?found|404/i.test(error instanceof Error ? error.message : String(error))) throw error; }
  }
  removeAgentFolders(agentId, places);
}

/**
 * IDs of this kind's agents in the local backend's agent records
 * (`<backend>/agents/<base64url(id)>.json`): same name and tag. The backend
 * never lists hidden agents, so this is how orphans whose crash record was
 * lost are found. Read-only; the caller deletes through the backend.
 */
export function hiddenAgentsOf(kind: TemporaryAgentKind, backendDirectory: string): string[] {
  const folder = join(backendDirectory, 'agents');
  let names: string[] = [];
  try { names = readdirSync(folder).filter(name => name.endsWith('.json')); } catch { return []; }
  const found: string[] = [];
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(join(folder, name), 'utf8')) as { id?: unknown; name?: unknown; tags?: unknown };
      if (record.name === kind.name && Array.isArray(record.tags) && record.tags.includes(kind.tag) && validLocalAgentId(record.id)) found.push(record.id);
    } catch { /* not an agent record */ }
  }
  return found;
}

/** A crash record for one job: written before the agent exists, updated with its ID, removed when everything is gone. */
export class TemporaryAgentRecord {
  readonly file: string;
  constructor(places: TemporaryAgentPlaces) {
    this.file = join(privateDirectory(join(places.directory, 'pending')), `${randomUUID()}.json`);
    writeFileSync(this.file, JSON.stringify({ createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  }
  created(agentId: string) { writeFileSync(this.file, JSON.stringify({ agentId, createdAt: new Date().toISOString() }), { mode: 0o600 }); }
  done() { try { unlinkSync(this.file); } catch { /* already removed */ } }
}

/**
 * Delete temporary agents a crash left behind: those named in crash records
 * (`<directory>/pending`), and any hidden agent of this kind the backend
 * still lists (same name and tag), with their memory repositories and
 * transcripts. Safe to call whenever no job of this kind runs. Resolves
 * with how many were removed.
 */
export async function sweepTemporaryAgents(kind: TemporaryAgentKind, places: TemporaryAgentPlaces, client?: LettaAgentClient): Promise<number> {
  const pending = join(places.directory, 'pending');
  const records = existsSync(pending) ? readdirSync(pending).filter(name => name.endsWith('.json')) : [];
  const own = client ?? new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', requestTimeoutMs: 30_000 } });
  let removed = 0;
  try {
    const ids = new Set<string>();
    for (const name of records) {
      const record = join(pending, name);
      let agentId: unknown;
      try { agentId = JSON.parse(readFileSync(record, 'utf8')).agentId; } catch { agentId = undefined; }
      if (agentId === undefined) { try { unlinkSync(record); } catch { /* gone */ } continue; } // creation never returned an ID
      if (!validLocalAgentId(agentId)) continue;
      try { await removeTemporaryAgent(own, agentId, kind, places); ids.add(agentId); removed++; try { unlinkSync(record); } catch { /* gone */ } }
      catch { /* keep the record; try again next time */ }
    }
    // Agents whose record was lost: hidden agents are never listed, so read the backend's agent records (the same name and tag rule).
    for (const agentId of hiddenAgentsOf(kind, places.backendDirectory)) {
      if (ids.has(agentId)) continue;
      try { await removeTemporaryAgent(own, agentId, kind, places); removed++; } catch { /* next time */ }
    }
  } finally { if (!client) await own.close(); }
  return removed;
}
