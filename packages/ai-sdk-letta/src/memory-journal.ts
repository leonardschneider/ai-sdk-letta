import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONVERSATION_TRAILER, REWIND_TRAILER, TURN_TRAILER, commitInfo, commitsSince, commitsWithTrailer, headOf, planRevert, withTrailers, type CommitInfo, type FilePlan, type GitRunner, type RevertPlan } from './revert.js';
import { PROVENANCE_TRAILERS, provenanceTrailers, withSource, type ContentSource, type TurnProvenance } from './provenance.js';

/**
 * Which turn changed the agent's memory (MemFS, a git repository the Letta
 * harness keeps), so a rewind can undo exactly the memory changes of the
 * turns it removes.
 *
 * The agent edits memory files during its turns and commits them with the
 * one command it is allowed (`memoryCommitCommand`), or not at all (the
 * harness then reminds it in a later turn, which would mix two turns'
 * changes). So at the end of every turn the journal commits what is left
 * ("Agent memory changes", with `X-Turn` and `X-Conversation` trailers) and
 * records which new commits the turn made, in a ledger next to the agent's
 * state (`<state>/memory/<agentId>.json`).
 *
 * Commits are classified as:
 * - `turn`: made by one turn (its own commits and the end-of-turn commit);
 * - `shared`: made while turns of several conversations ran at once (they
 *   cannot be told apart, so a rewind keeps them and says so);
 * - background: anything else, such as dreaming (reflection) merging its
 *   work: never attributed to a turn; a rewind keeps it and says so.
 */

/** A rewind's view of the memory: what is reverted, what is kept. */
export interface MemoryRewindPlan {
  /** Files the rewound turns changed: reverted, or kept on conflict. */
  files: FilePlan[];
  /** The rewound turns' commits. */
  commits: CommitInfo[];
  /** Commits since the rewound turns started that are kept: dreaming and other background work (`background`), or several turns at once (`shared`). */
  kept: (CommitInfo & { kind: 'background' | 'shared' })[];
}
type Entry = { commit: string; kind: 'turn' | 'shared'; turns: string[]; conversationId?: string; at: string; provenance?: TurnProvenance };
type Ledger = { version: 1; since: string; entries: Entry[]; starts?: Record<string, string>;
  /** Untrusted content each conversation has read (it stays in its context, so later turns are untrusted too). */
  tainted?: Record<string, ContentSource[]> };
type Active = { conversationId?: string; start?: string; overlapped: boolean; provenance?: TurnProvenance };
/** Lines a reviewer drops: lines `start`..`end` (1-based, inclusive) of `path` at HEAD, with their exact text (joined with "\n"). */
export type LineDrop = { path: string; start: number; end: number; text: string };
/** A turn's recorded memory commits (see {@link MemoryJournal.endTurn}). */
export type TurnCommits = { turn: string; conversationId?: string; commits: string[]; kind: 'turn' | 'shared'; provenance?: TurnProvenance };

/** Git notes ref where the provenance of commits without trailers (the agent's own commits) is kept. */
export const PROVENANCE_NOTES = 'refs/notes/provenance';
/** Author email of the agent's own memory commits (its one allowed command, and the end-of-turn commit). */
export const AGENT_EMAIL = 'agent@localhost';
const REWIND_EMAIL = 'rewind@ai-sdk-letta.invalid';
/** Author email of commits the harness makes for memory reviews (reverts and re-applied changes). */
export const REVIEW_EMAIL = 'memory-review@ai-sdk-letta.invalid';
/** Whether a commit was made by the harness itself (a rewind, a review's revert or re-apply), not by the agent or dreaming. */
export const harnessCommit = (author?: string) => author === REWIND_EMAIL || author === REVIEW_EMAIL;
const journals = new Map<string, MemoryJournal>();
const queues = new Map<string, Promise<unknown>>();
/** One operation at a time per memory repository (in this process). */
async function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  try { return await run; } finally { if (queues.get(key) === tail) queues.delete(key); }
}

/** The memory journal of one agent. Get one with {@link MemoryJournal.open}. */
export class MemoryJournal {
  private readonly active = new Map<string, Active>();
  private constructor(readonly file: string, readonly memoryDirectory: string, readonly author: string) {}

