import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import type { Experimental_SandboxSession } from 'ai';
import {
  commandGoal, commandJob, parseProgressLine, visibleLine, OutputLines, pollScript, parsePollOutput, pollCommandOutput, runSandboxCommand, commandScript, sandboxTools, formatCommandResult,
  JOBS_CONTEXT, type JobDesk, type JobEndRequest, type JobStartRequest, type JobUpdateRequest, type CommandOutputChunk,
} from '../src/index.js';

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

test('tqdm: done, total, rate and ETA; s/it rates; scaled counts', () => {
  assert.deepEqual(parseProgressLine(' 45%|████▌     | 9/20 [00:12<00:15,  1.35it/s]'), { done: 9, total: 20, ratePerSecond: 1.35, etaSeconds: 15 });
  assert.deepEqual(parseProgressLine('games:  50%|█████     | 10/20 [01:02<1:00:05,  2.50s/it]'), { done: 10, total: 20, ratePerSecond: 0.4, etaSeconds: 3605 });
  assert.deepEqual(parseProgressLine('100%|██████████| 1.2k/1.2k [00:03<00:00, 400it/s]'), { done: 1200, total: 1200, ratePerSecond: 400, etaSeconds: 0 });
  assert.deepEqual(parseProgressLine('  0%|          | 0/20 [00:00<?, ?it/s]'), { done: 0, total: 20 });
});

test('N/M, pip downloads and percentages; noise is ignored', () => {
  assert.deepEqual(parseProgressLine('step 9/20 loss=0.31'), { done: 9, total: 20 });
  assert.deepEqual(parseProgressLine('[3/10] compiling'), { done: 3, total: 10 });
  assert.deepEqual(parseProgressLine('   ━━━━━━━━━━━━━━━━━━━━ 1.2/3.4 MB 2.1 MB/s eta 0:00:02'), { done: 1_200_000, total: 3_400_000, etaSeconds: 2 });
  assert.deepEqual(parseProgressLine('Downloading: 73%'), { done: 73, total: 100 });
  assert.equal(parseProgressLine('hello world'), undefined);
  assert.equal(parseProgressLine('see https://example.com/a/b'), undefined);
  assert.equal(parseProgressLine('released 2024/10'), undefined);
  assert.equal(parseProgressLine('ratio 30/20'), undefined);
  assert.equal(parseProgressLine('used 250% cpu'), undefined);
});

test('carriage returns: the last drawn segment is the line; streams split as they grow', () => {
  assert.equal(visibleLine('  0%|   | 0/20\r 45%|████▌ | 9/20\r'), ' 45%|████▌ | 9/20');
  const lines = new OutputLines();
  assert.deepEqual(lines.push('start\n 10%|█ | 2/20\r 15%|'), { complete: ['start'], current: ' 15%|' });
  assert.deepEqual(lines.push('█▌ | 3/20 [00:01<00:05, 3.00it/s]\r'), { complete: [], current: ' 15%|█▌ | 3/20 [00:01<00:05, 3.00it/s]' });
  assert.deepEqual(lines.push('\r\n100%|█| 20/20\ndone\n'), { complete: [' 15%|█▌ | 3/20 [00:01<00:05, 3.00it/s]', '100%|█| 20/20', 'done'] });
});

test('goal: the command, on one line, shortened', () => {
  assert.equal(commandGoal('python play.py --games 20'), '$ python play.py --games 20');
  assert.equal(commandGoal('cd x\npython y.py'), '$ cd x…');
  const long = commandGoal(`python ${'a'.repeat(200)}`);
  assert.ok(long.length <= 80 && long.endsWith('…'));
});

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */

test('the poll script reads new output from the offsets, the newest bytes, and nothing once the folder is gone', () => {
  const runId = `t${process.pid}${Date.now()}`;
  const dir = `/tmp/.ai-sdk-letta-${runId}`;
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(`${dir}/o`, 'line 1\n'); writeFileSync(`${dir}/e`, ' 10%|█ | 2/20\r');
    const sh = (script: string) => execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
    const first = parsePollOutput(runId, sh(pollScript(runId, { stdout: 0, stderr: 0 })))!;
    assert.deepEqual(first, { stdout: 'line 1\n', stderr: ' 10%|█ | 2/20\r', stdoutBytes: 7, stderrBytes: Buffer.byteLength(' 10%|█ | 2/20\r') });
    appendFileSync(`${dir}/o`, 'line 2\n'); appendFileSync(`${dir}/e`, ' 50%|█████ | 10/20\r');
    const second = parsePollOutput(runId, sh(pollScript(runId, { stdout: first.stdoutBytes, stderr: first.stderrBytes })))!;
    assert.equal(second.stdout, 'line 2\n'); assert.equal(second.stderr, ' 50%|█████ | 10/20\r');
    appendFileSync(`${dir}/o`, 'x'.repeat(10_000));
    assert.equal(parsePollOutput(runId, sh(pollScript(runId, { stdout: second.stdoutBytes, stderr: second.stderrBytes }, 100)))!.stdout, 'x'.repeat(100));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(parsePollOutput(runId, execFileSync('/bin/sh', ['-c', pollScript(runId, { stdout: 0, stderr: 0 })], { encoding: 'utf8' })), undefined);
});

