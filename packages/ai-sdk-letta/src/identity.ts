import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Persisted mapping from a logical definition ID to the Letta-generated agent ID.
 *
 * `conversationId` is the last selected conversation: absent until the first
 * one is created. New conversations are always named Letta conversations,
 * never the agent's `default` one. Mappings written by earlier versions
 * record `'default'` and keep working (that conversation stays usable).
 * `namedOnly`: the mapping was created by a version that never uses the
 * `default` conversation, so pickers do not offer it (it is empty).
 */
export type Identity = { version: 2; definitionId: string; name: string; backend: string; agentId: string; conversationId?: string; namedOnly?: true;
  /** The definition adopted an existing agent in place (see `AgentDefinition.adopt`): it was never created here, and its `default` conversation is offered. */
  adopted?: true; adoptedAt?: string };

/** Letta conversation IDs accepted by this library (`default` is the agent's default conversation). */
export const validConversationId = (id: string): boolean => id === 'default' || /^(?:conv-|local-conv-)[a-zA-Z0-9-]+$/.test(id);
const validLocalAgentId = (id: unknown): id is string => typeof id === 'string' && /^agent-local-[a-zA-Z0-9-]+$/.test(id);

/** Backend operations used while acquiring an identity. */
export interface IdentityBackend {
  /** Create the Letta agent. Called at most once per logical ID, ever. */
  create(): Promise<string>;
  /** Confirm the mapped agent still exists and matches; throw otherwise. */
  validate(id: string): Promise<void>;
  /**
   * Adopt this existing agent instead of creating one (see
   * `AgentDefinition.adopt`). `create` is then never called, and a mapping
   * that names another agent is refused.
   */
  adopt?: string;
}

/** The other logical IDs whose mapping in `directory` names `agentId` (an agent belongs to one definition at a time). */
export function claimsOf(directory: string, agentId: string, except?: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(directory).filter(name => /^[a-z0-9-]+\.json$/.test(name)); } catch { return []; }
  return names.flatMap(name => {
    const id = name.slice(0, -5);
    if (id === except) return [];
    try { const stored = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { agentId?: unknown; definitionId?: unknown }; return stored.agentId === agentId ? [id] : []; } catch { return []; }
  });
}

/**
 * Forget a definition's mapping (an adopted agent removed from the app). The
 * Letta agent is never touched. Refused while the identity is locked or has
 * an uncertain creation or turn.
 * @returns whether a mapping was removed
 */
export function forgetIdentity(directory: string, definitionId: string): boolean {
  if (!/^[a-z0-9-]+$/.test(definitionId)) throw new Error('Invalid logical agent identity');
  const base = join(directory, definitionId);
  let names: string[] = [];
  try { names = readdirSync(directory); } catch { return false; }
  if (names.some(name => name === `${definitionId}.lock` || (name.startsWith(`${definitionId}.`) && name.endsWith('.pending.json')))) throw new Error('identity_busy');
  try { unlinkSync(`${base}.json`); return true; } catch { return false; }
}

/** A turn marker (see `IdentityLease.pendingTurn`): when it was written, and the OTID the turn was sent with. */
export type PendingTurn = { createdAt: string; otid?: string };
/**
 * A turn whose outcome became known without it finishing (see
 * `IdentityLease.settleTurn`): `stopped` by the application after delivery
 * (the backend confirmed the run ended), or `reconciled` after an uncertain
 * delivery was checked ("Check and unlock"). `delivered`: whether the
 * message with `otid` is in the backend history (when the turn had one).
 * `through`: the newest backend message ID when it was settled.
 */
export type SettledTurn = { outcome: 'stopped' | 'reconciled'; delivered?: boolean; otid?: string; through?: string; settledAt: string };
/** Handle returned by {@link acquireIdentity}. Holds an exclusive lock until `release()`. */
export type IdentityLease = Awaited<ReturnType<typeof acquireIdentity>>;

/**
 * Acquire the durable identity for a definition, creating the Letta agent on
 * first use. Fails closed on stale locks, uncertain creations or mismatches:
 * it never searches by name, recreates, or retries.
 *
 * Files in `directory` (all 0600, directory 0700):
 * - `<id>.json` the mapping; `<id>.lock` the process lock;
 * - `<id>.pending.json` / `<id>.conversation.pending.json` uncertain creations;
 * - `<id>.<conversation>.turn.pending.json` a turn whose delivery is not yet confirmed;
 * - `<id>.<conversation>.turn.settled.json` the latest turn that was stopped or checked (see `settleTurn`).
 */
