import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore, FILE_LIMITS, FileInputError, UploadStaging, attachmentNote, decodeFilePart, describeFile, detectFileType, isPlainFileName, isText, parseAttachmentNote, sanitizeFileName, STAGING_TTL_MS } from '../src/index.js';
import { quarterlyReport } from './pdf-fixture.js';
import { png } from './png.js';

const AGENT = 'agent-local-1111';
const code = (c: string) => (error: unknown) => error instanceof FileInputError && error.code === c;
function root() { return mkdtempSync(join(tmpdir(), 'ai-sdk-letta-files-')); }
const text = (s: string) => new TextEncoder().encode(s);

test('file names are sanitized to a plain, visible, bounded last path segment', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('C:\\Users\\me\\report.pdf'), 'report.pdf');
  assert.equal(sanitizeFileName('.env'), 'env');
  assert.equal(sanitizeFileName('...'), 'file');
  assert.equal(sanitizeFileName(''), 'file');
  assert.equal(sanitizeFileName('a\u0000b\u202ec\u200b.txt'), 'abc.txt', 'control, bidi and zero-width characters are removed');
  assert.equal(sanitizeFileName('  re<po>rt?:*.csv  '), 're_po_rt___.csv');
  assert.equal(sanitizeFileName('Cafe\u0301.md'), 'Café.md', 'NFC normalized');
  const long = sanitizeFileName(`${'x'.repeat(300)}.pdf`);
  assert.equal(long.length, 120); assert.ok(long.endsWith('.pdf'));
  assert.equal(isPlainFileName('report.pdf'), true);
  for (const bad of ['../x', 'a/b', '.hidden', '', 'x\u0000', ' padded', 7, undefined]) assert.equal(isPlainFileName(bad), false, String(bad));
});

test('types are detected by content: text (UTF-8, no binary), PDF and images; the name cannot contradict the content', () => {
  assert.equal(isText(text('a,b\n1,2\n')), true);
  assert.equal(isText(text('\ufeffhéllo – ✓\n')), true);
  assert.equal(isText(new Uint8Array([0x68, 0x00, 0x69])), false, 'NUL bytes are binary');
  assert.equal(isText(new Uint8Array([0xc3, 0x28])), false, 'invalid UTF-8');
  assert.equal(isText(new Uint8Array(200).map((_, i) => i % 32)), false, 'control characters');
  assert.deepEqual(detectFileType(text('a,b\n'), 'data.csv'), { kind: 'text', mediaType: 'text/csv', label: 'CSV' });
  assert.deepEqual(detectFileType(text('# Title'), 'notes.md'), { kind: 'text', mediaType: 'text/markdown', label: 'Markdown' });
  assert.deepEqual(detectFileType(text('{"a":1}'), 'x.json'), { kind: 'text', mediaType: 'application/json', label: 'JSON' });
  assert.deepEqual(detectFileType(text('print(1)'), 'main.py'), { kind: 'text', mediaType: 'text/plain', label: 'Python' });
  assert.deepEqual(detectFileType(text('plain'), 'README'), { kind: 'text', mediaType: 'text/plain', label: 'Text' });
  assert.deepEqual(detectFileType(quarterlyReport(), 'whatever.txt'), { kind: 'pdf', mediaType: 'application/pdf', label: 'PDF' }, 'content wins over the name');
  assert.deepEqual(detectFileType(png(4, 4), 'shot'), { kind: 'image', mediaType: 'image/png', label: 'PNG image' });
  assert.throws(() => detectFileType(text('not a pdf'), 'fake.pdf'), code('file_invalid'));
  assert.throws(() => detectFileType(text('hello'), 'fake.png'), code('file_invalid'));
  assert.throws(() => detectFileType(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'sheet.xlsx'), code('file_unsupported_type'));
  assert.throws(() => detectFileType(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]), 'tool.txt'), code('file_unsupported_type'), 'an ELF binary named .txt is refused');
  assert.throws(() => detectFileType(new Uint8Array(), 'empty.txt'), code('file_invalid'));
});