/** A session that runs scripts with the host's /bin/sh (concurrent runs, like the built-in providers' `exec`). */
function hostSession(log: string[] = []): Experimental_SandboxSession {
  const run = async ({ command: script, abortSignal }: { command: string; abortSignal?: AbortSignal }) => {
    // The tools start in /workspace; on the host, /tmp stands in for it.
    const command = script.replace("cd -- '/workspace'", "cd -- '/tmp'");
    log.push(command.includes('<<ai-sdk-letta-poll:') ? 'poll' : 'command');
    const { spawn } = await import('node:child_process');
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], { signal: abortSignal });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
      child.on('error', reject);
      child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  };
  return { description: 'host', run, spawn: async () => { throw new Error('no'); }, readFile: async () => { throw new Error('no'); } } as unknown as Experimental_SandboxSession;
}
const ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' };

test('polling starts after the delay, then reads every interval, and stops when the command ends', async () => {
  const log: string[] = [];
  const chunks: CommandOutputChunk[] = [];
  const session = hostSession(log);
  const result = await runSandboxCommand(session, { command: 'for i in 1 2 3 4 5 6; do echo "step $i/6"; sleep 0.2; done', cwd: '/tmp', env: ENV, timeoutMs: 20_000, onOutput: chunk => { chunks.push(chunk); }, polling: { delayMs: 300, intervalMs: 150 } });
  assert.equal(result.exitCode, 0);
  const polls = log.filter(l => l === 'poll').length;
  assert.ok(polls >= 3, `polled ${polls} times`);
  assert.ok(chunks.length >= 2 && chunks.every(c => !c.stdout.includes('step 1/6\nstep 1/6')));
  // No reads after the end.
  const after = log.length;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(log.length, after);
  // What the model gets does not depend on the polling.
  const plain = await runSandboxCommand(hostSession(), { command: 'for i in 1 2 3 4 5 6; do echo "step $i/6"; sleep 0.2; done', cwd: '/tmp', env: ENV, timeoutMs: 20_000 });
  assert.equal(formatCommandResult({ ...result, durationMs: 0 }), formatCommandResult({ ...plain, durationMs: 0 }));
});

test('quick commands are never polled', async () => {
  const log: string[] = [];
  let called = 0;
  await runSandboxCommand(hostSession(log), { command: 'echo hi', cwd: '/tmp', env: ENV, timeoutMs: 10_000, onOutput: () => { called++; } });
  assert.deepEqual(log, ['command']); assert.equal(called, 0);
  const poller = pollCommandOutput(hostSession(log), 'none', () => { called++; }, { delayMs: 10_000 });
  await poller.stop();
  assert.deepEqual(log, ['command']);
  assert.ok(commandScript({ runId: 'r', command: 'x', cwd: '/', env: {}, timeoutSeconds: 1 }).includes('/tmp/.ai-sdk-letta-r'));
});

/* ------------------------------------------------------------------ */
/* Automatic job                                                       */
/* ------------------------------------------------------------------ */

function fakeDesk(agentActive = false) {
  const calls: { op: string; request: JobStartRequest | JobUpdateRequest | JobEndRequest; toolCallId: string }[] = [];
  const desk: JobDesk = {
    start: (request, turn) => { calls.push({ op: 'start', request, toolCallId: turn.toolCallId }); return { id: 'job-1' }; },
    update: (_id, request, turn) => { calls.push({ op: 'update', request, toolCallId: turn.toolCallId }); },
    end: (_id, request, turn) => { calls.push({ op: 'end', request, toolCallId: turn.toolCallId }); },
    agentJobActive: () => agentActive,
  };
  return { desk, calls, context: { [JOBS_CONTEXT]: { desk, conversationId: 'c1' } } };
}
const stream = (text: string) => ({ head: text, bytes: Buffer.byteLength(text) });

