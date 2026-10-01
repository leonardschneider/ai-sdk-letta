import test from 'node:test';
import assert from 'node:assert/strict';
import { folderNameFromTitle, parseTitle, safeLinkHref, shortUrl, titleText, type TitleNode } from '../src/index.js';

/** A compact view of parsed nodes: text as strings, constructs as [type, ...]. */
const shape = (nodes: TitleNode[]): unknown[] => nodes.map(node => {
  switch (node.type) {
    case 'text': return node.value;
    case 'code': return ['code', node.value];
    case 'image': return ['image', node.alt];
    case 'link': return ['link', node.href ?? null, ...(node.auto ? ['auto'] : []), ...shape(node.children)];
    default: return [node.type, ...shape(node.children)];
  }
});

test('titles parse inline Markdown: links, bold, italic and code', () => {
  assert.deepEqual(shape(parseTitle('Review [Spec](https://example.com) **v2**')), ['Review ', ['link', 'https://example.com/', 'Spec'], ' ', ['strong', 'v2']]);
  assert.deepEqual(shape(parseTitle('*one* _two_ __three__ `four`')), [['emphasis', 'one'], ' ', ['emphasis', 'two'], ' ', ['strong', 'three'], ' ', ['code', 'four']]);
  assert.deepEqual(shape(parseTitle('**[bold link](https://a.example/x)** and [**inner**](https://b.example)')),
    [['strong', ['link', 'https://a.example/x', 'bold link']], ' and ', ['link', 'https://b.example/', ['strong', 'inner']]]);
  assert.deepEqual(shape(parseTitle('`**not bold**` and `[not](https://x.example)`')), [['code', '**not bold**'], ' and ', ['code', '[not](https://x.example)']]);
  assert.deepEqual(shape(parseTitle('[a](https://x.example/a_(b)) "t"')), [['link', 'https://x.example/a_(b)', 'a'], ' "t"']);
  assert.deepEqual(shape(parseTitle('[t](https://x.example "Title")')), [['link', 'https://x.example/', 't']]);
});

test('anything that is not inline Markdown stays text', () => {
  for (const text of ['# Heading', '- item', '1. first', '> quote', '2 * 3 * 4', 'snake_case_name', 'a ** b ** c', '* not a list item', '[no link]', '**unclosed', '`unclosed']) {
    assert.equal(titleText(text), text.replace(/\s+/g, ' '), text);
    assert.ok(parseTitle(text).every(node => node.type === 'text'), text);
  }
  // An unclosed link is text; the URL inside it is still a bare URL.
  assert.deepEqual(shape(parseTitle('[unclosed](https://x.example')), ['[unclosed](', ['link', 'https://x.example/', 'auto', 'https://x.example']]);
  assert.deepEqual(shape(parseTitle('\\*literal\\* and \\[x\\](y)')), ['*literal* and [x](y)']);
  assert.deepEqual(shape(parseTitle('![diagram](https://x.example/a.png) here')), [['image', 'diagram'], ' here']);
});

test('only http, https and mailto links are active', () => {
  assert.equal(safeLinkHref('https://example.com/a?b=c#d'), 'https://example.com/a?b=c#d');
  assert.equal(safeLinkHref('http://example.com'), 'http://example.com/');
  assert.equal(safeLinkHref('mailto:me@example.com'), 'mailto:me@example.com');
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', '//evil.example', '/relative', 'relative', 'https://', 'mailto:', 'mailto:nobody', 'https://exa mple.com', 'https://x.example/\u202e', 'ftp://x.example']) {
    assert.equal(safeLinkHref(bad), undefined, bad);
  }
  const inert = parseTitle('[click](javascript:alert(1)) [data](data:text/html,x)');
  assert.deepEqual(shape(inert), [['link', null, 'click'], ' ', ['link', null, 'data']]);
  assert.equal(titleText('[click](javascript:alert(1))'), 'click');
});

test('bare URLs, <autolinks> and www. addresses become links', () => {
  assert.deepEqual(shape(parseTitle('See https://example.com/docs/page.')), ['See ', ['link', 'https://example.com/docs/page', 'auto', 'https://example.com/docs/page'], '.']);
  assert.deepEqual(shape(parseTitle('(https://example.com/a_(b)) done')), ['(', ['link', 'https://example.com/a_(b)', 'auto', 'https://example.com/a_(b)'], ') done']);
  assert.deepEqual(shape(parseTitle('www.example.com, then mailto:me@example.com')), [['link', 'https://www.example.com/', 'auto', 'www.example.com'], ', then ', ['link', 'mailto:me@example.com', 'auto', 'mailto:me@example.com']]);
  assert.deepEqual(shape(parseTitle('<https://example.com> <me@example.com>')), [['link', 'https://example.com/', 'auto', 'https://example.com'], ' ', ['link', 'mailto:me@example.com', 'auto', 'me@example.com']]);
  assert.deepEqual(shape(parseTitle('**https://example.com**')), [['strong', ['link', 'https://example.com/', 'auto', 'https://example.com']]]);
  // Not URLs: inside words, scheme only, other schemes.
  assert.deepEqual(shape(parseTitle('xhttps://example.com https:// javascript:alert(1)')), ['xhttps://example.com https:// javascript:alert(1)']);
});

test('plain text of a title is what it shows: search, window titles, terminal', () => {
  assert.equal(titleText('Review [Spec](https://example.com) **v2**'), 'Review Spec v2');
  assert.equal(titleText('Fix `parse()` in *core*'), 'Fix parse() in core');
  assert.equal(titleText('Read https://example.com/a'), 'Read https://example.com/a');
  assert.equal(titleText('Read https://example.com/a', { shortUrls: true }), 'Read example.com/a');
  assert.equal(titleText('  many   spaces '), 'many spaces');
  assert.equal(shortUrl('https://www.example.com/'), 'example.com');
  assert.equal(shortUrl('https://example.com/docs/a-very-long-path/with/many/segments'), 'example.com/docs/a-very-long-pa…');
  assert.equal([...shortUrl('https://example.com/' + 'x'.repeat(80))].length, 32);
});

test('folder names come from the text a title shows, never its Markdown', () => {
  assert.equal(folderNameFromTitle('[Spec](https://x)', 'f'), 'Spec');
  assert.equal(folderNameFromTitle('Review [Spec](https://example.com) **v2**', 'f'), 'Review Spec v2');
  assert.equal(folderNameFromTitle('Notes on `config.ts` and *tests*', 'f'), 'Notes on config.ts and tests');
  assert.equal(folderNameFromTitle('Read https://example.com/docs/guide', 'f'), 'Read example.com - docs - guide');
  assert.equal(folderNameFromTitle('[](https://x)', 'Conversation abc'), 'Conversation abc');
  assert.equal(folderNameFromTitle('[evil](javascript:alert(1)) plan', 'f'), 'evil plan');
});
