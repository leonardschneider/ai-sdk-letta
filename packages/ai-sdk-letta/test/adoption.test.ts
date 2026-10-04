import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListMessagesResult } from '@letta-ai/letta-agent-sdk';
import {
  acquireIdentity, forgetIdentity, claimsOf, defineAgent, AdoptionStore, adoptionRefusal, adoptedDefinitionId, hiddenAgent, listAdoptableAgents, lettaCodeActivity,
  adoptedInstructionsSection, withoutInstructionsSection, instructionsUpdate, projectHistory, MemoryJournal, MemoryGuard, isProtectedPath, DEFAULT_MEMORY, provenanceLabel,
  type JiminyVerdict, type MemoryReviewer,
} from '../src/index.js';

const AGENT = 'agent-local-2cc740f1-9438-4173-9418-aa89a45d258d';
const adopted = (id = 'blog-2cc740f1', agentId = AGENT) => defineAgent({ id, name: 'blog', model: 'openai/gpt-test', instructions: 'unused for adopted agents', tools: {}, adopt: { agentId } });
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: gitEnv, encoding: 'utf8' }).trim();

/* ---------------- identity: adopt by ID ---------------- */

test('adoption maps the existing agent by ID, never creates one, and keeps it across restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-adopt-'));
  let created = 0; const validated: string[] = [];
  const api = { adopt: AGENT, create: async () => { created++; return 'agent-local-new'; }, validate: async (id: string) => { validated.push(id); } };
  const lease = await acquireIdentity(directory, adopted(), '/backend', api);
  assert.equal(lease.identity.agentId, AGENT); assert.equal(lease.identity.adopted, true); assert.ok(lease.identity.adoptedAt);
  assert.equal(lease.identity.conversationId, undefined);
  lease.selectConversation('default');
  lease.release();
  const again = await acquireIdentity(directory, adopted(), '/backend', api);
  assert.equal(again.identity.agentId, AGENT); assert.equal(again.identity.conversationId, 'default');
  again.release();
  assert.equal(created, 0);
  assert.deepEqual(validated, [AGENT, AGENT]);
});

test('adoption refuses an agent another definition claims, a missing agent, and a mapping that names another agent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-adopt-'));
  const ok = { adopt: AGENT, create: async () => assert.fail('never created'), validate: async () => {} };
  (await acquireIdentity(directory, adopted('blog-a'), '/backend', ok)).release();
  assert.deepEqual(claimsOf(directory, AGENT, 'other'), ['blog-a']);
  await assert.rejects(acquireIdentity(directory, adopted('blog-b'), '/backend', ok), /agent_claimed/);
  assert.equal(existsSync(join(directory, 'blog-b.json')), false);
  await assert.rejects(acquireIdentity(directory, adopted('gone'), '/backend', { adopt: 'agent-local-missing', create: async () => assert.fail(), validate: async () => { throw new Error('agent_missing'); } }), /agent_missing/);
  assert.equal(existsSync(join(directory, 'gone.json')), false, 'nothing recorded for a missing agent');
  await assert.rejects(acquireIdentity(directory, adopted('blog-a'), '/backend', { ...ok, adopt: 'agent-local-other' }), /names another agent/);
});

test('removing an adopted agent forgets only its mapping, never while it is open', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-adopt-'));
  const lease = await acquireIdentity(directory, adopted(), '/backend', { adopt: AGENT, create: async () => assert.fail(), validate: async () => {} });
  assert.throws(() => forgetIdentity(directory, 'blog-2cc740f1'), /identity_busy/);
  lease.release();
  assert.equal(forgetIdentity(directory, 'blog-2cc740f1'), true);
  assert.equal(forgetIdentity(directory, 'blog-2cc740f1'), false);
});

test('defineAgent validates adopt', () => {
  assert.equal(adopted().adopt?.agentId, AGENT);
  assert.throws(() => adopted('x', '../etc'), /adopt.agentId/);
});

/* ---------------- picker ---------------- */