test('auto job: started on the first output, progress from the latest line, ended with the exit code', async () => {
  const { calls, context } = fakeDesk();
  const job = commandJob(context, 'call-1', 'python play.py --games 20')!;
  await job.output({ stdout: 'loading\n', stderr: '  0%|          | 0/20\r 45%|████▌     | 9/20 [00:12<00:15,  1.35it/s]\r', stdoutBytes: 8, stderrBytes: 70 });
  await job.finish({ exitCode: 3, timedOut: false, stdout: stream('loading\nbye\n'), stderr: stream('') });
  assert.deepEqual(calls.map(c => c.op), ['start', 'update', 'update', 'end']);
  assert.deepEqual(calls[0]!.request, { goal: '$ python play.py --games 20', kind: 'command' });
  assert.equal(calls[0]!.toolCallId, 'call-1');
  assert.deepEqual(calls[1]!.request, { message: 'loading\n45%|████▌ | 9/20 [00:12<00:15, 1.35it/s]', done: 9, total: 20, ratePerSecond: 1.35, etaSeconds: 15 });
  assert.equal((calls[2]!.request as JobUpdateRequest).message, 'bye');
  assert.deepEqual(calls[3]!.request, { status: 'failed', result: 'Exit code 3' });
});

test('auto job: none for quick commands, none when the agent reports its own job; timeouts read as such', async () => {
  const quick = fakeDesk();
  await commandJob(quick.context, 'c', 'ls')!.finish({ exitCode: 0, timedOut: false, stdout: stream('a\n'), stderr: stream('') });
  assert.deepEqual(quick.calls, []);
  const agent = fakeDesk(true);
  const job = commandJob(agent.context, 'c', 'python long.py')!;
  await job.output({ stdout: 'x\n', stderr: '', stdoutBytes: 2, stderrBytes: 0 });
  await job.finish({ exitCode: 0, timedOut: false, stdout: stream('x\n'), stderr: stream('') });
  assert.deepEqual(agent.calls, []);
  assert.equal(commandJob(undefined, 'c', 'x'), undefined);
  const slow = fakeDesk();
  const timed = commandJob(slow.context, 'c', 'sleep 999')!;
  await timed.output({ stdout: '', stderr: 'waiting\n', stdoutBytes: 0, stderrBytes: 8 });
  await timed.finish({ exitCode: 124, timedOut: true, timeoutMs: 60_000, stdout: stream(''), stderr: stream('waiting\n') });
  assert.deepEqual(slow.calls.at(-1)!.request, { status: 'failed', result: 'Timed out after 60 s (exit code 124)' });
});

test('run_command: the card follows a long command, and the model gets exactly the same output', async () => {
  const { calls, context } = fakeDesk();
  const session = hostSession();
  const command = 'for i in 1 2 3 4 5; do printf "\\r%d/5" $i >&2; sleep 0.25; done; echo finished';
  const execute = sandboxTools.run_command.execute!;
  const withJob = await execute({ command }, { toolCallId: 't1', messages: [], context, experimental_sandbox: session } as never) as { text: string };
  // The default delay is 3 s: this command took ~1.3 s, so no card.
  assert.deepEqual(calls, []);
  const without = await execute({ command }, { toolCallId: 't2', messages: [], experimental_sandbox: session } as never) as { text: string };
  const strip = (text: string) => text.replace(/\(\d+(\.\d+)? m?s\)/, '');
  assert.equal(strip(withJob.text), strip(without.text));
});

test('run_command: a long command gets a live card that ends done', { timeout: 20_000 }, async () => {
  const { calls, context } = fakeDesk();
  const command = 'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do printf "\\r%3d%%|##| %d/20 [00:01<00:01, 4.00it/s]" $((i*5)) $i >&2; sleep 0.25; done; echo finished';
  const out = await sandboxTools.run_command.execute!({ command }, { toolCallId: 't3', messages: [], context, experimental_sandbox: hostSession() } as never) as { text: string };
  assert.match(out.text, /^Exit code: 0/);
  assert.equal(calls[0]!.op, 'start');
  const updates = calls.filter(c => c.op === 'update').map(c => c.request as JobUpdateRequest);
  assert.ok(updates.length >= 1 && updates.some(u => u.total === 20 && (u.done ?? 0) >= 12), JSON.stringify(updates));
  assert.deepEqual(calls.at(-1), { op: 'end', request: { status: 'done', result: 'Exit code 0' }, toolCallId: 't3' });
});
