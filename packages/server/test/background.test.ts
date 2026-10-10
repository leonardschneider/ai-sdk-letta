import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { BackgroundCommands, LettaAgent, ToolInteractions, backgroundRunId, type BackgroundRecord } from 'ai-sdk-letta';
import { BackgroundNotifier, ThreadRuntime, agentActivity, type RuntimeHost } from '../src/index.js';

/** A runtime over a scripted agent that replies "Got: <first line>"; `hold` keeps a turn running until released. */
function fixture(directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-bgsrv-'))) {
  const sent: { text: string; otid?: string }[] = [];
  let hold: Promise<void> | undefined;
  const histories = new Map<string, UIMessage[]>();
  const host: RuntimeHost = {
    async close() {},
    async open(target) {
      const conversationId = 'conversationId' in target ? target.conversationId : `conv-${randomUUID()}`;
      const history = histories.get(conversationId) ?? []; histories.set(conversationId, history);
      let input = '';
      const agent = new LettaAgent({ id: 'fixture', tools: {}, lettaAgentId: 'agent-bg', interactions: new ToolInteractions(),
        open: () => ({
          async send(message: SendMessage, options?: { otid?: string }) {
            const full = typeof message === 'string' ? message : message.map(item => item.type === 'text' ? item.text : '').join('');
            input = full.replace(/^(<system-reminder>[\s\S]*?<\/system-reminder>\n)+/, '');
            sent.push({ text: full, ...(options?.otid ? { otid: options.otid } : {}) });
            history.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: input }], metadata: { otid: options?.otid } });
          },
          async abort() {}, close() {},
          async *stream() {
            if (hold) await hold;
            const reply = `Got: ${input.split('\n')[0]!.slice(0, 80)}`;
            yield { type: 'assistant', content: reply, uuid: 'r1' } as SDKMessage;
            history.push({ id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: reply }] });
            yield { type: 'result', success: true, uuid: 'r2', durationMs: 1, conversationId } as SDKMessage;
          },
        }) });
      return { agent, agentId: 'agent-bg', conversationId, history: structuredClone(history) };
    },
  };
  const runtime = new ThreadRuntime(host, join(directory, 'state.json'), 'owner');
  return { directory, runtime, sent, setHold(p?: Promise<void>) { hold = p; } };
}
async function until(fn: () => boolean, label = 'condition', ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error(`deadline: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
/** A command record whose files are on disk, ended by writing `exit`. */
function command(commands: BackgroundCommands, root: string, conversationId: string, extra: Partial<BackgroundRecord> = {}) {
  const id = `bg-${randomUUID().slice(0, 8)}`;
  const dir = join(root, '.jobs', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'out'), 'epoch 1\nepoch 2\naccuracy 0.93\n'); writeFileSync(join(dir, 'err'), ''); writeFileSync(join(dir, 'alive'), '1');
  commands.add({ id, owner: `agent-bg.${conversationId}`, conversationId, command: 'python train.py', cwd: '/workspace', dir, limitMs: 3600_000, notify: true, ...extra });
  return { id, end: (code = 0) => writeFileSync(join(dir, 'exit'), `${code}\n`) };
}
async function opened(f: ReturnType<typeof fixture>) {
  const threadId = randomUUID();
  await f.runtime.create('owner', threadId, 'Training');
  const first = randomUUID();
  await f.runtime.start('owner', { id: first, threadId, text: 'start training', parentRunId: null });
  await until(() => f.runtime.runRecord('owner', first)?.status === 'completed', 'first turn');
  const conversationId = f.runtime.conversationsOf('owner', threadId)[0]!;
  return { threadId, conversationId };
}

test('a finished background command brings the agent one notification turn, with the reminder, shown as a background line', async () => {
  const f = fixture();
  const commands = new BackgroundCommands({ pollMs: 50 });
  try {
    const { threadId, conversationId } = await opened(f);
    const notifier = new BackgroundNotifier(f.runtime, commands, 'owner');
    const cmd = command(commands, f.directory, conversationId);
    cmd.end(0);
    const runId = backgroundRunId(cmd.id);
    await until(() => f.runtime.runRecord('owner', runId)?.status === 'completed', 'notification turn');
    const run = f.runtime.runRecord('owner', runId)!;
    assert.match(run.input, /^\[Background command finished\] `python train.py` · exit 0 · \d+ s · job bg-[a-z0-9]+ · last lines: epoch 1 ⏎ epoch 2 ⏎ accuracy 0\.93$/);
    assert.deepEqual(run.background, { jobId: cmd.id, command: 'python train.py', state: 'done', exitCode: 0 });
    const message = f.sent.at(-1)!;
    assert.match(message.text, /<system-reminder>[\s\S]*a background command you started has ended[\s\S]*report the outcome/);
    assert.equal(commands.get(cmd.id)!.notified, true);
    // Once only: a second delivery (a restart) finds the turn and sends nothing.
    const before = f.sent.length;
    await notifier.deliver(cmd.id);
    const again = new BackgroundNotifier(f.runtime, commands, 'owner'); again.resumeAll();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.sent.length, before);
    // History metadata: the app shows a compact line.
    const view = await f.runtime.view('owner', threadId);
    const user = (view as { messages: UIMessage[] }).messages.find(m => m.role === 'user' && (m.metadata as { background?: unknown } | undefined)?.background);
    assert.ok(user, 'the notification carries its background metadata');
    notifier.close(); again.close();
  } finally { commands.close(); await f.runtime.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('notify: false, and the agent\'s own stop, bring no turn', async () => {
  const f = fixture();
  const commands = new BackgroundCommands({ pollMs: 50 });
  try {
    const { conversationId } = await opened(f);
    const notifier = new BackgroundNotifier(f.runtime, commands, 'owner');
    const quiet = command(commands, f.directory, conversationId, { notify: false });
    quiet.end(3);
    await until(() => commands.get(quiet.id)!.state === 'failed', 'ended');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.runtime.runRecord('owner', backgroundRunId(quiet.id)), undefined);
    notifier.close();
  } finally { commands.close(); await f.runtime.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('the notification waits for a running turn, then follows it', async () => {
  const f = fixture();
  const commands = new BackgroundCommands({ pollMs: 50 });
  try {
    const { threadId, conversationId } = await opened(f);
    const notifier = new BackgroundNotifier(f.runtime, commands, 'owner', undefined, { pauseMs: 50 });
    let release!: () => void;
    f.setHold(new Promise<void>(resolve => { release = resolve; }));
    const busy = randomUUID();
    await f.runtime.start('owner', { id: busy, threadId, text: 'long turn', parentRunId: f.runtime.latestRun('owner', threadId)!.id });
    const cmd = command(commands, f.directory, conversationId);
    cmd.end(1);
    await until(() => commands.get(cmd.id)!.state === 'failed', 'ended');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.runtime.runRecord('owner', backgroundRunId(cmd.id)), undefined, 'not while a turn runs');
    f.setHold(undefined); release();
    await until(() => f.runtime.runRecord('owner', backgroundRunId(cmd.id))?.status === 'completed', 'sent after the turn');
    assert.equal(f.runtime.runRecord('owner', backgroundRunId(cmd.id))!.parentRunId, busy);
    notifier.close();
  } finally { commands.close(); await f.runtime.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('a person\'s Stop from the activity view: the command is stopped and the agent is told', async () => {
  const f = fixture();
  const commands = new BackgroundCommands({ pollMs: 50, staleMs: 400 });
  try {
    const { threadId, conversationId } = await opened(f);
    const notifier = new BackgroundNotifier(f.runtime, commands, 'owner');
    const cmd = command(commands, f.directory, conversationId);
    const item = agentActivity(f.runtime, 'owner').items.find(i => i.ref === cmd.id)!;
    assert.deepEqual(item.actions, ['stop-command']);
    assert.equal(item.label, '$ python train.py');
    // The sandbox (simulated) obeys the stop file by ending with 143.
    const stopping = f.runtime.stopBackgroundCommand('owner', threadId, cmd.id);
    await until(() => existsSync(join(commands.get(cmd.id)!.dir, 'stop')), 'stop file', 3000);
    cmd.end(143);
    assert.deepEqual(await stopping, { jobId: cmd.id, state: 'stopped' });
    await until(() => f.runtime.runRecord('owner', backgroundRunId(cmd.id))?.status === 'completed', 'notification');
    assert.match(f.runtime.runRecord('owner', backgroundRunId(cmd.id))!.input, /^\[Background command stopped\] `python train.py` · stopped by a person/);
    notifier.close();
  } finally { commands.close(); await f.runtime.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
