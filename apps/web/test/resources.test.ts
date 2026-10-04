import test from 'node:test';
import assert from 'node:assert/strict';
import { ancestors, canDrop, clampWidth, DEFAULT_LAYOUT, fileStats, find, footerText, iconKind, parseDelimited, previewKind, readLayout, readShowArchived, resourceError, shortSize, splitArchived, validName, walk, type ResourceNode } from '../src/resources-model.js';

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

test('archived conversations: their folders leave the tree (with their files), user folders stay; nothing else changes', () => {
  const nested: ResourceNode[] = [
    ...tree,
    { name: 'Old trip', path: 'Old trip', type: 'folder', modifiedAt: '', conversationId: 'conv-2', children: [{ name: 'plan.md', path: 'Old trip/plan.md', type: 'file', bytes: 100, modifiedAt: '' }] },
    // A conversation folder the user moved into one of their folders.
    { name: 'Projects', path: 'Projects', type: 'folder', modifiedAt: '', children: [
      { name: 'Q3', path: 'Projects/Q3', type: 'folder', modifiedAt: '', conversationId: 'conv-3', children: [{ name: 'q3.csv', path: 'Projects/Q3/q3.csv', type: 'file', bytes: 50, modifiedAt: '' }] },
      { name: 'keep.txt', path: 'Projects/keep.txt', type: 'file', bytes: 5, modifiedAt: '' },
    ] },
  ];
  const before = JSON.stringify(nested);
  const split = splitArchived(nested, ['Old trip', 'Projects/Q3']);
  assert.deepEqual([...walk(split.visible)].map(n => n.path), ['Trip', 'Trip/Data', 'Trip/Data/a.csv', 'Trip/notes.md', 'Archive', 'Projects', 'Projects/keep.txt']);
  assert.deepEqual(split.archived.map(n => n.path), ['Old trip', 'Projects/Q3'], 'in tree order, with their content');
  assert.deepEqual([...walk(split.archived)].map(n => n.path), ['Old trip', 'Old trip/plan.md', 'Projects/Q3', 'Projects/Q3/q3.csv']);
  assert.equal(JSON.stringify(nested), before, 'the tree itself is left as it was');
  // A user folder named like an archived path is not touched unless it is listed; a file never is.
  assert.deepEqual(splitArchived(nested, ['Projects/keep.txt']).archived, []);
  // Nothing archived, or an older server without the field: everything shows.
  for (const archived of [[], undefined]) { const all = splitArchived(nested, archived); assert.equal(all.visible.length, nested.length); assert.deepEqual(all.archived, []); }
  // Restored: the folder is back in the normal tree.
  assert.ok(splitArchived(nested, ['Projects/Q3']).visible.some(n => n.path === 'Old trip'));
});

test('the footer counts only the files shown, and says how many archived folders are hidden', () => {
  const nested: ResourceNode[] = [...tree, { name: 'Old', path: 'Old', type: 'folder', modifiedAt: '', conversationId: 'conv-2', children: [{ name: 'x.md', path: 'Old/x.md', type: 'file', bytes: 1024, modifiedAt: '' }] }];
  const split = splitArchived(nested, ['Old']);
  assert.deepEqual(fileStats(split.visible), { files: 2, bytes: 2058 });
  assert.equal(footerText(split.visible, split.archived.length), '2 files, 2 KB · 1 archived hidden');
  assert.equal(footerText([...split.visible, ...split.archived], 0), '3 files, 3 KB', 'shown: counted, nothing hidden');
  assert.equal(footerText([], 2), '0 files, 0 B · 2 archived hidden');
  assert.equal(footerText([{ name: 'a', path: 'a', type: 'file', bytes: 1, modifiedAt: '' }], 0), '1 file, 1 B');
  // The toggle is off unless it was turned on.
  assert.equal(readShowArchived(null), false); assert.equal(readShowArchived('false'), false); assert.equal(readShowArchived('true'), true); assert.equal(readShowArchived('{'), false);
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
