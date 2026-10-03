import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACHMENTS_CONTEXT, AttachmentStore, FILE_TOOL_PERMISSIONS, FileInputError, LettaAgent, RESOURCES_GITIGNORE, ResourceStore, createToolBridge, fileTools, folderNameFromTitle, titleFromFolderName, listFiles, openResources, readFile, searchFiles, splitResourcePath, statePaths,
} from '../src/index.js';
import { quarterlyReport } from './pdf-fixture.js';

const AGENT = 'agent-local-1111';
const enc = (s: string) => new TextEncoder().encode(s);
const code = (c: string) => (error: unknown) => error instanceof FileInputError && error.code === c;
const tmp = () => mkdtempSync(join(tmpdir(), 'ai-sdk-letta-resources-'));
/** git on the resources repository, as a person would run it to inspect or recover. */
const git = (store: ResourceStore, ...args: string[]) => execFileSync('git', [`--git-dir=${store.gitDir}`, `--work-tree=${store.files}`, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString();
const subjects = (store: ResourceStore) => git(store, 'log', '--format=%s').trim().split('\n');
const tracked = (store: ResourceStore) => git(store, 'ls-files').trim().split('\n').filter(Boolean).sort();

test('paths: plain visible names only, never "..", hidden names, control characters or backslashes', () => {
  assert.deepEqual(splitResourcePath('a/b c/d.txt'), ['a', 'b c', 'd.txt']);
  assert.deepEqual(splitResourcePath('/a/b/'), ['a', 'b']);
  assert.deepEqual(splitResourcePath('/', { allowRoot: true }), []);
  for (const bad of ['', '/', '..', 'a/../b', './a', 'a//b', '.git/config', 'a/.venv/x', 'a\u0000b', 'a\\b', 'x\n', 7, undefined, 'a/'.repeat(30) + 'b', 'x'.repeat(1100)]) {
    assert.throws(() => splitResourcePath(bad), code('file_name_invalid'), JSON.stringify(bad));
  }
  assert.equal(folderNameFromTitle('Q3 report: draft / v2?', 'x'), 'Q3 report - draft - v2');
  assert.equal(folderNameFromTitle('Plan my trip to Rome…', 'x'), 'Plan my trip to Rome');
  assert.equal(folderNameFromTitle('  ', 'Conversation abc'), 'Conversation abc');
  assert.equal([...folderNameFromTitle('x'.repeat(200), 'y')].length, 60);
});

test('layout: work tree, separate git history (never inside the tree), private folders, ignore rules kept outside the tree', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    await store.init();
    assert.equal(store.files, join(root, AGENT, 'files'));
    assert.ok(existsSync(join(store.gitDir, 'HEAD')), 'git directory next to the work tree');
    assert.ok(!existsSync(join(store.files, '.git')), 'nothing to rewrite from inside the work tree');
    assert.equal(readFileSync(join(store.gitDir, 'info', 'exclude'), 'utf8'), RESOURCES_GITIGNORE);
    assert.match(readFileSync(join(store.gitDir, 'config'), 'utf8'), /bare = false/);
    assert.doesNotMatch(readFileSync(join(store.gitDir, 'config'), 'utf8'), /remote|worktree/, 'no remote, no recorded work tree');
    assert.equal(ResourceStore.open(root, AGENT), store, 'one instance per folder');
    assert.throws(() => ResourceStore.open(root, '../x'), code('file_name_invalid'));
    assert.throws(() => ResourceStore.open('relative', AGENT), code('file_name_invalid'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conversation folders: named after the title, unique, with a mapping that follows moves', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    await store.init();
    assert.equal(store.ensureFolder('conv-a', 'Trip planning'), 'Trip planning');
    assert.equal(store.ensureFolder('conv-b', 'trip planning'), 'trip planning (2)', 'unique ignoring case');
    assert.equal(store.ensureFolder('conv-a', 'Another title'), 'Trip planning', 'the mapping is stable');
    assert.equal(store.ensureFolder('conv-c', 'New conversation'), 'New conversation');
    assert.equal(await store.retitle('conv-c', 'Budget review'), 'Budget review');
    assert.equal(store.folderOf('conv-c'), 'Budget review');
    // Moving a conversation folder keeps the mapping.
    await store.createFolder('', 'Archive');
    await store.move('Trip planning', 'Archive/Trip planning');
    assert.equal(store.folderOf('conv-a'), 'Archive/Trip planning');
    assert.equal(store.ensureFolder('conv-a'), 'Archive/Trip planning');
    // A folder renamed outside the app (e.g. by `mv` in the sandbox) is found again by inode.
    execFileSync('mv', [join(store.files, 'Budget review'), join(store.files, 'Budget 2026')]);
    assert.equal(store.folderOf('conv-c'), 'Budget 2026');
    // A deleted conversation folder is recreated, empty, on the next use.
    await store.delete('Archive');
    assert.equal(store.ensureFolder('conv-a'), 'Trip planning');
    const tree = store.tree();
    assert.deepEqual(tree.children.map(n => [n.name, n.conversationId]), [['Budget 2026', 'conv-c'], ['Trip planning', 'conv-a'], ['trip planning (2)', 'conv-b']]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renaming a conversation renames its folder: unique name, one commit, after a manual rename or move, deferred during a turn, chips still resolve', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    await store.init();
    const a = new AttachmentStore(store, 'conv-a', { title: 'Trip' });
    await a.save([{ name: 'plan.md', bytes: enc('# Plan\n') }]);
    store.ensureFolder('conv-b', 'Budget');
    // Follows the title, sanitized, as one commit.
    assert.equal(await store.retitle('conv-a', 'Lisbon: day trips?'), 'Lisbon - day trips');
    assert.equal(subjects(store)[0], 'Rename folder Trip → Lisbon - day trips');
    assert.deepEqual(tracked(store), ['Lisbon - day trips/plan.md']);
    assert.equal(store.folderOf('conv-a'), 'Lisbon - day trips', 'the mapping is updated');
    assert.equal(a.path, 'Lisbon - day trips', 'the conversation keeps using its folder');
    // Same title again: nothing to do, no empty commit.
    const count = subjects(store).length;
    assert.equal(await store.retitle('conv-a', 'Lisbon: day trips?'), undefined);
    assert.equal(subjects(store).length, count);
    // Unique among its siblings, ignoring case.
    assert.equal(await store.retitle('conv-a', 'budget'), 'budget (2)');
    // A case-only change of its own name is fine.
    assert.equal(await store.retitle('conv-b', 'BUDGET'), 'BUDGET');
    // The user renamed and moved the folder in the panel: a later conversation rename still renames it, where it is.
    await store.move('budget (2)', 'My trip');
    await store.createFolder('', 'Archive');
    await store.move('My trip', 'Archive/My trip');
    assert.equal(await store.retitle('conv-a', 'Porto'), 'Archive/Porto');
    // Chips of older messages still resolve to the attached file.
    assert.equal(store.locateAttachment('conv-a', 'plan.md'), 'Archive/Porto/plan.md');
    // During a turn the rename waits; it applies after the end-of-turn commit, with the newest title.
    store.beginTurn('conv-a');
    writeFileSync(join(store.files, 'Archive/Porto/out.txt'), 'made during the turn');
    assert.equal(await store.retitle('conv-a', 'Faro'), 'deferred');
    assert.equal(await store.retitle('conv-a', 'Sagres'), 'deferred');
    assert.equal(store.folderOf('conv-a'), 'Archive/Porto', 'not renamed while the turn runs');
    await store.endTurn('conv-a');
    assert.equal(store.folderOf('conv-a'), 'Archive/Sagres');
    assert.deepEqual(subjects(store).slice(0, 2), ['Rename folder Archive/Porto → Sagres', 'Agent changes in Archive/Porto']);
    assert.ok(tracked(store).includes('Archive/Sagres/out.txt'));
    assert.equal(store.locateAttachment('conv-a', 'plan.md'), 'Archive/Sagres/plan.md');
    // A deleted folder is not recreated by a rename, and the rename does not fail.
    await store.delete('Archive/Sagres');
    const before = subjects(store).length;
    assert.equal(await store.retitle('conv-a', 'Gone'), undefined);
    assert.equal(subjects(store).length, before);
    assert.ok(!existsSync(join(store.files, 'Gone')));
    assert.equal(await store.retitle('conv-unknown', 'X'), undefined, 'a conversation without a folder');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renaming a folder gives the conversation title: Markdown kept when it shows the same text, otherwise the name as written', () => {
  assert.equal(titleFromFolderName('Trip', 'Lisbon'), 'Lisbon');
  assert.equal(titleFromFolderName('[Spec](https://x) **v2**', 'Spec v2'), '[Spec](https://x) **v2**', 'the visible text is the name: Markdown kept');
  assert.equal(titleFromFolderName('**Trip**', 'trip'), 'trip', 'a different text (even only by case) is the new title');
  assert.equal(titleFromFolderName('**Trip**', 'Trip (2)'), 'Trip (2)', 'a name typed by the user is taken as written');
  assert.equal(titleFromFolderName('Notes', 'my_notes_v2'), 'my_notes_v2', 'as written, no escaping');
  assert.equal(titleFromFolderName('x', 'y'.repeat(200)).length, 120, 'at most the title limit');
  assert.equal(titleFromFolderName('Keep', '   '), 'Keep');
});

test('a conversation folder renamed by the user wins over a title rename waiting for the turn; a move without rename does not', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    await store.init();
    await new AttachmentStore(store, 'conv-a', { title: 'Trip' }).save([{ name: 'plan.md', bytes: enc('# Plan\n') }]);
    await store.createFolder('', 'Archive');
    store.beginTurn('conv-a');
    assert.equal(await store.retitle('conv-a', 'Faro'), 'deferred');
    await store.move('Trip', 'Archive/Trip');
    await store.move('Archive/Trip', 'Archive/Lisbon');
    await store.endTurn('conv-a');
    assert.equal(store.folderOf('conv-a'), 'Archive/Lisbon', 'the folder keeps the name the user gave it');
    assert.equal(subjects(store)[0], 'Rename Archive/Trip to Lisbon');
    // A plain move keeps a waiting title rename.
    store.beginTurn('conv-a');
    assert.equal(await store.retitle('conv-a', 'Sagres'), 'deferred');
    await store.move('Archive/Lisbon', 'Lisbon');
    await store.endTurn('conv-a');
    assert.equal(store.folderOf('conv-a'), 'Sagres');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every user operation is one commit with a clear message; deletion keeps history and can be restored', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    await store.init();
    const a = store.ensureFolder('conv-a', 'Alpha');
    const up = await store.upload(a, 'notes.txt', enc('hello\n'));
    assert.equal(up.path, 'Alpha/notes.txt');
    assert.match(up.commit ?? '', /^[a-f0-9]{40}$/);
    const second = await store.upload(a, 'notes.txt', enc('other\n'));
    assert.equal(second.path, 'Alpha/notes (2).txt', 'never overwrites');
    await store.createFolder(a, 'Data');
    await store.move('Alpha/notes (2).txt', 'Alpha/Data/other.txt');
    await store.move('Alpha/notes.txt', 'Alpha/hello.txt');
    const deleted = await store.delete('Alpha/Data');
    assert.deepEqual(subjects(store), ['Delete Alpha/Data', 'Rename Alpha/notes.txt to hello.txt', 'Move Alpha/notes (2).txt to Alpha/Data', 'Create folder Alpha/Data', 'Upload Alpha/notes (2).txt', 'Upload Alpha/notes.txt', 'Initialize resources']);
    assert.deepEqual(tracked(store), ['Alpha/hello.txt']);
    assert.deepEqual(await store.changed(deleted.commit!), ['Alpha/Data/.gitkeep', 'Alpha/Data/other.txt']);
    // Undo: restore what the delete removed, as it was.
    const restored = await store.restore('Alpha/Data', deleted.commit!);
    assert.equal(readFileSync(join(store.files, 'Alpha/Data/other.txt'), 'utf8'), 'other\n');
    assert.equal(subjects(store)[0], 'Restore Alpha/Data');
    assert.ok(restored.commit);
    await assert.rejects(store.restore('Alpha/Data', deleted.commit!), code('file_exists'));
    await assert.rejects(store.restore('Alpha/never', deleted.commit!), code('file_not_found'));
    // Refusals change nothing.
    const before = subjects(store).length;
    await assert.rejects(store.move('Alpha', 'Alpha/Data/Alpha'), code('file_name_invalid'));
    await assert.rejects(store.move('Alpha/hello.txt', 'Alpha/Data/other.txt'), code('file_exists'));
    await assert.rejects(store.move('Alpha/hello.txt', 'Nope/hello.txt'), code('file_not_found'));
    await assert.rejects(store.move('../x', 'y'), code('file_name_invalid'));
    await assert.rejects(store.createFolder('Alpha', 'data'), code('file_exists'), 'case-insensitive collision');
    await assert.rejects(store.delete('.git'), code('file_name_invalid'));
    await assert.rejects(store.delete(''), code('file_name_invalid'), 'the root cannot be deleted');
    assert.equal(subjects(store).length, before);
    // A case-only rename is allowed.
    await store.move('Alpha/hello.txt', 'Alpha/Hello.txt');
    assert.ok(tracked(store).includes('Alpha/Hello.txt'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('user operations commit only their own paths, leaving other uncommitted changes for the agent\'s end-of-turn commit', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    await store.init();
    const folder = store.ensureFolder('conv-a', 'Alpha');
    writeFileSync(join(store.files, folder, 'agent-made.csv'), 'a,b\n');
    await store.upload(folder, 'user.txt', enc('u'));
    assert.deepEqual(tracked(store), ['Alpha/user.txt'], 'the agent\'s file is not swept into the user\'s commit');
    const commit = await store.commitAgentChanges('conv-a');
    assert.match(commit ?? '', /^[a-f0-9]{40}$/);
    assert.equal(subjects(store)[0], 'Agent changes in Alpha');
    assert.deepEqual(tracked(store), ['Alpha/agent-made.csv', 'Alpha/user.txt']);
    assert.equal(await store.commitAgentChanges('conv-a'), undefined, 'nothing changed, no empty commit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ignored and unsafe entries are never versioned: .venv, caches, links; nested repositories are kept but sanitized', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    await store.init();
    const f = join(store.files, 'Alpha');
    mkdirSync(join(store.files, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(store.files, '.venv', 'bin', 'python'), 'x');
    mkdirSync(join(f, '__pycache__'), { recursive: true });
    writeFileSync(join(f, '__pycache__', 'm.pyc'), 'x');
    writeFileSync(join(f, 'script.py'), 'print(1)\n');
    symlinkSync('/etc/hosts', join(f, 'hosts-link'));
    // A repository the agent made in a folder: its files are versioned; its .git is not, and hostile settings are removed.
    const repo = join(f, 'project');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    writeFileSync(join(repo, 'README.md'), '# hi\n');
    writeFileSync(join(repo, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = /tmp/evil\n[alias]\n\tx = !rm -rf /\n');
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho evil\n');
    await store.commitAll('Agent changes');
    assert.deepEqual(tracked(store), ['Alpha/project/README.md', 'Alpha/script.py']);
    assert.doesNotMatch(readFileSync(join(repo, '.git', 'config'), 'utf8'), /fsmonitor|alias/);
    assert.ok(!existsSync(join(repo, '.git', 'hooks', 'pre-commit')));
    // The hidden entries do not show in the tree either.
    const names = JSON.stringify(store.tree());
    assert.doesNotMatch(names, /\.venv|__pycache__|hosts-link|\.git"/);
    assert.match(names, /script\.py/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the agent\'s own git commands cannot touch the resources history; commits it makes in its repositories are left alone', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    await store.init();
    const folder = store.ensureFolder('conv-a', 'Alpha');
    // From inside the work tree (as /workspace in the sandbox), git finds no repository for the resources.
    let found: string;
    try { found = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: join(store.files, folder), env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: store.directory }, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
    catch { found = ''; }
    assert.equal(found, '', 'no repository is reachable from inside the work tree');
    // A repository the agent makes and commits to keeps its own history.
    const repo = join(store.files, folder, 'proj');
    mkdirSync(repo);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' };
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    execFileSync('git', ['add', '.'], { cwd: repo, env });
    execFileSync('git', ['commit', '-qm', 'agent commit'], { cwd: repo, env });
    await store.commitAgentChanges('conv-a');
    assert.equal(execFileSync('git', ['log', '--format=%s'], { cwd: repo, env }).toString().trim(), 'agent commit');
    assert.ok(tracked(store).includes('Alpha/proj/a.txt'));
    // Even a repository at the top of the work tree (git init in /workspace) never replaces the resources history.
    execFileSync('git', ['init', '-q'], { cwd: store.files, env });
    writeFileSync(join(store.files, '.git', 'config'), '[core]\n\tbare = false\n\thooksPath = /tmp/evil\n');
    const before = subjects(store).length;
    writeFileSync(join(store.files, folder, 'after.txt'), 'x');
    await store.commitAgentChanges('conv-a');
    assert.equal(subjects(store).length, before + 1, 'committed to the resources repository');
    assert.ok(tracked(store).includes('Alpha/after.txt'));
    assert.doesNotMatch(readFileSync(join(store.files, '.git', 'config'), 'utf8'), /hooksPath/, 'its hostile settings are removed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the lock serializes user operations and the agent\'s commit, in this process and across processes', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    await store.init();
    const folder = store.ensureFolder('conv-a', 'Alpha');
    // Many concurrent operations: every one lands as its own commit, none is lost.
    const uploads = Array.from({ length: 12 }, (_, i) => store.upload(folder, `f${i}.txt`, enc(String(i))));
    writeFileSync(join(store.files, folder, 'agent.txt'), 'agent');
    const agent = store.commitAgentChanges('conv-a');
    const results = await Promise.all([...uploads, agent]);
    assert.equal(new Set(results.slice(0, 12).map(r => (r as { commit: string }).commit)).size, 12);
    assert.equal(subjects(store).filter(s => s.startsWith('Upload ')).length, 12);
    assert.equal(tracked(store).length, 13);
    assert.equal(git(store, 'status', '--porcelain').trim(), '', 'clean afterwards');
    // Another process holding the lock: operations wait for it.
    const lock = join(store.directory, 'resources.lock');
    writeFileSync(lock, String(process.ppid), { flag: 'wx' });
    let done = false;
    const waiting = store.upload(folder, 'late.txt', enc('late')).then(r => { done = true; return r; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(done, false, 'waits while another live process holds the lock');
    rmSync(lock);
    assert.equal((await waiting).path, 'Alpha/late.txt');
    // A lock left by a process that is gone is taken over.
    writeFileSync(lock, '999999', { flag: 'wx' });
    assert.equal((await store.upload(folder, 'after.txt', enc('x'))).path, 'Alpha/after.txt');
    assert.ok(!existsSync(lock));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a dirty tree from outside the app (app closed) is committed on open; a half-staged index never leaks', async () => {
  const root = tmp();
  try {
    const first = ResourceStore.open(root, AGENT);
    await first.init();
    writeFileSync(join(first.files, 'loose.txt'), 'x');
    // Simulate a new process: a fresh instance commits what changed meanwhile.
    const fresh = Reflect.construct(Object.getPrototypeOf(first).constructor as new (...a: unknown[]) => ResourceStore, [root, AGENT, first.limits]) as ResourceStore;
    await fresh.init();
    assert.equal(subjects(fresh)[0], 'Changes made while the app was closed');
    assert.deepEqual(tracked(fresh), ['loose.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration from per-conversation attachment folders: files move into titled folders, idempotently, with one commit; old links still resolve', async () => {
  const root = tmp();
  try {
    const paths = statePaths(root);
    // The 0.3 layout: <attachments>/<agentId>/<conversationId>/ with .meta and .text sidecars and a .venv.
    const legacy = (conversation: string, files: Record<string, string>) => {
      const dir = join(paths.attachments, AGENT, conversation);
      mkdirSync(join(dir, '.meta'), { recursive: true }); mkdirSync(join(dir, '.text'), { recursive: true }); mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(dir, name), text);
        const sha = execFileSync('shasum', ['-a', '256', join(dir, name)]).toString().split(' ')[0];
        writeFileSync(join(dir, '.meta', `${name}.json`), JSON.stringify({ name, kind: 'text', mediaType: 'text/plain', label: 'Text', bytes: Buffer.byteLength(text), sha256: sha, lines: 1, createdAt: '2026-01-02T03:04:05.000Z' }));
      }
      writeFileSync(join(dir, '.venv', 'bin', 'python'), 'x');
    };
    legacy('conv-a', { 'notes.txt': 'alpha\n', 'data.csv': 'a,b\n' });
    legacy('conv-b', { 'notes.txt': 'beta\n' });
    const store = await openResources(paths, AGENT, { 'conv-a': 'Trip planning' });
    assert.equal(store.folderOf('conv-a'), 'Trip planning');
    assert.equal(store.folderOf('conv-b'), 'Conversation b', 'no title known: named after the ID');
    assert.equal(readFileSync(join(store.files, 'Trip planning', 'notes.txt'), 'utf8'), 'alpha\n');
    assert.deepEqual(tracked(store), ['Conversation b/notes.txt', 'Trip planning/data.csv', 'Trip planning/notes.txt']);
    assert.deepEqual(subjects(store), ['Import attachments from earlier versions', 'Initialize resources']);
    assert.deepEqual(readdirSync(join(paths.attachments, AGENT)), ['.migrated'], 'old folders are kept aside, not deleted');
    // Idempotent: opening again does nothing.
    await openResources(paths, AGENT);
    assert.equal(subjects(store).length, 2);
    // Links in old messages ("Attached: notes.txt") resolve through the mapping, also after moves.
    assert.equal(store.locateAttachment('conv-a', 'notes.txt'), 'Trip planning/notes.txt');
    await store.createFolder('', 'Archive');
    await store.move('Trip planning/notes.txt', 'Archive/alpha-notes.txt');
    assert.equal(store.locateAttachment('conv-a', 'notes.txt'), 'Archive/alpha-notes.txt');
    await store.move('Trip planning', 'Archive/Trip');
    assert.equal(store.locateAttachment('conv-a', 'data.csv'), 'Archive/Trip/data.csv');
    // Moved outside the app: found by content.
    execFileSync('mv', [join(store.files, 'Archive', 'alpha-notes.txt'), join(store.files, 'Archive', 'x.txt')]);
    assert.equal(store.locateAttachment('conv-a', 'notes.txt'), 'Archive/x.txt');
    assert.equal(store.locateAttachment('conv-a', 'never.txt'), undefined);
    // An interrupted migration resumes: a new legacy folder appearing later is imported too.
    legacy('conv-c', { 'late.txt': 'gamma\n' });
    await openResources(paths, AGENT);
    assert.equal(readFileSync(join(store.files, 'Conversation c', 'late.txt'), 'utf8'), 'gamma\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('file tools: default to the conversation\'s folder, reach every conversation from "/", never escape the root', async () => {
  const root = tmp();
  const outside = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    const a = new AttachmentStore(store, 'conv-a', { title: 'Trip planning' });
    const b = new AttachmentStore(store, 'conv-b', { title: 'Budget' });
    await a.save([{ name: 'itinerary.md', bytes: enc('# Day 1\nVisit Lisbon castle\n') }]);
    await b.save([{ name: 'report.pdf', bytes: quarterlyReport() }]);
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
    let current = b;
    const bridge = createToolBridge({ tools: fileTools, permissions: FILE_TOOL_PERMISSIONS, persist: () => {}, timeoutMs: 20_000, context: () => ({ [ATTACHMENTS_CONTEXT]: current }) });
    const call = async (name: string, args: unknown) => { const r = await bridge.execute(name, `${name}-${Math.random()}`, args); return { text: r.content.map(c => c.text ?? '').join(''), isError: r.isError }; };
    assert.match((await call('list_files', {})).text, /^1 file in this conversation's folder \(\/Budget\)/);
    const all = (await call('list_files', { folder: '/' })).text;
    assert.match(all, /- \/Trip planning\/itinerary\.md \(Markdown, 2 lines/);
    assert.match(all, /- \/Budget\/report\.pdf \(PDF, 5 pages/);
    const read = await call('read_file', { name: '/Trip planning/itinerary.md' });
    assert.equal(read.isError, false);
    assert.match(read.text, /Visit Lisbon castle/);
    assert.match((await call('read_file', { name: '/workspace/Trip planning/itinerary.md' })).text, /Visit Lisbon castle/, 'the sandbox path works too');
    assert.match((await call('search_files', { query: 'lisbon', folder: '/' })).text, /\/Trip planning\/itinerary\.md, line 2/);
    assert.match((await call('search_files', { query: 'lisbon' })).text, /No passages found/, 'search stays in the conversation\'s folder by default');
    symlinkSync(outside, join(store.files, 'Escape'));
    linkSync(join(outside, 'secret.txt'), join(store.files, 'Budget', 'hard.txt'));
    for (const name of ['../Trip planning/itinerary.md', '/../../etc/passwd', '/Escape/secret.txt', 'hard.txt', '/.git/config', `${outside}/secret.txt`]) {
      const result = await call('read_file', { name });
      assert.equal(result.isError, true, name);
      assert.doesNotMatch(result.text, /TOP SECRET/, name);
    }
    assert.doesNotMatch((await call('list_files', { folder: '/' })).text, /secret|hard\.txt \(/);
    // The tools read files the agent made too (not only attachments), described by content.
    writeFileSync(join(store.files, 'Budget', 'summary.csv'), 'q,revenue\nQ3,4.2\n');
    assert.match((await readFile(b, 'summary.csv')).text, /Q3,4\.2/);
    assert.match(listFiles(b).text, /summary\.csv \(CSV, 2 lines/);
    assert.match((await searchFiles(b, 'revenue')).text, /summary\.csv, line 1/);
    current = a;
    assert.match((await call('read_file', { name: '/Budget/report.pdf', range: '3' })).text, /marketing budget for Q4 is 380,000 euros/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('the agent commits its changes at the end of each turn, even a failed one', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    const files = new AttachmentStore(store, 'conv-a', { title: 'Alpha' });
    files.path;
    await store.init();
    let fail = false;
    const agent = new LettaAgent({ id: 'r', tools: { ...fileTools }, attachments: files, afterTurn: async () => { await store.commitAgentChanges('conv-a'); }, open: () => ({
      send: async () => { writeFileSync(join(store.files, 'Alpha', 'made-by-agent.md'), '# Notes\n'); },
      // eslint-disable-next-line require-yield
      stream: async function* () { if (fail) throw new Error('boom'); yield { type: 'result', success: true } as never; },
      abort: async () => {}, close: () => {},
    }) });
    await agent.generate({ prompt: 'write notes' });
    await agent.idle();
    assert.equal(subjects(store)[0], 'Agent changes in Alpha');
    assert.ok(tracked(store).includes('Alpha/made-by-agent.md'));
    // A failed turn still commits what the agent changed.
    const second = new LettaAgent({ id: 'r2', tools: { ...fileTools }, attachments: files, afterTurn: async () => { await store.commitAgentChanges('conv-a'); }, open: () => ({
      send: async () => { writeFileSync(join(store.files, 'Alpha', 'partial.txt'), 'x'); },
      // eslint-disable-next-line require-yield
      stream: async function* () { throw new Error('boom'); },
      abort: async () => {}, close: () => {},
    }) });
    fail = true;
    await assert.rejects(second.generate({ prompt: 'try' }));
    await second.idle();
    assert.ok(tracked(store).includes('Alpha/partial.txt'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rewind attribution: end-of-turn commits carry X-Turn and X-Conversation; overlapping turns share their commit (X-Shared-Turns), which a rewind keeps', async () => {
  const root = tmp();
  try {
    const store = ResourceStore.open(root, AGENT);
    await store.init();
    const folder = store.ensureFolder('local-conv-a', 'Alpha');
    store.beginTurn('local-conv-a', 'turn-1');
    writeFileSync(join(store.files, folder, 'one.md'), 'one\n');
    await store.endTurn('local-conv-a', 'turn-1');
    assert.match(git(store, 'log', '-n1', '--format=%B'), /X-Turn: turn-1\nX-Conversation: local-conv-a/);
    // Two conversations' turns at once: one commit, both turns named, neither alone.
    store.ensureFolder('local-conv-b', 'Beta');
    store.beginTurn('local-conv-a', 'turn-2'); store.beginTurn('local-conv-b', 'turn-3');
    writeFileSync(join(store.files, folder, 'two.md'), 'two\n');
    await store.endTurn('local-conv-a', 'turn-2');
    await store.endTurn('local-conv-b', 'turn-3');
    assert.match(git(store, 'log', '-n1', '--format=%B'), /X-Shared-Turns: turn-2,turn-3/);
    const plan = await store.planRewind('local-conv-a', new Set(['turn-2']), new Date(Date.now() - 60_000).toISOString());
    assert.deepEqual(plan.files, [], 'a shared commit is not reverted');
    assert.equal(plan.kept.find(c => c.kind === 'shared')?.subject, `Agent changes in ${folder}`);
    const one = await store.planRewind('local-conv-a', new Set(['turn-1']));
    assert.deepEqual(one.files.map(f => [f.path, f.change, f.status]), [[`${folder}/one.md`, 'created', 'revert']]);
    // A rename of the folder later is followed: the file is reverted where it is now.
    await store.move(folder, 'Renamed');
    const moved = await store.planRewind('local-conv-a', new Set(['turn-1']));
    assert.deepEqual(moved.files.map(f => f.path), ['Renamed/one.md']);
    const applied = await store.applyRewind('11111111-1111-4111-8111-111111111111', 'local-conv-a', new Set(['turn-1']));
    assert.equal(existsSync(join(store.files, 'Renamed', 'one.md')), false);
    assert.equal(existsSync(join(store.files, 'Renamed', 'two.md')), true);
    assert.match(git(store, 'log', '-n1', '--format=%B'), /^Rewind: revert 1 file changed by later turns in Renamed\n\nX-Rewind: 11111111-1111-4111-8111-111111111111/);
    // Idempotent: applying the same rewind again changes nothing.
    const again = await store.applyRewind('11111111-1111-4111-8111-111111111111', 'local-conv-a', new Set(['turn-1']));
    assert.equal(again.applied, false); assert.equal(again.commit, applied.commit);
    // Rebinding moves the folder (and attachment links) to the conversation that replaced it.
    store.recordAttachments('local-conv-a', [{ name: 'two.md', path: 'Renamed/two.md', sha256: 'a'.repeat(64), bytes: 4 }]);
    store.rebind('local-conv-a', 'local-conv-c');
    assert.equal(store.folderOf('local-conv-c'), 'Renamed');
    assert.equal(store.folderOf('local-conv-a'), undefined);
    assert.equal(store.locateAttachment('local-conv-c', 'two.md'), 'Renamed/two.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
