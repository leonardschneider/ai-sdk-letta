import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILE_LIMITS as LIBRARY_FILE_LIMITS, formatBytes as libraryFormatBytes, parseAttachmentNote } from 'ai-sdk-letta';
import { FILE_LIMITS, FileAttachmentAdapter, fileDetail, fileMessage, fileMessages, formatBytes, type FileInfo } from '../src/attachments.js';
import { historyMessages, splitAttachmentNote, userContent } from '../src/messages.js';
import { fileToolSummary, toolLabel } from '../src/presentation.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test('browser file limits and size formatting mirror the library', () => {
  assert.deepEqual({ ...FILE_LIMITS }, { ...LIBRARY_FILE_LIMITS });
  for (const bytes of [0, 1, 512, 2048, 1_500_000, 2.1 * 1024 * 1024, 25 * 1024 * 1024]) assert.equal(formatBytes(bytes), libraryFormatBytes(bytes));
  assert.equal(fileDetail({ label: 'PDF', bytes: 2.1 * 1024 * 1024, pages: 12 }), 'PDF · 12 pages · 2.1 MB');
  assert.equal(fileDetail({ label: 'CSV', bytes: 19, lines: 1 }), 'CSV · 1 line · 19 bytes');
});

test('the attachment note splits into chips exactly like the library parser', () => {
  const text = 'Compare these\n\nAttached: Bericht (2).pdf (PDF, 5 pages, 3 KB)\nAttached: team.csv (CSV, 2 lines, 19 bytes)\nAttached: shot.png (PNG image, 75 bytes)';
  const split = splitAttachmentNote(text);
  assert.equal(split.text, 'Compare these');
  assert.deepEqual(split.files, [
    { name: 'Bericht (2).pdf', detail: 'PDF · 5 pages · 3 KB', kind: 'pdf' },
    { name: 'team.csv', detail: 'CSV · 2 lines · 19 bytes', kind: 'text' },
    { name: 'shot.png', detail: 'PNG image · 75 bytes', kind: 'image' },
  ]);
  assert.deepEqual(split.files.map(f => f.name), parseAttachmentNote(text).files.map(f => f.name));
  assert.deepEqual(splitAttachmentNote('Attached: is just words'), { text: 'Attached: is just words', files: [] });
  assert.deepEqual(splitAttachmentNote('no note'), { text: 'no note', files: [] });
});

