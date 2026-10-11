import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeRefusal, resetSet, setTokens, setToolMode, shortDescription, tokenLabel, totalTokens, type ControlSet, type ControlTool } from '../src/tool-sets.js';
import { settingsSections } from '../src/settings-model.js';

const tool = (name: string, extra: Partial<ControlTool> = {}): ControlTool => ({ name, description: 'Does a thing. More text.', default: 'allow', tokens: 100, ...extra });
const set: ControlSet = { set: 'sandbox', enabled: true, tools: [tool('run_command'), tool('run_command_online', { default: 'ask', locked: { refuse: ['allow'], reason: 'run_command_online uses the network' } })], tokens: 200 };

test('locked and tighten-only modes are refused with a reason', () => {
  assert.equal(modeRefusal(set.tools[1]!, 'allow'), 'run_command_online uses the network');
  assert.equal(modeRefusal(set.tools[1]!, 'off'), undefined);
  assert.match(modeRefusal(tool('x', { default: 'ask' }), 'allow', true)!, /tightened/);
  assert.equal(modeRefusal(tool('x'), 'allow', true), undefined);
});

test('overrides: the default removes one, reset clears a set, costs follow', () => {
  let overrides = setToolMode({}, set.tools[1]!, 'off');
  assert.deepEqual(overrides, { run_command_online: 'off' });
  assert.equal(setTokens(set, overrides), 100);
  assert.equal(totalTokens([set], ['sandbox'], overrides), 100);
  assert.equal(totalTokens([set], [], overrides), 0);
  overrides = setToolMode(overrides, set.tools[1]!, 'ask');
  assert.deepEqual(overrides, {});
  assert.deepEqual(resetSet({ run_command: 'ask', other: 'off' }, set), { other: 'off' });
  assert.equal(tokenLabel(4123), '≈ 4.1k tokens');
  assert.equal(tokenLabel(12_400), '≈ 12k tokens');
  assert.equal(tokenLabel(820), '≈ 820 tokens');
  assert.equal(shortDescription('Does a thing. More text.'), 'Does a thing.');
  assert.equal(shortDescription('Like run_command, but online, e.g. pip install. Asks.'), 'Like run_command, but online, e.g. pip install.');
});

test('the app’s own agent gets a Tools section when it offers tool control', () => {
  assert.deepEqual(settingsSections({ id: 'a', name: 'A', approvalTools: [], toolControl: true }), ['general', 'tools']);
  assert.deepEqual(settingsSections({ id: 'a', name: 'A', approvalTools: [], toolControl: true }, { team: true }), ['general']);
});
