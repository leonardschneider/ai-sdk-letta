import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Experimental_SandboxSession } from 'ai';
import {
  BackgroundCommands, BACKGROUND_MARK, KILL_SCRIPT, JOBS_CONTEXT, SANDBOX_CONTEXT, SandboxManager, backgroundNotice, backgroundRunId, backgroundScript, resolveSandboxConfig, sandboxTools,
  type BackgroundRecord, type JobDesk, type JobEndRequest, type JobUpdateRequest, type SandboxFactory,
} from '../src/index.js';

const HOST_BIN = ['/opt/homebrew/bin', '/opt/homebrew/opt/coreutils/libexec/gnubin'].filter(existsSync).map(p => `${p}:`).join('');
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `ai-sdk-letta-${prefix}-`));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 10_000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out waiting'); await wait(50); } }

/** A sandbox over the host's /bin/sh with `/workspace` mapped to `dir` (the sandbox's own process sweep never runs on the host). */
function hostFactory(dir: string, log: string[] = []): { factory: SandboxFactory; stops: () => number } {
  let stops = 0;
  const run = async ({ command: script, abortSignal }: { command: string; abortSignal?: AbortSignal }) => {
    // GNU timeout may live elsewhere on the host (Homebrew on macOS).
    const command = script.split(KILL_SCRIPT).join('true').split('/workspace').join(dir).split('PATH=/usr/local/sbin:').join(`PATH=${HOST_BIN}/usr/local/sbin:`);
    assert.ok(!command.includes('kill -9 "$n"'), 'never the sandbox sweep on the host');
    log.push(command);
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], { signal: abortSignal, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
      child.on('error', reject);
      child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  };
  const session = { description: 'host', run, spawn: async () => { throw new Error('no'); }, readFile: async () => null, readBinaryFile: async () => null, readTextFile: async () => null, writeFile: async () => {}, writeBinaryFile: async () => {}, writeTextFile: async () => {} } as unknown as Experimental_SandboxSession;
  return { factory: async () => ({ session, stop: async () => { stops++; } }), stops: () => stops };
}