test('stores files privately and atomically, with collision-safe names and the descriptive note', async () => {
  const dir = root();
  try {
    const store = new AttachmentStore(dir, AGENT, 'conv-a');
    const [first] = await store.save([{ name: 'report.pdf', bytes: quarterlyReport() }]);
    assert.deepEqual({ name: first!.name, kind: first!.kind, pages: first!.pages, label: first!.label }, { name: 'report.pdf', kind: 'pdf', pages: 5, label: 'PDF' });
    assert.equal(statSync(store.directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(store.directory, 'report.pdf')).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, AGENT)).mode & 0o777, 0o700);
    assert.equal(readdirSync(store.directory).filter(n => n.startsWith('.tmp-')).length, 0, 'no temporary files remain');
    // Same name and same content: reused, not duplicated. Same name, other content: numbered.
    const [again] = await store.save([{ name: 'report.pdf', bytes: quarterlyReport() }]);
    assert.equal(again!.name, 'report.pdf');
    const [other] = await store.save([{ name: 'report.pdf', bytes: text('%PDF-1.4 broken') }]).catch(e => [e]);
    assert.ok(code('file_invalid')(other), 'a broken PDF is refused');
    const [csv] = await store.save([{ name: 'data.csv', bytes: text('a,b\n1,2\n') }]);
    const [csv2] = await store.save([{ name: 'data.csv', bytes: text('a,b\n3,4\n5,6\n') }]);
    assert.equal(csv2!.name, 'data (2).csv');
    assert.equal(csv!.lines, 2); assert.equal(csv2!.lines, 3);
    const [renamed] = await store.save([{ name: 'scan', bytes: quarterlyReport() }]);
    assert.equal(renamed!.name, 'scan.pdf', 'the extension follows the content');
    assert.deepEqual(store.list().map(f => f.name), ['report.pdf', 'data.csv', 'data (2).csv', 'scan.pdf']);
    assert.equal(describeFile(first!), 'PDF, 5 pages, 3 KB');
    assert.equal(attachmentNote([first!, csv!]), 'Attached: report.pdf (PDF, 5 pages, 3 KB)\nAttached: data.csv (CSV, 2 lines, 8 bytes)');
    assert.deepEqual(parseAttachmentNote(`Summarize these\n\n${attachmentNote([first!, csv!])}`), { text: 'Summarize these', files: [
      { name: 'report.pdf', description: 'PDF, 5 pages, 3 KB', label: 'PDF' }, { name: 'data.csv', description: 'CSV, 2 lines, 8 bytes', label: 'CSV' }] });
    assert.deepEqual(parseAttachmentNote('Attached: nothing here'), { text: 'Attached: nothing here', files: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('names resolve only inside the folder: traversal, hidden sidecars, symlinks and hard links are refused', async () => {
  const dir = root();
  const outside = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-outside-'));
  try {
    const store = new AttachmentStore(dir, AGENT, 'conv-a');
    await store.save([{ name: 'notes.txt', bytes: text('inside') }]);
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
    for (const name of ['../../../etc/passwd', '../conv-b/notes.txt', '/etc/passwd', '.meta/notes.txt.json', 'notes.txt/..', '..', '.', 'sub/notes.txt']) {
      assert.throws(() => store.read(name), code('file_name_invalid'), name);
    }
    symlinkSync(join(outside, 'secret.txt'), join(store.directory, 'link.txt'));
    assert.equal(store.list().some(f => f.name === 'link.txt'), false, 'symlinks are not listed');
    assert.throws(() => store.read('link.txt'), code('file_not_found'));
    linkSync(join(outside, 'secret.txt'), join(store.directory, 'hard.txt'));
    assert.equal(store.list().some(f => f.name === 'hard.txt'), false, 'hard links are not listed');
    // A symlinked conversation folder is refused outright.
    mkdirSync(join(dir, AGENT), { recursive: true });
    symlinkSync(outside, join(dir, AGENT, 'conv-evil'));
    assert.throws(() => new AttachmentStore(dir, AGENT, 'conv-evil').list(), code('file_name_invalid'));
    // A symlinked agent folder too.
    symlinkSync(join(dir, AGENT), join(dir, 'agent-local-2222'));
    assert.throws(() => new AttachmentStore(dir, 'agent-local-2222', 'conv-a').list(), code('file_name_invalid'));
    // IDs are validated before any path is built.
    assert.throws(() => new AttachmentStore(dir, AGENT, '../conv-a'), code('file_name_invalid'));
    assert.throws(() => new AttachmentStore(dir, '../agent', 'conv-a'), code('file_name_invalid'));
    assert.throws(() => new AttachmentStore('relative', AGENT, 'conv-a'), code('file_name_invalid'));
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'TOP SECRET');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('conversations are isolated: one store never lists or reads another conversation\'s files', async () => {
  const dir = root();
  try {
    const a = new AttachmentStore(dir, AGENT, 'conv-a');
    const b = new AttachmentStore(dir, AGENT, 'conv-b');
    const otherAgent = new AttachmentStore(dir, 'agent-local-9999', 'conv-a');
    await a.save([{ name: 'a-only.txt', bytes: text('alpha') }]);
    await b.save([{ name: 'b-only.txt', bytes: text('beta') }]);
    assert.deepEqual(a.list().map(f => f.name), ['a-only.txt']);
    assert.deepEqual(b.list().map(f => f.name), ['b-only.txt']);
    assert.deepEqual(otherAgent.list(), [], 'same conversation ID under another agent is a different folder');
    assert.throws(() => b.read('a-only.txt'), code('file_not_found'));
    assert.equal(new AttachmentStore(dir, AGENT, 'conv-empty').list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('limits: per file, per message, per conversation count and size, all before writing', async () => {
  const dir = root();
  try {
    const limits = { maxFileBytes: 100, maxFilesPerMessage: 2, maxConversationFiles: 3, maxConversationBytes: 150 };
    const store = new AttachmentStore(dir, AGENT, 'conv-a', limits);
    await assert.rejects(store.save([{ name: 'big.txt', bytes: text('x'.repeat(101)) }]), code('file_too_large'));
    await store.save([{ name: 'one.txt', bytes: text('a'.repeat(60)) }, { name: 'two.txt', bytes: text('b'.repeat(60)) }]);
    await assert.rejects(store.save([{ name: 'three.txt', bytes: text('c'.repeat(40)) }]), code('conversation_files_full'), 'total size');
    assert.equal(store.list().length, 2, 'nothing was written');
    await store.save([{ name: 'small.txt', bytes: text('c') }]);
    await assert.rejects(store.save([{ name: 'four.txt', bytes: text('d') }]), code('conversation_files_full'), 'file count');
    // A batch that does not fit writes nothing.
    const other = new AttachmentStore(dir, AGENT, 'conv-b', limits);
    await assert.rejects(other.save([{ name: 'x.txt', bytes: text('x'.repeat(90)) }, { name: 'y.txt', bytes: text('y'.repeat(90)) }]), code('conversation_files_full'));
    assert.equal(other.list().length, 0);
    assert.equal(FILE_LIMITS.maxFileBytes, 25 * 1024 * 1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('files added or changed by hand: described from content, or refused when they no longer match', async () => {
  const dir = root();
  try {
    const store = new AttachmentStore(dir, AGENT, 'conv-a');
    await store.save([{ name: 'notes.txt', bytes: text('one\ntwo\n') }]);
    writeFileSync(join(store.directory, 'manual.md'), '# Added by hand\n');
    writeFileSync(join(store.directory, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    const listed = store.list();
    assert.deepEqual(listed.map(f => f.name).sort(), ['manual.md', 'notes.txt']);
    assert.equal(listed.find(f => f.name === 'manual.md')!.label, 'Markdown');
    writeFileSync(join(store.directory, 'notes.txt'), 'six!\n!!');
    assert.equal(store.read('notes.txt').bytes.toString(), 'six!\n!!', 'a resized edit is re-described from content');
    await store.save([{ name: 'same.txt', bytes: text('abc') }]);
    writeFileSync(join(store.directory, 'same.txt'), 'xyz');
    assert.throws(() => store.read('same.txt'), code('file_invalid'), 'a same-size edit no longer matches its recorded hash');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('upload staging validates by content, survives until committed, expires, and is bounded', async () => {
  const dir = root();
  try {
    const staging = new UploadStaging(dir, FILE_LIMITS, 3);
    const pdf = await staging.stage('report.pdf', quarterlyReport());
    assert.equal(pdf.pages, 5);
    assert.equal(statSync(join(dir, '.staging', pdf.id)).mode & 0o777, 0o700);
    await assert.rejects(staging.stage('x.bin', new Uint8Array([0, 1, 2])), code('file_unsupported_type'));
    const csv = await staging.stage('d.csv', text('a,b\n'));
    const [loaded] = staging.load([pdf.id]);
    assert.equal(loaded!.prepared.pages!.length, 5);
    assert.throws(() => staging.load(['not-an-id']), code('file_not_found'));
    assert.throws(() => staging.load([pdf.id, pdf.id]), code('file_invalid'));
    // Tampered bytes are refused.
    writeFileSync(join(dir, '.staging', csv.id, 'data'), 'a,c\n');
    assert.throws(() => staging.load([csv.id]), code('file_not_found'));
    // Commit into a conversation, then discard.
    const store = new AttachmentStore(dir, AGENT, 'conv-a');
    store.store([loaded!.prepared]);
    staging.discard([pdf.id]);
    assert.throws(() => staging.load([pdf.id]), code('file_not_found'));
    assert.equal(store.list()[0]!.name, 'report.pdf');
    assert.equal((await store.content('report.pdf') as { pages: string[] }).pages[2], 'Budget\nThe marketing budget for Q4 is 380,000 euros.\nThe research budget for Q4 is 1.1 million euros.\nBudget owner: Ines Duarte.');
    // Bounded: at most 3 pending (one tampered + two new).
    await staging.stage('a.txt', text('a')); await staging.stage('b.txt', text('b'));
    await assert.rejects(staging.stage('c.txt', text('c')), code('files_too_many'));
    // Expired uploads are swept on the next upload.
    const old = new Date(Date.now() - STAGING_TTL_MS - 1000);
    for (const entry of readdirSync(join(dir, '.staging'))) utimesSync(join(dir, '.staging', entry), old, old);
    await staging.stage('fresh.txt', text('fresh'));
    assert.equal(readdirSync(join(dir, '.staging')).length, 1);
    assert.ok(lstatSync(join(dir, '.staging')).isDirectory());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('file parts decode from data URLs, base64, bytes and inline text; remote URLs are never fetched', () => {
  assert.equal(new TextDecoder().decode(decodeFilePart({ data: 'data:text/plain;base64,aGk=', filename: 'a.txt' }).bytes), 'hi');
  assert.equal(new TextDecoder().decode(decodeFilePart({ data: { type: 'url', url: 'data:text/plain,hi%20there' } }).bytes), 'hi there');
  assert.equal(new TextDecoder().decode(decodeFilePart({ data: { type: 'data', data: 'aGk=' } }).bytes), 'hi');
  assert.equal(new TextDecoder().decode(decodeFilePart({ data: { type: 'text', text: 'inline' } }).bytes), 'inline');
  assert.equal(decodeFilePart({ data: new Uint8Array([1, 2]) }).bytes.length, 2);
  assert.equal(decodeFilePart({ data: 'aGk=' }).name, 'file');
  assert.throws(() => decodeFilePart({ data: 'https://example.com/a.pdf' }), code('file_invalid'));
  assert.throws(() => decodeFilePart({ data: new URL('file:///etc/passwd') }), code('file_invalid'));
  assert.throws(() => decodeFilePart({ data: { type: 'reference', reference: { openai: 'f' } } }), code('file_invalid'));
  assert.throws(() => decodeFilePart({ data: 'not base64!' }), code('file_invalid'));
  assert.throws(() => decodeFilePart({ data: Buffer.alloc(11).toString('base64') }, 10), code('file_too_large'));
});
