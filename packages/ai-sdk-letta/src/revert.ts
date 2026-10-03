/**
 * Precise reverts for rewind: undo what some commits (the turns being
 * rewound) changed, on top of everything that happened since, like
 * `git revert`, without touching the work tree until the result is known.
 *
 * Each commit is reverted with a three-way merge (`git merge-tree`; base: the
 * commit, ours: the result so far, theirs: its parent), newest first, only
 * for the paths that commit changed. Files moved later without changes (a
 * conversation folder renamed after its title, a move in the Resources
 * panel) are followed. A file the merge cannot revert cleanly (someone
 * changed the same lines later, or edited or deleted a file the turn
 * created) is a conflict: it is kept as it is now, and reported. Nothing is
 * rewritten: applying a plan makes one new commit.
 */

/** Runs git on one repository. `ok1`: exit code 1 is not an error. */
export type GitRunner = (args: string[], options?: { input?: string | Buffer; ok1?: boolean; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: Buffer; code: number }>;

/** A commit as shown in a rewind summary. */
export interface CommitInfo { commit: string; subject: string; date: string; author?: string }
/** What the rewound turns did to a file (over all their commits). */
export type FileChange = 'created' | 'modified' | 'deleted';
/**
 * One file of a revert plan. `revert`: it is brought back to how it was;
 * `conflict`: it is kept as it is now (`reason`: `changed_later`, a later
 * change the turns did not make overlaps; `uncommitted`, it is being changed
 * right now). `path` is where the file is now (or was, for a deleted one).
 */
export interface FilePlan { path: string; change: FileChange; status: 'revert' | 'conflict'; reason?: 'changed_later' | 'uncommitted'; by?: CommitInfo[] }
/** A planned revert: `tree` is HEAD's tree with the reverts applied; `changes` the entries to write. */
export interface RevertPlan {
  head?: string; tree: string; files: FilePlan[]; commits: CommitInfo[];
  changes: { path: string; entry?: TreeEntry }[];
}
/** A tree entry. */
export type TreeEntry = { mode: string; oid: string };

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const split0 = (text: string) => text.split('\0').map(s => s.replace(/^\n/, '')).filter(Boolean);
async function text(git: GitRunner, args: string[], options?: Parameters<GitRunner>[1]) { return (await git(args, options)).stdout.toString(); }

/** The installed git can plan reverts (`merge-tree --write-tree --merge-base` needs git 2.40 or later). */
export async function gitSupportsRevert(git: GitRunner): Promise<boolean> {
  try {
    const match = /(\d+)\.(\d+)/.exec(await text(git, ['version']));
    return !!match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 40));
  } catch { return false; }
}

/** Commit metadata, in the order given. */
export async function commitInfo(git: GitRunner, commits: readonly string[]): Promise<CommitInfo[]> {
  if (!commits.length) return [];
  const records = split0(await text(git, ['show', '-s', '-z', '--format=%H%x1f%s%x1f%cI%x1f%ae', ...commits]));
  return records.map(record => { const [commit, subject, date, author] = record.split('\x1f'); return { commit: commit!, subject: subject ?? '', date: date ?? '', ...(author ? { author } : {}) }; });
}
/** HEAD, or undefined in an empty repository. */
export async function headOf(git: GitRunner): Promise<string | undefined> {
  const { stdout, code } = await git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { ok1: true });
  const head = stdout.toString().trim();
  return code === 0 && OID.test(head) ? head : undefined;
}
async function firstParent(git: GitRunner, commit: string): Promise<string> {
  const { stdout, code } = await git(['rev-parse', '-q', '--verify', `${commit}^1`], { ok1: true });
  const parent = stdout.toString().trim();
  return code === 0 && OID.test(parent) ? parent : EMPTY_TREE;
}
/** Entries of `paths` in `tree`. */
export async function treeEntries(git: GitRunner, tree: string, paths: readonly string[]): Promise<Map<string, TreeEntry>> {
  const found = new Map<string, TreeEntry>();
  for (let i = 0; i < paths.length; i += 200) {
    for (const line of split0(await text(git, ['ls-tree', '-r', '-z', '--full-tree', tree, '--', ...paths.slice(i, i + 200)]))) {
      const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]+)\t(.+)$/s.exec(line);
      if (match) found.set(match[3]!, { mode: match[1]!, oid: match[2]! });
    }
  }
  return found;
}
/** Paths a commit changed against its first parent (no rename detection), and how. */
export async function changedBy(git: GitRunner, commit: string): Promise<Map<string, 'A' | 'M' | 'D'>> {
  const fields = split0(await text(git, ['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', await firstParent(git, commit), commit]));
  const result = new Map<string, 'A' | 'M' | 'D'>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i]!.split(' ').pop()!.charAt(0);
    result.set(fields[i + 1]!, status === 'A' ? 'A' : status === 'D' ? 'D' : 'M');
  }
  return result;
}
/** Exact renames (files moved unchanged) a commit made: from → to. */
async function renamesBy(git: GitRunner, commit: string): Promise<Map<string, string>> {
  const fields = split0(await text(git, ['diff-tree', '-r', '-z', '-M100%', '--diff-filter=R', '--no-commit-id', await firstParent(git, commit), commit]));
  const result = new Map<string, string>();
  for (let i = 0; i + 2 < fields.length; i += 3) result.set(fields[i + 1]!, fields[i + 2]!);
  return result;
}
/** Write `changes` over `tree` (no entry: remove) with a scratch index; returns the new tree. */
async function patchTree(git: GitRunner, tree: string, changes: ReadonlyMap<string, TreeEntry | undefined>, indexFile: string): Promise<string> {
  if (!changes.size) return tree;
  const env = { GIT_INDEX_FILE: indexFile };
  await git(['read-tree', tree], { env });
  const remove = [...changes].filter(([, entry]) => !entry).map(([path]) => path);
  const add = [...changes].filter((change): change is [string, TreeEntry] => !!change[1]);
  if (remove.length) await git(['update-index', '--force-remove', '-z', '--stdin'], { env, input: Buffer.from(`${remove.join('\0')}\0`) });
  if (add.length) await git(['update-index', '--add', '-z', '--index-info'], { env, input: Buffer.from(add.map(([path, entry]) => `${entry.mode} ${entry.oid}\t${path}\0`).join('')) });
  return (await text(git, ['write-tree'], { env })).trim();
}

