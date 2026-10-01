import test from 'node:test';
import assert from 'node:assert/strict';
import { commandPreview, toolView } from '../src/tool-view.js';

test('command cards read "Ran `cmd`" with the exit code, the command and the first lines of output', () => {
  const output = `Exit code: 0 (12 ms)\n${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')}`;
  const view = toolView({ toolName: 'run_command', toolCallId: 'c1', state: 'output-available', input: { command: 'rg budget' }, output })!;
  assert.equal(view.title, 'Ran `rg budget`');
  assert.equal(view.rightTitle, 'exit 0 · 12 ms');
  assert.equal(view.content, `$ rg budget\n\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n… 12 more lines`);
  assert.equal(toolView({ toolName: 'run_command', toolCallId: 'c1', state: 'input-available', input: { command: 'sleep 5', cwd: 'data' } })!.title, 'Running `sleep 5`');
  assert.match(toolView({ toolName: 'run_command', toolCallId: 'c1', state: 'input-available', input: { command: 'sleep 5', cwd: 'data' } })!.content!, /\(in data\)/);
  assert.equal(toolView({ toolName: 'run_command', toolCallId: 'c1', state: 'output-available', input: { command: 'sleep 500' }, output: 'Exit code: 124 (timed out after 120 s; the command was stopped)\n(no output)' })!.rightTitle, 'timed out');
  assert.equal(toolView({ toolName: 'run_command_online', toolCallId: 'c2', state: 'output-error', input: { command: 'curl https://x' }, errorText: '{"error":"user_denied"}' })!.title, 'Denied: `curl https://x`');
  assert.equal(toolView({ toolName: 'run_command_online', toolCallId: 'c2', state: 'output-available', input: { command: 'pip install tabulate' }, output: 'Exit code: 0 (3.1 s)\nok' })!.title, 'Ran with internet `pip install tabulate`');
  assert.match(toolView({ toolName: 'run_command', toolCallId: 'c3', state: 'output-available', input: { command: 'ls', cwd: '..' }, output: 'Error (cwd_invalid): Working directory must be inside /workspace' })!.content!, /must be inside \/workspace/);
  assert.equal(toolView({ toolName: 'read_file', toolCallId: 'c4', state: 'output-available', input: { name: 'a' }, output: 'x' }), undefined, 'other tools keep the default card');
  assert.equal(commandPreview('python3 - <<EOF\nprint(1)\nEOF'), 'python3 - <<EOF…');
});
