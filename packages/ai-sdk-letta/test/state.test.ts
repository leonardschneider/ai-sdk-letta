import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { resolveStateDirectory, statePaths, STATE_DIR_ENV } from '../src/index.js';

test('state directory: explicit, then environment, then platform default in its own namespace', () => {
  assert.equal(resolveStateDirectory('/tmp/explicit', { [STATE_DIR_ENV]: '/tmp/env' }), resolve('/tmp/explicit'));
  assert.equal(resolveStateDirectory(undefined, { [STATE_DIR_ENV]: '/tmp/env' }), resolve('/tmp/env'));
  assert.equal(resolveStateDirectory(undefined, {}, 'linux', '/home/u'), join('/home/u', '.local', 'state', 'ai-sdk-letta'));
  assert.equal(resolveStateDirectory(undefined, { XDG_STATE_HOME: '/xdg' }, 'linux', '/home/u'), join('/xdg', 'ai-sdk-letta'));
  assert.equal(resolveStateDirectory(undefined, { XDG_STATE_HOME: 'relative' }, 'darwin', '/home/someone'), join('/home/someone', '.local', 'state', 'ai-sdk-letta'));
  assert.equal(resolveStateDirectory(undefined, { LOCALAPPDATA: 'C:\\Local' }, 'win32', 'C:\\Users\\u'), join('C:\\Local', 'ai-sdk-letta', 'state'));
  assert.throws(() => resolveStateDirectory('  '), /empty/);
  const paths = statePaths('/s');
  assert.equal(paths.agents, join('/s', 'agents'));
  assert.equal(paths.server('my-agent'), join('/s', 'server', 'my-agent'));
});