/**
 * Plan the revert of `targets` (commits of the turns being rewound, in any
 * order) on top of HEAD. Only git objects are written (in a scratch index
 * `indexFile`, which the caller removes).
 * @param busy paths being changed right now (uncommitted): never reverted, reported as conflicts
 * @param only revert only these paths (as the commits named them); others are left as they are
 */
export async function planRevert(git: GitRunner, targets: readonly string[], indexFile: string, busy: ReadonlySet<string> = new Set(), only?: ReadonlySet<string>): Promise<RevertPlan> {
  if (targets.length && !await gitSupportsRevert(git)) throw new Error('rewind_unavailable: git 2.40 or later is needed');
  const head = await headOf(git);
  if (!head) return { tree: EMPTY_TREE, files: [], commits: [], changes: [] };
  const headTree = (await text(git, ['rev-parse', `${head}^{tree}`])).trim();
  if (!targets.length) return { head, tree: headTree, files: [], commits: [], changes: [] };
  // Newest first (as `git revert` of a range); only commits reachable from HEAD.
  const ordered = split0(await text(git, ['rev-list', '-z', '--no-walk=sorted', ...targets])).filter(Boolean);
  const reachable = new Set(split0(await text(git, ['rev-list', '-z', '--first-parent', head])));
  const targetSet = new Set(ordered.filter(c => reachable.has(c)));
  const chain = [...reachable].reverse(); // oldest first
  await git(['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' });
  let tree = headTree;
  const conflicts = new Map<string, 'changed_later' | 'uncommitted'>();
  // What happened to each file (now-path), over all the reverted commits: first and last change.
  const touched = new Map<string, { first: 'A' | 'M' | 'D'; last: 'A' | 'M' | 'D'; origin: string }>();
  const before = new Map<string, TreeEntry | undefined>();
  for (const commit of ordered.filter(c => targetSet.has(c))) {
    const changed = await changedBy(git, commit);
    if (only) for (const path of [...changed.keys()]) if (!only.has(path)) changed.delete(path);
    if (!changed.size) continue;
    // Where each of its paths is now: follow exact moves made by later commits that are not reverted.
    const later = chain.slice(chain.indexOf(commit) + 1).filter(c => !targetSet.has(c));
    const where = new Map([...changed.keys()].map(path => [path, path]));
    for (const next of later) {
      const moves = await renamesBy(git, next);
      if (!moves.size) continue;
      for (const [path, now] of where) if (moves.has(now)) where.set(path, moves.get(now)!);
    }
    // Ours, in this commit's coordinates (moved files put back where the commit left them).
    const moved = [...where].filter(([path, now]) => path !== now);
    const ours = moved.length ? await patchTree(git, tree, new Map((await (async () => {
      const current = await treeEntries(git, tree, moved.map(([, now]) => now));
      return moved.map(([path, now]) => [path, current.get(now)] as [string, TreeEntry | undefined]);
    })())), indexFile) : tree;
    const parent = await firstParent(git, commit);
    const merged = await git(['-c', 'merge.renames=false', 'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', `--merge-base=${commit}`, ours, parent], { ok1: true });
    const fields = merged.stdout.toString().split('\0');
    const result = fields[0]!.trim();
    if (!OID.test(result)) throw new Error('git merge-tree gave no result');
    const conflicted = new Set(merged.code === 1 ? fields.slice(1).filter(Boolean) : []);
    const paths = [...changed.keys()];
    const fromMerge = await treeEntries(git, result, paths);
    const nowPaths = paths.map(path => where.get(path)!);
    const current = await treeEntries(git, tree, nowPaths);
    for (const path of nowPaths) if (!before.has(path)) before.set(path, (await treeEntries(git, headTree, [path])).get(path));
    const update = new Map<string, TreeEntry | undefined>();
    for (const path of paths) {
      const now = where.get(path)!;
      const kind = changed.get(path)!;
      const seen = touched.get(now);
      touched.set(now, { first: kind, last: seen?.last ?? kind, origin: seen?.origin ?? path });
      if (busy.has(now)) { conflicts.set(now, 'uncommitted'); continue; }
      if (conflicted.has(path)) { conflicts.set(now, 'changed_later'); continue; }
      const next = fromMerge.get(path);
      const present = current.get(now);
      if (next?.oid !== present?.oid || next?.mode !== present?.mode) update.set(now, next);
    }
    tree = await patchTree(git, tree, update, indexFile);
  }
  const after = await treeEntries(git, tree, [...touched.keys()]);
  const files: FilePlan[] = [];
  const changes: RevertPlan['changes'] = [];
  const oldest = ordered.filter(c => targetSet.has(c)).at(-1)!;
  for (const [path, kinds] of [...touched].sort(([a], [b]) => a.localeCompare(b))) {
    const change: FileChange = kinds.first === 'A' ? 'created' : kinds.last === 'D' ? 'deleted' : 'modified';
    const reason = conflicts.get(path);
    const a = after.get(path), b = before.get(path);
    if (reason) {
      const by = reason === 'changed_later' ? split0(await text(git, ['log', '-z', '--format=%H', '--first-parent', `${oldest}..${head}`, '--', path])).filter(c => !targetSet.has(c)).slice(0, 3) : [];
      files.push({ path, change, status: 'conflict', reason, ...(by.length ? { by: await commitInfo(git, by) } : {}) });
    } else if (a?.oid !== b?.oid || a?.mode !== b?.mode) files.push({ path, change, status: 'revert' });
    if (a?.oid !== b?.oid || a?.mode !== b?.mode) changes.push({ path, ...(a ? { entry: a } : {}) });
  }
  return { head, tree, files, commits: await commitInfo(git, ordered.filter(c => targetSet.has(c))), changes };
}

