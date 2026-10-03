import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
export type Identity = { version: 2; definitionId: string; name: string; backend: string; agentId: string; conversationId?: string; namedOnly?: true };

/** Letta conversation IDs accepted by this library (`default` is the agent's default conversation). */
export const validConversationId = (id: string): boolean => id === 'default' || /^(?:conv-|local-conv-)[a-zA-Z0-9-]+$/.test(id);
const validLocalAgentId = (id: unknown): id is string => typeof id === 'string' && /^agent-local-[a-zA-Z0-9-]+$/.test(id);

/** Backend operations used while acquiring an identity. */
export interface IdentityBackend {
  /** Create the Letta agent. Called at most once per logical ID, ever. */
  create(): Promise<string>;
  /** Confirm the mapped agent still exists and matches; throw otherwise. */
  validate(id: string): Promise<void>;
}

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
 * - `<id>.<conversation>.turn.pending.json` a turn whose delivery is not yet confirmed.
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
    const save = () => {
      if (released) throw new Error('Identity lock already released');
      durableWrite(`${file}.new`, identity);
      renameSync(`${file}.new`, file);
      syncDirectory();
    };
    if (exists(file)) {
      const stored = read(file);
      if (![1, 2].includes(stored.version) || stored.definitionId !== definition.id || stored.name !== definition.name || stored.backend !== backend || (stored.conversationId !== undefined && (typeof stored.conversationId !== 'string' || !validConversationId(stored.conversationId))) || (stored.conversationId === undefined && stored.namedOnly !== true) || (stored.namedOnly !== undefined && stored.namedOnly !== true) || (stored.version === 1 && stored.conversationId !== 'default') || !validLocalAgentId(stored.agentId)) throw new Error('Invalid identity mapping or backend mismatch; refusing to recreate agent');
      migrate = stored.version === 1;
      identity = { ...stored, version: 2 };
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
    await api.validate(identity.agentId);
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
      if (exists(turnPath(id))) throw new Error(`Uncertain prior delivery: ${turnPath(id)}. Inspect backend and reconcile manually; no automatic replay. Select another conversation to continue.`);
    };
    const beginTurn = (id: string) => {
      if (released) throw new Error('Identity lock already released');
      assertNoPendingTurn(id);
      durableWrite(turnPath(id), { agentId: identity.agentId, conversationId: id, createdAt: new Date().toISOString(), state: 'delivery-uncertain' });
    };
    const completeTurn = (id: string) => {
      if (released) throw new Error('Identity lock already released');
      unlinkSync(turnPath(id));
      syncDirectory();
    };
    return { identity, release, selectConversation, createConversation, assertNoPendingTurn, beginTurn, completeTurn };
  } catch (error) { release(); throw error; }
}
