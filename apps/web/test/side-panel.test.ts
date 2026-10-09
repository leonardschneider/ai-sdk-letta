import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SIDE_PANEL, MAX_APP_TABS, SIDE_WIDTH, activeTab, announce, appTab, appsOf, clampSideWidth, close, closeApp, hasApp, isShown, openApp, readSidePanel, select, tabKey, toggle, visibleTabs, type SidePanel } from '../src/side-panel-model.js';

const all = { threadId: 't1', resources: true, preview: true };

test('tabs: Resources, Preview, then the conversation’s apps', () => {
  let state = openApp(DEFAULT_SIDE_PANEL, 't1', { id: 'c1', tool: 'get-time' });
  state = openApp(state, 't2', { id: 'c2', tool: 'get-time' });
  assert.deepEqual(visibleTabs(state, all), ['resources', 'preview', 'app:c1']);
  assert.deepEqual(visibleTabs(state, { ...all, threadId: 't2' }), ['resources', 'preview', 'app:c2']);
  // A draft has no Preview and no apps; disabled features have no tab.
  assert.deepEqual(visibleTabs(state, { resources: true, preview: true }), ['resources']);
  assert.deepEqual(visibleTabs(state, { threadId: 't1', resources: false, preview: false }), ['app:c1']);
});

test('open and select: a header button opens its tab, again closes the panel', () => {
  let state = toggle(DEFAULT_SIDE_PANEL, 'resources', all);
  assert.equal(state.open, true); assert.equal(activeTab(state, all), 'resources');
  state = toggle(state, 'preview', all);
  assert.equal(state.open, true); assert.equal(activeTab(state, all), 'preview');
  state = toggle(state, 'preview', all);
  assert.equal(state.open, false); assert.equal(state.tab, 'preview');
  assert.equal(isShown(state, all), false);
  state = select(state, 'resources');
  assert.equal(isShown(state, all), true);
  assert.equal(close(state).open, false);
});

test('active tab falls back when the chosen one is not shown here', () => {
  const state: SidePanel = { ...DEFAULT_SIDE_PANEL, open: true, tab: 'app:c9' };
  assert.equal(activeTab(state, all), 'resources');
  assert.equal(activeTab({ ...state, tab: 'preview' }, { ...all, preview: false }), 'resources');
  assert.equal(activeTab(state, { threadId: 't1', resources: false, preview: false }), undefined);
  assert.equal(isShown(state, { threadId: 't1', resources: false, preview: false }), false);
});

test('app tabs: open once, close selects the neighbour, the last closes the panel', () => {
  let state = openApp(DEFAULT_SIDE_PANEL, 't1', { id: 'a', tool: 'x' });
  state = openApp(state, 't1', { id: 'b', tool: 'x' });
  state = openApp(state, 't1', { id: 'a', tool: 'x' });
  assert.deepEqual(appsOf(state, 't1').map(t => t.id), ['a', 'b']);
  assert.equal(state.tab, appTab('a'));
  assert.ok(hasApp(state, 't1', 'b')); assert.ok(!hasApp(state, 't2', 'b')); assert.ok(!hasApp(state, undefined, 'b'));
  state = closeApp(state, 't1', 'a');
  assert.equal(state.tab, appTab('b')); assert.equal(state.open, true);
  state = select(state, 'resources');
  state = openApp(state, 't1', { id: 'c', tool: 'x' });
  state = select(state, 'preview');
  // Closing a tab that isn't showing keeps the selection.
  state = closeApp(state, 't1', 'b');
  assert.equal(state.tab, 'preview');
  state = select(state, appTab('c'));
  state = closeApp(state, 't1', 'c');
  assert.equal(state.open, false); assert.equal(state.tab, 'resources');
  assert.equal(state.apps.t1, undefined);
  assert.equal(closeApp(state, 't1', 'nope'), state);
});

test('app tabs are capped per conversation', () => {
  let state = DEFAULT_SIDE_PANEL;
  for (let i = 0; i < MAX_APP_TABS + 3; i++) state = openApp(state, 't1', { id: `c${i}`, tool: 'x' });
  assert.equal(appsOf(state, 't1').length, MAX_APP_TABS);
  assert.equal(appsOf(state, 't1')[0]!.id, 'c3');
});

test('persistence round trip, clamping and garbage', () => {
  let state = openApp(select(DEFAULT_SIDE_PANEL, 'preview'), 't1', { id: 'c1', tool: 'get-time' });
  state = { ...state, width: 700 };
  assert.deepEqual(readSidePanel(JSON.stringify(state)), state);
  assert.equal(readSidePanel(JSON.stringify({ width: 99999 })).width, SIDE_WIDTH.max);
  assert.equal(readSidePanel(JSON.stringify({ width: 10 })).width, SIDE_WIDTH.min);
  assert.equal(readSidePanel(JSON.stringify({ tab: 'bogus' })).tab, 'resources');
  assert.deepEqual(readSidePanel(JSON.stringify({ apps: { t1: [{ id: 1 }, { id: 'ok', tool: 't' }], t2: 'x' } })).apps, { t1: [{ id: 'ok', tool: 't' }] });
  assert.equal(clampSideWidth(Number.NaN), SIDE_WIDTH.initial);
});

test('migration from the former panels', () => {
  assert.deepEqual(readSidePanel(null), DEFAULT_SIDE_PANEL);
  const migrated = readSidePanel(null, { layout: JSON.stringify({ sidebar: true, resources: true, resourcesWidth: 410 }), preview: JSON.stringify({ open: false, width: 700 }) });
  assert.deepEqual(migrated, { open: true, width: 410, tab: 'resources', apps: {} });
  assert.equal(readSidePanel(null, { layout: '{"resources":false}', preview: '{"open":true}' }).tab, 'preview');
  // The new key wins once written.
  assert.equal(readSidePanel(JSON.stringify(DEFAULT_SIDE_PANEL), { layout: '{"resources":true,"resourcesWidth":500}' }).width, SIDE_WIDTH.initial);
});

test('auto-open: once per dev server start, not on a conversation’s first status', () => {
  let r = announce({}, 't1', '2026-01-01');
  assert.equal(r.open, false);
  r = announce(r.next, 't1', '2026-01-01');
  assert.equal(r.open, false);
  r = announce(r.next, 't1', undefined);
  assert.equal(r.open, false);
  r = announce(r.next, 't1', '2026-01-02');
  assert.equal(r.open, true);
  // The same start again (the user closed it): stays closed.
  r = announce(r.next, 't1', '2026-01-02');
  assert.equal(r.open, false);
  // Restart: opens again.
  assert.equal(announce(r.next, 't1', '2026-01-03').open, true);
  // Another conversation's first status: only remembered.
  assert.equal(announce(r.next, 't2', '2026-01-04').open, false);
});

test('arrow keys move through the tabs, wrapping', () => {
  const tabs = visibleTabs(openApp(DEFAULT_SIDE_PANEL, 't1', { id: 'c1', tool: 'x' }), all);
  assert.equal(tabKey(tabs, 'resources', 'ArrowRight'), 'preview');
  assert.equal(tabKey(tabs, 'app:c1', 'ArrowRight'), 'resources');
  assert.equal(tabKey(tabs, 'resources', 'ArrowLeft'), 'app:c1');
  assert.equal(tabKey(tabs, 'preview', 'Home'), 'resources');
  assert.equal(tabKey(tabs, 'preview', 'End'), 'app:c1');
  assert.equal(tabKey(tabs, 'preview', 'a'), undefined);
});