/** Trailer naming the turn (run ID, sent as the user message's OTID) a commit belongs to. */
export const TURN_TRAILER = 'X-Turn';
/** Trailer naming the Letta conversation a commit belongs to. */
export const CONVERSATION_TRAILER = 'X-Conversation';
/** Trailer of a commit several turns' changes went into (turns of different conversations at once): their IDs. A rewind keeps it. */
export const SHARED_TRAILER = 'X-Shared-Turns';
/** Trailer of the commit a rewind made (its ID), so a retried rewind finds it. */
export const REWIND_TRAILER = 'X-Rewind';
/** A commit message with trailers (a last paragraph of `Key: value` lines). */
export function withTrailers(message: string, trailers: Readonly<Record<string, string | undefined>>): string {
  const lines = Object.entries(trailers).filter(([, value]) => value).map(([key, value]) => `${key}: ${value!.replace(/[\r\n]/g, ' ').trim()}`);
  return lines.length ? `${message.trimEnd()}\n\n${lines.join('\n')}` : message;
}
/** Commits on HEAD's first-parent chain (newest `limit`) whose `trailer` is one of `values`, newest first. */
export async function commitsWithTrailer(git: GitRunner, trailer: string, values: ReadonlySet<string>, limit = 5000): Promise<{ commit: string; value: string; date: string }[]> {
  if (!values.size || !await headOf(git)) return [];
  const records = split0(await text(git, ['log', '--first-parent', `-n${limit}`, '-z', `--format=%H%x1f%cI%x1f%(trailers:key=${trailer},valueonly,separator=%x2C)`]));
  const found: { commit: string; value: string; date: string }[] = [];
  for (const record of records) {
    const [commit, date, value] = record.split('\x1f');
    for (const v of (value ?? '').split(',').map(s => s.trim()).filter(Boolean)) if (values.has(v)) found.push({ commit: commit!, value: v, date: date ?? '' });
  }
  return found;
}
/** Commits on HEAD's first-parent chain made after `since` (exclusive), oldest first, with their trailers. */
export async function commitsSince(git: GitRunner, since: string | undefined): Promise<(CommitInfo & { turn?: string; rewind?: string; parents: number })[]> {
  if (!await headOf(git)) return [];
  const range = since ? [`${since}..HEAD`] : ['HEAD'];
  const records = split0(await text(git, ['log', '--first-parent', '--reverse', '-n5000', '-z', `--format=%H%x1f%s%x1f%cI%x1f%ae%x1f%P%x1f%(trailers:key=${TURN_TRAILER},valueonly,separator=%x2C)%x1f%(trailers:key=${REWIND_TRAILER},valueonly,separator=%x2C)`, ...range]));
  return records.map(record => {
    const [commit, subject, date, author, parents, turn, rewind] = record.split('\x1f');
    return { commit: commit!, subject: subject ?? '', date: date ?? '', ...(author ? { author } : {}), parents: (parents ?? '').split(' ').filter(Boolean).length, ...(turn?.trim() ? { turn: turn.trim() } : {}), ...(rewind?.trim() ? { rewind: rewind.trim() } : {}) };
  });
}
