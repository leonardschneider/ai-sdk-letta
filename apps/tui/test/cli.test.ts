import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LettaConversation } from '@letta-ai/letta-agent-sdk';
import { parseTerminalArgs, conversationRows } from '../src/index.js';
import { newConversationTitle } from 'ai-sdk-letta';

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
test('Markdown titles show as plain text in the terminal', () => {
  const rows = conversationRows({ version: 2, definitionId: 'test-assistant', name: 'Test Assistant', backend: '/backend', agentId: 'agent-local-1', conversationId: 'default' }, [
    { id: 'local-conv-2', agent_id: 'agent-local-1', summary: 'Review [Spec](https://example.com) **v2**', last_message_at: 'today' } as LettaConversation,
    { id: 'local-conv-3', agent_id: 'agent-local-1', summary: '**\x1b[31m**', last_message_at: 'today' } as LettaConversation,
  ]);
  assert.equal(rows[1]!.title, 'Review Spec v2');
  assert.equal(rows[2]!.title, '****', 'terminal controls are removed before parsing');
});

test('named conversations: a new agent\'s picker has no default conversation; an agent of an earlier version keeps it', () => {
  const conversations = [{ id: 'local-conv-2', agent_id: 'agent-local-1', summary: 'Work', last_message_at: 'today' } as LettaConversation, { id: 'default', agent_id: 'agent-local-1' } as LettaConversation];
  const fresh = conversationRows({ version: 2, definitionId: 'test-assistant', name: 'Test Assistant', backend: '/backend', agentId: 'agent-local-1', namedOnly: true }, conversations);
  assert.deepEqual(fresh.map(row => row.id), ['local-conv-2']);
  const legacy = conversationRows({ version: 2, definitionId: 'test-assistant', name: 'Test Assistant', backend: '/backend', agentId: 'agent-local-1', conversationId: 'default' }, conversations);
  assert.deepEqual(legacy.map(row => row.id), ['default', 'local-conv-2']);
  assert.match(newConversationTitle(new Date('2026-10-03T09:12:30Z')), /^Conversation 2026-10-03 09:12$/);
});

test('--agent opens an agent adopted in the browser app; adopted agents list their default conversation', () => {
  assert.deepEqual(parseTerminalArgs(['--agent', 'blog-2cc740f1', '--resume']), { agent: 'blog-2cc740f1', resume: true });
  assert.throws(() => parseTerminalArgs(['--agent']), /--agent requires/);
  assert.throws(() => parseTerminalArgs(['--agent', '../x']), /--agent requires/);
  const rows = conversationRows({ version: 2, definitionId: 'blog-2cc740f1', name: 'blog', backend: '/b', agentId: 'agent-local-x', adopted: true }, []);
  assert.deepEqual(rows.map(r => r.id), ['default']);
});
