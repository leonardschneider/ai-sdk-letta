import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsAgent, settingsHash, settingsPlan, settingsSections, settingsTarget } from '../src/settings-model.js';
import type { AgentInfo } from '../src/api.js';

const agent = (extra: Partial<AgentInfo> = {}): AgentInfo => ({ id: 'a', name: 'A', approvalTools: [], ...extra });
const adopted = (extra: Partial<NonNullable<AgentInfo['adopted']>> = {}) => ({ agentId: 'agent-1', model: 'openai/gpt-5', tools: ['files'], instructions: false, ...extra });

test('hash routing: open, close, reload', () => {
  // Open: the hash names the agent (IDs are encoded).
  assert.equal(settingsHash('chess'), '#/agents/chess/settings');
  assert.equal(settingsHash('a/b c'), '#/agents/a%2Fb%20c/settings');
  assert.equal(settingsAgent(settingsHash('a/b c')), 'a/b c');
  assert.equal(settingsAgent('#/agents/chess/settings/'), 'chess');
  // Closed: no hash, or any other hash.
  for (const hash of ['', '#', '#/agents/chess', '#/agents//settings', '#/agents/chess/settings/tools', '#settings-general', '#/agents/%E0%A4%A/settings']) assert.equal(settingsAgent(hash), undefined, hash);
  // Plans from the current agent.
  assert.deepEqual(settingsPlan('chess', '#/agents/chess/settings'), { kind: 'open' });
  assert.deepEqual(settingsPlan('main', '#/agents/chess/settings'), { kind: 'switch', agentId: 'chess' });
  assert.deepEqual(settingsPlan('chess', ''), { kind: 'close' });
  // Reload: only a known agent is opened (a removed one falls back to the saved agent).
  assert.equal(settingsTarget('#/agents/chess/settings', ['main', 'chess']), 'chess');
  assert.equal(settingsTarget('#/agents/gone/settings', ['main', 'chess']), undefined);
  assert.equal(settingsTarget('', ['main']), undefined);
});

test('sections: the main (definition) agent', () => {
  assert.deepEqual(settingsSections(agent()), ['general']);
  assert.deepEqual(settingsSections(agent({ apps: true, memory: true, automations: true })), ['general', 'apps', 'memory', 'automations']);
});

test('sections: an adopted agent', () => {
  assert.deepEqual(settingsSections(agent({ adopted: adopted() })), ['general', 'tools', 'voices', 'instructions', 'danger']);
  assert.deepEqual(settingsSections(agent({ adopted: adopted(), apps: true, memory: true })), ['general', 'tools', 'voices', 'instructions', 'apps', 'memory', 'danger']);
});

test('sections: a view-only agent hides what it cannot change here', () => {
  assert.deepEqual(settingsSections(agent({ adopted: adopted({ viewOnly: true }), viewOnly: true, apps: true, automations: true })), ['general', 'danger']);
  // Memory stays: the earlier reviews are listed (read-only).
  assert.deepEqual(settingsSections(agent({ adopted: adopted({ viewOnly: true }), viewOnly: true, memory: true })), ['general', 'memory', 'danger']);
});

test('sections: team admins and members', () => {
  const full = { apps: true, memory: true, automations: true };
  assert.deepEqual(settingsSections(agent({ ...full, role: 'admin' }), { team: true }), ['general', 'apps', 'memory', 'automations', 'members']);
  assert.deepEqual(settingsSections(agent({ ...full, role: 'member' }), { team: true }), ['general', 'memory']);
});
