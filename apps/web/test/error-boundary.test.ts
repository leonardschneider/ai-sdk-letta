import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportLimiter, clientErrorReport, errorMessage, REPORT_LIMITS } from '../src/error-model.js';
import { AppErrorPanel, ErrorBoundary, ErrorCard } from '../src/error-boundary.js';

test('error reports: bounded message and stacks, no query strings of URLs', () => {
  const error = new TypeError('Cannot read properties of undefined (reading \'tool\')');
  error.stack = `TypeError: boom\n    at AppPanel (http://127.0.0.1:4400/assets/index.js?v=1#frag:9:48)\n${'x'.repeat(10_000)}`;
  const report = clientErrorReport('side-panel', error, '\n    at AppPanel\n    at SideBoundary', new Date('2026-10-09T10:00:00Z'));
  assert.equal(report.where, 'side-panel');
  assert.equal(report.message, 'TypeError: Cannot read properties of undefined (reading \'tool\')');
  assert.equal(report.at, '2026-10-09T10:00:00.000Z');
  assert.ok(report.stack!.length <= REPORT_LIMITS.stack);
  assert.match(report.stack!, /http:\/\/127\.0\.0\.1:4400\/assets\/index\.js:9:48|index\.js/);
  assert.doesNotMatch(report.stack!, /\?v=1|#frag/);
  assert.match(report.componentStack!, /SideBoundary/);
  assert.equal(clientErrorReport('app', 'x'.repeat(2000)).message.length, REPORT_LIMITS.message);
  assert.equal(errorMessage(new Error('')), 'Unknown error');
  assert.equal(errorMessage({ code: 1 }), '{"code":1}');
});

test('error reports: rate limited per minute, the same error once', () => {
  const limiter = new ReportLimiter(3, 60_000);
  const a = { where: 'message' as const, message: 'a' };
  assert.equal(limiter.allow(a, 0), true);
  assert.equal(limiter.allow(a, 10), false, 'the same error again within the minute');
  assert.equal(limiter.allow({ ...a, message: 'b' }, 20), true);
  assert.equal(limiter.allow({ ...a, message: 'c' }, 30), true);
  assert.equal(limiter.allow({ ...a, message: 'd' }, 40), false, 'at most 3 a minute');
  assert.equal(limiter.allow({ ...a, message: 'd' }, 60_001), true, 'a minute later');
  assert.equal(limiter.allow(a, 60_031), true, 'once the earlier ones are a minute old');
});

test('fallbacks: the inline card and the top-level panel (Try again, Reload, collapsed details)', () => {
  const card = renderToStaticMarkup(React.createElement(ErrorCard, { error: new Error('bad view'), reset: () => {}, label: 'This message couldn’t be shown.' }));
  assert.match(card, /role="alert"/);
  assert.match(card, /This message couldn’t be shown\./);
  assert.match(card, />Try again</);
  assert.match(card, /<details class="error-details"><summary>Details<\/summary><pre>bad view<\/pre><\/details>/);
  const panel = renderToStaticMarkup(React.createElement(AppErrorPanel, { error: new Error('render failed'), reset: () => {} }));
  assert.match(panel, /Something went wrong/);
  assert.match(panel, />Try again</);
  assert.match(panel, /Reload<\/button>/);
  assert.match(panel, /<details class="error-details"><summary>Error details<\/summary><pre>render failed/);
});

test('boundary: renders its children, or its fallback once a render error is caught (a new reset key renders them again)', () => {
  const ok = renderToStaticMarkup(React.createElement(ErrorBoundary, { where: 'message', fallback: () => 'fallback', children: React.createElement('p', null, 'fine') }));
  assert.equal(ok, '<p>fine</p>');
  const state = ErrorBoundary.getDerivedStateFromError(new Error('x'));
  assert.ok(state.error);
  assert.deepEqual(ErrorBoundary.getDerivedStateFromProps({ where: 'message', fallback: () => null, children: null, resetKey: 'b' }, { error: { value: 1 }, key: 'a' }), { key: 'b', error: undefined });
  assert.equal(ErrorBoundary.getDerivedStateFromProps({ where: 'message', fallback: () => null, children: null, resetKey: 'a' }, { error: { value: 1 }, key: 'a' }), null);
  const boundary = new ErrorBoundary({ where: 'message', fallback: ({ error }) => `failed: ${(error as Error).message}`, children: 'fine' });
  boundary.state = { error: { value: new Error('boom') } };
  assert.equal(boundary.render(), 'failed: boom');
});
