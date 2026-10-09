import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptFrameMessage, appToolLabel, approvalError, approvalTitle, devGenerationsKey, hostContext, viewGeneration, inlineHeight, INLINE_HEIGHT, nextDisplayMode, openableLink, THEME_VARIABLES } from '../src/apps-model.js';
import { historyMessages, knownApp } from '../src/messages.js';

test('display modes: only modes the view declared and the host offers; otherwise the current one', () => {
  assert.equal(nextDisplayMode('fullscreen', 'inline', ['inline', 'fullscreen']), 'fullscreen');
  assert.equal(nextDisplayMode('pip', 'inline', ['inline', 'fullscreen']), 'inline', 'not declared');
  assert.equal(nextDisplayMode('pip', 'inline', undefined), 'pip', 'nothing declared: the host decides');
  assert.equal(nextDisplayMode('theatre', 'fullscreen', undefined), 'fullscreen', 'unknown mode');
  assert.equal(nextDisplayMode(42, 'inline', undefined), 'inline');
});

test('size-changed: inline height follows the view, within bounds', () => {
  assert.equal(inlineHeight(300, 160), 300);
  assert.equal(inlineHeight(10, 160), INLINE_HEIGHT.min);
  assert.equal(inlineHeight(10_000, 160), INLINE_HEIGHT.max);
  assert.equal(inlineHeight(undefined, 222), 222);
  assert.equal(inlineHeight(Number.NaN, 222), 222);
});

test('host context: theme, mode, dimensions, locale and tool info; light-dark() theme variables', () => {
  const inline = hostContext({ theme: 'dark', displayMode: 'inline', placement: 'inline', width: 640, toolCallId: 'call-1', tool: { name: 'show', inputSchema: { type: 'object' } }, locale: 'fr-FR', timeZone: 'Europe/Paris' });
  assert.equal(inline.theme, 'dark');
  assert.equal(inline.displayMode, 'inline');
  assert.deepEqual(inline.availableDisplayModes, ['inline', 'fullscreen', 'pip']);
  assert.deepEqual(inline.containerDimensions, { maxWidth: 640, maxHeight: INLINE_HEIGHT.max });
  assert.equal(inline.locale, 'fr-FR');
  assert.equal(inline.toolInfo.id, 'call-1');
  const panel = hostContext({ theme: 'light', displayMode: 'inline', placement: 'panel', width: 500, height: 700, toolCallId: 'c', tool: { name: 'show', inputSchema: {} } });
  assert.deepEqual(panel.containerDimensions, { width: 500, height: 700 });
  for (const [key, value] of Object.entries(THEME_VARIABLES)) if (key.startsWith('--color-')) assert.match(value, /^light-dark\(/, key);
});

test('relay: only JSON-RPC from exactly the view frame and its origin', () => {
  const frame = { window: {}, origin: 'http://s-abc.localhost:5000' };
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
  assert.equal(acceptFrameMessage({ source: frame.window, origin: frame.origin, data: message }, frame), true);
  assert.equal(acceptFrameMessage({ source: {}, origin: frame.origin, data: message }, frame), false, 'another frame (another view)');
  assert.equal(acceptFrameMessage({ source: frame.window, origin: 'http://s-def.localhost:5000', data: message }, frame), false, 'forged origin');
  assert.equal(acceptFrameMessage({ source: frame.window, origin: frame.origin, data: { id: 1 } }, frame), false, 'not JSON-RPC');
  assert.equal(acceptFrameMessage({ source: frame.window, origin: frame.origin, data: 'x' }, frame), false);
  assert.equal(acceptFrameMessage({ source: null, origin: frame.origin, data: message }, { window: null, origin: frame.origin }), false);
});

test('open-link: http(s) to other sites only', () => {
  assert.equal(openableLink('https://modelcontextprotocol.io/', 'http://127.0.0.1:4400'), 'https://modelcontextprotocol.io/');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://127.0.0.1:4400/api/session', 'http://p-x.localhost:1/', 'https://user:pass@example.org/', 'file:///etc/passwd', 42]) assert.equal(openableLink(bad, 'http://127.0.0.1:4400'), undefined, String(bad));
});

test('labels and approvals', () => {
  const view = { app: 'clock', appName: 'Clock', tool: 'get-time', title: 'Get Time' };
  assert.equal(appToolLabel(view, 'running'), 'Clock: Get Time…');
  assert.equal(appToolLabel(view, 'done'), 'Clock: Get Time');
  assert.equal(approvalTitle({ kind: 'call', appName: 'Clock', tool: 'record' }), 'Clock wants to run record');
  assert.equal(approvalTitle({ kind: 'message', appName: 'Clock' }), 'Clock wants to send a message to the agent');
  assert.equal(approvalError({ status: 'denied' }), 'The person denied this action.');
  assert.equal(approvalError({ status: 'expired' }), 'Nobody answered in time.');
});

test('history: a message an app sent keeps its app (the "App" badge after a reload)', () => {
  const app = { id: 'clock', name: 'Clock', toolCallId: 'call-1', approvedBy: { id: 'local', name: 'You' } };
  assert.deepEqual(knownApp({ metadata: { app } }), app);
  assert.equal(knownApp({ metadata: { app: { id: 'clock' } } }), undefined);
  const [message] = historyMessages([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello from the app' }], metadata: { app } }]);
  assert.deepEqual((message!.metadata?.custom as { app?: unknown }).app, app);
});

test('dev reloads: a view keys on its dev app\'s generation; installed apps and unknown tools stay at 0', () => {
  const tools = { dev_notes__show_board: { app: 'dev_notes', appName: 'notes (dev)', tool: 'show_board', dev: true as const }, clock__show: { app: 'clock', appName: 'Clock', tool: 'show' } };
  assert.equal(viewGeneration(tools, { dev_notes: 3 }, 'dev_notes__show_board'), 3);
  assert.equal(viewGeneration(tools, {}, 'dev_notes__show_board'), 0, 'a stopped dev app');
  assert.equal(viewGeneration(tools, { dev_notes: 3, clock: 9 }, 'clock__show'), 0, 'installed apps never remount');
  assert.equal(viewGeneration(tools, { dev_notes: 3 }, 'nope'), 0);
  assert.equal(viewGeneration(tools, { dev_notes: 3 }, undefined), 0);
  assert.equal(devGenerationsKey({ b: 2, a: 1 }), 'a:1,b:2');
  assert.notEqual(devGenerationsKey({ a: 1 }), devGenerationsKey({ a: 2 }));
});
