import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Real-PTY regressions for the patched @ai-sdk/tui. They drive the actual
 * terminal renderer with offline fixtures (no Letta backend or model).
 * Requires POSIX and python3; skipped cleanly otherwise.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const python = (() => {
  if (process.platform === 'win32') return undefined;
  try { execFileSync('python3', ['-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }); return 'python3'; } catch { return undefined; }
})();
const skip = python ? false : 'requires POSIX python3 with pty/termios';
const run = (script: string, timeout: number) => promisify(execFile)(python!, [join(fixtures, script)], { timeout, cwd: join(fixtures, '..', '..') });

test('patched real TUI restores scrollback and never replays it to the agent', { timeout: 30_000, skip }, async () => {
  assert.match((await run('history_pty.py', 25_000)).stdout, /PASS real PTY/);
});

test('patched real TUI intercepts slash navigation, returns intact and switches without replay', { timeout: 40_000, skip }, async () => {
  assert.match((await run('navigation_pty.py', 35_000)).stdout, /PASS real PTY navigation/);
});

test('patched real TUI handles active-turn approvals and questions without replay or double execution', { timeout: 40_000, skip }, async () => {
  assert.match((await run('interactions_pty.py', 35_000)).stdout, /PASS actual PTY/);
});

test('patched real TUI attaches images via Ctrl+V and dropped paths, removes markers, sends only the new turn', { timeout: 40_000, skip }, async () => {
  assert.match((await run('images_pty.py', 35_000)).stdout, /PASS actual PTY images/);
});

test('patched real TUI attaches dropped PDF and CSV paths as [File N: name], removes markers, sends only the note', { timeout: 40_000, skip }, async () => {
  assert.match((await run('files_pty.py', 35_000)).stdout, /PASS actual PTY files/);
});
