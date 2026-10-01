import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { versionLine, versionParts } from '../src/versions.js';
import { VersionInfo } from '../src/version-info.js';

test('version parts and line: all three, unknown ones left out, nothing when none is known', () => {
  assert.equal(versionLine({ aiSdkLetta: '0.5.0', server: '0.5.0', lettaSdk: '0.8.22' }), 'ai-sdk-letta 0.5.0 · server 0.5.0 · Letta SDK 0.8.22');
  assert.equal(versionLine({ aiSdkLetta: '0.5.1', server: null, lettaSdk: '0.8.22' }), 'ai-sdk-letta 0.5.1 · Letta SDK 0.8.22');
  assert.equal(versionLine({ aiSdkLetta: null, server: null, lettaSdk: null }), '');
  assert.equal(versionLine({}), '');
  assert.equal(versionLine(undefined), '');
  assert.deepEqual(versionParts({ aiSdkLetta: '0.5.0', server: null, lettaSdk: '0.8.22' }), ['ai-sdk-letta 0.5.0', 'Letta SDK 0.8.22']);
});

test('About: the versions as selectable text with a copy button; nothing before the session answers', () => {
  const html = renderToStaticMarkup(createElement(VersionInfo, { versions: { aiSdkLetta: '0.5.0', server: '0.5.0', lettaSdk: '0.8.22' } }));
  const text = /<span class="mono versions-text">(.*?)<\/span><button/.exec(html)?.[1];
  assert.equal(text?.replace(/<[^>]+>/g, ''), 'ai-sdk-letta 0.5.0 · server 0.5.0 · Letta SDK 0.8.22');
  // Each "name version" stays on one line.
  assert.deepEqual([...html.matchAll(/<span class="versions-part">([^<]*)<\/span>/g)].map(m => m[1]), ['ai-sdk-letta 0.5.0', 'server 0.5.0', 'Letta SDK 0.8.22']);
  assert.match(html, /<button type="button" class="icon-btn small versions-copy" aria-label="Copy versions"/);
  assert.equal(renderToStaticMarkup(createElement(VersionInfo, { versions: undefined })), '');
});