test('bubbles: file chips after images and before text, live and restored', () => {
  const chip = { name: 'r.pdf', detail: 'PDF · 5 pages · 3 KB', kind: 'pdf' as const };
  assert.deepEqual(userContent('hi', [], [chip]), [{ type: 'data-file', data: chip }, { type: 'text', text: 'hi' }]);
  const restored = historyMessages([{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Read it\n\nAttached: r.pdf (PDF, 5 pages, 3 KB)' }] }]);
  assert.deepEqual(restored[0]!.content, [{ type: 'data-file', data: chip }, { type: 'text', text: 'Read it' }]);
  const fileOnly = historyMessages([{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Attached: r.pdf (PDF, 5 pages, 3 KB)' }] }]);
  assert.deepEqual(fileOnly[0]!.content, [{ type: 'data-file', data: chip }]);
  // Assistant text that happens to look like a note stays text.
  const assistant = historyMessages([{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Attached: r.pdf (PDF, 5 pages, 3 KB)' }] }]);
  assert.deepEqual(assistant[0]!.content, [{ type: 'text', text: 'Attached: r.pdf (PDF, 5 pages, 3 KB)' }]);
});

test('file tool lines read naturally', () => {
  assert.equal(toolLabel('read_file', 'done', 'x', { name: 'report.pdf', range: '1-3' }), 'Read report.pdf, pages 1–3');
  assert.equal(toolLabel('read_file', 'done', 'x', { name: 'report.pdf', range: '5' }), 'Read report.pdf, page 5');
  assert.equal(toolLabel('read_file', 'running', undefined, { name: 'report.pdf', range: 'pages 4-' }), 'Reading report.pdf, pages 4–end…');
  assert.equal(toolLabel('read_file', 'done', 'x', { name: 'data.csv', range: '10-40' }), 'Read data.csv, lines 10–40');
  assert.equal(toolLabel('read_file', 'done', 'x', { name: 'notes.md' }), 'Read notes.md');
  assert.equal(toolLabel('read_file', 'error', 'Error (file_not_found)', { name: 'x.pdf', range: '2' }), 'Couldn’t read x.pdf, page 2');
  assert.equal(toolLabel('search_files', 'done', 'x', { query: 'budget' }), 'Searched files for “budget”');
  assert.equal(toolLabel('search_files', 'running', undefined, { query: 'owner', name: 'team.csv' }), 'Searching team.csv for “owner”…');
  assert.equal(toolLabel('list_files', 'done', 'x', {}), 'Listed files');
  assert.equal(toolLabel('read_file', 'error', '{"error":"user_denied"}', { name: 'r.pdf' }), 'Denied: Read file');
  assert.equal(toolLabel('text_stats', 'done'), 'Used Text stats', 'other tools are unchanged');
  assert.equal(fileToolSummary('read_file', 'r.pdf (PDF, 5 pages, 3 KB): pages 1–3 of 5\n\n--- Page 1 ---'), 'pages 1–3 of 5');
  assert.equal(fileToolSummary('read_file', 'r.pdf (PDF, 5 pages, 3 KB): pages 5 of 5\n\n(no text layer)\n[Page 5 has no text layer (likely scanned); its image is attached below]'), 'page 5 of 5 · with page image');
  assert.equal(fileToolSummary('read_file', 'big.csv (CSV): lines 1–400 of 3,000\n\n...\n[Truncated at the 12,000-character limit'), 'lines 1–400 of 3,000 · truncated');
  assert.equal(fileToolSummary('search_files', 'Found 3 passages for "budget" in 2 files.\n\n...'), 'Found 3 passages for "budget" in 2 files');
  assert.equal(fileToolSummary('search_files', 'Found 32 passages for "a b" in 1 file (0 exact; others contain most of the words), showing the first 20. Narrow the query.'), 'Found 32 passages for "a b" in 1 file');
  assert.equal(fileToolSummary('list_files', '2 files in this conversation (36 KB):\n- a'), '2 files in this conversation (36 KB)');
  assert.equal(fileToolSummary('text_stats', 'x'), undefined);
});

test('file adapter: images keep the image path; other files upload at once; limits and errors become toast text', async () => {
  const uploaded: string[] = [];
  const info = (name: string): FileInfo => ({ id: crypto.randomUUID(), name, kind: 'pdf', mediaType: 'application/pdf', label: 'PDF', bytes: 10, pages: 2 });
  const current: { id: string; type: string; name: string; status: { type: 'complete' }; content: [] }[] = [];
  const adapter = new FileAttachmentAdapter(() => current, async file => { uploaded.push(file.name); if (file.name === 'bad.bin') throw new Error(fileMessage('file_unsupported_type')); return info(file.name); });
  assert.match(adapter.accept, /\.pdf/); assert.match(adapter.accept, /image\/png/);
  const pdf = await adapter.add({ file: new File(['%PDF-1.4'], 'r.pdf', { type: 'application/pdf' }) });
  assert.equal(pdf.type, 'document'); assert.equal(adapter.uploaded(pdf.id)?.pages, 2);
  const sent = await adapter.send(pdf);
  assert.deepEqual(sent.content, [{ type: 'data', name: 'upload', data: adapter.uploaded(pdf.id) }]);
  // Small images pass through prepareImage unchanged (stub the browser decoder for Node).
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
  try {
    const image = await adapter.add({ file: new File([PNG], 'shot.png', { type: 'image/png' }) });
    assert.equal(image.type, 'image');
  } finally { delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap; }
  assert.deepEqual(uploaded, ['r.pdf'], 'images are not uploaded separately');
  await assert.rejects(adapter.add({ file: new File([new Uint8Array([0, 1])], 'bad.bin') }), (e: Error) => e.message === fileMessages.file_unsupported_type);
  await assert.rejects(adapter.add({ file: { name: 'huge.pdf', type: 'application/pdf', size: FILE_LIMITS.maxFileBytes + 1, slice: () => new Blob(['%PDF']) } as unknown as File }), (e: Error) => e.message === fileMessages.file_too_large);
  for (let i = 0; i < FILE_LIMITS.maxFilesPerMessage; i++) current.push({ id: String(i), type: 'document', name: `${i}.txt`, status: { type: 'complete' }, content: [] });
  await assert.rejects(adapter.add({ file: new File(['x'], 'one-more.txt') }), (e: Error) => e.message === fileMessages.files_too_many);
  await adapter.remove(pdf);
  await assert.rejects(adapter.send(pdf), (e: Error) => e.message === fileMessages.file_not_found);
  // Without file support (the agent has no file tools), the adapter is the image adapter.
  const imagesOnly = new FileAttachmentAdapter(() => [], undefined);
  assert.equal(imagesOnly.accept, 'image/png,image/jpeg,image/gif,image/webp');
  assert.equal(fileMessage('mystery'), 'Couldn’t attach that file. Try again.');
});
