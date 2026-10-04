import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREVIEW_LAYOUT, addressOf, clampPreviewWidth, devServerRunning, folderLabel, frameUrl, originLabel, readPreviewLayout, statusLine, type PreviewStatus } from '../src/preview-model.js';

const base = 'http://p-0123456789abcdef0123456789abcdef.localhost:4555/';

test('address bar: paths on the preview origin only', () => {
  assert.equal(frameUrl('/about?x=1#y', base), 'http://p-0123456789abcdef0123456789abcdef.localhost:4555/about?x=1#y');
  assert.equal(frameUrl('about', base), 'http://p-0123456789abcdef0123456789abcdef.localhost:4555/about');
  assert.equal(frameUrl('', base), base);
  // The agent's address of the dev server maps onto the preview.
  assert.equal(frameUrl('http://127.0.0.1:5173/list', base), 'http://p-0123456789abcdef0123456789abcdef.localhost:4555/list');
  assert.equal(frameUrl(`${base}x`, base), `${base}x`);
  for (const bad of ['http://127.0.0.1:4400/api/session', '//evil.com/x', 'javascript:alert(1)', 'https://evil.com', 'http://p-ffffffffffffffffffffffffffffffff.localhost:4555/', 'data:text/html,x', '/a\nb']) assert.equal(frameUrl(bad, base), undefined, bad);
  assert.equal(addressOf(`${base}about?x=1`, base), '/about?x=1');
  assert.equal(addressOf('https://evil.com/', base), '/');
});

test('status: live only with a running dev server; labels', () => {
  const live: PreviewStatus = { enabled: true, previewUrl: base, container: 'running', devServer: { folder: '/workspace/Todo app/todo', command: 'npm run dev', startedAt: '2026-10-04T00:00:00Z' }, origins: ['https://cdn.jsdelivr.net'] };
  assert.equal(devServerRunning(live), true);
  assert.equal(devServerRunning({ ...live, container: 'stopped' }), false);
  assert.equal(devServerRunning({ enabled: true, previewUrl: base, container: 'running', origins: [] }), false);
  assert.equal(devServerRunning({ enabled: false }), false);
  assert.equal(devServerRunning(undefined), false);
  assert.equal(statusLine(live), 'Live · Todo app/todo');
  assert.equal(statusLine({ enabled: true, previewUrl: base, container: 'starting', origins: [] }), 'Starting…');
  assert.equal(statusLine({ enabled: true, previewUrl: base, container: 'stopped', origins: [] }), 'No dev server');
  assert.equal(folderLabel('/workspace'), '/workspace');
  assert.equal(originLabel('https://cdn.jsdelivr.net'), 'cdn.jsdelivr.net');
  assert.equal(originLabel('https://x.example.com:8443'), 'x.example.com:8443');
});

test('layout: persisted, validated, clamped', () => {
  assert.deepEqual(readPreviewLayout(null), DEFAULT_PREVIEW_LAYOUT);
  assert.deepEqual(readPreviewLayout('{oops'), DEFAULT_PREVIEW_LAYOUT);
  assert.deepEqual(readPreviewLayout(JSON.stringify({ open: true, width: 99999, device: 'phone' })), { open: true, width: 1200, device: 'phone' });
  assert.deepEqual(readPreviewLayout(JSON.stringify({ open: 'yes', width: 10, device: 'tv' })), { open: false, width: 320, device: 'desktop' });
  assert.equal(clampPreviewWidth(NaN), 560);
});
