import test from 'node:test';
import assert from 'node:assert/strict';
import { ancestors, canDrop, clampWidth, DEFAULT_LAYOUT, find, iconKind, parseDelimited, previewKind, readLayout, resourceError, shortSize, validName, walk, type ResourceNode } from '../src/resources-model.js';

const tree: ResourceNode[] = [
  { name: 'Trip', path: 'Trip', type: 'folder', modifiedAt: '', conversationId: 'conv-1', children: [
    { name: 'Data', path: 'Trip/Data', type: 'folder', modifiedAt: '', children: [{ name: 'a.csv', path: 'Trip/Data/a.csv', type: 'file', bytes: 10, modifiedAt: '' }] },
    { name: 'notes.md', path: 'Trip/notes.md', type: 'file', bytes: 2048, modifiedAt: '' },
  ] },
  { name: 'Archive', path: 'Archive', type: 'folder', modifiedAt: '', children: [] },
];

test('preview kinds and icons follow the extension; anything unknown has no preview', () => {
  assert.deepEqual(['a.csv', 'b.TSV', 'c.md', 'd.txt', 'e.html', 'f.pdf', 'g.png', 'h.jpeg', 'i.py', 'README', 'j.zip', 'k.docx'].map(previewKind), ['table', 'table', 'markdown', 'text', 'html', 'pdf', 'image', 'image', 'text', 'text', 'none', 'none']);
  assert.deepEqual(['a.csv', 'c.md', 'd.txt', 'e.html', 'f.pdf', 'g.webp', 'i.ts', 'j.zip'].map(iconKind), ['table', 'markdown', 'text', 'html', 'pdf', 'image', 'code', 'other']);
  assert.equal(shortSize(512), '512 B'); assert.equal(shortSize(2048), '2 KB'); assert.equal(shortSize(3 * 1024 * 1024), '3 MB'); assert.equal(shortSize(undefined), '');
});

test('tree helpers: walk, find, ancestors, and where a drag may drop', () => {
  assert.deepEqual([...walk(tree)].map(n => n.path), ['Trip', 'Trip/Data', 'Trip/Data/a.csv', 'Trip/notes.md', 'Archive']);
  assert.equal(find(tree, 'Trip/notes.md')?.bytes, 2048);
  assert.deepEqual(ancestors('Trip/Data/a.csv'), ['Trip', 'Trip/Data']);
  assert.equal(canDrop('Trip/notes.md', 'Archive'), true);
  assert.equal(canDrop('Trip/notes.md', ''), true, 'to the top level');
  assert.equal(canDrop('Trip/notes.md', 'Trip'), false, 'already there');
  assert.equal(canDrop('Trip', 'Trip/Data'), false, 'not into itself');
  assert.equal(canDrop('Trip', 'Trip'), false);
  assert.equal(canDrop('Archive', ''), false);
});

test('names are validated like the server does', () => {
  assert.equal(validName('Report 2026.pdf'), undefined);
  for (const bad of ['', '  ', 'a/b', 'a\\b', '.hidden', 'x'.repeat(121), 'a\u0000b', 'a\u202eb']) assert.ok(validName(bad), JSON.stringify(bad));
});

test('CSV and TSV: quotes, escaped quotes, newlines in fields, CRLF, BOM, and a row cap', () => {
  assert.deepEqual(parseDelimited('\ufeffname,note\r\n"Lee, Sam","said ""hi""\nthen left"\r\nAna,\n', ',').rows, [['name', 'note'], ['Lee, Sam', 'said "hi"\nthen left'], ['Ana', '']]);
  assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t').rows, [['a', 'b'], ['1', '2']]);
  const many = parseDelimited(Array.from({ length: 1000 }, (_, i) => `r${i},x`).join('\n'), ',', 100);
  assert.equal(many.rows.length, 100); assert.equal(many.truncated, true);
  assert.equal(parseDelimited('a,b\n1,2\n', ',', 100).truncated, false);
});

test('layout is persisted defensively: bad or missing values fall back, width is clamped', () => {
  assert.deepEqual(readLayout(null), DEFAULT_LAYOUT);
  assert.deepEqual(readLayout('{oops'), DEFAULT_LAYOUT);
  assert.deepEqual(readLayout(JSON.stringify({ sidebar: false, resources: true, resourcesWidth: 9999 })), { sidebar: false, resources: true, resourcesWidth: 640 });
  assert.deepEqual(readLayout(JSON.stringify({ sidebar: 'no', resourcesWidth: 10 })), { sidebar: true, resources: false, resourcesWidth: 240 });
  assert.equal(clampWidth(NaN), 320);
  assert.match(resourceError('file_exists'), /already there/);
  assert.match(resourceError('whatever'), /Nothing was changed/);
});

test('Atlassian documents (.adf.json) preview with the Atlassian renderer; saved and bare documents parse', async () => {
  const { parseAtlassianDocument } = await import('../src/resources-model.js');
  assert.equal(previewKind('KAN-1.adf.json'), 'atlassian');
  assert.equal(previewKind('data.json'), 'text');
  assert.equal(iconKind('KAN-1.adf.json'), 'atlassian');
  const saved = { format: 'ai-sdk-letta/atlassian@1', source: { product: 'jira', url: 'https://a.atlassian.net/browse/KAN-1', title: 'T', key: 'KAN-1' }, media: {}, document: { type: 'doc', version: 1, content: [] } };
  assert.equal(parseAtlassianDocument(JSON.stringify(saved))?.source?.key, 'KAN-1');
  assert.deepEqual(parseAtlassianDocument('{"type":"doc","version":1,"content":[]}')?.document.content, []);
  assert.equal(parseAtlassianDocument('{"type":"paragraph"}'), undefined);
  assert.equal(parseAtlassianDocument('not json'), undefined);
  assert.equal(resourceError('atlassian_not_connected'), 'Connect Atlassian to load its images.');
});
