import test from 'node:test';
import assert from 'node:assert/strict';
import { hostCapabilities, VIEW_STATE_EXTENSION, VIEW_STATE_SAVE, viewStateContext, viewStateParams, acceptFrameMessage, appToolLabel, approvalError, approvalTitle, devGenerationsKey, hostContext, isAppToolName, viewGeneration, inlineHeight, INLINE_HEIGHT, nextDisplayMode, openableLink, THEME_VARIABLES, appDownReason, appStatusLine, VIEW_HEARTBEAT_MS } from '../src/apps-model.js';
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
  // A dev app's tools are app tools too (their line shows the view).
  assert.ok(isAppToolName('dev_notes__show_board'));
  assert.ok(isAppToolName('clock__show'));
  assert.ok(!isAppToolName('run_command'));
  assert.ok(!isAppToolName('app_dev_start'));
  assert.notEqual(devGenerationsKey({ a: 1 }), devGenerationsKey({ a: 2 }));
});

test('size-changed: small changes and oscillations are damped (no jitter)', async () => {
  const { SizeDamper, SIZE_DAMPING } = await import('../src/apps-model.js');
  const damper = new SizeDamper(160);
  assert.equal(damper.next(300, 0), 300, 'a real change applies');
  assert.equal(damper.next(301, 10), undefined, '±1px is ignored');
  assert.equal(damper.next(298, 20), undefined, '±2px is ignored');
  assert.equal(damper.next(320, 30), 320, 'growing applies');
  assert.equal(damper.next(300, 40), undefined, 'shrinking back to a height just seen is an oscillation: held');
  assert.equal(damper.next(320, 50), undefined, 'and the held height stays');
  assert.equal(damper.next(250, 60), undefined, 'no shrinking while it oscillates');
  assert.equal(damper.next(250, 60 + SIZE_DAMPING.window + 1), 250, 'after the window a real shrink applies');
  assert.equal(damper.next(10_000, 3000), INLINE_HEIGHT.max, 'bounded');
  assert.equal(damper.next(undefined, 3100), undefined);
});

test('one live view: the latest call of each app view, pins, policy', async () => {
  const { liveViews, liveCallOf, viewIdentity, readViewPolicy, viewPolicyKey } = await import('../src/apps-model.js');
  const viewTools = {
    chess__move: { app: 'chess', appName: 'Chess', tool: 'move', resourceUri: 'ui://chess/board' },
    chess__new: { app: 'chess', appName: 'Chess', tool: 'new', resourceUri: 'ui://chess/board' },
    clock__time: { app: 'clock', appName: 'Clock', tool: 'time', resourceUri: 'ui://clock/view' },
  };
  const calls = [{ id: 'a', tool: 'chess__new' }, { id: 'b', tool: 'clock__time' }, { id: 'c', tool: 'chess__move' }, { id: 'd', tool: 'clock__time' }, { id: 'e', tool: 'chess__move' }];
  const single = () => 'single' as const;
  const live = liveViews(calls, viewTools, single);
  assert.deepEqual(live, { [viewIdentity(viewTools.chess__move)]: 'e', [viewIdentity(viewTools.clock__time)]: 'd' }, 'tools sharing a view are one view; the latest call is live');
  assert.equal(liveCallOf(live, viewTools, 'chess__new', 'a'), 'e');
  assert.equal(liveCallOf(live, viewTools, 'other__x', 'z'), 'z');
  const chess = viewIdentity(viewTools.chess__move);
  assert.equal(liveViews(calls, viewTools, single, { [chess]: { id: 'c', newest: 'e' } })[chess], 'c', '"Show this one"');
  assert.equal(liveViews([...calls, { id: 'f', tool: 'chess__move' }], viewTools, single, { [chess]: { id: 'c', newest: 'e' } })[chess], 'f', 'a newer call takes over from a pin');
  assert.equal(liveViews(calls, viewTools, single, { [chess]: { id: 'gone', newest: 'e' } })[chess], 'e', 'a pin of an unknown call is ignored');
  assert.deepEqual(Object.keys(liveViews(calls, viewTools, app => app === 'chess' ? 'every' : 'single')), [viewIdentity(viewTools.clock__time)], 'every call its own view: not collapsed');
  assert.equal(readViewPolicy(null), 'single', 'default: one live view');
  assert.equal(readViewPolicy('every'), 'every');
  assert.equal(readViewPolicy('junk'), 'single');
  assert.equal(viewPolicyKey('agent-1', 'chess'), 'ai-sdk-letta-app-views:agent-1:chess');
});

