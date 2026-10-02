import test from 'node:test';
import assert from 'node:assert/strict';
import { adfHash, adfToMarkdown, lostElements, markdownToAdf, spliceMarkdown, splitBlocks, validateAdf, type AdfDocument, type AdfNode } from '../src/index.js';

const t = (text: string, marks?: AdfNode['marks']): AdfNode => marks ? { type: 'text', text, marks } : { type: 'text', text };
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const doc = (...content: AdfNode[]): AdfDocument => ({ version: 1, type: 'doc', content });
const mention = { type: 'mention', attrs: { id: 'acc-1', text: '@Jane Doe' } };
const status = { type: 'status', attrs: { text: 'IN PROGRESS', color: 'blue', localId: 's-1' } };

/** A document with plain blocks and blocks holding protected elements. */
const rich = doc(
  { type: 'heading', attrs: { level: 2 }, content: [t('Context')] },
  p(t('Owner: '), mention, t(' — state '), status, t('.')),
  p(t('Plain paragraph with '), t('bold', [{ type: 'strong' }]), t(' and a '), t('link', [{ type: 'link', attrs: { href: 'https://example.com/a' } }]), t('.')),
  { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('Info panel.'))] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }, { type: 'listItem', content: [p(t('two'))] }] },
  { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { id: 'f-1', type: 'file', collection: '', alt: 'shot.png' } }] },
  p(t('Closing paragraph.')),
);

test('ADF → Markdown: plain Markdown with readable tokens for what Markdown cannot show', () => {
  const md = adfToMarkdown(rich);
  assert.equal(md, [
    '## Context',
    'Owner: @Jane Doe — state [status: IN PROGRESS].',
    'Plain paragraph with **bold** and a [link](https://example.com/a).',
    '> **[info panel]**\n> Info panel.',
    '- one\n- two',
    '[image: shot.png]',
    'Closing paragraph.',
  ].join('\n\n') + '\n');
  // Media named by their attachment when known.
  assert.match(adfToMarkdown(rich, { mediaName: attrs => attrs.id === 'f-1' ? 'screenshot 1.png' : undefined }), /\[image: screenshot 1\.png\]/);
  // Literal Markdown characters are escaped, so the text reads back as text.
  const literal = doc(p(t('Use *args, a_b, [x], <b>tag</b> and # not heading')));
  assert.deepEqual(markdownToAdf(adfToMarkdown(literal)).content, literal.content);
  assert.equal(adfToMarkdown(doc()), '');
});

