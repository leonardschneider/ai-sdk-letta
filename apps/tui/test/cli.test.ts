import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LettaConversation } from '@letta-ai/letta-agent-sdk';
import { parseTerminalArgs, conversationRows } from '../src/index.js';

test('CLI supports explicit navigation, rejects contradictory flags, and shows title/activity/id', () => {
  assert.deepEqual(parseTerminalArgs(['--state-dir', '/tmp/state', '--conversation', 'default']), { stateDirectory: '/tmp/state', conversationId: 'default' });
  assert.deepEqual(parseTerminalArgs(['--new', 'Work']), { newTitle: 'Work' });
  assert.throws(() => parseTerminalArgs(['--list', '--new']), /only one/);
  assert.throws(() => parseTerminalArgs(['--conversation']), /requires/);
  assert.throws(() => parseTerminalArgs(['--state-dir']), /requires/);
  assert.throws(() => parseTerminalArgs(['--smoke']), /Unknown option/);
  const result = conversationRows({ version: 2, definitionId: 'test-assistant', name: 'Test Assistant', backend: '/backend', agentId: 'agent-local-1', conversationId: 'default' }, [{ id: 'local-conv-2', agent_id: 'agent-local-1', summary: 'Work', last_message_at: 'today' } as LettaConversation]);
  assert.deepEqual(result[1], { id: 'local-conv-2', title: 'Work', activity: 'today' });
});