test('a view asks again while its call runs, and briefly when its phase is unknown (a panel retargeted to a streaming call)', async () => {
  const { retryInstance } = await import('../src/apps-model.js');
  assert.equal(retryInstance('running', 0), true);
  assert.equal(retryInstance('running', 40), false, 'bounded');
  assert.equal(retryInstance(undefined, 0), true, 'the panel and full screen: a call that streams is recorded a moment later');
  assert.equal(retryInstance(undefined, 12), false);
  assert.equal(retryInstance('done', 0), false, 'a finished call is recorded at once: no retry');
});

test('app messages: the first sentence, IDs shortened, at most 80 characters; the full text stays for the agent', async () => {
  const { appMessageSummary, shortenIds } = await import('../src/apps-model.js');
  const chess = 'I played e2e4. Play the next move on ChessOS board 86e6b101-66f8-4107-93e0-c12b90845214. Get its latest state and use make_move with expected_fen.';
  assert.deepEqual(appMessageSummary(chess), { summary: 'I played e2e4.', truncated: true });
  assert.deepEqual(appMessageSummary('Hello'), { summary: 'Hello', truncated: false }, 'short: nothing to expand');
  assert.deepEqual(appMessageSummary('line one\nline two'), { summary: 'line one', truncated: true }, 'the first line');
  assert.equal(appMessageSummary('Use e.g. 1.5 values. Next').summary, 'Use e.g. 1.5 values.', 'not split inside "e.g." or "1.5"');
  const long = appMessageSummary(`Board 86e6b101-66f8-4107-93e0-c12b90845214 changed ${'and more words '.repeat(10)}`);
  assert.ok(long.summary.length <= 80 && long.summary.endsWith('…') && long.summary.startsWith('Board 86e6b101… changed'), long.summary);
  assert.equal(shortenIds('board 86E6B101-66f8-4107-93e0-c12b90845214.'), 'board 86E6B101….');
  assert.equal(shortenIds('token abcdef0123456789abcdef!'), 'token abcdef01…!');
  assert.equal(shortenIds('internationalization rnbqkbnr/pppppppp/8 e2e4'), 'internationalization rnbqkbnr/pppppppp/8 e2e4', 'words, FENs and moves stay');
});

test('view state (host extension): namespaced capability and host context key, { state } params', () => {
  assert.equal(VIEW_STATE_EXTENSION, 'io.ai-sdk-letta/viewState');
  assert.equal(VIEW_STATE_SAVE, 'ui/state/save');
  const csp = { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };
  assert.deepEqual(hostCapabilities(csp).experimental, { 'io.ai-sdk-letta/viewState': {} }, 'advertised for feature detection');
  assert.deepEqual(hostCapabilities(csp).sandbox, { csp });
  assert.deepEqual(viewStateContext({ viewState: { n: 2 } }), { 'io.ai-sdk-letta/viewState': { state: { n: 2 } } });
  assert.deepEqual(viewStateContext({ viewState: null }), { 'io.ai-sdk-letta/viewState': { state: null } }, 'null is a saved state');
  assert.deepEqual(viewStateContext({}), {}, 'nothing saved: no key');
  assert.deepEqual(viewStateParams['~standard'].validate({ state: [1] }), { value: { state: [1] } });
  assert.ok('issues' in viewStateParams['~standard'].validate({}));
  assert.ok('issues' in viewStateParams['~standard'].validate(null));
});

test('not-running reasons: idle, failed, starting, exited, manual; the Apps dialog line', () => {
  assert.equal(appDownReason({ appStatus: 'stopped', stopReason: 'idle' }), 'Stopped after 30 min idle.');
  assert.equal(appDownReason({ appStatus: 'failed', error: 'Cannot find module' }), 'Failed to start: Cannot find module');
  assert.equal(appDownReason({ appStatus: 'failed' }), 'Failed to start.');
  assert.equal(appDownReason({ appStatus: 'starting' }), 'Starting…');
  assert.equal(appDownReason({ appStatus: 'stopped', stopReason: 'exited', error: 'The dev app server exited' }), 'Its server exited: The dev app server exited');
  assert.equal(appDownReason({ appStatus: 'stopped', stopReason: 'restart' }), 'Stopped when the app restarted.');
  assert.equal(appDownReason({ appStatus: 'stopped', stopReason: 'manual' }), 'Stopped.');
  assert.equal(appDownReason({ appStatus: 'stopped' }), 'Not running.');
  assert.equal(appStatusLine({ status: 'running', enabled: true }), 'Running');
  assert.equal(appStatusLine({ status: 'running', enabled: false }), 'Disabled');
  assert.equal(appStatusLine({ status: 'stopped', enabled: true, stopReason: 'idle' }), 'Stopped after 30 min idle');
  assert.equal(appStatusLine({ status: 'failed', enabled: true, error: 'boom' }), 'Failed to start: boom');
  assert.ok(VIEW_HEARTBEAT_MS <= 60_000);
});