  /**
   * The journal of an agent's memory (one per memory directory in this process).
   * @param directory where ledgers are kept (`statePaths(...).memory`)
   * @param author the name the agent's memory commits use (the definition's name)
   */
  static open(directory: string, agentId: string, memoryDirectory: string, author = 'ai-sdk-letta agent'): MemoryJournal {
    if (!/^agent-[a-zA-Z0-9-]{1,100}$/.test(agentId)) throw new Error('Invalid agent ID');
    const key = resolve(memoryDirectory);
    let journal = journals.get(key);
    if (!journal) { journal = new MemoryJournal(join(directory, `${agentId}.json`), key, author); journals.set(key, journal); }
    return journal;
  }

  /** Runs git in the memory repository, without global or system configuration and without hooks. */
  readonly git: GitRunner = (args, options = {}) => new Promise((done, fail) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.memoryDirectory, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.env };
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-C', this.memoryDirectory, ...args], { env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (error && !(options.ok1 && code === 1)) fail(new Error(`git ${args[0]} failed: ${String(stderr).trim().slice(0, 300) || (error as Error).message}`));
      else done({ stdout, code: error ? 1 : 0 });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });

  private ledger(): Ledger {
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Ledger;
      if (value.version === 1 && Array.isArray(value.entries)) return value;
    } catch { /* new */ }
    return { version: 1, since: new Date().toISOString(), entries: [] };
  }
  private save(ledger: Ledger) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    if (ledger.entries.length > 5000) ledger.entries = ledger.entries.slice(-5000);
    const temporary = `${this.file}.tmp-${randomUUID()}`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, JSON.stringify(ledger)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file);
  }
  /** When the journal started recording (turns before that cannot be rewound precisely). */
  get since(): string { const ledger = this.ledger(); if (!ledger.entries.length) this.save(ledger); return ledger.since; }

  /**
   * A turn started (`turn`: its ID, the OTID of its message). Paired with
   * {@link endTurn}. `provenance`: who acted and how (see `TurnProvenance`);
   * recorded in the ledger and as trailers of the turn's commits.
   */
  beginTurn(turn: string, conversationId?: string, provenance?: TurnProvenance) {
    for (const other of this.active.values()) other.overlapped = true;
    // Untrusted content read earlier in this conversation is still in its context: the turn is untrusted too.
    if (provenance && conversationId) for (const source of this.taintOf(conversationId)) provenance = withSource(provenance, { ...source, label: `${source.label ?? source.kind} (earlier in this conversation)` });
    const entry: Active = { ...(conversationId ? { conversationId } : {}), overlapped: this.active.size > 0, ...(provenance ? { provenance: { ...provenance, turn, ...(conversationId ? { conversationId } : {}) } } : {}) };
    this.active.set(turn, entry);
    void serial(this.memoryDirectory, async () => { entry.start = await headOf(this.git).catch(() => undefined); });
  }
  /** The running turn's provenance (with the sources it has read so far), if it was given one. */
  provenance(turn: string): TurnProvenance | undefined { const p = this.active.get(turn)?.provenance; return p ? structuredClone(p) : undefined; }
  /** The running turn read untrusted content (a tool result, an attachment): recorded in its provenance. */
  noteSource(turn: string, source: ContentSource) {
    const entry = this.active.get(turn);
    if (entry?.provenance) entry.provenance = withSource(entry.provenance, source);
  }
  /** Untrusted content a conversation has read in earlier turns (see {@link beginTurn}). */
  taintOf(conversationId: string): ContentSource[] { return structuredClone(this.ledger().tainted?.[conversationId] ?? []); }
  /** A conversation continues another (a rewind's fork): it inherits what the other had read. */
  inheritTaint(from: string, to: string) {
    const ledger = this.ledger();
    const sources = ledger.tainted?.[from];
    if (!sources?.length) return;
    ledger.tainted ??= {}; ledger.tainted[to] = [...(ledger.tainted[to] ?? []), ...sources].slice(-20);
    this.save(ledger);
  }
  /** Turns running now. */
  get running(): string[] { return [...this.active.keys()]; }
  /**
   * A turn ended: commit the memory changes it left uncommitted, then record
   * which commits since it started are its own. Errors are swallowed (memory
   * attribution must never fail a turn); see {@link since}. Resolves with
   * the turn's recorded commits (for its review), if any.
   */
  async endTurn(turn: string, conversationId?: string): Promise<TurnCommits | undefined> {
    const entry = this.active.get(turn);
    this.active.delete(turn);
    if (!entry) return undefined;
    return serial(this.memoryDirectory, async () => {
      try {
        if (!this.mergeInProgress()) await this.sweep(turn, conversationId ?? entry.conversationId, entry.overlapped, entry.provenance);
        const commits = (await commitsSince(this.git, entry.start)).filter(c => !entry.start || c.commit !== entry.start);
        const ledger = this.ledger();
        if (entry.start) { ledger.starts ??= {}; ledger.starts[turn] = entry.start; const keys = Object.keys(ledger.starts); if (keys.length > 5000) for (const old of keys.slice(0, keys.length - 5000)) delete ledger.starts[old]; }
        const known = new Set(ledger.entries.map(e => e.commit));
        const at = new Date().toISOString();
        const mine: string[] = [];
        let shared = false;
        for (const commit of commits) {
          if (known.has(commit.commit) || commit.rewind) continue;
          // The agent's own commits (its one allowed command) and the end-of-turn commit; nothing else (dreaming merges, reflection).
          const own = commit.author === AGENT_EMAIL && commit.parents <= 1;
          if (!own) continue;
          const kind = entry.overlapped && commit.turn !== turn ? 'shared' : 'turn';
          if (kind === 'shared') shared = true;
          mine.push(commit.commit);
          ledger.entries.push({ commit: commit.commit, kind, turns: kind === 'shared' ? [turn, ...[...this.active.keys()]] : [turn], ...(conversationId ?? entry.conversationId ? { conversationId: conversationId ?? entry.conversationId } : {}), at, ...(entry.provenance ? { provenance: entry.provenance } : {}) });
        }
        // What the turn read stays in the conversation's context.
        const read = entry.provenance?.sources.filter(source => !/\(earlier in this conversation\)$/.test(source.label ?? '')) ?? [];
        const conversationKey = conversationId ?? entry.conversationId;
        if (read.length && conversationKey) {
          ledger.tainted ??= {};
          const known = ledger.tainted[conversationKey] ?? [];
          for (const source of read) if (!known.some(k => k.kind === source.kind && k.label === source.label)) known.push({ kind: source.kind, ...(source.label ? { label: source.label } : {}) });
          ledger.tainted[conversationKey] = known.slice(-20);
          const keys = Object.keys(ledger.tainted); if (keys.length > 2000) for (const old of keys.slice(0, keys.length - 2000)) delete ledger.tainted[old];
        }
        this.save(ledger);
        // Commits the agent made with its own command carry no trailers: attach the turn's provenance as a git note (history is never rewritten).
        if (entry.provenance) for (const commit of mine) await this.note(commit, { ...provenanceTrailers(entry.provenance), [TURN_TRAILER]: turn }).catch(() => {});
        const conversation = conversationId ?? entry.conversationId;
        return mine.length ? { turn, ...(conversation ? { conversationId: conversation } : {}), commits: mine, kind: shared ? 'shared' as const : 'turn' as const, ...(entry.provenance ? { provenance: entry.provenance } : {}) } : undefined;
      } catch { return undefined; /* never fails a turn */ }
    });
  }
  /** Attach provenance to a commit as a note (`refs/notes/provenance`), trailer-formatted; existing notes are kept. */
  private async note(commit: string, trailers: Readonly<Record<string, string | undefined>>) {
    const body = Object.entries(trailers).filter(([, value]) => value).map(([key, value]) => `${key}: ${value!.replace(/[\r\n]/g, ' ')}`).join('\n');
    if (!body) return;
    const existing = await this.git(['notes', `--ref=${PROVENANCE_NOTES}`, 'show', commit], { ok1: true }).catch(() => undefined);
    if (existing && existing.code === 0 && existing.stdout.toString().trim()) return;
    await this.git(['-c', `user.name=${this.author.replace(/[\r\n]/g, ' ')}`, '-c', `user.email=${AGENT_EMAIL}`, 'notes', `--ref=${PROVENANCE_NOTES}`, 'add', '-f', '-F', '-', commit], { input: `${body}\n` });
  }
  /** The provenance recorded for commits (the ledger), by commit. */
  recorded(): Map<string, TurnProvenance> {
    const map = new Map<string, TurnProvenance>();
    for (const entry of this.ledger().entries) if (entry.provenance) map.set(entry.commit, entry.provenance);
    return map;
  }
  /** The ledger entry of a commit, if any (which turn made it, and its provenance). */
  entryOf(commit: string): { kind: 'turn' | 'shared'; turns: string[]; conversationId?: string; provenance?: TurnProvenance } | undefined {
    const found = this.ledger().entries.find(e => e.commit === commit);
    return found ? structuredClone({ kind: found.kind, turns: found.turns, ...(found.conversationId ? { conversationId: found.conversationId } : {}), ...(found.provenance ? { provenance: found.provenance } : {}) }) : undefined;
  }
  private mergeInProgress() {
    for (const name of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      try { lstatSync(join(this.memoryDirectory, '.git', name)); return true; } catch { /* absent */ }
    }
    return false;
  }
  /** Commit uncommitted Markdown changes (the agent's), as the agent: "Agent memory changes", with the turn's provenance as trailers. */
  private async sweep(turn: string, conversationId: string | undefined, overlapped: boolean, provenance?: TurnProvenance) {
    const status = (await this.git(['status', '--porcelain', '-z', '--', '*.md'])).stdout.toString();
    if (!status.replace(/\0/g, '').trim()) return;
    await this.git(['add', '-A', '--', '*.md']);
    const staged = await this.git(['diff', '--cached', '--quiet'], { ok1: true });
    if (staged.code === 0) return;
    const message = withTrailers('Agent memory changes', { [TURN_TRAILER]: overlapped ? undefined : turn, [CONVERSATION_TRAILER]: overlapped ? undefined : conversationId, ...(provenance && !overlapped ? provenanceTrailers(provenance) : {}) });
    await this.git(['-c', `user.name=${this.author.replace(/[\r\n]/g, ' ')}`, '-c', `user.email=${AGENT_EMAIL}`, 'commit', '-q', '--no-verify', '-F', '-'], { input: `${message}\n` });
  }

  /** The commits of `turns` recorded in the ledger (only `turn` ones), and the others since `since`. */
  private async classify(turns: ReadonlySet<string>, since?: string) {
    const ledger = this.ledger();
    const byCommit = new Map(ledger.entries.map(e => [e.commit, e]));
    const targets = ledger.entries.filter(e => e.kind === 'turn' && e.turns.some(t => turns.has(t))).map(e => e.commit);
    const kept: MemoryRewindPlan['kept'] = [];
    // Commits since the first rewound turn started: from the HEAD it started at when recorded, otherwise by time.
    const startHead = [...turns].map(t => ledger.starts?.[t]).find(Boolean);
    if (since || startHead) {
      const start = since ? Date.parse(since) - 1000 : 0;
      const targetSet = new Set(targets);
      const candidates = startHead ? await commitsSince(this.git, startHead).catch(() => commitsSince(this.git, undefined)) : await commitsSince(this.git, undefined);
      for (const commit of candidates.filter(c => (startHead || Date.parse(c.date) >= start) && !targetSet.has(c.commit) && !c.rewind).slice(-200)) {
        const entry = byCommit.get(commit.commit);
        // Other turns' commits (other conversations, or turns that stay) are theirs: not listed.
        if (entry?.kind === 'turn') continue;
        if (entry?.kind === 'shared' && !entry.turns.some(t => turns.has(t))) continue;
        kept.push({ commit: commit.commit, subject: commit.subject, date: commit.date, ...(commit.author ? { author: commit.author } : {}), kind: entry?.kind === 'shared' ? 'shared' : 'background' });
      }
    }
    return { targets, kept };
  }
  /** What rewinding `turns` would revert in memory, and what it keeps (see {@link MemoryRewindPlan}). `since`: when the first rewound turn started. */
  planRewind(turns: ReadonlySet<string>, since?: string): Promise<MemoryRewindPlan> {
    return serial(this.memoryDirectory, () => this.plan(turns, since).then(({ files, commits, kept }) => ({ files, commits, kept })));
  }
  private async plan(turns: ReadonlySet<string>, since?: string) {
    const { targets, kept } = await this.classify(turns, since);
    const index = join(this.memoryDirectory, '.git', `rewind-${randomUUID()}.index`);
    try {
      const plan = await planRevert(this.git, targets, index, await this.uncommitted());
      return { ...plan, kept };
    } finally { try { unlinkSync(index); } catch { /* none */ } }
  }
  private async uncommitted(): Promise<Set<string>> {
    const out = (await this.git(['status', '--porcelain', '-z', '--untracked-files=all'])).stdout.toString().split('\0').filter(Boolean);
    return new Set(out.map(line => line.slice(3)));
  }
  /**
   * Revert the memory changes of `turns` as one new commit ("Rewind: revert
   * memory changes of later turns", trailer `X-Rewind: <rewindId>`).
   * Idempotent: a rewind whose commit is already there is not applied again.
   */
  applyRewind(rewindId: string, turns: ReadonlySet<string>, since?: string): Promise<MemoryRewindPlan & { commit?: string; applied: boolean }> {
    return serial(this.memoryDirectory, async () => {
      const done = await commitsWithTrailer(this.git, REWIND_TRAILER, new Set([rewindId]));
      if (done.length) return { files: [], commits: [], kept: [], commit: done[0]!.commit, applied: false };
      if (this.mergeInProgress()) throw new Error('memory_busy');
      const plan = await this.plan(turns, since);
      const count = plan.files.filter(file => file.status === 'revert').length;
      const message = withTrailers(`Rewind: revert memory changes of later turns (${count} file${count === 1 ? '' : 's'})`, { [REWIND_TRAILER]: rewindId });
      const commit = await this.write(plan, message, 'ai-sdk-letta rewind', REWIND_EMAIL);
      return { files: plan.files, commits: plan.commits, kept: plan.kept, ...(commit ? { commit } : {}), applied: true };
    });
  }
  /** Write a planned revert into the work tree and commit exactly those paths. Returns the new commit, or `undefined` when nothing changed. */
  private async write(plan: Pick<RevertPlan, 'changes'>, message: string, name: string, email: string): Promise<string | undefined> {
    const written: string[] = [];
    for (const change of plan.changes) {
      const parts = change.path.split('/');
      if (parts.some(part => !part || part === '.' || part === '..' || part === '.git')) continue;
      const absolute = join(this.memoryDirectory, ...parts);
      let current = this.memoryDirectory;
      let safe = true;
      for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        try { const info = lstatSync(current); if (!info.isDirectory() || info.isSymbolicLink()) { safe = false; break; } }
        catch { if (!change.entry) { safe = false; break; } mkdirSync(current, { recursive: true }); }
      }
      if (!safe) continue;
      let exists = false;
      try { const info = lstatSync(absolute); if (!info.isFile() && !info.isSymbolicLink()) continue; exists = true; } catch { /* absent */ }
      if (!change.entry) { if (exists) unlinkSync(absolute); written.push(change.path); continue; }
      const bytes = (await this.git(['cat-file', 'blob', change.entry.oid])).stdout;
      if (exists) unlinkSync(absolute);
      writeFileSync(absolute, bytes, { mode: change.entry.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
      written.push(change.path);
    }
    if (!written.length) return undefined;
    await this.git(['add', '-A', '--', ...written]);
    await this.git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--no-verify', '-F', '-', '--', ...written], { input: `${message}\n` });
    return headOf(this.git);
  }
  /**
   * Revert specific commits (a memory review's verdict, or a protected file a
   * dream changed) as one new commit made by the harness, like `git revert`
   * of each, on top of everything since. `id` names the operation
   * (`X-Reverts: <id>` trailer): applying it again changes nothing. Files
   * changed again later on the same lines, or being changed now, are kept
   * and reported as conflicts. `trailers`: more trailers (provenance).
   * `only`: revert only these paths of the commits.
   */
  revertCommits(id: string, commits: readonly string[], subject: string, trailers: Readonly<Record<string, string | undefined>> = {}, only?: ReadonlySet<string>): Promise<{ files: FilePlan[]; commit?: string; applied: boolean }> {
    return serial(this.memoryDirectory, async () => {
      const done = await commitsWithTrailer(this.git, PROVENANCE_TRAILERS.reverts, new Set([id]));
      if (done.length) return { files: [], commit: done[0]!.commit, applied: false };
      if (this.mergeInProgress()) throw new Error('memory_busy');
      const index = join(this.memoryDirectory, '.git', `review-${randomUUID()}.index`);
      try {
        const plan = await planRevert(this.git, commits, index, await this.uncommitted(), only);
        const commit = await this.write(plan, withTrailers(subject, { ...trailers, [PROVENANCE_TRAILERS.reverts]: id }), 'ai-sdk-letta memory review', REVIEW_EMAIL);
        return { files: plan.files, ...(commit ? { commit } : {}), applied: true };
      } finally { try { unlinkSync(index); } catch { /* none */ } }
    });
  }
  /**
   * Drop specific lines from memory files as one commit made by the harness
   * (a partial revert: a reviewer kept most of a change but not these lines).
   * Each drop is a line range of a file at HEAD with its exact text, and
   * must be lines `added` says the reviewed change added; anything that does
   * not apply exactly, or a file being changed right now, fails closed
   * (`applied: false`, nothing written). `id` names the operation
   * (`X-Reverts`): applying it again changes nothing.
   */
  dropLines(id: string, drops: readonly LineDrop[], added: (path: string) => ReadonlySet<string>, subject: string, trailers: Readonly<Record<string, string | undefined>> = {}): Promise<{ commit?: string; applied: boolean }> {
    return serial(this.memoryDirectory, async () => {
      const done = await commitsWithTrailer(this.git, PROVENANCE_TRAILERS.reverts, new Set([id]));
      if (done.length) return { commit: done[0]!.commit, applied: false };
      if (this.mergeInProgress() || !drops.length) return { applied: false };
      const busy = await this.uncommitted();
      const byPath = new Map<string, LineDrop[]>();
      for (const drop of drops) {
        if (drop.path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || busy.has(drop.path)) return { applied: false };
        byPath.set(drop.path, [...(byPath.get(drop.path) ?? []), drop]);
      }
      const updates = new Map<string, string>();
      for (const [path, list] of byPath) {
        const shown = await this.git(['show', `HEAD:${path}`], { ok1: true }).catch(() => undefined);
        if (!shown || shown.code !== 0) return { applied: false };
        const lines = shown.stdout.toString().split('\n');
        const fromChange = added(path);
        const remove = new Set<number>();
        for (const drop of list) {
          if (drop.end > lines.length || drop.start < 1 || drop.end < drop.start) return { applied: false };
          const range = lines.slice(drop.start - 1, drop.end);
          if (range.join('\n') !== drop.text || range.some(line => !fromChange.has(line))) return { applied: false };
          for (let line = drop.start; line <= drop.end; line++) { if (remove.has(line)) return { applied: false }; remove.add(line); }
        }
        updates.set(path, lines.filter((_, index) => !remove.has(index + 1)).join('\n'));
      }
      for (const [path, text] of updates) writeFileSync(join(this.memoryDirectory, ...path.split('/')), text);
      await this.git(['add', '--', ...updates.keys()]);
      const message = withTrailers(subject, { ...trailers, [PROVENANCE_TRAILERS.reverts]: id });
      await this.git(['-c', 'user.name=ai-sdk-letta memory review', '-c', `user.email=${REVIEW_EMAIL}`, 'commit', '-q', '--no-verify', '-F', '-', '--', ...updates.keys()], { input: `${message}\n` });
      const commit = await headOf(this.git);
      return { ...(commit ? { commit } : {}), applied: true };
    });
  }
  /** Run `task` alone on this memory repository (no turn end, rewind or review in between). */
  exclusive<T>(task: () => Promise<T>): Promise<T> { return serial(this.memoryDirectory, task); }
  /** Commit metadata (for summaries). */
  info(commits: readonly string[]) { return commitInfo(this.git, commits); }
}
