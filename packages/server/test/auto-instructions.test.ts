import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTRUCTIONS_BEGIN, INSTRUCTIONS_END } from 'ai-sdk-letta';
import { AdoptionRegistry, ThreadRuntime, type AdoptionBackend, type AdoptionNotice } from '../src/index.js';

const CHESS = 'agent-local-c4e55000-9438-4173-9418-aa89a45d258d';
const ID = 'chess-c4e55000';

/** A registry over a fake backend; each runtime's `busy` can be forced (a turn running) and its end signalled. */
function fixture(dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-autoinstr-')), systems = new Map([[CHESS, 'You are chess.\n']])) {
  const lettaCode = new Set<string>();
  const writes: string[] = [];
  const backend: AdoptionBackend = {
    list: async () => [],
    agent: async id => systems.has(id) ? { id, name: 'chess', model: 'openai-codex/gpt-6', tags: ['origin:letta-code', 'git-memory-enabled'], system: systems.get(id)! } : undefined,
    conversations: async () => [],
    setSystem: async (id, system) => { writes.push(system); systems.set(id, system); },
    setModel: async () => {},
    models: async () => [],
    activity: id => lettaCode.has(id) ? { active: true, recent: true, reason: 'running' } : { active: false, recent: false },
  };
  const turns = { busy: false };
  const runtimes: ThreadRuntime[] = [];
  const build = (_definition: unknown, folder: string) => {
    mkdirSync(folder, { recursive: true });
    const runtime = new ThreadRuntime({ open: async () => { throw new Error('no session in tests'); }, close: async () => {} }, join(folder, 'state.json'), 'local-gui');
    Object.defineProperty(runtime, 'busy', { get: () => turns.busy });
    runtimes.push(runtime);
    return { runtime };
  };
  const notices: AdoptionNotice[] = [];
  const registry = new AdoptionRegistry({ stateDirectory: dir, owner: 'local-gui', reserved: { definitionIds: [] }, backend, build: build as never, instructionsPollMs: 20, onNotice: n => notices.push(n) });
  /** End the running turn: observers hear the change. */
  const endTurn = () => { turns.busy = false; for (const r of runtimes) (r as unknown as { changed(): void }).changed(); };
  return { dir, systems, registry, writes, turns, lettaCode, notices, endTurn };
}
const section = (system: string) => system.slice(system.indexOf(INSTRUCTIONS_BEGIN), system.indexOf(INSTRUCTIONS_END) + INSTRUCTIONS_END.length);
const settle = (registry: AdoptionRegistry) => registry.instructionsSettled();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('at start, an opted-in agent with an out-of-date section is updated; an identical one is left alone', async () => {
  const f = fixture();
  try {
    await f.registry.adopt({ agentId: CHESS, tools: ['files'] });
    await f.registry.applyInstructions(ID);
    const current = f.systems.get(CHESS)!;
    await f.registry.close();
    // Same text: nothing is written.
    const same = fixture(f.dir, f.systems); same.registry.start(); await settle(same.registry);
    assert.equal(same.writes.length, 0); assert.equal(same.notices.length, 0);
    await same.registry.close();
    // An older section (as written by an earlier version of the app), with user text after the markers.
    const stale = current.replace(section(current), `${INSTRUCTIONS_BEGIN}\nold section\n${INSTRUCTIONS_END}`) + '\nUser notes after.\n';
    f.systems.set(CHESS, stale);
    const restarted = fixture(f.dir, f.systems); restarted.registry.start(); await settle(restarted.registry);
    const updated = f.systems.get(CHESS)!;
    assert.equal(section(updated), section(current));
    assert.ok(updated.startsWith('You are chess.\n\n'), 'text before the markers is untouched');
    assert.ok(updated.endsWith('\nUser notes after.\n'), 'text after the markers is untouched');
    assert.equal(restarted.notices.length, 1);
    assert.equal(restarted.notices[0]!.text, 'Updated chess’s app instructions (app updated)');
    const view = await restarted.registry.instructions(ID);
    assert.equal(view.changed, false); assert.equal(view.auto?.reason, 'app updated'); assert.match(view.auto!.diff, /old section/);
    await restarted.registry.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a tools change re-applies the section, with a toast notice', async () => {
  const f = fixture();
  try {
    await f.registry.adopt({ agentId: CHESS, tools: ['files'] });
    await f.registry.applyInstructions(ID);
    assert.doesNotMatch(f.systems.get(CHESS)!, /job_start/);
    // A long poll for notices wakes with the update.
    const poll = f.registry.noticesSince(0, 5000);
    await f.registry.setTools(ID, { tools: ['files', 'jobs'] });
    await settle(f.registry);
    assert.match(f.systems.get(CHESS)!, /job_start/);
    assert.equal(f.notices.length, 1); assert.equal(f.notices[0]!.text, 'Updated chess’s app instructions (tools changed)');
    const { notices } = await poll; assert.equal(notices[0]!.reason, 'tools changed');
    await f.registry.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('an update found while a turn runs is queued and applied after the turn ends (never during it)', async () => {
  const f = fixture();
  try {
    await f.registry.adopt({ agentId: CHESS, tools: ['files'] });
    await f.registry.applyInstructions(ID);
    const current = f.systems.get(CHESS)!;
    f.systems.set(CHESS, current.replace(section(current), `${INSTRUCTIONS_BEGIN}\nold\n${INSTRUCTIONS_END}`));
    f.turns.busy = true;
    // Opening the settings page notices the difference.
    const view = await f.registry.instructions(ID);
    assert.equal(view.changed, true); assert.equal(view.queued, true);
    await sleep(100);
    assert.match(f.systems.get(CHESS)!, /\nold\n/, 'never changed during a turn');
    f.endTurn();
    await settle(f.registry);
    assert.equal(f.systems.get(CHESS), current);
    assert.equal(f.notices[0]!.reason, 'app section changed');
    await f.registry.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('it waits while Letta Code uses the agent', async () => {
  const f = fixture();
  try {
    await f.registry.adopt({ agentId: CHESS, tools: ['files'] });
    await f.registry.applyInstructions(ID);
    f.lettaCode.add(CHESS);
    await f.registry.setTools(ID, { tools: ['files', 'jobs'] }).catch(() => 0);
    await sleep(100);
    assert.doesNotMatch(f.systems.get(CHESS)!, /job_start/);
    f.lettaCode.delete(CHESS);
    await settle(f.registry);
    assert.match(f.systems.get(CHESS)!, /job_start/);
    await f.registry.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('manual Apply queues while busy instead of failing', async () => {
  const f = fixture();
  try {
    await f.registry.adopt({ agentId: CHESS, tools: ['files'] });
    f.turns.busy = true;
    assert.deepEqual(await f.registry.applyInstructions(ID), { queued: true });
    await sleep(60);
    assert.equal(f.systems.get(CHESS), 'You are chess.\n');
    f.endTurn();
    await settle(f.registry);
    assert.match(f.systems.get(CHESS)!, /ai-sdk-letta: begin/);
    assert.equal(f.notices.length, 0, 'a manual Apply is not an automatic update');
    await f.registry.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('Revert turns automatic updates off; Apply turns them back on', async () => {
  const f = fixture();
  try {
    await f.registry.adopt({ agentId: CHESS, tools: ['files'] });
    await f.registry.applyInstructions(ID);
    await f.registry.revertInstructions(ID);
    assert.equal(f.registry.store.read()[0]!.autoUpdate, false);
    await f.registry.setTools(ID, { tools: ['files', 'jobs'] }); await settle(f.registry);
    assert.equal(f.systems.get(CHESS), 'You are chess.\n', 'not managed after a revert');
    assert.equal((await f.registry.instructions(ID)).managed, false);
    await f.registry.applyInstructions(ID);
    assert.equal(f.registry.store.read()[0]!.autoUpdate, undefined);
    await f.registry.setTools(ID, { tools: ['files'] }); await settle(f.registry);
    assert.doesNotMatch(f.systems.get(CHESS)!, /job_start/, 'kept current again');
    await f.registry.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('agents never applied, and view-only agents, are not updated automatically', async () => {
  const f = fixture();
  try {
    await f.registry.adopt({ agentId: CHESS, tools: ['files'] });
    await f.registry.setTools(ID, { tools: ['files', 'jobs'] }); await settle(f.registry);
    assert.equal(f.writes.length, 0, 'not opted in');
    await f.registry.applyInstructions(ID);
    await f.registry.setViewOnly(ID, { viewOnly: true });
    const before = f.systems.get(CHESS)!;
    f.systems.set(CHESS, before.replace(section(before), `${INSTRUCTIONS_BEGIN}\nold\n${INSTRUCTIONS_END}`));
    await f.registry.close();
    const restarted = fixture(f.dir, f.systems); restarted.registry.start(); await settle(restarted.registry);
    assert.match(f.systems.get(CHESS)!, /\nold\n/, 'view only: skipped');
    // Turning View only off brings it current.
    await restarted.registry.setViewOnly(ID, { viewOnly: false }); await settle(restarted.registry);
    assert.doesNotMatch(f.systems.get(CHESS)!, /\nold\n/);
    assert.equal(restarted.notices[0]!.reason, 'view only turned off');
    await restarted.registry.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
