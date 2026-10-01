/**
 * Real-container checks for the built-in sandbox providers. Opt-in:
 *
 *   AI_SDK_LETTA_SANDBOX_TEST=docker,apple-container npm run test:sandbox --workspace ai-sdk-letta
 *
 * The first run builds the sandbox image (a few minutes). The network test
 * installs a small package from PyPI. Every container is labelled and removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_IMAGE, SANDBOX_LABEL, SandboxManager, formatCommandResult, prepareSandbox, resolveSandboxConfig, sweepStaleSandboxes, type SandboxProviderName } from '../src/index.js';

const wanted = (process.env.AI_SDK_LETTA_SANDBOX_TEST ?? '').split(',').map(s => s.trim()).filter(Boolean) as SandboxProviderName[];
const cli = (provider: SandboxProviderName) => provider === 'docker' ? 'docker' : 'container';
const listOurs = (provider: SandboxProviderName): string[] => {
  if (provider === 'docker') return execFileSync('docker', ['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}.pid=${process.pid}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const all = JSON.parse(execFileSync('container', ['list', '--all', '--format', 'json'], { encoding: 'utf8' }) || '[]') as { configuration?: { id?: string; labels?: Record<string, string> } }[];
  return all.filter(c => c.configuration?.labels?.[`${SANDBOX_LABEL}.pid`] === String(process.pid)).map(c => c.configuration!.id!);
};

for (const provider of ['docker', 'apple-container'] as const) {
  test(`${provider}: isolation, network on demand, persistence, abort, timeout, git and cleanup`, { skip: !wanted.includes(provider) && `set AI_SDK_LETTA_SANDBOX_TEST=${provider}`, timeout: 900_000 }, async () => {
    await prepareSandbox({ provider }, line => console.log(line));
    const root = realpathSync(mkdtempSync(join(tmpdir(), `ai-sdk-letta-sbx-${provider}-`)));
    const workspace = join(root, 'ws');
    mkdirSync(workspace, { mode: 0o700 });
    writeFileSync(join(workspace, 'data.csv'), 'x,y\n1,2\n3,4\n');
    const manager = new SandboxManager(resolveSandboxConfig({ provider, timeoutMs: 20_000, git: { name: 'Sandbox Bot', email: 'bot@sandbox.invalid' } }), { workspace: () => workspace, owner: 'test' });
    process.env.AI_SDK_LETTA_TEST_SECRET = 'must-not-leak';
    const run = async (command: string, options: { network?: boolean; signal?: AbortSignal; cwd?: string } = {}) => (await manager.run({ command, ...options })).result;
    try {
      // Workspace read and write, as the host user.
      let r = await run('cat data.csv && echo made > made.txt && id -u');
      assert.equal(r.exitCode, 0, formatCommandResult(r));
      assert.match(r.stdout.head, /^x,y\n1,2\n3,4\n\d+\n$/);
      assert.equal(statSync(join(workspace, 'made.txt')).uid, process.getuid!(), 'files created in the sandbox belong to the host user');
      assert.equal(r.stdout.head.trim().split('\n').at(-1), String(process.getuid!()));
      // Metadata sidecars are read-only.
      r = await run('echo x > .meta/evil.json');
      assert.notEqual(r.exitCode, 0);
      // Tools from the image.
      r = await run('python3 --version && git --version && rg --version | head -1 && jq --version && pdftotext -v 2>&1 | head -1 && curl --version | head -1');
      assert.equal(r.exitCode, 0, formatCommandResult(r));
      // No network by default.
      r = await run('curl -sS -m 5 https://pypi.org/simple/ -o /dev/null; echo curl=$?; pip download -q --no-deps -d /tmp/d --timeout 5 --retries 0 tabulate >/dev/null 2>&1; echo pip=$?');
      assert.match(r.stdout.head, /curl=[1-9]\d*\npip=[1-9]/, formatCommandResult(r));
      // Environment: only ours; no host variables; no host secrets.
      r = await run('env | cut -d= -f1 | sort | tr "\\n" " "; echo; echo "${AI_SDK_LETTA_TEST_SECRET:-none}"');
      assert.match(r.stdout.head, /\nnone\n$/);
      for (const name of r.stdout.head.split('\n')[0]!.trim().split(' ')) assert.ok(name in manager.environment || ['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name), `unexpected variable ${name}`);
      r = await run(`ls -a ~ ; ls ${process.env.HOME}/.ssh 2>&1; cat ${process.env.HOME}/.gitconfig 2>&1; ls ${process.env.HOME}/.config 2>&1; ls /Users /home 2>&1; ls /var/run/docker.sock 2>&1`);
      assert.doesNotMatch(r.stdout.head + r.stderr.head, /id_rsa|id_ed25519|\[user\]|docker\.sock\n(?!.*No such)/);
      assert.match(r.stdout.head + r.stderr.head, /No such file or directory/);
      // Git: our identity only, global and system config ignored.
      r = await run('mkdir -p repo && cd repo && git init -q -b main && echo a > a.txt && git add a.txt && git commit -qm init && git log --format="%an <%ae>|%cn <%ce>" && git config --show-origin --list | cut -f1 | sort -u');
      assert.equal(r.exitCode, 0, formatCommandResult(r));
      assert.match(r.stdout.head, /^Sandbox Bot <bot@sandbox\.invalid>\|Sandbox Bot <bot@sandbox\.invalid>\nfile:\.git\/config\n$/);
      assert.equal(execFileSync('git', ['-C', join(workspace, 'repo'), 'log', '--format=%an'], { encoding: 'utf8' }).trim(), 'Sandbox Bot');
      // Network on demand, in a separate sandbox; the package persists in the workspace venv.
      r = await run('pip install -q tabulate==0.9.0 && python -c "import tabulate; print(tabulate.__version__)"', { network: true });
      assert.equal(r.exitCode, 0, formatCommandResult(r));
      assert.match(r.stdout.head, /0\.9\.0/);
      r = await run('python -c "import tabulate; print(tabulate.tabulate([[1, 2]]))"; curl -sS -m 5 https://pypi.org -o /dev/null; echo curl=$?');
      assert.match(r.stdout.head, /-  -\n1  2\n-  -\ncurl=[1-9]/, formatCommandResult(r));
      assert.ok(existsSync(join(workspace, '.venv', 'lib')), 'the venv lives in the workspace');
      // Timeout: stopped, and nothing keeps running.
      const started = Date.now();
      const short = new SandboxManager(resolveSandboxConfig({ provider, timeoutMs: 2000 }), { workspace: () => workspace });
      try {
        const timed = (await short.run({ command: 'sleep 60 & sleep 60; echo never' })).result;
        assert.equal(timed.timedOut, true, formatCommandResult(timed));
        assert.ok(Date.now() - started < 30_000);
        const after = (await short.run({ command: 'ps -eo args | grep -c "^sleep 60" || true' })).result;
        assert.equal(after.stdout.head.trim(), '0', 'timed-out processes are gone');
      } finally { await short.close(); }
      // Abort (the Stop button): the run rejects quickly and the process is killed in the sandbox.
      const control = new AbortController();
      const pending = run('sleep 45 & sleep 45; echo never', { signal: control.signal });
      setTimeout(() => control.abort(new Error('stopped')), 2000);
      const abortedAt = Date.now();
      await assert.rejects(pending, /stopped/);
      assert.ok(Date.now() - abortedAt < 15_000);
      r = await run('ps -eo args | grep -c "^sleep 45" || true');
      assert.equal(r.stdout.head.trim(), '0', 'aborted processes are gone');
      // Large output is capped in the sandbox.
      r = await run('seq 1 200000');
      assert.ok(r.stdout.tail);
      assert.match(formatCommandResult(r), /\n200000\n\[Output truncated/);
    } finally {
      await manager.close();
      delete process.env.AI_SDK_LETTA_TEST_SECRET;
      rmSync(root, { recursive: true, force: true });
    }
    assert.deepEqual(listOurs(provider), [], 'no container left behind');
  });

  test(`${provider}: containers of a crashed process are removed at the next start`, { skip: !wanted.includes(provider) && `set AI_SDK_LETTA_SANDBOX_TEST=${provider}`, timeout: 300_000 }, async () => {
    // A labelled container whose owner PID is not running (as after kill -9).
    const name = `ai-sdk-letta-crash-${process.pid}`;
    const deadPid = '999999';
    const labels = ['--label', `${SANDBOX_LABEL}=1`, '--label', `${SANDBOX_LABEL}.pid=${deadPid}`, '--label', `${SANDBOX_LABEL}.host=${hostname()}`];
    const created = spawnSync(cli(provider), ['run', '-d', '--name', name, '--network', 'none', ...labels, SANDBOX_IMAGE, 'sleep', '600'], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    // Sweeping is once per process; a fresh resolve with another binary path forces it here.
    const swept = await sweepStaleSandboxes(resolveSandboxConfig({ provider, binary: execFileSync('which', [cli(provider)], { encoding: 'utf8' }).trim() }));
    assert.ok(swept.includes(name), `swept ${swept.join(', ')}`);
    const left = spawnSync(cli(provider), provider === 'docker' ? ['inspect', name] : ['inspect', name], { encoding: 'utf8' });
    assert.ok(left.status !== 0 || left.stdout.trim() === '[]', 'the stale container is gone');
  });
}

test('container tests are opt-in and skip without AI_SDK_LETTA_SANDBOX_TEST', { skip: wanted.length > 0 && 'running container tests' }, () => {
  // CI (Linux, no Apple Container) runs this file with the variable unset: nothing above starts a container.
  assert.deepEqual(wanted, []);
});
