import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Experimental_SandboxSession } from 'ai';
import { createJustBashNetworkSandboxSession } from '@ai-sdk/sandbox-just-bash';
import {
  AttachmentStore, FILE_TOOL_PERMISSIONS, KILL_SCRIPT, SANDBOX_CONTEXT, SANDBOX_LIMITS, SANDBOX_TOOL_PERMISSIONS, SandboxError, SandboxManager, checkProjectFolder, commandScript, createToolBridge,
  defineAgent, fileTools, formatCommandResult, gitConfigCredentials, parseCommandOutput, resolveSandboxConfig, resolveWorkingDirectory, runSandboxCommand, sandboxEnabled, sandboxEnvironment, sandboxTools,
  type SandboxFactory, type SandboxRequest,
} from '../src/index.js';

const ENV = sandboxEnvironment({ git: { name: 'Sandbox Bot', email: 'bot@sandbox.invalid' } });
const justBash = async () => (await createJustBashNetworkSandboxSession({ cwd: '/workspace' })).restricted();
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `ai-sdk-letta-${prefix}-`));
const text = async (output: unknown) => { const o = await output as { text: string; isError?: boolean }; return o; };

/** A factory over just-bash: records requests, counts creations and stops. */
function fakeProvider() {
  const requests: SandboxRequest[] = [];
  let created = 0; let stopped = 0;
  const factory: SandboxFactory = async request => {
    requests.push(request);
    created++;
    const session = await justBash();
    await session.run({ command: 'mkdir -p /workspace' });
    return { session, stop: async () => { stopped++; } };
  };
  return { factory, requests, get created() { return created; }, get stopped() { return stopped; } };
}

/* ------------------------------------------------------------------ */
/* Command wrapper and output                                          */
/* ------------------------------------------------------------------ */

