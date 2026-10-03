import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryJournal, memoryCommitCommand } from '../src/index.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-memory-'));
  const memory = join(root, 'memfs');
  mkdirSync(memory);
  git(memory, 'init', '-q', '-b', 'main');
  writeFileSync(join(memory, 'MEMORY.md'), '# Memory\n');
  git(memory, 'add', '-A'); git(memory, '-c', 'user.name=Letta', '-c', 'user.email=agent-local-x@letta.com', 'commit', '-qm', 'chore: initialize local memory');
  return { root, memory, journal: MemoryJournal.open(join(root, 'ledger'), 'agent-local-x', memory, 'Pal') };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('memory journal: a turn\'s uncommitted memory is committed at its end with its ID; its own commits (the one allowed command) are attributed too', async () => {
  const { root, memory, journal } = repo();
  try {
    journal.beginTurn('t1', 'conv-1'); await settle();
    writeFileSync(join(memory, 'colour.md'), 'TEAL\n');
    await journal.endTurn('t1', 'conv-1');
    assert.match(git(memory, 'log', '-n1', '--format=%B'), /^Agent memory changes\n\nX-Turn: t1\nX-Conversation: conv-1/);
    assert.equal(git(memory, 'status', '--porcelain'), '');
    // The agent commits itself with the exact command it is allowed (hooks off, fixed author), then edits again without committing.
    journal.beginTurn('t2', 'conv-1'); await settle();
    writeFileSync(join(memory, 'pet.md'), 'ZORRO\n');
    execFileSync('sh', ['-c', memoryCommitCommand(memory, 'Pal')], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    writeFileSync(join(memory, 'MEMORY.md'), '# Memory\n- pet\n');
    await journal.endTurn('t2', 'conv-1');
    const plan = await journal.planRewind(new Set(['t2']));
    assert.deepEqual(plan.files.map(f => [f.path, f.change, f.status]), [['MEMORY.md', 'modified', 'revert'], ['pet.md', 'created', 'revert']]);
    assert.equal(plan.commits.length, 2, 'the agent\'s own commit and the end-of-turn commit');
    // Dreaming (reflection) merges its work later: kept, listed as background.
    git(memory, 'checkout', '-q', '-b', 'reflection');
    writeFileSync(join(memory, 'dream.md'), 'consolidated\n');
    git(memory, 'add', '-A'); git(memory, '-c', 'user.name=Reflection Subagent', '-c', 'user.email=agent-child@letta.com', 'commit', '-qm', 'feat(reflection): consolidate 🔮');
    git(memory, 'checkout', '-q', 'main');
    git(memory, '-c', 'user.name=Pal', '-c', 'user.email=agent-local-x@letta.com', 'merge', '-q', '--no-ff', '-m', 'merge(memory): reflection', 'reflection');
    const later = await journal.planRewind(new Set(['t2']), new Date(Date.now() - 60_000).toISOString());
    assert.deepEqual(later.kept.map(c => [c.subject, c.kind]), [['merge(memory): reflection', 'background']]);
    const applied = await journal.applyRewind('rw-1', new Set(['t2']));
    assert.equal(existsSync(join(memory, 'pet.md')), false);
    assert.equal(readFileSync(join(memory, 'MEMORY.md'), 'utf8'), '# Memory\n');
    assert.equal(readFileSync(join(memory, 'dream.md'), 'utf8'), 'consolidated\n', 'dreaming stays');
    assert.equal(readFileSync(join(memory, 'colour.md'), 'utf8'), 'TEAL\n', 'the earlier turn stays');
    assert.match(git(memory, 'log', '-n1', '--format=%B'), /X-Rewind: rw-1/);
    assert.equal((await journal.applyRewind('rw-1', new Set(['t2']))).applied, false, 'idempotent');
    assert.ok(applied.commit);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('memory journal: turns of two conversations at once share their changes (kept by a rewind, reported as shared); a later edit of the same lines is a conflict', async () => {
  const { root, memory, journal } = repo();
  try {
    journal.beginTurn('a1', 'conv-a'); await settle();
    journal.beginTurn('b1', 'conv-b'); await settle();
    writeFileSync(join(memory, 'both.md'), 'mixed\n');
    await journal.endTurn('a1', 'conv-a');
    await journal.endTurn('b1', 'conv-b');
    const plan = await journal.planRewind(new Set(['a1']), new Date(Date.now() - 60_000).toISOString());
    assert.deepEqual(plan.files, []);
    assert.deepEqual(plan.kept.map(c => c.kind), ['shared']);
    // A turn writes a fact; another conversation's later turn edits the same line.
    journal.beginTurn('a2', 'conv-a'); await settle();
    writeFileSync(join(memory, 'facts.md'), 'city: Rome\n');
    await journal.endTurn('a2', 'conv-a');
    journal.beginTurn('b2', 'conv-b'); await settle();
    writeFileSync(join(memory, 'facts.md'), 'city: Rome (confirmed)\n');
    await journal.endTurn('b2', 'conv-b');
    const conflict = await journal.planRewind(new Set(['a2']));
    assert.deepEqual(conflict.files.map(f => [f.path, f.status, f.reason]), [['facts.md', 'conflict', 'changed_later']]);
    await journal.applyRewind('rw-2', new Set(['a2']));
    assert.equal(readFileSync(join(memory, 'facts.md'), 'utf8'), 'city: Rome (confirmed)\n', 'kept as it is now');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
