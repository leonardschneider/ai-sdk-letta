import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Per-user secrets of integrations (for example, an Atlassian API token),
 * stored by the server for the person who entered them.
 *
 * Layout: `<state>/credentials/<integration>/<sha256(user ID)>.json`. The
 * directories are 0700 and the files 0600, written atomically (temporary
 * file, fsync, rename); links are never followed. A user ID is hashed into
 * the file name, so no ID can reach another file. Nothing in here is ever
 * under the agent's resources, so neither the agent, its file tools nor the
 * sandbox can read it; the HTTP routes return only {@link publicStatus}.
 */

/** The user of single-user apps (the local GUI and TUI). Team servers use each person's stable user ID. */
export const LOCAL_USER_ID = 'local';

/** Who a turn acts for: the person whose message started it. Tools that use personal credentials act as this user. */
export type TurnActor = { id: string; name?: string; login?: string };
/** The local user of single-user apps. */
export const LOCAL_ACTOR: Readonly<TurnActor> = Object.freeze({ id: LOCAL_USER_ID, name: 'You' });
/** Key under which the runtime passes the turn's {@link TurnActor} to tools (`options.context[ACTOR_CONTEXT]`). Never from the model. */
export const ACTOR_CONTEXT = 'ai-sdk-letta.actor';

/** A user's Atlassian connection as stored on the server. `token` never leaves the server. */
export type AtlassianCredentials = {
  /** `https://<site>.atlassian.net` */
  site: string;
  email: string;
  token: string;
  savedAt: string;
  /** Last successful check (connect, test, or a tool call). */
  checkedAt?: string;
  accountId?: string;
  accountName?: string;
  /** `'rejected'` once Atlassian answered 401 for this token (it expired or was revoked): the user must replace it. */
  status: 'ok' | 'rejected';
  rejectedAt?: string;
};
/** What a user (and only that user) may see of their connection: never the token. */
export type AtlassianStatus = { connected: false } | { connected: true; site: string; email: string; accountName?: string; savedAt: string; checkedAt?: string; status: 'ok' | 'rejected'; rejectedAt?: string };

/** The public view of stored credentials: everything but the token. */
export function publicStatus(credentials: AtlassianCredentials | undefined): AtlassianStatus {
  if (!credentials) return { connected: false };
  const { site, email, accountName, savedAt, checkedAt, status, rejectedAt } = credentials;
  return { connected: true, site, email, ...(accountName ? { accountName } : {}), savedAt, ...(checkedAt ? { checkedAt } : {}), status, ...(rejectedAt ? { rejectedAt } : {}) };
}

const INTEGRATIONS = new Set(['atlassian']);
type Integration = 'atlassian';

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credentials directory');
  if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/** Per-user integration secrets in a private directory (see the module notes). */
export class CredentialStore {
  constructor(readonly directory: string) {}

  private file(integration: Integration, userId: string): string {
    if (!INTEGRATIONS.has(integration)) throw new Error('Unknown integration');
    if (typeof userId !== 'string' || !userId || userId.length > 200) throw new Error('Invalid user ID');
    const folder = join(this.directory, integration);
    privateDirectory(this.directory);
    privateDirectory(folder);
    return join(folder, `${createHash('sha256').update(`${integration}\0${userId}`).digest('hex')}.json`);
  }

  /** The user's stored Atlassian credentials, or `undefined`. */
  atlassian(userId: string): AtlassianCredentials | undefined {
    const file = this.file('atlassian', userId);
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const value = JSON.parse(readFileSync(fd, 'utf8')) as AtlassianCredentials & { userId?: string };
      // The file names a hash; the record names its owner too, so a file copied to another user's name is never used.
      if (value.userId !== userId || typeof value.token !== 'string' || typeof value.site !== 'string' || typeof value.email !== 'string') return undefined;
      const { userId: _owner, ...credentials } = value;
      return { ...credentials, status: credentials.status === 'rejected' ? 'rejected' : 'ok' };
    } finally { closeSync(fd); }
  }

  /** Save (replace) the user's Atlassian credentials atomically, 0600. */
  saveAtlassian(userId: string, credentials: AtlassianCredentials): void {
    const file = this.file('atlassian', userId);
    const temporary = `${file}.tmp-${randomUUID()}`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ ...credentials, userId })); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, file); } catch (error) { try { unlinkSync(temporary); } catch { /* gone */ } throw error; }
    try { const dir = openSync(join(this.directory, 'atlassian'), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* best effort */ }
  }

  /** Update fields of the stored record (for example, after a 401), if there is one. */
  updateAtlassian(userId: string, patch: Partial<Omit<AtlassianCredentials, 'token' | 'site' | 'email'>>): AtlassianCredentials | undefined {
    const current = this.atlassian(userId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    if (next.status === 'ok') delete next.rejectedAt;
    this.saveAtlassian(userId, next);
    return next;
  }

  /** Forget the user's Atlassian credentials. Returns whether there were any. */
  deleteAtlassian(userId: string): boolean {
    try { unlinkSync(this.file('atlassian', userId)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
}
