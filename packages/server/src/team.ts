import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { RuntimeFault, type RunAuthor } from './runtime.js';

/* ------------------------------------------------------------------ */
/* Tailscale identity                                                  */
/* ------------------------------------------------------------------ */

/**
 * A person as Tailscale reports them: `login` is the stable tailnet login
 * (for example `alice@example.com` or `alice@github`), `name` the display name.
 */
export type TailscaleIdentity = { login: string; name: string; avatar?: string };

/** RFC 2047 "Q" decoding of one header value (Tailscale encodes non-ASCII names this way). Anything malformed is returned as is. */
export function decodeHeaderValue(value: string): string {
  return value.replace(/=\?utf-8\?q\?([^?]*)\?=/gi, (whole, text: string) => {
    try {
      const bytes: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (c === '_') bytes.push(0x20);
        else if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
        else bytes.push(c.charCodeAt(0));
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    } catch { return whole; }
  }).replace(/\?=\s+=\?utf-8\?q\?/gi, '');
}

const LOGIN = /^[^\s@<>"'`\\]{1,128}@[^\s@<>"'`\\]{1,128}$/;
const loopback = (address: string | undefined) => !!address && (address === '::1' || /^127\./.test(address) || /^::ffff:127\./.test(address));
const one = (value: string | string[] | undefined) => Array.isArray(value) ? undefined : value;
/** Control characters, bidi and other invisible formatting are never shown. */
const visible = (value: string, max: number) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The person `tailscale serve` says made this request, or `undefined`.
 *
 * Trust rule: the identity headers are believed only on a connection from the
 * loopback interface, because `tailscale serve` proxies from 127.0.0.1 and
 * strips any identity headers the client sent. A request that reaches the app
 * any other way (it is bound to 127.0.0.1, so only local processes can) is
 * treated the same way: local processes are trusted, like the single-user app.
 * Headers repeated, empty or malformed are refused. A `Tailscale-Funnel-Request`
 * (public internet) never authenticates.
 */
export function tailscaleIdentity(headers: IncomingHttpHeaders, remoteAddress: string | undefined): TailscaleIdentity | undefined {
  if (!loopback(remoteAddress)) return undefined;
  if (headers['tailscale-funnel-request'] !== undefined) return undefined;
  const rawLogin = one(headers['tailscale-user-login']);
  if (!rawLogin) return undefined;
  const login = decodeHeaderValue(rawLogin).trim().toLowerCase();
  if (!LOGIN.test(login)) return undefined;
  const rawName = one(headers['tailscale-user-name']);
  const name = visible(rawName ? decodeHeaderValue(rawName) : '', 80) || login.split('@')[0]!;
  const rawAvatar = one(headers['tailscale-user-profile-pic']);
  let avatar: string | undefined;
  if (rawAvatar) { try { const url = new URL(rawAvatar); if (url.protocol === 'https:' && rawAvatar.length <= 1024) avatar = url.href; } catch { /* no avatar */ } }
  return { login, name, ...(avatar ? { avatar } : {}) };
}

/**
 * A served origin (`https://machine.tailnet.ts.net`, `http://name:8443`):
 * normalized, with the `Host` header value requests for it carry. Only http
 * and https, no path, query, credentials or fragment.
 * @throws if it is not such an origin
 */
export function servedOrigin(value: string): { origin: string; host: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid served origin: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') || !url.hostname) throw new Error(`Invalid served origin: ${value} (expected https://host or http://host:port)`);
  return { origin: url.origin.toLowerCase(), host: url.host.toLowerCase() };
}

/* ------------------------------------------------------------------ */
/* Directory: users, agents, memberships                               */
/* ------------------------------------------------------------------ */

/** Role of a member in one agent. Admins manage members; everyone shares everything inside the agent. */
export type MemberRole = 'admin' | 'member';
/**
 * A person known to the server. `id` is stable (other features, such as
 * per-user tokens, attach to it); `login` is their Tailscale login; `name`
 * and `avatar` are refreshed from Tailscale at each sign-in.
 */
export type TeamUser = { id: string; login: string; name: string; avatar?: string; createdAt: string; lastSeenAt?: string };
export type Membership = { agentId: string; userId: string; role: MemberRole; addedAt: string; addedBy?: string };
type DirectoryState = { version: 1; users: TeamUser[]; memberships: Membership[] };
/** A member as listed to an agent's members (no internal fields). */
export type MemberSummary = { id: string; login: string; name: string; avatar?: string; role: MemberRole; pending: boolean; you?: boolean };

/** Most people one server keeps, and members per agent. */
export const DIRECTORY_LIMITS = Object.freeze({ users: 1000, membersPerAgent: 200 });

/**
 * The server's people and who belongs to which agent, stored durably
 * (`team.json`, 0600, written atomically like the runtime state).
 *
 * Membership is per agent. The server owners named at startup are made
 * admins of every hosted agent (they can never be removed by others); admins
 * add and remove members and appoint other admins. Someone added by login
 * before they ever signed in is a "pending" member until their first visit.
 */
export class TeamDirectory {
  private state: DirectoryState;
  constructor(private readonly filename: string, private readonly owners: readonly string[] = []) {
    if (existsSync(filename)) {
      if (lstatSync(filename).isSymbolicLink()) throw new Error('Unsafe team directory file');
      this.state = JSON.parse(readFileSync(filename, 'utf8')) as DirectoryState;
      if (this.state.version !== 1 || !Array.isArray(this.state.users) || !Array.isArray(this.state.memberships)) throw new Error('Invalid team directory');
    } else this.state = { version: 1, users: [], memberships: [] };
    for (const owner of owners) if (!LOGIN.test(owner.trim().toLowerCase())) throw new Error(`Invalid owner login: ${owner}`);
  }
  private save() {
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const tmp = `${this.filename}.tmp`;
    // A leftover temporary file is an uncertain write, not permission to overwrite it.
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(tmp, this.filename); } catch (error) { try { unlinkSync(tmp); } catch { /* gone */ } throw error; }
    const directory = openSync(dirname(this.filename), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  /** Is `login` a server owner (configured at startup)? */
  isOwner(login: string) { return this.owners.some(owner => owner.trim().toLowerCase() === login); }
  /** Make sure every server owner is an admin of each of these agents (run at startup). */
  bootstrap(agentIds: readonly string[]) {
    let changed = false;
    for (const login of this.owners.map(owner => owner.trim().toLowerCase())) {
      const user = this.userByLogin(login) ?? this.addUser({ login, name: login.split('@')[0]! }, false);
      for (const agentId of agentIds) {
        const membership = this.state.memberships.find(m => m.agentId === agentId && m.userId === user.id);
        if (!membership) { this.state.memberships.push({ agentId, userId: user.id, role: 'admin', addedAt: new Date().toISOString() }); changed = true; }
        else if (membership.role !== 'admin') { membership.role = 'admin'; changed = true; }
      }
    }
    if (changed || !existsSync(this.filename)) this.save();
  }
  userByLogin(login: string) { return this.state.users.find(user => user.login === login); }
  user(id: string) { return this.state.users.find(user => user.id === id); }
  private addUser(identity: Pick<TailscaleIdentity, 'login' | 'name' | 'avatar'>, seen: boolean): TeamUser {
    if (this.state.users.length >= DIRECTORY_LIMITS.users) throw new RuntimeFault('capacity_reached');
    const now = new Date().toISOString();
    const user: TeamUser = { id: randomUUID(), login: identity.login, name: identity.name, ...(identity.avatar ? { avatar: identity.avatar } : {}), createdAt: now, ...(seen ? { lastSeenAt: now } : {}) };
    this.state.users.push(user);
    return user;
  }
  /**
   * The user record of a signed-in person, refreshing their name and avatar.
   * People who belong to no agent get no record (they only see "no access").
   */
  signIn(identity: TailscaleIdentity): TeamUser | undefined {
    const user = this.userByLogin(identity.login);
    if (!user) return undefined;
    const fresh = user.name !== identity.name || user.avatar !== identity.avatar || !user.lastSeenAt || Date.now() - Date.parse(user.lastSeenAt) > 60 * 60_000;
    if (fresh) {
      user.name = identity.name;
      if (identity.avatar) user.avatar = identity.avatar; else delete user.avatar;
      user.lastSeenAt = new Date().toISOString();
      this.save();
    }
    return user;
  }
  role(agentId: string, userId: string): MemberRole | undefined { return this.state.memberships.find(m => m.agentId === agentId && m.userId === userId)?.role; }
  /** Agents (of `agentIds`) this user belongs to, with their role. */
  agentsOf(userId: string, agentIds: readonly string[]) { return agentIds.flatMap(agentId => { const role = this.role(agentId, userId); return role ? [{ agentId, role }] : []; }); }
  members(agentId: string, viewer?: string): MemberSummary[] {
    return this.state.memberships.filter(m => m.agentId === agentId).flatMap(m => {
      const user = this.user(m.userId);
      return user ? [{ id: user.id, login: user.login, name: user.name, ...(user.avatar ? { avatar: user.avatar } : {}), role: m.role, pending: !user.lastSeenAt, ...(viewer === user.id ? { you: true } : {}) }] : [];
    }).sort((a, b) => Number(b.role === 'admin') - Number(a.role === 'admin') || a.name.localeCompare(b.name));
  }
  private requireAdmin(agentId: string, actor: TeamUser) { if (this.role(agentId, actor.id) !== 'admin') throw new RuntimeFault('admin_required', 403); }
  /** Add someone by Tailscale login (admins only). Adding an existing member changes nothing. */
  addMember(agentId: string, actor: TeamUser, input: unknown): MemberSummary {
    this.requireAdmin(agentId, actor);
    const { login: rawLogin, role = 'member' } = (input ?? {}) as { login?: unknown; role?: unknown };
    if (typeof rawLogin !== 'string' || (role !== 'member' && role !== 'admin')) throw new RuntimeFault('invalid_input', 400);
    const login = rawLogin.trim().toLowerCase();
    if (!LOGIN.test(login)) throw new RuntimeFault('invalid_login', 400);
    if (this.state.memberships.filter(m => m.agentId === agentId).length >= DIRECTORY_LIMITS.membersPerAgent) throw new RuntimeFault('capacity_reached');
    const user = this.userByLogin(login) ?? this.addUser({ login, name: login.split('@')[0]! }, false);
    if (!this.role(agentId, user.id)) { this.state.memberships.push({ agentId, userId: user.id, role, addedAt: new Date().toISOString(), addedBy: actor.id }); this.save(); }
    return this.members(agentId, actor.id).find(m => m.id === user.id)!;
  }
  /** Change a member's role (admins only). The last admin cannot step down, and server owners always stay admins. */
  setRole(agentId: string, actor: TeamUser, userId: string, input: unknown): MemberSummary {
    this.requireAdmin(agentId, actor);
    const { role } = (input ?? {}) as { role?: unknown };
    if (role !== 'member' && role !== 'admin') throw new RuntimeFault('invalid_input', 400);
    const membership = this.state.memberships.find(m => m.agentId === agentId && m.userId === userId);
    if (!membership) throw new RuntimeFault('not_found', 404);
    if (role === 'member' && membership.role === 'admin') {
      if (this.isOwner(this.user(userId)!.login)) throw new RuntimeFault('owner_is_admin', 409);
      if (this.state.memberships.filter(m => m.agentId === agentId && m.role === 'admin').length <= 1) throw new RuntimeFault('last_admin', 409);
    }
    if (membership.role !== role) { membership.role = role; this.save(); }
    return this.members(agentId, actor.id).find(m => m.id === userId)!;
  }
  /** Remove a member (admins only; anyone may leave). Server owners and the last admin cannot be removed. */
  removeMember(agentId: string, actor: TeamUser, userId: string) {
    if (userId !== actor.id) this.requireAdmin(agentId, actor);
    const membership = this.state.memberships.find(m => m.agentId === agentId && m.userId === userId);
    if (!membership) throw new RuntimeFault('not_found', 404);
    if (this.isOwner(this.user(userId)!.login)) throw new RuntimeFault('owner_is_admin', 409);
    if (membership.role === 'admin' && this.state.memberships.filter(m => m.agentId === agentId && m.role === 'admin').length <= 1) throw new RuntimeFault('last_admin', 409);
    this.state.memberships = this.state.memberships.filter(m => m !== membership);
    this.save();
  }
}

/** The author recorded on a run for a user. */
export const authorOf = (user: TeamUser): RunAuthor => ({ id: user.id, login: user.login, name: user.name, ...(user.avatar ? { avatar: user.avatar } : {}) });