export async function acquireIdentity(directory: string, definition: { id: string; name: string }, backend: string, api: IdentityBackend) {
  if (!/^[a-z0-9-]+$/.test(definition.id)) throw new Error('Invalid logical agent identity');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe identity directory');
  chmodSync(directory, 0o700);
  const base = join(directory, definition.id);
  const lock = `${base}.lock`;
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new Error(`Agent identity is locked: ${lock}. Another process may be running. After a crash, verify its PID is no longer running before removing the lock; never remove a pending intent blindly.`); }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  fsyncSync(fd); closeSync(fd);
  let released = false;
  const release = () => { if (!released) { unlinkSync(lock); released = true; } };
  const file = `${base}.json`;
  const pending = `${base}.pending.json`;
  const syncDirectory = () => { const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } };
  const exists = (path: string) => {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const read = (path: string) => {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Unsafe identity file');
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const durableWrite = (path: string, value: unknown) => {
    const handle = openSync(path, 'wx', 0o600);
    try { writeFileSync(handle, JSON.stringify(value, null, 2)); fsyncSync(handle); } finally { closeSync(handle); }
    syncDirectory();
  };
  try {
    if (exists(pending)) throw new Error(`Unresolved agent creation intent: ${pending}. Inspect the local backend and reconcile manually; refusing to create a duplicate.`);
    const conversationPending = `${base}.conversation.pending.json`;
    if (exists(conversationPending)) throw new Error(`Unresolved conversation creation intent: ${conversationPending}. Reconcile with backend before continuing; refusing to create a duplicate.`);
    let identity: Identity;
    let migrate = false;
    let adoptedNow = false;
    const save = () => {
      if (released) throw new Error('Identity lock already released');
      durableWrite(`${file}.new`, identity);
      renameSync(`${file}.new`, file);
      syncDirectory();
    };
    if (exists(file)) {
      const stored = read(file);
      if (![1, 2].includes(stored.version) || stored.definitionId !== definition.id || stored.name !== definition.name || stored.backend !== backend || (stored.conversationId !== undefined && (typeof stored.conversationId !== 'string' || !validConversationId(stored.conversationId))) || (stored.conversationId === undefined && stored.namedOnly !== true && stored.adopted !== true) || (stored.namedOnly !== undefined && stored.namedOnly !== true) || (stored.version === 1 && stored.conversationId !== 'default') || !validLocalAgentId(stored.agentId)) throw new Error('Invalid identity mapping or backend mismatch; refusing to recreate agent');
      if (api.adopt !== undefined && stored.agentId !== api.adopt) throw new Error('The mapping of this definition names another agent; refusing to adopt');
      migrate = stored.version === 1;
      identity = { ...stored, version: 2 };
    } else if (api.adopt !== undefined) {
      // Adopt in place: map the existing agent; nothing is created, ever.
      if (!validLocalAgentId(api.adopt)) throw new Error('Invalid adopted agent ID');
      const claimed = claimsOf(directory, api.adopt, definition.id);
      if (claimed.length) throw new Error(`agent_claimed: this agent is already used by ${claimed.join(', ')}`);
      await api.validate(api.adopt);
      identity = { version: 2, definitionId: definition.id, name: definition.name, backend, agentId: api.adopt, adopted: true, adoptedAt: new Date().toISOString() };
      durableWrite(`${file}.new`, identity);
      renameSync(`${file}.new`, file);
      syncDirectory();
      adoptedNow = true;
    } else {
      durableWrite(pending, { definitionId: definition.id, name: definition.name, backend, createdAt: new Date().toISOString(), state: 'creation-uncertain' });
      const agentId = await api.create();
      if (!validLocalAgentId(agentId)) throw new Error('SDK returned a non-local agent ID');
      // No conversation yet: the first one is created (named) when the agent is first opened.
      identity = { version: 2, definitionId: definition.id, name: definition.name, backend, agentId, namedOnly: true };
      // Keep the intent until an fsynced mapping is in place. Crashes fail closed.
      durableWrite(`${file}.new`, identity);
      renameSync(`${file}.new`, file);
      syncDirectory();
      unlinkSync(pending);
    }
    if (!adoptedNow) await api.validate(identity.agentId);
    if (migrate) save();
    const selectConversation = (id: string) => {
      if (!validConversationId(id)) throw new Error('Invalid conversation ID');
      identity.conversationId = id; save();
    };
    const createConversation = async (create: (agentId: string) => Promise<string>) => {
      if (released || exists(conversationPending)) throw new Error('Unresolved conversation creation or released lock');
      durableWrite(conversationPending, { agentId: identity.agentId, createdAt: new Date().toISOString(), state: 'creation-uncertain' });
      const id = await create(identity.agentId);
      if (id === 'default' || !validConversationId(id)) throw new Error('Invalid created conversation');
      selectConversation(id);
      unlinkSync(conversationPending);
      syncDirectory();
      return id;
    };
    const turnPath = (id: string) => {
      if (!validConversationId(id)) throw new Error('Invalid conversation ID');
      return `${base}.${id}.turn.pending.json`;
    };
    const assertNoPendingTurn = (id: string) => {
      if (exists(turnPath(id))) throw new Error(`Uncertain prior delivery: ${turnPath(id)}. Inspect backend and reconcile manually (in the GUI: Check and unlock); no automatic replay. Select another conversation to continue.`);
    };
    /** The marker of a turn whose delivery is not confirmed, if any (its OTID when it recorded one). */
    const pendingTurn = (id: string): PendingTurn | undefined => {
      if (!exists(turnPath(id))) return undefined;
      const stored = read(turnPath(id)) as Partial<PendingTurn>;
      return { createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : '', ...(typeof stored.otid === 'string' ? { otid: stored.otid } : {}) };
    };
    const beginTurn = (id: string, otid?: string) => {
      if (released) throw new Error('Identity lock already released');
      assertNoPendingTurn(id);
      durableWrite(turnPath(id), { agentId: identity.agentId, conversationId: id, createdAt: new Date().toISOString(), state: 'delivery-uncertain', ...(otid ? { otid } : {}) });
    };
    const completeTurn = (id: string) => {
      if (released) throw new Error('Identity lock already released');
      unlinkSync(turnPath(id));
      syncDirectory();
    };
    const settledPath = (id: string) => `${turnPath(id).slice(0, -'.turn.pending.json'.length)}.turn.settled.json`;
    /**
     * A turn whose outcome is now known although it did not finish: it was
     * stopped (and the backend confirmed it ended), or an uncertain turn was
     * checked and found ended. The record is written first, then the
     * pending marker is removed; the history up to `through` (and the user
     * message with `otid`) then counts as settled (see `assertHistorySettled`).
     */
    const settleTurn = (id: string, record: Omit<SettledTurn, 'settledAt'>) => {
      if (released) throw new Error('Identity lock already released');
      const path = settledPath(id);
      if (exists(`${path}.new`)) unlinkSync(`${path}.new`);
      durableWrite(`${path}.new`, { ...record, settledAt: new Date().toISOString() });
      renameSync(`${path}.new`, path);
      if (exists(turnPath(id))) unlinkSync(turnPath(id));
      syncDirectory();
    };
    /** The latest settled turn of a conversation (see {@link settleTurn}). */
    const settledTurn = (id: string): SettledTurn | undefined => {
      if (!exists(settledPath(id))) return undefined;
      const stored = read(settledPath(id)) as Partial<SettledTurn>;
      return { outcome: stored.outcome === 'reconciled' ? 'reconciled' : 'stopped', ...(typeof stored.delivered === 'boolean' ? { delivered: stored.delivered } : {}), settledAt: typeof stored.settledAt === 'string' ? stored.settledAt : '',
        ...(typeof stored.otid === 'string' ? { otid: stored.otid } : {}), ...(typeof stored.through === 'string' ? { through: stored.through } : {}) };
    };
    return { identity, release, selectConversation, createConversation, assertNoPendingTurn, pendingTurn, beginTurn, completeTurn, settleTurn, settledTurn };
  } catch (error) { release(); throw error; }
}
