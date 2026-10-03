import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import { tool, jsonSchema, type UIMessage } from 'ai';
import { AttachmentStore, LettaAgent, MemoryJournal, ResourceStore, ToolInteractions, createToolBridge, decisionTools, DECISIONS_CONTEXT, DECISION_TOOL_PERMISSIONS, type ConversationRewind, type HistoryRecord } from 'ai-sdk-letta';
import { AutomationService, AutomationStore, createToken, DecisionBoard, ThreadRuntime, forkPoint, guiApp, rewoundSpan, soloRefusal, externalEffects, type AutomationAgent, type Orchestrator, type Run, type RunAuthor, type RuntimeHost } from '../src/index.js';

/* ------------------------------------------------------------------ */
/* Fixture: a scripted agent over real resources and a real memory repo */
/* ------------------------------------------------------------------ */

const AGENT = 'agent-local-rewind';
/** The agent's tools: the decision tools, and a stand-in for the sandbox's internet command (its result is scripted). */
const tools = { ...decisionTools, run_command_online: tool({ inputSchema: jsonSchema<{ command: string }>({ type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }), execute: async () => ({ exitCode: 0 }) }) };
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
type Record_ = HistoryRecord & { conversationId: string };

/**
 * A runtime whose agent follows scripts in the message: `write <path> <text>`
 * writes a file in its conversation's folder (`/<path>`: from the root),
 * `remember <file> <text>` writes a memory file (left uncommitted, as the
 * real agent often does), `decide` asks for a decision, `schedule` schedules
 * a task, `online` runs a command with internet access, `hold` waits until
 * released. Any message gets a reply.
 */