test('commands run with an empty environment plus exactly ours, in the working directory, with exit code and both streams', async () => {
  const session = await justBash();
  await session.run({ command: 'mkdir -p /workspace/sub' });
  const result = await runSandboxCommand(session, { command: 'pwd; echo "$GIT_CONFIG_GLOBAL $GIT_AUTHOR_NAME"; echo "host=${HOME_SECRET:-none}"; echo oops >&2; exit 7', cwd: '/workspace/sub', env: ENV, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.head, '/workspace/sub\n/dev/null Sandbox Bot\nhost=none\n');
  assert.equal(result.stderr.head, 'oops\n');
  assert.equal(result.stdout.tail, undefined);
  assert.equal(result.stdout.bytes, Buffer.byteLength(result.stdout.head));
  assert.equal(ENV.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(Object.keys(ENV).some(key => /TOKEN|SECRET|SSH|AWS/.test(key)), false);
  assert.equal(Object.values(ENV).some(value => value.includes(process.env.HOME ?? '/nonexistent-home')), false, 'no host paths');
});

test('a missing working directory is reported, not run elsewhere', async () => {
  const session = await justBash();
  await assert.rejects(runSandboxCommand(session, { command: 'echo hi', cwd: '/workspace/nope', env: ENV, timeoutMs: 5000 }), (error: unknown) => error instanceof SandboxError && error.code === 'cwd_not_found');
});

test('timeout: the command is stopped and reported as timed out', async () => {
  const session = await justBash();
  const started = Date.now();
  const result = await runSandboxCommand(session, { command: 'sleep 10; echo never', cwd: '/workspace', env: ENV, timeoutMs: 1000 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout.head, '');
  assert.equal(formatCommandResult(result, 1000, 1000), 'Exit code: 124 (timed out after 1 s; the command was stopped)\n(no output)');
});

test('abort: the run rejects with the abort reason and a cleanup command is sent to the sandbox', async () => {
  const commands: string[] = [];
  const session: Experimental_SandboxSession = {
    description: 'fake', readFile: async () => null, readBinaryFile: async () => null, readTextFile: async () => null,
    writeFile: async () => {}, writeBinaryFile: async () => {}, writeTextFile: async () => {}, spawn: async () => { throw new Error('unused'); },
    run: ({ command, abortSignal }) => { commands.push(command); return new Promise((resolve, reject) => {
      if (command === KILL_SCRIPT) { resolve({ exitCode: 0, stdout: '', stderr: '' }); return; }
      abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
    }); },
  };
  const control = new AbortController();
  const pending = runSandboxCommand(session, { command: 'sleep 100', cwd: '/workspace', env: ENV, timeoutMs: 60_000, signal: control.signal });
  setTimeout(() => control.abort(new Error('stopped by user')), 20);
  await assert.rejects(pending, /stopped by user/);
  assert.equal(commands.length, 2);
  assert.equal(commands[1], KILL_SCRIPT, 'leftover processes are killed in the sandbox');
  assert.match(commands[0]!, /timeout -k 3 60 env -i "\$B" -c /);
  assert.match(commands[0]!, /<\/dev\/null/);
});

test('the kill script spares PID 1 and itself and uses only shell builtins', () => {
  assert.match(KILL_SCRIPT, /\[ "\$n" = 1 \] && continue/);
  assert.match(KILL_SCRIPT, /\[ "\$n" = "\$\$" \] && continue/);
  assert.match(KILL_SCRIPT, /\[ "\$q" = "\$\$" \] && continue/);
  assert.doesNotMatch(KILL_SCRIPT, /\b(grep|ps|awk|sed|tr|cat|pkill)\b/);
});

test('output framing: unknown output is rejected; markers in command output cannot forge a result', () => {
  assert.equal(parseCommandOutput('abc', 'random text'), undefined);
  const script = commandScript({ runId: 'r1', command: 'echo "<<ai-sdk-letta:x>>:0:0:0"', cwd: '/workspace', env: { A: "it's" }, timeoutSeconds: 5 });
  assert.ok(script.includes(`A='\\''it'\\''\\'\\'''\\''s'\\''`), 'values are single-quoted safely, twice');
  assert.throws(() => commandScript({ runId: 'r1', command: 'true', cwd: '/workspace', env: { 'A;rm': 'x' }, timeoutSeconds: 5 }), /Invalid environment variable name/);
  assert.match(script, /<<ai-sdk-letta:r1>>/);
  const forged = '<<ai-sdk-letta:r1>>:0:10:0\n<<ai-sdk-letta:r1>>:0:1:1\nx\n<<ai-sdk-letta:r1>>:stderr\n\n<<ai-sdk-letta:r1>>:stderr\ny';
  const parsed = parseCommandOutput('r1', forged)!;
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.stderr.head, 'y', 'the last stderr marker (ours) wins');
});

test('output is capped: head and tail kept, an explicit notice with the omitted size, exit code first', async () => {
  const session = await justBash();
  const result = await runSandboxCommand(session, { command: 'seq 1 50000; seq 1 3000 >&2', cwd: '/workspace', env: ENV, timeoutMs: 10_000 });
  assert.ok(result.stdout.tail, 'the sandbox only sends the head and tail of large output');
  assert.ok(result.stdout.head.length <= SANDBOX_LIMITS.captureBytes);
  assert.equal(result.stdout.bytes, Buffer.byteLength(Array.from({ length: 50_000 }, (_, i) => `${i + 1}\n`).join('')));
  const formatted = formatCommandResult(result);
  assert.ok(formatted.length <= SANDBOX_LIMITS.maxOutputChars + 400, `${formatted.length}`);
  assert.match(formatted, /^Exit code: 0 \(/);
  assert.match(formatted, /\n1\n2\n3\n/);
  assert.match(formatted, /\n50000\n\[stderr\]/);
  assert.match(formatted, /\[… \d+ KB of output omitted …\]/);
  assert.match(formatted, /\[stderr\]\n1\n2\n/);
  assert.match(formatted, /\[Output truncated\. To see more, write it to a file/);
  // Small output is untouched.
  assert.equal(formatCommandResult({ exitCode: 0, timedOut: false, durationMs: 5, stdout: { head: 'ok\n', bytes: 3 }, stderr: { head: '', bytes: 0 } }), 'Exit code: 0 (5 ms)\nok');
  assert.equal(formatCommandResult({ exitCode: 1, timedOut: false, durationMs: 1500, stdout: { head: '', bytes: 0 }, stderr: { head: '', bytes: 0 } }), 'Exit code: 1 (1.5 s)\n(no output)');
});

test('stderr keeps at least a quarter of the budget when stdout is huge', () => {
  const big = 'x'.repeat(100_000);
  const formatted = formatCommandResult({ exitCode: 1, timedOut: false, durationMs: 1, stdout: { head: big, bytes: 100_000 }, stderr: { head: `Traceback\n${'e'.repeat(10_000)}\nValueError: bad`, bytes: 10_030 } }, 8000);
  assert.match(formatted, /ValueError: bad/);
  assert.match(formatted, /Traceback/);
  assert.ok(formatted.length < 8400);
});

/* ------------------------------------------------------------------ */
/* Working directory                                                   */
/* ------------------------------------------------------------------ */

test('working directories stay inside /workspace (and /project when mounted); ".." is refused', () => {
  assert.equal(resolveWorkingDirectory(undefined), '/workspace');
  assert.equal(resolveWorkingDirectory(''), '/workspace');
  assert.equal(resolveWorkingDirectory('.'), '/workspace');
  assert.equal(resolveWorkingDirectory('data/raw'), '/workspace/data/raw');
  assert.equal(resolveWorkingDirectory('/workspace/data/'), '/workspace/data');
  assert.equal(resolveWorkingDirectory('./a//b'), '/workspace/a/b');
  const invalid = (cwd: string, project = false) => assert.throws(() => resolveWorkingDirectory(cwd, project), (error: unknown) => error instanceof SandboxError && error.code === 'cwd_invalid', cwd);
  for (const cwd of ['..', '../etc', 'a/../../etc', '/etc', '/', '/workspacex', '/workspace/../root', '/project', 'a\nb']) invalid(cwd);
  assert.equal(resolveWorkingDirectory('/project/src', true), '/project/src');
  invalid('/project/../etc', true);
});

/* ------------------------------------------------------------------ */
/* Definition, permissions, exposure                                   */
/* ------------------------------------------------------------------ */

const base = { id: 'sandbox-test', name: 'Sandbox Test', model: 'test/model', instructions: 'Test.' };

test('permissions: run_command defaults to allow, network commands to ask and can never be allow', () => {
  assert.deepEqual({ ...SANDBOX_TOOL_PERMISSIONS }, { run_command: 'allow', run_command_online: 'ask' });
  assert.ok(Object.isFrozen(SANDBOX_TOOL_PERMISSIONS));
  const definition = defineAgent({ ...base, tools: { ...sandboxTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS }, sandbox: { provider: 'docker' } });
  assert.equal(definition.permissions.run_command, 'allow');
  assert.equal(definition.permissions.run_command_online, 'ask');
  assert.ok(sandboxEnabled(definition));
  assert.throws(() => defineAgent({ ...base, tools: { ...sandboxTools }, permissions: { run_command: 'allow', run_command_online: 'allow' }, sandbox: { provider: 'docker' } }), /run_command_online uses the network/);
  assert.throws(() => defineAgent({ ...base, tools: { ...sandboxTools }, permissions: { run_command: 'allow' }, sandbox: { provider: 'docker' } }), /Missing permission for tool\(s\): run_command_online/, 'fail-closed: every tool needs a permission');
  // Denied, or no sandbox: not enabled.
  assert.equal(sandboxEnabled(defineAgent({ ...base, tools: { ...sandboxTools }, permissions: { run_command: 'deny', run_command_online: 'deny' }, sandbox: { provider: 'docker' } })), false);
  assert.equal(sandboxEnabled(defineAgent({ ...base, tools: { ...sandboxTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS } })), false);
});

test('sandbox config is validated and frozen', () => {
  const config = resolveSandboxConfig({ provider: 'apple-container' });
  assert.ok(Object.isFrozen(config));
  assert.equal(config.timeoutMs, SANDBOX_LIMITS.defaultTimeoutMs);
  assert.equal(config.idleTimeoutMs, SANDBOX_LIMITS.defaultIdleMs);
  assert.deepEqual({ ...config.git }, { name: 'Sandbox', email: 'sandbox@localhost' });
  const bad = (input: object, pattern: RegExp) => assert.throws(() => resolveSandboxConfig(input as never), (error: unknown) => error instanceof SandboxError && error.code === 'sandbox_config_invalid' && pattern.test(error.message));
  bad({ provider: 'podman' }, /provider/);
  bad({ provider: 'docker', timeoutMs: 999_999 }, /timeoutMs/);
  bad({ provider: 'docker', project: 'relative/path' }, /absolute/);
  bad({ provider: 'docker', project: '/tmp/a,b' }, /commas/);
  bad({ provider: 'docker', git: { name: 'x', email: 'not-an-email' } }, /git/);
  bad({ provider: 'docker', git: { name: 'evil\nname', email: 'a@b.c' } }, /git/);
  bad({ provider: 'docker', image: 'bad image' }, /image/);
  bad({ provider: 'docker', memory: 'lots' }, /memory/);
  assert.equal(resolveSandboxConfig({ provider: 'docker', project: { path: '/tmp/x', readOnly: true } }).project?.readOnly, true);
});

test('the shell tools are never exposed without a sandbox, even when listed and allowed', async () => {
  const tools = { ...sandboxTools, ...fileTools };
  const permissions = { ...SANDBOX_TOOL_PERMISSIONS, ...FILE_TOOL_PERMISSIONS };
  const definition = defineAgent({ ...base, tools, permissions });
  assert.equal(sandboxEnabled(definition), false);
  // The runtime passes this restriction when no sandbox is configured.
  const bridge = createToolBridge({ tools: definition.tools, permissions: definition.permissions, persist: () => {}, allowedTools: Object.keys(tools).filter(name => !name.startsWith('run_command')) });
  assert.deepEqual(bridge.allowedTools.sort(), ['list_files', 'read_file', 'search_files']);
  const denied = await bridge.execute('run_command', 'call-1', { command: 'id' });
  assert.equal(denied.isError, true);
  assert.match((denied.content[0] as { text: string }).text, /tool_denied/);
  // And a direct call without any sandbox reports it plainly.
  const output = await text(sandboxTools.run_command.execute!({ command: 'id' }, { toolCallId: 'x', messages: [], context: {} }));
  assert.equal(output.isError, true);
  assert.match(output.text, /sandbox_unavailable/);
});

test('run_command uses the AI SDK experimental_sandbox when no manager is bound (standard interface)', async () => {
  const session = await justBash();
  const output = await text(sandboxTools.run_command.execute!({ command: 'echo from-standard-sandbox; pwd' }, { toolCallId: 'x', messages: [], context: {}, experimental_sandbox: session }));
  assert.equal(output.isError, undefined);
  assert.equal(output.text.split('\n').slice(1).join('\n'), 'from-standard-sandbox\n/workspace');
  // The bridge passes the bound sandbox to every tool.
  const bridge = createToolBridge({ tools: { run_command: sandboxTools.run_command }, permissions: { run_command: 'allow' }, persist: () => {}, sandbox: () => session });
  const result = await bridge.execute('run_command', 'call-2', { command: 'echo via-bridge', cwd: '.' });
  assert.equal(result.isError, false);
  assert.match((result.content[0] as { text: string }).text, /^Exit code: 0 .*\nvia-bridge$/s);
});

test('the bridge applies per-tool timeouts to shell tools and validates arguments first', async () => {
  const slow = { run_command: { ...sandboxTools.run_command, execute: () => new Promise(resolve => setTimeout(() => resolve({ text: 'late' }), 400)) } };
  const events: string[] = [];
  const quick = createToolBridge({ tools: slow as never, permissions: { run_command: 'allow' }, persist: event => events.push(`${event.status}:${event.code ?? ''}`), timeoutMs: 5000, toolTimeouts: { run_command: 50 } });
  const result = await quick.execute('run_command', 'call-t', { command: 'sleep 1' });
  assert.match((result.content[0] as { text: string }).text, /tool_timeout/);
  assert.ok(events.includes('error:tool_timeout'));
  const invalid = await quick.execute('run_command', 'call-i', { command: 'x', extra: true });
  assert.match((invalid.content[0] as { text: string }).text, /invalid_arguments/);
  const empty = await quick.execute('run_command', 'call-e', { command: '' });
  assert.match((empty.content[0] as { text: string }).text, /invalid_arguments/);
});

test('run_command_online always asks, shows the exact command, and a denial never starts a sandbox', async () => {
  const provider = fakeProvider();
  const dir = tmp('online');
  try {
    const manager = new SandboxManager(resolveSandboxConfig({ provider: provider.factory }), { workspace: () => dir });
    const requests: { title: string; details?: string; tool: string }[] = [];
    const interactions = { request: async (request: { title: string; details?: string; tool: string }) => { requests.push(request); return { id: 'r', approved: false }; } };
    const bridge = createToolBridge({ tools: { ...sandboxTools }, permissions: { ...SANDBOX_TOOL_PERMISSIONS }, persist: () => {}, interactions: interactions as never, context: () => ({ [SANDBOX_CONTEXT]: manager }) });
    const result = await bridge.execute('run_command_online', 'call-n', { command: 'pip install tabulate' });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /user_denied/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.tool, 'run_command_online');
    assert.equal(JSON.parse(requests[0]!.details!).command, 'pip install tabulate');
    assert.equal(provider.created, 0, 'no sandbox was created');
    await manager.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

test('lifecycle: created lazily on the first command, reused across commands, stopped when idle and on close', async () => {
  const provider = fakeProvider();
  const dir = tmp('life');
  try {
    const manager = new SandboxManager(resolveSandboxConfig({ provider: provider.factory, idleTimeoutMs: 1000 }), { workspace: () => dir, owner: 'agent-x.conv-y' });
    assert.equal(provider.created, 0, 'nothing starts before a command');
    assert.equal(manager.running, false);
    const first = await manager.run({ command: 'echo one > /workspace/state.txt; echo ok' });
    assert.equal(first.result.exitCode, 0);
    const second = await manager.run({ command: 'cat /workspace/state.txt' });
    assert.equal(second.result.stdout.head, 'one\n', 'the same sandbox is reused');
    assert.equal(provider.created, 1);
    const request = provider.requests[0]!;
    assert.equal(request.network, false, 'no network by default');
    assert.deepEqual(request.mounts.map(m => [m.containerPath, !!m.readOnly]), [['/workspace', false], ['/workspace/.meta', true], ['/workspace/.text', true]]);
    assert.equal(request.mounts[0]!.hostPath, dir);
    assert.equal(request.labels['ai-sdk-letta.sandbox'], '1');
    assert.equal(request.labels['ai-sdk-letta.sandbox.pid'], String(process.pid));
    assert.equal(request.labels['ai-sdk-letta.sandbox.owner'], 'agent-x.conv-y');
    // Idle: stopped after idleTimeoutMs, then recreated on demand.
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(provider.stopped, 1);
    assert.equal(manager.running, false);
    await manager.run({ command: 'true' });
    assert.equal(provider.created, 2);
    await manager.close();
    assert.equal(provider.stopped, 2);
    await assert.rejects(manager.run({ command: 'true' }), (error: unknown) => error instanceof SandboxError && error.code === 'sandbox_unavailable');
    await manager.close();
    assert.equal(provider.stopped, 2, 'close is idempotent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('network commands get their own short-lived network sandbox on the same workspace', async () => {
  const provider = fakeProvider();
  const dir = tmp('net');
  try {
    const manager = new SandboxManager(resolveSandboxConfig({ provider: provider.factory }), { workspace: () => dir });
    await manager.run({ command: 'true' });
    const online = await manager.run({ command: 'echo fetched', network: true });
    assert.equal(online.result.stdout.head, 'fetched\n');
    assert.deepEqual(provider.requests.map(r => r.network), [false, true]);
    assert.equal(provider.requests[1]!.mounts[0]!.hostPath, dir, 'same workspace');
    assert.equal(provider.requests[1]!.labels['ai-sdk-letta.sandbox.network'], 'on');
    assert.equal(provider.stopped, 1, 'the network sandbox is removed right after its command');
    assert.equal(manager.running, true, 'the offline sandbox keeps running');
    await manager.close();
    assert.equal(provider.stopped, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commands of one conversation run one at a time; a failed start is retried on the next command', async () => {
  let fail = true;
  let concurrent = 0; let peak = 0;
  const factory: SandboxFactory = async () => {
    if (fail) { fail = false; throw new Error('daemon not running'); }
    const session = await justBash();
    const run = session.run.bind(session);
    return { session: { ...session, run: async (options) => { concurrent++; peak = Math.max(peak, concurrent); try { return await run(options); } finally { concurrent--; } } }, stop: async () => {} };
  };
  const dir = tmp('serial');
  try {
    const manager = new SandboxManager(resolveSandboxConfig({ provider: factory }), { workspace: () => dir });
    await assert.rejects(manager.run({ command: 'true' }), (error: unknown) => error instanceof SandboxError && error.code === 'sandbox_unavailable' && /daemon not running/.test(error.message));
    const results = await Promise.all([1, 2, 3].map(n => manager.run({ command: `sleep 0.1; echo ${n}` })));
    assert.deepEqual(results.map(r => r.result.stdout.head), ['1\n', '2\n', '3\n']);
    assert.equal(peak, 1);
    await manager.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tool output through the runtime context: exit code, output and errors as text', async () => {
  const provider = fakeProvider();
  const dir = tmp('tool');
  try {
    const manager = new SandboxManager(resolveSandboxConfig({ provider: provider.factory }), { workspace: () => dir });
    const run = (input: { command: string; cwd?: string }) => text(sandboxTools.run_command.execute!(input, { toolCallId: 'x', messages: [], context: { [SANDBOX_CONTEXT]: manager } }));
    assert.match((await run({ command: 'echo hi' })).text, /^Exit code: 0 \(\d+ ms\)\nhi$/);
    const outside = await run({ command: 'ls', cwd: '../..' });
    assert.equal(outside.isError, true);
    assert.match(outside.text, /^Error \(cwd_invalid\)/);
    const missing = await run({ command: 'ls', cwd: 'nope' });
    assert.match(missing.text, /^Error \(cwd_not_found\)/);
    const model = sandboxTools.run_command.toModelOutput!({ toolCallId: 'x', input: { command: 'ls' }, output: outside });
    assert.equal((model as { type: string }).type, 'error-text');
    await manager.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ */
/* Project folders and credentials                                     */
/* ------------------------------------------------------------------ */

test('git config credentials are detected: userinfo URLs, credential settings, extraheader, includes', () => {
  assert.deepEqual(gitConfigCredentials('[remote "origin"]\n\turl = git@github.com:me/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[core]\n\tbare = false'), []);
  assert.deepEqual(gitConfigCredentials('[remote "origin"]\n\turl = https://github.com/me/repo.git'), []);
  assert.deepEqual(gitConfigCredentials('[remote "origin"]\n\turl = ssh://git@github.com/me/repo.git'), [], 'an ssh user name is not a secret');
  const has = (config: string, pattern: RegExp) => { const reasons = gitConfigCredentials(config); assert.ok(reasons.some(r => pattern.test(r)), `${config} -> ${reasons.join('; ')}`); };
  has('[remote "origin"]\n\turl = https://x-access-token:ghp_abc@github.com/me/repo.git', /url contains credentials/);
  has('[remote "origin"]\n\turl = https://ghp_abc@github.com/me/repo.git', /url contains credentials/);
  has('[remote "origin"]\n  pushurl = "https://user:pw@example.com/r.git"', /pushurl contains credentials/);
  has('[remote "o"]\n\turl = ssh://user:pw@host/r.git', /url contains credentials/);
  has('[credential]\n\thelper = store', /credential setting/);
  has('[credential "https://github.com"]\n\tusername = me', /credential setting/);
  has('[http]\n\textraHeader = AUTHORIZATION: bearer abc', /extraHeader/);
  has('[http "https://github.com/"]\n\textraheader = Authorization: basic xyz', /extraHeader/);
  has('[url "https://tok@github.com/"]\n\tinsteadOf = https://github.com/', /rewrites to a URL with credentials/);
  has('[include]\n\tpath = ~/.gitconfig-secrets', /include/);
  has('[includeIf "gitdir:~/work/"]\n\tpath = work.inc', /include/);
  has('[remote.origin]\n\turl = https://u:p@h/r', /contains credentials/);
});

test('project folders: credentialed repos, home folders and odd .git entries are refused; a clean repo is accepted', () => {
  const root = tmp('proj');
  const fakeHome = join(root, 'home');
  mkdirSync(fakeHome);
  try {
    const repo = (name: string, config?: string) => { const dir = join(root, name); mkdirSync(join(dir, '.git'), { recursive: true }); if (config !== undefined) writeFileSync(join(dir, '.git', 'config'), config); return dir; };
    const refused = (path: string, code: string, pattern?: RegExp) => assert.throws(() => checkProjectFolder(path, fakeHome), (error: unknown) => error instanceof SandboxError && error.code === code && (!pattern || pattern.test(error.message)), path);
    refused(repo('token', '[remote "origin"]\n\turl = https://x-access-token:ghp_1234@github.com/me/r.git\n'), 'project_has_credentials', /contains credentials/);
    refused(repo('helper', '[credential]\n\thelper = osxkeychain\n'), 'project_has_credentials', /credential setting/);
    refused(repo('header', '[http]\n\textraheader = AUTHORIZATION: basic Zm9v\n'), 'project_has_credentials', /extraHeader/);
    const clean = repo('clean', '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:me/r.git\n');
    assert.ok(checkProjectFolder(clean, fakeHome).endsWith('clean'));
    const plain = join(root, 'plain'); mkdirSync(plain);
    assert.ok(checkProjectFolder(plain, fakeHome));
    refused(fakeHome, 'project_unsafe', /home folder/);
    refused(root, 'project_unsafe', /home folder/, );
    refused('/', 'project_unsafe');
    const withSsh = join(root, 'looks-like-home'); mkdirSync(join(withSsh, '.ssh'), { recursive: true });
    refused(withSsh, 'project_unsafe', /\.ssh/);
    const worktree = join(root, 'worktree'); mkdirSync(worktree); writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere/else');
    refused(worktree, 'project_unsafe', /linked worktrees/);
    refused(join(root, 'missing'), 'project_unsafe', /does not exist/);
    // The manager refuses at construction, before any sandbox exists.
    const provider = fakeProvider();
    assert.throws(() => new SandboxManager(resolveSandboxConfig({ provider: provider.factory, project: join(root, 'token') }), { workspace: () => plain }), (error: unknown) => error instanceof SandboxError && error.code === 'project_has_credentials');
    assert.equal(provider.created, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a project is mounted at /project with .git hooks read-only, and git settings changed by a command are restored', async () => {
  const root = tmp('mount');
  const project = join(root, 'repo');
  mkdirSync(join(project, '.git', 'hooks'), { recursive: true });
  const config = '[core]\n\trepositoryformatversion = 0\n';
  writeFileSync(join(project, '.git', 'config'), config);
  const workspace = join(root, 'ws'); mkdirSync(workspace);
  // The fake provider stands in for the container: commands write to the host project directly.
  const requests: SandboxRequest[] = [];
  const factory: SandboxFactory = async request => {
    requests.push(request);
    const session = await justBash();
    await session.run({ command: 'mkdir -p /workspace /project' });
    return { session: { ...session, run: async options => { if (options.command.includes('evil-config')) { writeFileSync(join(project, '.git', 'config'), `${config}[core]\n\tfsmonitor = /tmp/x\n`); writeFileSync(join(project, '.git', 'commondir'), '/tmp'); } return session.run(options); } }, stop: async () => {} };
  };
  try {
    const manager = new SandboxManager(resolveSandboxConfig({ provider: factory, project }), { workspace: () => workspace });
    assert.equal(manager.hasProject, true);
    const result = await manager.run({ command: 'echo evil-config', cwd: '/project' });
    assert.match(result.note ?? '', /git settings \(\.git\/commondir, \.git\/config\); they were restored/);
    assert.equal(readFileSync(join(project, '.git', 'config'), 'utf8'), config);
    assert.equal(existsSync(join(project, '.git', 'commondir')), false);
    assert.deepEqual(requests[0]!.mounts.map(m => [m.containerPath, !!m.readOnly]), [['/workspace', false], ['/workspace/.meta', true], ['/workspace/.text', true], ['/project', false], ['/project/.git', false], ['/project/.git/hooks', true]]);
    const clean = await manager.run({ command: 'true', cwd: '/project' });
    assert.equal(clean.note, undefined);
    await manager.close();
    // Read-only projects mount read-only, without the extra .git mounts.
    requests.length = 0;
    const readOnly = new SandboxManager(resolveSandboxConfig({ provider: factory, project: { path: project, readOnly: true } }), { workspace: () => workspace });
    await readOnly.run({ command: 'true' });
    assert.deepEqual(requests[0]!.mounts.slice(3).map(m => [m.containerPath, !!m.readOnly]), [['/project', true]]);
    await readOnly.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a repository created in a project without one keeps only plain settings and no active hooks', async () => {
  const root = tmp('newrepo');
  const project = join(root, 'p'); mkdirSync(project);
  const workspace = join(root, 'ws'); mkdirSync(workspace);
  const factory: SandboxFactory = async () => {
    const session = await justBash();
    return { session: { ...session, run: async options => {
      if (options.command.includes('git-init')) {
        mkdirSync(join(project, '.git', 'hooks'), { recursive: true });
        writeFileSync(join(project, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = /evil\n\thooksPath = /evil\n[alias]\n\tst = !evil\n[remote "origin"]\n\turl = https://github.com/me/r.git\n');
        writeFileSync(join(project, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nevil'); chmodSync(join(project, '.git', 'hooks', 'pre-commit'), 0o755);
        writeFileSync(join(project, '.git', 'hooks', 'pre-commit.sample'), 'sample');
      }
      return session.run(options);
    } }, stop: async () => {} };
  };
  try {
    const manager = new SandboxManager(resolveSandboxConfig({ provider: factory, project }), { workspace: () => workspace });
    const { note } = await manager.run({ command: 'echo git-init' });
    assert.match(note ?? '', /kept only plain settings in \.git\/config, removed hook pre-commit/);
    const config = readFileSync(join(project, '.git', 'config'), 'utf8');
    assert.match(config, /repositoryformatversion = 0/);
    assert.match(config, /url = https:\/\/github\.com\/me\/r\.git/);
    assert.doesNotMatch(config, /fsmonitor|hooksPath|alias|evil/i);
    assert.equal(existsSync(join(project, '.git', 'hooks', 'pre-commit')), false);
    assert.equal(existsSync(join(project, '.git', 'hooks', 'pre-commit.sample')), true);
    await manager.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the workspace is the conversation folder; its metadata sidecars are mounted read-only', async () => {
  const root = tmp('ws');
  try {
    const store = new AttachmentStore(root, 'agent-local-1111', 'conv-a');
    await store.save([{ name: 'data.csv', bytes: new TextEncoder().encode('a,b\n1,2\n') }]);
    const provider = fakeProvider();
    const manager = new SandboxManager(resolveSandboxConfig({ provider: provider.factory }), { workspace: () => store.folder() });
    await manager.run({ command: 'true' });
    const mounts = provider.requests[0]!.mounts;
    assert.equal(mounts[0]!.hostPath, store.folder());
    assert.ok(existsSync(join(mounts[0]!.hostPath, 'data.csv')));
    assert.ok(mounts.slice(1).every(m => m.readOnly && m.hostPath.startsWith(store.folder())));
    await manager.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