test('the picker lists adoptable local agents with model, activity and conversation count; hidden, subagents and temporary agents are excluded', async () => {
  const agents = [
    { id: AGENT, name: 'blog', tags: ['origin:letta-code', 'git-memory-enabled'], model: 'openai-codex/gpt-6', last_run_completion: '2026-09-06T00:00:00Z' },
    { id: 'agent-local-general', name: 'general', tags: ['origin:letta-code', 'git-memory-enabled'], llm_config: { handle: 'openai-codex/gpt-6-astra' } },
    { id: 'agent-local-sub', name: 'Letta Code', tags: ['origin:letta-code', 'role:subagent', 'parent:agent-local-general'] },
    { id: 'agent-local-reflect', name: 'Reflection Subagent', tags: [] },
    { id: 'agent-local-jiminy', name: 'Jiminy', tags: ['ai-sdk-letta:jiminy'] },
    { id: 'agent-local-hidden', name: 'secret', tags: ['git-memory-enabled'], hidden: true },
    { id: 'agent-local-plain', name: 'no memfs', tags: ['origin:letta-code'] },
  ];
  const conversations: Record<string, unknown[]> = {
    [AGENT]: [{ id: 'local-conv-11', agent_id: AGENT, last_message_at: '2026-09-06T01:00:00Z', archived: false }],
    'agent-local-general': [{ id: 'c1', agent_id: 'agent-local-general', last_message_at: '2026-10-03T01:00:00Z' }, { id: 'c2', agent_id: 'agent-local-general', archived: true }],
  };
  const rows = await listAdoptableAgents({ agents: { list: async () => agents as never }, conversations: { list: async ({ agentId }) => (conversations[agentId] ?? []) as never } }, [{ agentId: AGENT, definitionId: 'blog-2cc740f1' }]);
  assert.deepEqual(rows.map(r => r.name), ['general', 'blog', 'no memfs']);
  assert.deepEqual(rows[0], { agentId: 'agent-local-general', name: 'general', model: 'openai-codex/gpt-6-astra', conversations: 2, lastActivity: '2026-10-03T01:00:00Z' });
  assert.equal(rows[1]!.adoptedAs, 'blog-2cc740f1'); assert.equal(rows[1]!.conversations, 2); assert.equal(rows[1]!.model, 'openai-codex/gpt-6');
  assert.equal(rows[2]!.refusal, 'agent_without_memfs');
  assert.equal(hiddenAgent({ name: 'Web summarizer', tags: [] } as never), false);
  assert.equal(adoptionRefusal(undefined), 'agent_missing');
  assert.equal(adoptedDefinitionId({ id: AGENT, name: 'blog' }), 'blog-2cc740f1');
  assert.equal(adoptedDefinitionId({ id: 'agent-local-6b1f3273-c7bc', name: 'epsilon-cone-local' }), 'epsilon-cone-local-6b1f3273');
});

test('adoption records persist, refuse duplicates, and removing one keeps the others', () => {
  const store = new AdoptionStore(join(mkdtempSync(join(tmpdir(), 'ai-sdk-letta-adopt-')), 'adopted.json'));
  const record = { definitionId: 'blog-2cc740f1', agentId: AGENT, name: 'blog', model: 'm/x', tools: ['files' as const], adoptedAt: new Date().toISOString() };
  store.add(record);
  assert.throws(() => store.add({ ...record, definitionId: 'other' }), /agent_claimed/);
  assert.throws(() => store.add({ ...record, agentId: 'agent-local-x' }, {}), /agent_claimed/);
  assert.throws(() => store.add({ ...record, definitionId: 'example', agentId: 'agent-local-y' }, { definitionIds: ['example'] }), /agent_claimed/);
  store.add({ ...record, definitionId: 'general-1', agentId: 'agent-local-general' });
  assert.deepEqual(new AdoptionStore(store.file).read().map(r => r.definitionId), ['blog-2cc740f1', 'general-1']);
  assert.equal(store.remove('blog-2cc740f1'), true);
  assert.deepEqual(store.read().map(r => r.definitionId), ['general-1']);
  assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).version, 1);
});

/* ---------------- Letta Code activity ---------------- */

test('a running Letta Code session of the agent blocks; recent memory commits only warn', () => {
  const backend = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-backend-'));
  const conversation = join(backend, 'conversations', Buffer.from('conversation:local-conv-11').toString('base64url'));
  mkdirSync(conversation, { recursive: true });
  writeFileSync(join(conversation, 'conversation.json'), JSON.stringify({ id: 'local-conv-11', agent_id: AGENT, last_message_at: '2026-09-06T00:00:00Z' }));
  const idle = lettaCodeActivity(AGENT, { backendDirectory: backend, processes: ['node /x/letta.js --backend local server --listen ws://127.0.0.1:0', 'node letta.js --conv local-conv-99'] });
  assert.deepEqual([idle.active, idle.recent], [false, false]);
  assert.equal(lettaCodeActivity(AGENT, { backendDirectory: backend, processes: ['node /x/letta.js --permission-mode=x --backend local --conv local-conv-11'] }).active, true);
  assert.equal(lettaCodeActivity(AGENT, { backendDirectory: backend, processes: [`letta --agent ${AGENT}`] }).active, true);
  const memory = join(backend, 'memfs', AGENT, 'memory');
  mkdirSync(memory, { recursive: true });
  git(memory, 'init', '-q'); writeFileSync(join(memory, 'a.md'), 'x\n'); git(memory, 'add', '-A'); git(memory, '-c', 'user.name=blog', '-c', 'user.email=b@letta.com', 'commit', '-qm', 'x');
  const recent = lettaCodeActivity(AGENT, { backendDirectory: backend, processes: [] });
  assert.deepEqual([recent.active, recent.recent], [false, true]);
  assert.equal(lettaCodeActivity(AGENT, { backendDirectory: backend, processes: [], now: Date.now() + 3_600_000 }).recent, false);
});