function fixture(options: { team?: boolean; directory?: string; failFork?: () => boolean; failAfterSwitch?: () => boolean } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'ai-sdk-letta-rewind-'));
  const root = join(directory, 'resources');
  const memoryDir = join(directory, 'memfs');
  if (!existsSync(join(memoryDir, '.git'))) {
    mkdirSync(memoryDir, { recursive: true });
    git(memoryDir, 'init', '-q', '-b', 'main');
    writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory\n');
    git(memoryDir, 'add', '-A'); git(memoryDir, '-c', 'user.name=Letta', '-c', 'user.email=agent-local-rewind@letta.com', 'commit', '-qm', 'chore: initialize local memory');
  }
  const journal = MemoryJournal.open(join(directory, 'memory'), AGENT, memoryDir, 'Rewinder');
  const histories = new Map<string, Record_[]>();
  const archived = new Set<string>();
  const forks: { from: string; at: string | null; id: string }[] = [];
  const holds = new Map<string, () => void>();
  let runtime: ThreadRuntime | undefined;
  let conversations = 0;
  let settling = 0;
  const opened: ({ conversationId: string } | { newTitle: string })[] = [];
  const display = (records: Record_[]): UIMessage[] => records.filter(r => r.type === 'user_message' || r.type === 'assistant_message').map(r => ({ id: r.id, role: r.type === 'user_message' ? 'user' : 'assistant', parts: [{ type: 'text', text: r.text ?? '' }], metadata: { ...(r.otid ? { otid: r.otid } : {}) } }));
  const host: RuntimeHost = {
    ...(options.team ? { parallel: true } : {}),
    attachmentsRoot: root,
    resources: async () => { const store = ResourceStore.open(root, AGENT); await store.init(); return store; },
    async close() {},
    async open(target) {
      opened.push(structuredClone(target));
      const conversationId = 'conversationId' in target ? target.conversationId : `local-conv-${++conversations}-${randomUUID().slice(0, 8)}`;
      if (!histories.has(conversationId)) histories.set(conversationId, []);
      const store = ResourceStore.open(root, AGENT);
      await store.init();
      const folder = new AttachmentStore(store, conversationId, { title: 'title' in target ? (target as { newTitle: string }).newTitle : 'Rewind' });
      let input = '';
      let otid: string | undefined;
      let paused = false;
      const bridge = createToolBridge({ tools: decisionTools, permissions: DECISION_TOOL_PERMISSIONS, interactions: new ToolInteractions(), paused: () => paused,
        context: () => runtime?.decisions ? { [DECISIONS_CONTEXT]: { desk: runtime.decisions.desk, conversationId, requested: () => { paused = true; } } } : {} });
      const turnIds = new WeakMap<object, string>();
      const agent = new LettaAgent({ id: 'fixture', tools, lettaAgentId: AGENT, interactions: new ToolInteractions(), ...(options.team ? { listening: true, name: 'Rewinder' } : {}),
        beforeTurn: turn => { const id = turn.otid ?? randomUUID(); turnIds.set(turn, id); store.beginTurn(conversationId); journal.beginTurn(id, conversationId); },
        afterTurn: async turn => { settling++; try { await Promise.all([store.endTurn(conversationId, turn.otid), journal.endTurn(turnIds.get(turn)!, conversationId)]); } finally { settling--; } },
        open: () => { paused = false; return {
          async send(message: SendMessage, sendOptions?: { otid?: string }) {
            input = (typeof message === 'string' ? message : message.map(item => item.type === 'text' ? item.text : '').join('')).replace(/^(<system-reminder>[\s\S]*?<\/system-reminder>\n)+/, '');
            otid = sendOptions?.otid;
            histories.get(conversationId)!.push({ id: `msg-${randomUUID()}`, type: 'user_message', conversationId, text: input, ...(otid ? { otid } : {}), date: new Date().toISOString() });
          },
          async abort() {}, close() {},
          async *stream() {
            const history = histories.get(conversationId)!;
            const call = async function* (name: string, args: Record<string, unknown>, run?: () => Promise<string>) {
              const id = `call-${randomUUID()}`;
              yield { type: 'tool_call', toolCallId: id, toolName: name, toolInput: args, uuid: `${id}-a` } as SDKMessage;
              const content = run ? await run() : (await bridge.execute(name, id, args)).content[0]!.text!;
              history.push({ id: `msg-${randomUUID()}`, type: 'tool_call_message', conversationId, tool: { name, arguments: args } });
              yield { type: 'tool_result', toolCallId: id, content, uuid: `${id}-b` } as SDKMessage;
            };
            for (const line of input.split('\n')) {
              const [verb, path, ...rest] = line.trim().split(' ');
              if (verb === 'write') {
                const target = path!.startsWith('/') ? join(store.files, path!.slice(1)) : join(folder.directory, path!);
                mkdirSync(join(target, '..'), { recursive: true });
                writeFileSync(target, `${rest.join(' ')}\n`);
              } else if (verb === 'remember') {
                writeFileSync(join(memoryDir, path!), `${rest.join(' ')}\n`);
              } else if (verb === 'decide') {
                yield* call('request_decision', { question: 'Which format?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
              } else if (verb === 'online') {
                yield* call('run_command_online', { command: 'pip install requests' }, async () => '{"exitCode":0}');
              } else if (verb === 'hold') {
                await new Promise<void>(resolve => holds.set(conversationId, resolve));
              }
            }
            const reply = `Done: ${input.slice(0, 40)}`;
            history.push({ id: `msg-${randomUUID()}`, type: 'assistant_message', conversationId, text: reply });
            yield { type: 'assistant', content: reply, uuid: 'r1' } as SDKMessage;
            yield { type: 'result', success: true, uuid: 'r2', durationMs: 1, conversationId } as SDKMessage;
          },
        }; } });
      const rewind: ConversationRewind = {
        memory: journal,
        records: async () => ({ records: structuredClone(histories.get(conversationId)!), truncated: false }),
        fork: async (messageId, onCreated) => {
          if (options.failFork?.()) throw new Error('backend down');
          const source = histories.get(conversationId)!;
          const end = messageId === null ? 0 : source.findIndex(r => r.id === messageId) + 1;
          if (messageId !== null && end === 0) throw new Error('Message not found');
          const id = `local-conv-${++conversations}-${randomUUID().slice(0, 8)}`;
          histories.set(id, source.slice(0, end).map(r => ({ ...r, conversationId: id })));
          forks.push({ from: conversationId, at: messageId, id });
          onCreated?.(id);
          if (options.failAfterSwitch?.()) throw new Error('hydration failed');
          return id;
        },
        archive: async id => { if (id === 'default') return false; archived.add(id); return true; },
      };
      return { agent, agentId: AGENT, conversationId, history: display(histories.get(conversationId)!), rewind,
        ...(options.team ? { reload: async () => display(histories.get(conversationId)!), close: async () => { agent.close(); } } : {}) };
    },
  };
  const owner = options.team ? 'team' : 'owner';
  runtime = options.team
    ? new ThreadRuntime(host, join(directory, 'state.json'), owner, { queue: true, parallel: true, members: () => 2 })
    : new ThreadRuntime(host, join(directory, 'state.json'), owner);
  const board = new DecisionBoard(join(directory, 'decisions.json'), runtime, owner, { id: 'rewinder', name: 'Rewinder' });
  const rt = runtime;
  const store = () => ResourceStore.open(root, AGENT);
  return { opened, settled: () => until(() => settling === 0, 'end of turn'), directory, runtime: rt, board, owner, histories, archived, forks, journal, memoryDir, store, holds,
    async turn(threadId: string, text: string, author?: RunAuthor) {
      const id = randomUUID();
      await rt.start(owner, { id, threadId, text, parentRunId: rt.latestRun(owner, threadId)?.id ?? null }, author);
      await until(() => ['completed', 'failed', 'cancelled'].includes(rt.runRecord(owner, id)?.status ?? ''), `turn ${text}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      await until(() => settling === 0, 'end of turn');
      return id;
    },
    async thread(title = 'Trip', author?: RunAuthor) { const id = randomUUID(); await rt.create(owner, id, title, author); return id; },
    conversation: (threadId: string) => rt.conversationOf(owner, threadId)!,
    cleanup: async () => { await until(() => !rt.list(owner).some(t => rt.activeRun(t.id)) && settling === 0).catch(() => {}); await new Promise(resolve => setTimeout(resolve, 30)); await rt.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean | Promise<boolean>, label = 'condition') {
  for (let i = 0; i < 1000; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Fixture deadline: ${label}`);
}
const rewindInput = (runId: string, text: string) => ({ rewindId: randomUUID(), runId, text, newRunId: randomUUID() });
const read = (store: ResourceStore, path: string) => { try { return readFileSync(join(store.files, path), 'utf8'); } catch { return undefined; } };

/* ------------------------------------------------------------------ */
/* Pure parts                                                          */
/* ------------------------------------------------------------------ */

const run = (id: string, extra: Partial<Run> = {}): Run => ({ id, threadId: 't', input: id, parentRunId: null, status: 'completed', events: [], tagged: true, ...extra });
const ana: RunAuthor = { id: 'u-ana', login: 'ana@example.com', name: 'Ana' };
const ben: RunAuthor = { id: 'u-ben', login: 'ben@example.com', name: 'Ben' };

test('rewoundSpan: the edited turn and every later one; a message sent with others belongs to its combined turn', () => {
  const runs = [run('a'), run('b', { batch: ['b', 'c'] }), run('c', { batchOf: 'b' }), run('d')];
  assert.deepEqual(rewoundSpan(runs, 'b').map(r => r.id), ['b', 'c', 'd']);
  assert.deepEqual(rewoundSpan(runs, 'c').map(r => r.id), ['b', 'c', 'd']);
  assert.deepEqual(rewoundSpan(runs, 'a').map(r => r.id), ['a', 'b', 'c', 'd']);
  assert.throws(() => rewoundSpan(runs, 'x'));
});

test('soloRefusal: only your own ordinary message, in a conversation only you wrote in, with no automation after it, all turns finished and recorded', () => {
  // Single-user: no authors.
  assert.equal(soloRefusal([run('a'), run('b')], [run('b')], undefined, false), undefined);
  assert.equal(soloRefusal([run('a')], [run('a', { tagged: false })], undefined, false), 'rewind_too_old');
  assert.equal(soloRefusal([run('a')], [run('a', { status: 'failed' })], undefined, false), 'delivery_uncertain');
  assert.equal(soloRefusal([run('a')], [run('a', { decision: { id: 'd', outcome: 'decided', question: 'q', by: { id: 'u', name: 'U' } } })], undefined, false), 'rewind_not_editable');
  const auto = run('s', { source: { kind: 'schedule', via: 'n8n', tokenId: 'x', name: 'Scheduled task' } });
  assert.equal(soloRefusal([run('a'), auto], [run('a'), auto], undefined, false), 'rewind_automation');
  assert.equal(soloRefusal([auto], [auto], undefined, false), 'rewind_not_editable');
  // Team: every message is Ana's.
  const mine = [run('a', { author: ana }), run('b', { author: ana })];
  assert.equal(soloRefusal(mine, mine.slice(1), ana, true), undefined);
  assert.equal(soloRefusal(mine, mine.slice(1), ben, true), 'rewind_not_editable');
  const group = [...mine, run('c', { author: ben })];
  assert.equal(soloRefusal(group, group.slice(1), ana, true), 'rewind_not_solo', 'Ben wrote here: a group conversation');
  // A message of Ben's that was withdrawn before sending does not count.
  assert.equal(soloRefusal([...mine, run('w', { author: ben, notSent: true, status: 'cancelled' })], mine.slice(1), ana, true), undefined);
});

test('forkPoint: the record just before the edited message (its reminders belong to it); the first message forks an empty conversation', () => {
  const records: HistoryRecord[] = [
    { id: 'm1', type: 'user_message', otid: 'r1', text: 'hi' }, { id: 'm2', type: 'assistant_message', text: 'hello' },
    { id: 'm3', type: 'user_message' }, { id: 'm4', type: 'user_message', otid: 'r2', text: 'next' }, { id: 'm5', type: 'assistant_message', text: 'ok' },
  ];
  assert.deepEqual(forkPoint(records, 'r2'), { messageId: 'm2', index: 3 });
  assert.deepEqual(forkPoint(records, 'r1'), { messageId: null, index: 0 });
  assert.throws(() => forkPoint(records, 'r3'), /rewind_too_old/);
});

test('externalEffects: internet commands, Atlassian writes, sandbox commands and other app tools are listed; reads and app-internal tools are not', () => {
  const events = (calls: [string, unknown][]) => calls.flatMap(([name, input], i) => [{ sequence: i * 2 + 1, type: 'tool_started', data: { toolCallId: `c${i}`, name, input } }, { sequence: i * 2 + 2, type: 'tool_completed', data: { toolCallId: `c${i}`, name } }]);
  const effects = externalEffects([run('a', { events: events([['run_command_online', { command: 'pip install x' }], ['atlassian_request', { method: 'GET', path: '/rest/api/3/issue/X-1' }], ['atlassian_request', { method: 'POST', path: '/rest/api/3/issue/X-1/comment' }], ['read_file', { name: 'a' }], ['atlassian_update', { file: 'X-1.md' }], ['run_command', { command: 'ls' }], ['deploy', {}]]) })]);
  assert.deepEqual(effects.map(e => e.tool), ['run_command_online', 'atlassian_request', 'atlassian_update', 'run_command', 'deploy']);
  assert.equal(effects[1]!.label, 'Atlassian POST request');
  // A call that never completed (denied, failed) changed nothing.
  assert.deepEqual(externalEffects([run('b', { events: [{ sequence: 1, type: 'tool_started', data: { toolCallId: 'x', name: 'run_command_online', input: {} } }, { sequence: 2, type: 'tool_failed', data: { toolCallId: 'x', name: 'run_command_online' } }] })]), []);
});

/* ------------------------------------------------------------------ */
/* Rewind end to end (scripted agent, real git)                         */
/* ------------------------------------------------------------------ */

test('rewind: the preview lists the turns, files and memory changes; the rewind forks before the edited message, reverts them, archives the old conversation and sends the edited message', async () => {
  const f = fixture();
  try {
    const threadId = await f.thread();
    const first = await f.turn(threadId, 'write plan.md day one\nremember colour.md TEAL');
    const second = await f.turn(threadId, 'write plan.md day one and two\nwrite notes.md draft\nremember pet.md ZORRO');
    const third = await f.turn(threadId, 'write notes.md final\nremember MEMORY.md # Memory with pet');
    const store = f.store();
    const folder = store.folderOf(f.conversation(threadId))!;
    assert.equal(read(store, `${folder}/notes.md`), 'final\n');
    // Every turn's changes are committed with its run ID; memory left uncommitted is committed at the end of the turn.
    assert.match(git(f.memoryDir, 'log', '--format=%B', '-n1'), new RegExp(`X-Turn: ${third}`));
    assert.equal(git(f.memoryDir, 'status', '--porcelain'), '');

    const preview = await f.runtime.rewindPreview(f.owner, threadId, second);
    assert.deepEqual(preview.turns.map(t => t.runId), [second, third]);
    assert.equal(preview.message.input, 'write plan.md day one and two\nwrite notes.md draft\nremember pet.md ZORRO');
    assert.deepEqual(preview.resources!.files.map(file => [file.path, file.change, file.status]), [[`${folder}/notes.md`, 'created', 'revert'], [`${folder}/plan.md`, 'modified', 'revert']]);
    assert.deepEqual(preview.memory!.files.map(file => [file.path, file.change, file.status]), [['MEMORY.md', 'modified', 'revert'], ['pet.md', 'created', 'revert']]);
    assert.deepEqual(preview.external, []);
    // Nothing changed.
    assert.equal(read(store, `${folder}/notes.md`), 'final\n');
    const before = f.conversation(threadId);

    const input = rewindInput(second, 'write plan.md day one and three');
    const result = await f.runtime.rewind(f.owner, threadId, input);
    assert.equal(result.rewind.stage, 'done');
    assert.equal(result.run?.id, input.newRunId);
    const after = f.conversation(threadId);
    assert.notEqual(after, before, 'the thread now uses the forked conversation');
    assert.ok(f.archived.has(before), 'the old conversation is archived, kept for audit');
    // The fork holds exactly the history before the edited message.
    const firstReply = f.histories.get(before)!.findIndex(r => r.otid === second) - 1;
    assert.equal(f.forks[0]!.at, f.histories.get(before)![firstReply]!.id);
    await until(() => f.runtime.runRecord(f.owner, input.newRunId)?.status === 'completed', 'edited turn');
    await new Promise(resolve => setTimeout(resolve, 30));
    const fork = f.histories.get(after)!;
    assert.deepEqual(fork.filter(r => r.type === 'user_message').map(r => r.otid), [first, input.newRunId]);
    // Files: notes.md (created by turn 2) is gone, plan.md is back to turn 1's, then the edited turn wrote its own.
    assert.equal(read(store, `${store.folderOf(after)}/notes.md`), undefined);
    assert.equal(read(store, `${store.folderOf(after)}/plan.md`), 'day one and three\n');
    assert.equal(store.folderOf(after), folder, 'the folder follows the thread');
    // Memory: the rewound fact is gone; turn 1's stays.
    assert.equal(existsSync(join(f.memoryDir, 'pet.md')), false);
    assert.equal(readFileSync(join(f.memoryDir, 'MEMORY.md'), 'utf8'), '# Memory\n');
    assert.equal(readFileSync(join(f.memoryDir, 'colour.md'), 'utf8'), 'TEAL\n');
    // History is never rewritten: reverts are new commits.
    assert.match(git(f.memoryDir, 'log', '--format=%s'), /Rewind: revert memory changes of later turns \(2 files\)/);
    assert.ok((await store.log(20)).some(c => /^Rewind: revert 2 files changed by later turns/.test(c.message)));
    // The conversation shows the edited message, not the rewound turns.
    const history = await f.runtime.history(f.owner, threadId);
    assert.deepEqual(history.messages.filter(m => m.role === 'user').map(m => (m.parts[0] as { text: string }).text), ['write plan.md day one\nremember colour.md TEAL', 'write plan.md day one and three']);
    assert.equal(history.lastRunId, input.newRunId);
    // The same request again: the same result, nothing applied or sent twice.
    const again = await f.runtime.rewind(f.owner, threadId, input);
    assert.equal(again.rewind.id, input.rewindId); assert.equal(f.forks.length, 1);
    assert.equal((await store.log(50)).filter(c => c.message.startsWith('Rewind:')).length, 1);
    await assert.rejects(f.runtime.rewind(f.owner, threadId, { ...input, text: 'other' }), /id_conflict/);
  } finally { await f.cleanup(); }
});

test('rewind: a file another conversation changed later is kept and reported as a conflict, with who changed it; the rest is reverted', async () => {
  const f = fixture();
  try {
    const threadId = await f.thread('Trip');
    await f.turn(threadId, 'write /Shared/budget.md total 100');
    const second = await f.turn(threadId, 'write /Shared/budget.md total 150\nwrite ideas.md museums');
    const other = await f.thread('Other');
    await f.turn(other, 'write /Shared/budget.md total 150 plus taxes');
    const preview = await f.runtime.rewindPreview(f.owner, threadId, second);
    const budget = preview.resources!.files.find(file => file.path === 'Shared/budget.md')!;
    assert.equal(budget.status, 'conflict'); assert.equal(budget.reason, 'changed_later');
    assert.match(budget.by![0]!.subject, /Agent changes in Other/);
    assert.ok(preview.resources!.kept.some(c => /Agent changes in Other/.test(c.subject)), 'the other conversation\'s commit is listed as kept');
    await f.runtime.rewind(f.owner, threadId, rewindInput(second, 'write ideas.md food'));
    const store = f.store();
    assert.equal(read(store, 'Shared/budget.md'), 'total 150 plus taxes\n', 'the other conversation\'s change stays');
    assert.equal(read(store, `${store.folderOf(f.conversation(threadId))}/ideas.md`), undefined);
  } finally { await f.cleanup(); }
});

test('rewind: a later change to other lines of the same file is kept, and the rewound turn\'s lines are reverted (a clean three-way revert)', async () => {
  const f = fixture();
  try {
    const threadId = await f.thread('Trip');
    await f.turn(threadId, 'write /Shared/list.md placeholder');
    const store = f.store();
    writeFileSync(join(store.files, 'Shared/list.md'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    await store.commitAll('Upload Shared/list.md');
    // The turn to rewind changes line 2 (the scripted agent writes whole files, so the edit is made directly in its turn's commit).
    const second = await f.turn(threadId, 'hello');
    writeFileSync(join(store.files, 'Shared/list.md'), 'one\nTWO\nthree\nfour\nfive\nsix\nseven\n');
    await store.commitAgentChanges(f.conversation(threadId), second);
    // Another conversation changes line 6 later.
    writeFileSync(join(store.files, 'Shared/list.md'), 'one\nTWO\nthree\nfour\nfive\nSIX\nseven\n');
    await store.commitAgentChanges('local-conv-other', 'another-turn');
    const preview = await f.runtime.rewindPreview(f.owner, threadId, second);
    assert.deepEqual(preview.resources!.files.map(file => [file.path, file.status]), [['Shared/list.md', 'revert']]);
    await f.runtime.rewind(f.owner, threadId, rewindInput(second, 'hi'));
    assert.equal(read(store, 'Shared/list.md'), 'one\ntwo\nthree\nfour\nfive\nSIX\nseven\n');
  } finally { await f.cleanup(); }
});

test('rewind: your own changes in the Resources panel during the rewound span are kept and listed; dreaming commits are kept with a warning', async () => {
  const f = fixture();
  try {
    const threadId = await f.thread();
    await f.turn(threadId, 'write a.md one');
    const second = await f.turn(threadId, 'write b.md two\nremember fact.md X');
    const store = f.store();
    const folder = store.folderOf(f.conversation(threadId))!;
    // You upload a file in the panel; dreaming merges into memory.
    await store.upload(folder, 'mine.txt', new TextEncoder().encode('my notes'));
    writeFileSync(join(f.memoryDir, 'dream.md'), 'consolidated\n');
    git(f.memoryDir, 'add', '-A'); git(f.memoryDir, '-c', 'user.name=Reflection Subagent', '-c', 'user.email=agent-child@letta.com', 'commit', '-qm', 'feat(reflection): consolidate 🔮');
    const preview = await f.runtime.rewindPreview(f.owner, threadId, second);
    assert.deepEqual(preview.resources!.files.map(file => file.path), [`${folder}/b.md`]);
    assert.ok(preview.resources!.kept.some(c => c.subject === `Upload ${folder}/mine.txt`), 'your upload is listed as kept');
    assert.deepEqual(preview.memory!.files.map(file => file.path), ['fact.md']);
    assert.deepEqual(preview.memory!.kept.map(c => [c.subject, c.kind]), [['feat(reflection): consolidate 🔮', 'background']]);
    await f.runtime.rewind(f.owner, threadId, rewindInput(second, 'write c.md three'));
    assert.equal(read(store, `${folder}/mine.txt`), 'my notes');
    assert.equal(read(store, `${folder}/b.md`), undefined);
    assert.equal(readFileSync(join(f.memoryDir, 'dream.md'), 'utf8'), 'consolidated\n');
    assert.equal(existsSync(join(f.memoryDir, 'fact.md')), false);
  } finally { await f.cleanup(); }
});

test('rewind withdraws the decisions the rewound turns asked for and lists side effects that stay; earlier ones are untouched', async () => {
  const f = fixture();
  try {
    const threadId = await f.thread();
    const first = await f.turn(threadId, 'hello');
    const second = await f.turn(threadId, 'online\ndecide');
    const [pending] = f.board.pending();
    assert.equal(pending!.runId, second);
    const preview = await f.runtime.rewindPreview(f.owner, threadId, second);
    assert.deepEqual(preview.cancel.decisions.map(d => d.id), [pending!.id]);
    assert.deepEqual(preview.external.map(e => [e.tool, e.detail]), [['run_command_online', 'pip install requests']]);
    const result = await f.runtime.rewind(f.owner, threadId, rewindInput(second, 'something else'));
    assert.deepEqual(result.rewind.result!.decisions, [pending!.id]);
    const record = f.board.find(pending!.id)!;
    assert.equal(record.status, 'cancelled'); assert.equal(record.cancelReason, 'rewound');
    assert.equal(f.board.pending().length, 0);
    void first;
  } finally { await f.cleanup(); }
});

test('rewind cancels the tasks the rewound turns scheduled (their orchestrator jobs removed); tasks that already ran are listed as side effects', async () => {
  const f = fixture();
  try {
    const deleted: string[] = [];
    const orchestrator: Orchestrator = { kind: 'n8n', async createJob(job) { return { externalId: `wf-${job.id}` }; }, async deleteJob(handle) { deleted.push(handle.externalId); } };
    const agent: AutomationAgent = { id: 'rewinder', name: 'Rewinder', runtime: f.runtime, owner: f.owner, store: new AutomationStore(join(f.directory, 'automation.json')), preApprovable: [], replyModes: false };
    const service = new AutomationService({ agents: [agent], scheduler: { orchestrator, callbackUrl: 'http://127.0.0.1:1' } });
    f.runtime.rewindHooks = { schedules: ids => service.schedulesOf(agent, ids), cancelSchedules: ids => service.cancelSchedulesOf(agent, ids) };
    const threadId = await f.thread();
    await f.turn(threadId, 'hello');
    // The agent schedules during the second turn.
    const second = randomUUID();
    await f.runtime.start(f.owner, { id: second, threadId, text: 'hold', parentRunId: f.runtime.latestRun(f.owner, threadId)!.id });
    await until(() => f.holds.has(f.conversation(threadId)), 'held');
    const task = await service.schedulerFor('rewinder')!.schedule({ at: new Date(Date.now() + 3_600_000).toISOString(), prompt: 'Remind me', conversation: 'current' }, { conversationId: f.conversation(threadId) });
    // While it runs, a rewind is refused.
    await assert.rejects(f.runtime.rewindPreview(f.owner, threadId, second), /runtime_busy/);
    f.holds.get(f.conversation(threadId))!();
    await until(() => f.runtime.runRecord(f.owner, second)?.status === 'completed');
    await new Promise(resolve => setTimeout(resolve, 20));
    const preview = await f.runtime.rewindPreview(f.owner, threadId, second);
    assert.deepEqual(preview.cancel.schedules.map(s => s.id), [task.id]);
    const result = await f.runtime.rewind(f.owner, threadId, rewindInput(second, 'never mind'));
    assert.deepEqual(result.rewind.result!.schedules, [task.id]);
    assert.deepEqual(deleted, [`wf-${task.id}`]);
    assert.equal(agent.store.read().schedules[0]!.state, 'cancelled');
    service.close();
  } finally { await f.cleanup(); }
});

test('rewind is refused while a turn runs or waits, in a group conversation, for someone else\'s message, and after an automation\'s turn', async () => {
  const f = fixture({ team: true });
  try {
    const threadId = await f.thread('Group', ana);
    const mine = await f.turn(threadId, 'hello', ana);
    await f.turn(threadId, 'second', ana);
    // Solo so far: Ana can rewind; Ben cannot edit her message.
    assert.ok((await f.runtime.rewindPreview(f.owner, threadId, mine, ana)).turns.length === 2);
    await assert.rejects(f.runtime.rewindPreview(f.owner, threadId, mine, ben), /rewind_not_editable/);
    assert.deepEqual(f.runtime.editable(f.owner, threadId, ana).runIds.length, 2);
    // Ben writes: now a group conversation.
    await f.turn(threadId, 'my turn', ben);
    await assert.rejects(f.runtime.rewindPreview(f.owner, threadId, mine, ana), /rewind_not_solo/);
    await assert.rejects(f.runtime.rewind(f.owner, threadId, rewindInput(mine, 'x'), ana), /rewind_not_solo/);
    assert.deepEqual(f.runtime.editable(f.owner, threadId, ana), { runIds: [], refusal: 'rewind_not_solo' });
    // Busy: a turn is running.
    const solo = await f.thread('Solo', ana);
    const a = await f.turn(solo, 'one', ana);
    const held = randomUUID();
    await f.runtime.start(f.owner, { id: held, threadId: solo, text: 'hold', parentRunId: a }, ana);
    await until(() => f.holds.has(f.conversation(solo)));
    await assert.rejects(f.runtime.rewindPreview(f.owner, solo, a, ana), /runtime_busy/);
    await assert.rejects(f.runtime.rewind(f.owner, solo, rewindInput(a, 'x'), ana), /runtime_busy/);
    f.holds.get(f.conversation(solo))!();
    await until(() => f.runtime.runRecord(f.owner, held)?.status === 'completed');
  } finally { await f.cleanup(); }
});

test('rewind is crash-safe: a failure before the fork changes nothing; a crash after the switch is finished on restart; the thread always points at a conversation', async () => {
  // 1. The fork fails: the thread and everything else stay as they were; the same request can be retried.
  let fail = true;
  const f = fixture({ failFork: () => fail });
  const directory = f.directory;
  let threadId: string, second: string, input: ReturnType<typeof rewindInput>;
  try {
    threadId = await f.thread();
    await f.turn(threadId, 'write a.md one');
    second = await f.turn(threadId, 'write b.md two\nremember x.md X');
    const before = f.conversation(threadId);
    input = rewindInput(second, 'write c.md three');
    await assert.rejects(f.runtime.rewind(f.owner, threadId, input), /rewind_failed/);
    assert.equal(f.conversation(threadId), before);
    assert.equal(f.runtime.rewinds(f.owner, threadId)[0]!.stage, 'failed');
    assert.ok(existsSync(join(f.memoryDir, 'x.md')));
    fail = false;
    const retried = await f.runtime.rewind(f.owner, threadId, input);
    assert.equal(retried.rewind.stage, 'done');
    assert.equal(existsSync(join(f.memoryDir, 'x.md')), false);
    await until(() => f.runtime.runRecord(f.owner, input.newRunId)?.status === 'completed', 'edited turn');
    await f.settled();
  } finally { await f.runtime.close(); }

  // 2. A crash after the switch (simulated: the state says "switched", the reverts did not run).
  const g = fixture({ directory });
  try {
    const thread2 = await g.thread('Second');
    await g.turn(thread2, 'write d.md four');
    const later = await g.turn(thread2, 'write e.md five\nremember y.md Y');
    // Fork and switch, then "crash" before the reverts.
    const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
    const from = g.conversation(thread2);
    const rec = g.histories.get(from)!;
    const at = rec[rec.findIndex(r => r.otid === later) - 1]!.id;
    const forked = `local-conv-crash`;
    g.histories.set(forked, rec.slice(0, rec.findIndex(r => r.id === at) + 1));
    const intentId = randomUUID();
    const thread = state.threads.find((t: { id: string }) => t.id === thread2);
    thread.previousConversations = [from]; thread.conversationId = forked;
    for (const r of state.runs) if (r.id === later) r.rewound = intentId;
    state.rewinds = [...(state.rewinds ?? []), { id: intentId, threadId: thread2, runId: later, text: 'write f.md six', newRunId: randomUUID(), from, fork: forked, forkAt: at, turns: [later], since: state.runs.find((r: { id: string }) => r.id === later).startedAt, stage: 'switched', createdAt: new Date().toISOString() }];
    await g.runtime.close();
    writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
    const h = fixture({ directory });
    try {
      h.histories.set(forked, g.histories.get(forked)!); h.histories.set(from, g.histories.get(from)!);
      await h.runtime.resumeRewinds(h.owner);
      const intent = h.runtime.rewinds(h.owner, thread2).find(r => r.id === intentId)!;
      assert.equal(intent.stage, 'done');
      assert.equal(h.conversation(thread2), forked);
      assert.equal(existsSync(join(h.memoryDir, 'y.md')), false, 'memory reverted on restart');
      const store = h.store();
      assert.equal(read(store, `${store.folderOf(forked) ?? store.folderOf(from)}/e.md`), undefined, 'resources reverted on restart');
      assert.ok(h.archived.has(from));
      // Running it again changes nothing (idempotent through the X-Rewind trailers).
      const commits = git(h.memoryDir, 'rev-list', '--count', 'HEAD');
      await h.runtime.resumeRewinds(h.owner);
      assert.equal(git(h.memoryDir, 'rev-list', '--count', 'HEAD'), commits);
    } finally { await h.cleanup(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP: preview and rewind routes (CSRF, fixed error codes); capabilities announce rewind', async () => {
  const f = fixture();
  const assets = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-assets-'));
  writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const server = guiApp(f.runtime, f.owner, 0, assets, { id: 'rewinder', name: 'Rewinder' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const threadId = await f.thread();
    await f.turn(threadId, 'write a.md one');
    const second = await f.turn(threadId, 'write b.md two');
    const session = await fetch(`${base}/api/session`, { headers: { host: `127.0.0.1:${port}` } });
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf } = await session.json() as { csrf: string };
    const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: base, 'x-csrf-token': csrf, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await (await call('/v1/capabilities')).json() as { rewind: boolean }).rewind, true);
    const editable = await (await call(`/v1/threads/${threadId}/rewind`)).json() as { runIds: string[] };
    assert.equal(editable.runIds.length, 2);
    const preview = await call(`/v1/threads/${threadId}/rewind/preview`, { runId: second });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json() as { turns: unknown[] }).turns.length, 1);
    assert.equal((await call(`/v1/threads/${threadId}/rewind/preview`, { runId: second }, { 'x-csrf-token': 'nope' })).status, 403);
    assert.equal((await call(`/v1/threads/${threadId}/rewind/preview`, { runId: randomUUID() })).status, 404);
    assert.equal((await call(`/v1/threads/${threadId}/rewind`, { runId: second, text: 'x' })).status, 400);
    const done = await call(`/v1/threads/${threadId}/rewind`, rewindInput(second, 'write b.md TWO'));
    assert.equal(done.status, 200);
    assert.equal((await done.json() as { rewind: { stage: string } }).rewind.stage, 'done');
  } finally { server.close(); rmSync(assets, { recursive: true, force: true }); await f.cleanup(); }
});

test('legacy conversations (the agent\'s default Letta conversation) cannot be rewound: no editable messages, and preview and rewind refuse with rewind_legacy_conversation', async () => {
  const f = fixture();
  const directory = f.directory;
  try {
    const threadId = await f.thread('Legacy');
    await f.turn(threadId, 'hello');
    const second = await f.turn(threadId, 'write a.md one');
    await f.runtime.close();
    // A thread of an earlier version: its conversation is the agent's default one (same history, same runs).
    const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
    const thread = state.threads.find((t: { id: string }) => t.id === threadId);
    const history = f.histories.get(thread.conversationId)!;
    thread.conversationId = 'default';
    writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
    const g = fixture({ directory });
    try {
      g.histories.set('default', history);
      assert.deepEqual(g.runtime.editable(g.owner, threadId), { runIds: [], refusal: 'rewind_legacy_conversation' });
      await assert.rejects(g.runtime.rewindPreview(g.owner, threadId, second), (error: Error & { code?: string }) => error.message === 'rewind_legacy_conversation');
      await assert.rejects(g.runtime.rewind(g.owner, threadId, rewindInput(second, 'x')), /rewind_legacy_conversation/);
      assert.equal(g.forks.length, 0, 'nothing was forked');
      assert.equal(g.conversation(threadId), 'default', 'the thread keeps its conversation');
      // It still works as a conversation.
      await g.turn(threadId, 'still here');
      assert.equal(g.histories.get('default')!.filter(r => r.type === 'user_message').length, 3);
    } finally { await g.runtime.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('new conversations are always named: the GUI\'s threads and automation runs open with a new title, never the default conversation', async () => {
  const f = fixture();
  try {
    const threadId = await f.thread('Fresh');
    assert.match(f.conversation(threadId), /^local-conv-/);
    assert.ok(f.opened.every(target => !('conversationId' in target) || target.conversationId !== 'default'));
    assert.ok(f.opened.some(target => 'newTitle' in target && target.newTitle === 'Fresh'));
    const agent: AutomationAgent = { id: 'rewinder', name: 'Rewinder', runtime: f.runtime, owner: f.owner, store: new AutomationStore(join(f.directory, 'automation.json')), preApprovable: [], replyModes: false };
    const service = new AutomationService({ agents: [agent] });
    const { token } = createToken(agent.store, { name: 'Nightly', via: 'n8n', preApproved: [] }, { actor: { id: 'local', name: 'You' }, createdBy: { id: 'local', name: 'You' }, preApprovable: [] });
    const run = service.startRun(agent, agent.store.read().tokens.find(t => t.id === token.id)!, { text: 'hello', idempotencyKey: 'k1', newConversation: true, title: 'From n8n' });
    await until(() => !!service.runById(agent, run.id).threadId && f.runtime.runRecord(f.owner, run.id) !== undefined, 'automation run');
    const created = service.runById(agent, run.id).threadId!;
    assert.match(f.conversation(created), /^local-conv-/);
    assert.ok(f.opened.some(target => 'newTitle' in target && target.newTitle === 'From n8n'));
    assert.ok(f.opened.every(target => !('conversationId' in target) || target.conversationId !== 'default'));
    await until(() => ['completed', 'failed'].includes(f.runtime.runRecord(f.owner, run.id)?.status ?? ''), 'automation run done');
    await f.settled();
    service.close();
  } finally { await f.cleanup(); }
});