test('Markdown → ADF: headings, lists, tasks, code, tables, links and marks; valid ADF; raw HTML stays text', () => {
  const converted = markdownToAdf('# Title\n\nSome **bold** *it* ~~old~~ `code` [x](https://e.com) <b>raw</b>\n\n- a\n  - b\n\n3. c\n\n- [ ] todo\n- [x] done\n\n```ts\nconst a = 1;\n```\n\n> quote\n\n---\n\n| h | i |\n| - | - |\n| 1 |  |\n');
  assert.equal(validateAdf(converted).valid, true, JSON.stringify(validateAdf(converted)));
  const types = converted.content.map(n => n.type);
  assert.deepEqual(types, ['heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'blockquote', 'rule', 'table']);
  const inline = converted.content[1]!.content!;
  assert.deepEqual(inline.filter(n => n.marks).map(n => n.marks!.map(m => m.type).join('+')), ['strong', 'em', 'strike', 'code', 'link']);
  assert.ok(inline.some(n => n.text?.includes('<b>raw</b>')), 'HTML is kept as text, never interpreted');
  assert.equal(converted.content[3]!.attrs?.order, 3);
  assert.deepEqual(converted.content[4]!.content!.map(n => n.attrs?.state), ['TODO', 'DONE']);
  // Only http(s) and mailto links become links.
  assert.equal(markdownToAdf('[x](javascript:alert(1))').content[0]!.content!.some(n => n.marks), false);
});

test('validateAdf accepts real documents and rejects invalid ones', () => {
  assert.equal(validateAdf(rich).valid, true);
  const invalid = validateAdf({ version: 1, type: 'doc', content: [{ type: 'bogus' }] });
  assert.equal(invalid.valid, false);
  assert.equal(validateAdf({ type: 'doc' }).valid, false);
});

test('splice: an unchanged document is a no-op and keeps every attribute', () => {
  const result = spliceMarkdown(rich, adfToMarkdown(rich));
  assert.equal(result.ok && result.unchanged, true);
  // Trailing whitespace and line endings do not count as edits.
  const crlf = spliceMarkdown(rich, adfToMarkdown(rich).replace(/\n/g, '\r\n') + '\n\n');
  assert.equal(crlf.ok && crlf.unchanged, true);
});

test('splice: editing one paragraph rewrites only that block; every other block is kept verbatim', () => {
  const md = adfToMarkdown(rich).replace('Plain paragraph with **bold** and a', 'Edited paragraph with **bold** and a');
  const result = spliceMarkdown(rich, md);
  assert.ok(result.ok && !result.unchanged, JSON.stringify(result));
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.from, 2);
  assert.equal(result.changes[0]!.to, 3);
  for (const i of [0, 1, 3, 4, 5, 6]) assert.strictEqual(result.doc.content[i], rich.content[i], `block ${i} must be the original object`);
  assert.equal(result.doc.content[2]!.content![0]!.text, 'Edited paragraph with ');
  assert.equal(validateAdf(result.doc).valid, true);
});

test('splice: an appended paragraph is an insertion, never an edit of the block before it', () => {
  const md = `${adfToMarkdown(rich).trimEnd()}\n\nA new closing line from the agent.\n`;
  const result = spliceMarkdown(rich, md);
  assert.ok(result.ok && !result.unchanged);
  assert.equal(result.changes.length, 1);
  assert.deepEqual([result.changes[0]!.from, result.changes[0]!.to, result.changes[0]!.before.length], [7, 7, 0]);
  assert.equal(result.doc.content.length, rich.content.length + 1);
  for (let i = 0; i < rich.content.length; i++) assert.strictEqual(result.doc.content[i], rich.content[i]);
  // Inserted between two blocks too (right after a protected block): still an insertion.
  const between = adfToMarkdown(rich).replace('[image: shot.png]\n\n', '[image: shot.png]\n\nInserted after the image.\n\n');
  const inserted = spliceMarkdown(rich, between);
  assert.ok(inserted.ok && !inserted.unchanged);
  assert.deepEqual([inserted.changes[0]!.from, inserted.changes[0]!.to], [6, 6]);
});

test('splice: removing a plain block removes only it', () => {
  const md = adfToMarkdown(rich).replace('- one\n- two\n\n', '');
  const result = spliceMarkdown(rich, md);
  assert.ok(result.ok && !result.unchanged);
  assert.deepEqual(result.doc.content.map(n => n.type), ['heading', 'paragraph', 'paragraph', 'panel', 'mediaSingle', 'paragraph']);
  assert.strictEqual(result.doc.content[4], rich.content[5]);
});

test('splice: an edit touching a mention, status, panel or image is refused and names them', () => {
  const lostMention = spliceMarkdown(rich, adfToMarkdown(rich).replace('Owner: @Jane Doe — state', 'Owner: Jane — current state'));
  assert.equal(lostMention.ok, false);
  assert.ok(!lostMention.ok && lostMention.reason === 'protected');
  if (!lostMention.ok && lostMention.reason === 'protected') {
    assert.deepEqual(lostMention.lost, ['mention @Jane Doe', 'status "IN PROGRESS"']);
    assert.match(lostMention.message, /mention @Jane Doe/);
    assert.match(lostMention.message, /Nothing was written/);
  }
  // Even keeping the tokens' text is a loss: Markdown cannot write a mention back.
  const kept = spliceMarkdown(rich, adfToMarkdown(rich).replace(' — state ', ' — current state '));
  assert.ok(!kept.ok && kept.reason === 'protected' && kept.lost.includes('status "IN PROGRESS"'));
  const panel = spliceMarkdown(rich, adfToMarkdown(rich).replace('> Info panel.', '> Info panel, edited.'));
  assert.ok(!panel.ok && panel.reason === 'protected' && panel.lost.includes('info panel'));
  const image = spliceMarkdown(rich, adfToMarkdown(rich).replace('[image: shot.png]\n\n', ''));
  assert.ok(!image.ok && image.reason === 'protected' && image.lost.some(l => l.startsWith('image or file shot.png')));
});

test('protected inventory: colours, comments, task state and cell formatting count; moved elements do not', () => {
  const coloured = [p(t('red', [{ type: 'textColor', attrs: { color: '#ff0000' } }]), t(' and '), t('noted', [{ type: 'annotation', attrs: { id: 'a1', annotationType: 'inlineComment' } }]))];
  assert.deepEqual(lostElements(coloured, markdownToAdf('red and noted').content), ['text colour #ff0000 on "red"', 'inline comment on "noted"']);
  const task = [{ type: 'taskList', attrs: { localId: 'l' }, content: [{ type: 'taskItem', attrs: { localId: 'i', state: 'DONE' }, content: [t('ship')] }] }];
  assert.deepEqual(lostElements(task, markdownToAdf('- [ ] ship').content), ['task (DONE)'], 'the list itself survives; the done state does not');
  assert.deepEqual(lostElements(task, markdownToAdf('- [x] ship').content), [], 'same state and text: nothing lost');
  assert.deepEqual(lostElements([p(mention)], [p(t('x ')), p(mention)]), [], 'the same mention elsewhere in the region is kept');
  const cellDoc = [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { background: '#eee' }, content: [p(t('x'))] }] }] }];
  assert.deepEqual(lostElements(cellDoc, []), ['table cell formatting (colour, merged cells or widths)']);
});

test('splitBlocks keeps fenced code with blank lines in one block', () => {
  assert.deepEqual(splitBlocks('a\n\n```\nx\n\ny\n```\n\nb\n'), ['a', '```\nx\n\ny\n```', 'b']);
});

test('adfHash is stable across key order', () => {
  assert.equal(adfHash({ a: 1, b: { c: 2, d: 3 } }), adfHash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(adfHash(rich), adfHash(doc()));
});