function setup(options: { idleTimeoutMs?: number; backgroundTimeoutMs?: number; file?: string } = {}) {
  const dir = tmp('bg');
  const host = hostFactory(dir);
  const commands = new BackgroundCommands({ pollMs: 100, staleMs: 3000, ...(options.file ? { file: options.file } : {}) });
  const manager = new SandboxManager(resolveSandboxConfig({ provider: host.factory, idleTimeoutMs: options.idleTimeoutMs ?? 1000, ...(options.backgroundTimeoutMs ? { backgroundTimeoutMs: options.backgroundTimeoutMs } : {}) }), { workspace: () => dir, owner: 'agent.conv', background: { commands, conversationId: 'conv' } });
  const context = { [SANDBOX_CONTEXT]: manager };
  const call = async <T>(name: keyof typeof sandboxTools, input: T, extra: Record<string, unknown> = {}) => await (sandboxTools[name].execute as unknown as (input: T, options: unknown) => Promise<{ text: string; isError?: boolean; jobId?: string }>)(input, { toolCallId: `call-${Math.random()}`, messages: [], context: { ...context, ...extra } });
  return { dir, host, commands, manager, call, done: async () => { await manager.close(); commands.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('the sandbox sweep spares marked background processes (dash reads the whole environment as one line)', async () => {
  assert.match(KILL_SCRIPT, new RegExp(`\\*${BACKGROUND_MARK}\\*\\) continue`));
  const shell = existsSync('/bin/dash') ? '/bin/dash' : undefined;
  if (!shell) return;
  // A fake /proc: 1 (init), 10 (a leftover), 11 (a background command), 12 (marked further down its environment).
  const root = tmp('proc');
  try {
    const proc = (pid: number, env: string[]) => { mkdirSync(join(root, String(pid))); writeFileSync(join(root, String(pid), 'status'), `Name:\tx\nPPid:\t1\n`); writeFileSync(join(root, String(pid), 'environ'), env.map(e => `${e}\0`).join('')); };
    proc(1, ['A=1']); proc(10, ['PATH=/bin', 'HOME=/x']); proc(11, [BACKGROUND_MARK, 'PATH=/bin']); proc(12, ['PATH=/bin', BACKGROUND_MARK]);
    const script = KILL_SCRIPT.split('/proc/').join(`${root}/`).replace('kill -9 "$n" 2>/dev/null', 'echo "$n"');
    const killed = await new Promise<string>(resolve => { const c = spawn(shell, ['-c', script]); let out = ''; c.stdout.on('data', d => { out += d; }); c.on('close', () => resolve(out)); });
    assert.deepEqual(killed.trim().split('\n'), ['10']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('background script: detached, marked, wall-clock limited, writes exit last', () => {
  const script = backgroundScript({ id: 'bg-1234abcd', command: 'python play.py', cwd: '/workspace/conv', env: { PATH: '/bin' }, limitSeconds: 21600 });
  assert.match(script, /\/workspace\/\.jobs\/bg-1234abcd/);
  assert.match(script, new RegExp(`env -i ${BACKGROUND_MARK} PATH=`));
  assert.match(script, /setsid/);
  assert.match(script, /timeout -k 10 21600 env -i AI_SDK_LETTA_BACKGROUND=1 AI_SDK_LETTA_JOB=bg-1234abcd/);
  assert.match(script, /mv -f "\$D\/exit.tmp" "\$D\/exit"/);
  assert.throws(() => backgroundScript({ id: '../x', command: 'x', cwd: '/', env: {}, limitSeconds: 1 }));
});

test('run_command background: returns at once with a jobId; status, output and its end', async () => {
  const s = setup();
  try {
    // The first command creates the sandbox (a Python venv in the workspace: slow on CI); time only the background call.
    await s.manager.run({ command: 'true' });
    const started = Date.now();
    const out = await s.call('run_command', { command: 'for i in 1 2 3; do echo "step $i/3"; sleep 0.3; done; echo bye >&2', background: true });
    assert.ok(Date.now() - started < 3000, 'returns at once');
    assert.equal(out.isError, undefined, out.text);
    const parsed = JSON.parse(out.text) as { jobId: string; note: string };
    assert.match(parsed.jobId, /^bg-/);
    assert.match(parsed.note, /Running in the background; you'll be told when it finishes. Use command_status \/ command_output \/ command_stop/);
    const status = JSON.parse((await s.call('command_status', {})).text) as { commands: { jobId: string; state: string }[] };
    assert.equal(status.commands[0]!.state, 'running');
    await until(() => s.commands.get(parsed.jobId)!.state !== 'running');
    const record = s.commands.get(parsed.jobId)!;
    assert.equal(record.state, 'done'); assert.equal(record.exitCode, 0);
    assert.deepEqual(record.lastLines, ['step 1/3', 'step 2/3', 'step 3/3']);
    const output = await s.call('command_output', { jobId: parsed.jobId, tail: 2 });
    assert.match(output.text, /^done · exit code 0/);
    assert.match(output.text, /step 2\/3\nstep 3\/3\n\[stderr\]\nbye$/);
    assert.match((await s.call('command_output', { jobId: 'bg-nope' })).text, /No background command/);
  } finally { await s.done(); }
});

test('the idle stop is held while a background command runs, and resumes after', async () => {
  const s = setup({ idleTimeoutMs: 1000 });
  try {
    const { jobId } = JSON.parse((await s.call('run_command', { command: 'sleep 2.5', background: true })).text) as { jobId: string };
    await wait(1800);
    assert.equal(s.host.stops(), 0, 'not stopped while it runs');
    assert.equal(s.manager.running, true);
    await until(() => s.commands.get(jobId)!.state === 'done');
    await until(() => s.host.stops() === 1, 4000);
    assert.equal(s.manager.running, false);
  } finally { await s.done(); }
});

test('command_stop kills the command; no notification for the agent\'s own stop', async () => {
  const s = setup();
  const ended: BackgroundRecord[] = [];
  s.commands.onEnded(record => ended.push(record));
  try {
    const { jobId } = JSON.parse((await s.call('run_command', { command: 'sleep 30', background: true })).text) as { jobId: string };
    await wait(500);
    const stopped = await s.call('command_stop', { jobId });
    assert.match(stopped.text, /^Stopped/);
    const record = s.commands.get(jobId)!;
    assert.equal(record.state, 'stopped'); assert.equal(record.stoppedBy, 'agent'); assert.equal(record.notified, true);
    assert.equal(ended.length, 1);
    assert.deepEqual(s.commands.pendingNotifications(), []);
    assert.match((await s.call('command_stop', { jobId })).text, /^Already ended: stopped/);
  } finally { await s.done(); }
});

test('the wall-clock limit stops a command as timed_out', async () => {
  const s = setup({ backgroundTimeoutMs: 1000 });
  try {
    const { jobId } = JSON.parse((await s.call('run_command', { command: 'sleep 20', background: true })).text) as { jobId: string };
    await until(() => s.commands.get(jobId)!.state !== 'running', 15_000);
    assert.equal(s.commands.get(jobId)!.state, 'timed_out');
    assert.match(backgroundNotice(s.commands.get(jobId)!), /^\[Background command timed out\] `sleep 20` · stopped at its 1 s limit/);
  } finally { await s.done(); }
});

test('notify: an ended command is owed one notification, kept across a restart until delivered; notify: false owes none', async () => {
  const dir = tmp('bg-state');
  const file = join(dir, 'background-commands.json');
  const s = setup({ file });
  try {
    const a = JSON.parse((await s.call('run_command', { command: 'echo hi', background: true })).text) as { jobId: string };
    const b = JSON.parse((await s.call('run_command', { command: 'echo quiet', background: true, notify: false })).text) as { jobId: string; note: string };
    assert.match(b.note, /will not be told/);
    await until(() => s.commands.list({ state: 'running' }).length === 0);
    assert.deepEqual(s.commands.pendingNotifications().map(r => r.id), [a.jobId]);
    // A restart: the same record is still owed, under the same turn ID (so a turn already queued is never sent twice).
    const again = new BackgroundCommands({ file });
    assert.deepEqual(again.pendingNotifications().map(r => r.id), [a.jobId]);
    assert.equal(backgroundRunId(a.jobId), backgroundRunId(a.jobId));
    assert.match(backgroundRunId(a.jobId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    again.markNotified(a.jobId);
    assert.deepEqual(new BackgroundCommands({ file }).pendingNotifications(), []);
    again.close();
    assert.match(backgroundNotice(s.commands.get(a.jobId)!), /^\[Background command finished\] `echo hi` · exit 0 · \d+ s · job bg-[a-z0-9]+ · last lines: hi$/);
  } finally { await s.done(); rmSync(dir, { recursive: true, force: true }); }
});

test('after a restart: a command whose sandbox is gone is interrupted; one still running is followed again', async () => {
  const dir = tmp('bg-restart');
  const file = join(dir, 'background-commands.json');
  try {
    const jobs = (id: string) => { const d = join(dir, 'ws', '.jobs', id); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'out'), 'line\n'); writeFileSync(join(d, 'err'), ''); writeFileSync(join(d, 'alive'), '1'); return d; };
    const gone = jobs('bg-gone0001'); const alive = jobs('bg-live0001');
    const old = new Date(Date.now() - 60_000); utimesSync(join(gone, 'alive'), old, old);
    const base = { owner: 'a.c', conversationId: 'c', cwd: '/workspace', limitMs: 3600_000, notify: true, startedAt: new Date(Date.now() - 120_000).toISOString(), state: 'running' as const };
    writeFileSync(file, JSON.stringify({ version: 1, commands: [{ ...base, id: 'bg-gone0001', command: 'sleep 999', dir: gone }, { ...base, id: 'bg-live0001', command: 'python train.py', dir: alive }] }));
    const commands = new BackgroundCommands({ file, pollMs: 100, staleMs: 1500 });
    const ended: string[] = [];
    commands.onEnded(r => ended.push(`${r.id}:${r.state}`));
    // The live one keeps beating; the gone one never does.
    const beat = setInterval(() => writeFileSync(join(alive, 'alive'), String(Date.now())), 200);
    try {
      await until(() => ended.length === 1, 5000);
      assert.deepEqual(ended, ['bg-gone0001:interrupted']);
      assert.equal(commands.get('bg-live0001')!.state, 'running');
      writeFileSync(join(alive, 'exit'), '0\n');
      await until(() => ended.length === 2, 3000);
      assert.deepEqual(ended[1], 'bg-live0001:done');
    } finally { clearInterval(beat); commands.close(); }
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).commands.every((c: BackgroundRecord) => c.state !== 'running'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the live card starts at once and keeps updating from the files after the call returned', async () => {
  const updates: JobUpdateRequest[] = []; const ends: JobEndRequest[] = []; let starts = 0;
  const desk: JobDesk = { start: () => { starts++; return { id: 'job-1' }; }, update: (_id, request) => { updates.push(request); }, end: (_id, request) => { ends.push(request); } };
  const s = setup();
  try {
    const out = await s.call('run_command', { command: 'for i in 1 2 3 4; do echo "$i/4"; sleep 0.3; done', background: true }, { [JOBS_CONTEXT]: { desk, conversationId: 'conv' } });
    const { jobId } = JSON.parse(out.text) as { jobId: string };
    assert.equal(starts, 1, 'the card exists when the call returns');
    await until(() => ends.length === 1);
    assert.ok(updates.some(u => u.done === 4 && u.total === 4) || updates.some(u => (u.message ?? '').includes('4/4')), JSON.stringify(updates));
    assert.deepEqual(ends[0], { status: 'done', result: 'Exit code 0' });
    assert.equal(s.commands.get(jobId)!.cardJobId, 'job-1');
  } finally { await s.done(); }
});

test('a closed session keeps the sandbox for its running background commands, and stops it when they end', async () => {
  const s = setup();
  try {
    const { jobId } = JSON.parse((await s.call('run_command', { command: 'sleep 1.5', background: true })).text) as { jobId: string };
    await s.manager.close();
    assert.equal(s.host.stops(), 0, 'kept while it runs');
    await until(() => s.commands.get(jobId)!.state === 'done');
    await until(() => s.host.stops() === 1, 3000);
  } finally { await s.done(); }
});
