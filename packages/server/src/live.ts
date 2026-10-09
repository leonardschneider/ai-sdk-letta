import { watch as fsWatch, readdirSync, readFileSync, statSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { conversationDirectory } from 'ai-sdk-letta';

/** File system calls {@link LiveConversations} uses (tests replace them). */
export type LiveFs = {
  watch(path: string, listener: () => void): { close(): void };
  /** A signature of a file (mtime and size), or `undefined` when it is missing. */
  stat(path: string): { mtimeMs: number; size: number } | undefined;
  readdir(path: string): string[];
  readFile(path: string): string;
};

const nodeFs: LiveFs = {
  watch: (path, listener) => { const watcher: FSWatcher = fsWatch(path, { persistent: false }, () => listener()); watcher.on('error', () => {}); return watcher; },
  stat: path => { try { const s = statSync(path); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return undefined; } },
  readdir: path => { try { return readdirSync(path); } catch { return []; } },
  readFile: path => readFileSync(path, 'utf8'),
};

/** Options of {@link LiveConversations}. */
export type LiveOptions = {
  /** The local Letta backend (`~/.letta/lc-local-backend`). */
  backendDirectory: string;
  agentId: string;
  /** A watched conversation changed (debounced): `at` is when (its files' newest change). */
  onChange(conversationId: string, at: string): void;
  /** A conversation of this agent appeared (made in Letta Code). */
  onNewConversation(): void;
  /** No client watched for `idleMs`: every watcher stopped. */
  onIdle?(): void;
  /** @default 500 */
  debounceMs?: number;
  /** Polling fallback (file events can be missed on iCloud or APFS). @default 5000 */
  pollMs?: number;
  /** @default 120000 (2 minutes) */
  idleMs?: number;
  /** Most conversations watched at once (least recently viewed ones are dropped). @default 8 */
  maxConversations?: number;
  fs?: LiveFs;
};

/** The most conversations one agent's live view watches at once. */
export const LIVE_LIMITS = { maxConversations: 8, debounceMs: 500, pollMs: 5000, idleMs: 120_000 } as const;

type Watched = { id: string; directory: string; signature: string; watchers: { close(): void }[]; timer?: ReturnType<typeof setTimeout> };

/**
 * Live refresh of an adopted agent's conversations while Letta Code works on
 * them (read-only): the conversations someone views are watched
 * (`messages.jsonl`, `conversation.json`; file events debounced, plus a poll
 * since events can be missed), and the backend's conversations folder is
 * watched for new conversations of the agent. Watchers stop after `idleMs`
 * without a {@link touch}, and on {@link close}.
 */
export class LiveConversations {
  private readonly fs: LiveFs;
  private readonly watched = new Map<string, Watched>();
  private known?: Set<string>;
  private rootWatcher?: { close(): void };
  private rootTimer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private idle?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private readonly options: LiveOptions) { this.fs = options.fs ?? nodeFs; }
  /** Whether it watches (not idle, not closed). */
  get active(): boolean { return !this.closed && !!this.poll; }
  /** Conversations watched now, least recently viewed first. */
  get conversations(): string[] { return [...this.watched.keys()]; }
  private get conversationsRoot() { return join(this.options.backendDirectory, 'conversations'); }
  /** A client looks at the agent (and maybe at a conversation): start or keep watching. */
  touch(conversationId?: string) {
    if (this.closed) return;
    this.start();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.stop(); this.options.onIdle?.(); }, this.options.idleMs ?? LIVE_LIMITS.idleMs);
    this.idle.unref?.();
    if (conversationId && /^[\w-]{1,200}$/.test(conversationId)) this.add(conversationId);
  }
  private start() {
    if (this.poll) return;
    this.known = new Set(this.fs.readdir(this.conversationsRoot));
    try { this.rootWatcher = this.fs.watch(this.conversationsRoot, () => this.rootChanged()); } catch { /* the poll still runs */ }
    this.poll = setInterval(() => this.check(), this.options.pollMs ?? LIVE_LIMITS.pollMs);
    this.poll.unref?.();
  }
  private add(id: string) {
    const existing = this.watched.get(id);
    if (existing) { this.watched.delete(id); this.watched.set(id, existing); return; }
    const max = this.options.maxConversations ?? LIVE_LIMITS.maxConversations;
    while (this.watched.size >= max) { const oldest = this.watched.values().next().value!; this.drop(oldest); }
    const directory = conversationDirectory(this.options.backendDirectory, id, this.options.agentId);
    const entry: Watched = { id, directory, signature: this.signature(directory), watchers: [] };
    for (const name of ['messages.jsonl', 'conversation.json']) {
      try { entry.watchers.push(this.fs.watch(join(directory, name), () => this.schedule(entry))); } catch { /* missing yet: the poll sees it */ }
    }
    this.watched.set(id, entry);
  }
  private drop(entry: Watched) { clearTimeout(entry.timer); for (const w of entry.watchers) { try { w.close(); } catch { /* closed */ } } this.watched.delete(entry.id); }
  private signature(directory: string) {
    return ['messages.jsonl', 'conversation.json'].map(name => { const s = this.fs.stat(join(directory, name)); return s ? `${s.mtimeMs}:${s.size}` : '-'; }).join('|');
  }
  private schedule(entry: Watched) {
    if (this.closed || this.watched.get(entry.id) !== entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.settle(entry), this.options.debounceMs ?? LIVE_LIMITS.debounceMs);
  }
  private settle(entry: Watched) {
    entry.timer = undefined;
    if (this.closed || this.watched.get(entry.id) !== entry) return;
    const signature = this.signature(entry.directory);
    if (signature === entry.signature) return;
    entry.signature = signature;
    const newest = Math.max(0, ...['messages.jsonl', 'conversation.json'].map(name => this.fs.stat(join(entry.directory, name))?.mtimeMs ?? 0));
    try { this.options.onChange(entry.id, new Date(newest || Date.now()).toISOString()); } catch { /* observer */ }
  }
  private rootChanged() {
    if (this.closed) return;
    clearTimeout(this.rootTimer);
    this.rootTimer = setTimeout(() => this.scanNew(), this.options.debounceMs ?? LIVE_LIMITS.debounceMs);
  }
  /** New folders in the conversations folder: one of this agent's means a new conversation. */
  private scanNew() {
    if (this.closed || !this.known) return;
    let found = false;
    for (const name of this.fs.readdir(this.conversationsRoot)) {
      if (this.known.has(name)) continue;
      let agentId: string | undefined;
      try { agentId = (JSON.parse(this.fs.readFile(join(this.conversationsRoot, name, 'conversation.json'))) as { agent_id?: string }).agent_id; }
      catch { continue; } // Not written yet: looked at again on the next change or poll.
      this.known.add(name);
      if (agentId === this.options.agentId) found = true;
    }
    if (found) { try { this.options.onNewConversation(); } catch { /* observer */ } }
  }
  /** The polling fallback: changed signatures, and new conversations. */
  private check() {
    for (const entry of [...this.watched.values()]) if (!entry.timer && this.signature(entry.directory) !== entry.signature) this.schedule(entry);
    this.scanNew();
  }
  private stop() {
    clearInterval(this.poll); this.poll = undefined;
    clearTimeout(this.idle); this.idle = undefined;
    clearTimeout(this.rootTimer); this.rootTimer = undefined;
    try { this.rootWatcher?.close(); } catch { /* closed */ }
    this.rootWatcher = undefined;
    for (const entry of [...this.watched.values()]) this.drop(entry);
    this.known = undefined;
  }
  /** Stop every watcher for good. */
  close() { this.stop(); this.closed = true; }
}