/* ---------------- instructions ---------------- */

test('the instructions update appends one section, shows a diff, and can be reverted exactly', () => {
  const system = 'You are blog.\nBe concise.\n';
  const section = adoptedInstructionsSection(['read_file', 'web_search'], 'Memory policy.');
  const update = instructionsUpdate(system, section);
  assert.ok(update.changed);
  assert.ok(update.next.startsWith(system.trimEnd()));
  assert.match(update.diff, /\+ ## In the ai-sdk-letta app/);
  assert.doesNotMatch(update.diff, /^- /m);
  assert.equal(withoutInstructionsSection(update.next).trimEnd(), system.trimEnd());
  // Updating again replaces the section, never adds a second one.
  const again = instructionsUpdate(update.next, adoptedInstructionsSection(['read_file'], 'Memory policy.'));
  assert.equal(again.next.split('ai-sdk-letta: begin').length, 2);
  assert.equal(instructionsUpdate(update.next, section).changed, false);
});

/* ---------------- history ---------------- */

test('Letta Code tool calls project as inert generic tool parts for adopted agents; nothing crashes on odd records', () => {
  const rows = [
    { id: 'u', message_type: 'user_message', content: 'please check', date: '2026-09-06T00:00:00Z' },
    { id: 'c1', message_type: 'approval_request_message', tool_call: { tool_call_id: 'call-1', name: 'Bash', arguments: '{"command":"ls"}' } },
    { id: 'r1', message_type: 'tool_return_message', tool_call_id: 'call-1', status: 'success', tool_return: 'x'.repeat(5000) },
    { id: 'c2', message_type: 'tool_call_message', tool_call: { tool_call_id: 'call-2', name: 'Agent', arguments: 'not json' } },
    { id: 'r2', message_type: 'tool_return_message', tool_call_id: 'call-2', status: 'error', tool_return: { weird: true } },
    { id: 'c3', message_type: 'tool_call_message', tool_call: { tool_call_id: 'call-3', name: 'Read', arguments: '{}' } },
    { id: 's', message_type: 'summary_message', content: 'compacted' },
    { id: 'a', message_type: 'assistant_message', content: [{ type: 'text', text: 'Done.' }] },
  ] as unknown as ListMessagesResult['messages'];
  assert.deepEqual(projectHistory(rows, []).map(m => m.parts[0]!.type), ['text', 'text'], 'apps without foreignTools are unchanged');
  const shown = projectHistory(rows, [], undefined, { foreignTools: true });
  assert.deepEqual(shown.map(m => m.parts[0]!.type), ['text', 'dynamic-tool', 'dynamic-tool', 'text']);
  const bash = shown[1]!.parts[0] as { toolName: string; input: unknown; output: string; state: string };
  assert.equal(bash.toolName, 'Bash'); assert.deepEqual(bash.input, { command: 'ls' }); assert.equal(bash.state, 'output-available');
  assert.ok(bash.output.length < 2100 && bash.output.endsWith('[truncated]'));
  const agent = shown[2]!.parts[0] as { toolName: string; input: unknown; state: string };
  assert.equal(agent.toolName, 'Agent'); assert.deepEqual(agent.input, {}); assert.equal(agent.state, 'output-error');
});

/* ---------------- memory governance ---------------- */

test('the default protected files cover the older layout (system/**, system/persona.md)', () => {
  for (const path of ['system/persona.md', 'system/human/identity.md', 'SYSTEM/Persona.md', 'persona.md']) assert.ok(isProtectedPath(path, DEFAULT_MEMORY.protected), path);
  assert.equal(isProtectedPath('blog/publishing.md', DEFAULT_MEMORY.protected), false);
});

function memoryRepo(agentId: string) {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-adopt-memory-'));
  const memory = join(root, 'memory');
  mkdirSync(join(memory, 'system'), { recursive: true });
  mkdirSync(join(memory, 'blog'));
  writeFileSync(join(memory, 'system', 'persona.md'), '---\nname: persona\n---\nI help Leo write.\n');
  writeFileSync(join(memory, 'blog', 'publishing.md'), '# Publishing\n');
  git(memory, 'init', '-q', '-b', 'main'); git(memory, 'add', '-A');
  execFileSync('git', ['-C', memory, '-c', 'user.name=blog', '-c', `user.email=${agentId}@letta.com`, 'commit', '-qm', 'chore: initialize local memory'], { env: { ...gitEnv, GIT_AUTHOR_DATE: '2026-09-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T00:00:00Z' } });
  const journal = MemoryJournal.open(join(root, 'ledger'), agentId, memory, 'blog');
  return { root, memory, journal };
}

test('the end-of-turn commit takes only files the turn changed, never edits that were uncommitted before it', async () => {
  const { memory, journal } = memoryRepo('agent-local-scoped-1');
  writeFileSync(join(memory, 'blog', 'publishing.md'), '# Publishing\n- left uncommitted by Letta Code\n');
  writeFileSync(join(memory, 'blog', 'draft.md'), 'untracked before the turn\n');
  journal.beginTurn('turn-1', 'conv-1'); await journal.exclusive(async () => {});
  writeFileSync(join(memory, 'blog', 'rendering.md'), '# Rendering\n');
  const recorded = await journal.endTurn('turn-1', 'conv-1');
  assert.equal(recorded?.commits.length, 1);
  assert.deepEqual(git(memory, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['blog/rendering.md']);
  assert.match(git(memory, 'status', '--porcelain'), /^M blog\/publishing.md/m);
  assert.match(git(memory, 'status', '--porcelain'), /\?\? blog\/draft.md/);
  // A file that was dirty before but the turn changed again is the turn's.
  journal.beginTurn('turn-2', 'conv-1'); await journal.exclusive(async () => {});
  writeFileSync(join(memory, 'blog', 'publishing.md'), '# Publishing\n- left uncommitted by Letta Code\n- and the turn\n');
  await journal.endTurn('turn-2', 'conv-1');
  assert.deepEqual(git(memory, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['blog/publishing.md']);
  assert.match(git(memory, 'status', '--porcelain'), /\?\? blog\/draft.md/);
});

test('Letta Code commits of an adopted agent are shown as from Letta Code and never reverted, even on protected files; Jiminy only flags', async () => {
  const agentId = 'agent-local-lettacode-1';
  const { root, memory, journal } = memoryRepo(agentId);
  const asked: unknown[] = [];
  const reviewer: MemoryReviewer = async request => { asked.push(request); return { trust: 0.1, verdict: 'reject', alters_directives: true, reason: 'changes persona', evidence: [] } as JiminyVerdict; };
  const guard = MemoryGuard.open({ journal, reviewer, adopted: { email: `${agentId}@letta.com`, since: new Date(Date.now() - 1000).toISOString() }, file: join(root, 'reviews.json') });
  await guard.check();
  writeFileSync(join(memory, 'system', 'persona.md'), '---\nname: persona\n---\nI help Leo write, and run tests.\n');
  git(memory, 'add', '-A'); git(memory, '-c', 'user.name=blog', '-c', `user.email=${agentId}@letta.com`, 'commit', '-qm', 'Record testing preference');
  const head = git(memory, 'rev-parse', 'HEAD');
  await guard.check(); await guard.idle();
  assert.equal(git(memory, 'rev-parse', 'HEAD'), head, 'nothing reverted');
  const [review] = guard.list();
  assert.equal(review!.provenance.writer, 'letta-code');
  assert.equal(review!.verdict, 'flag'); assert.equal(review!.outcome, 'kept');
  assert.equal(provenanceLabel(review!.provenance), 'From Letta Code');
  assert.equal(asked.length, 1);
  const sections = (await guard.provenanceOf('system/persona.md')).sections;
  assert.deepEqual([...new Set(sections.map(s => s.by))].sort(), ['Before adoption', 'From Letta Code']);
  // Another author (not the agent's identity, not a turn) on a protected file is still reverted.
  writeFileSync(join(memory, 'system', 'persona.md'), 'tampered\n');
  git(memory, 'add', '-A'); git(memory, '-c', 'user.name=x', '-c', 'user.email=someone@else', 'commit', '-qm', 'tamper');
  await guard.check(); await guard.idle();
  assert.match(readFileSync(join(memory, 'system', 'persona.md'), 'utf8'), /run tests/);
  guard.close();
});
