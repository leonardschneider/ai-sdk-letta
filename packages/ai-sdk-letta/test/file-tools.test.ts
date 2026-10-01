import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { ModelMessage } from 'ai';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import {
  ATTACHMENTS_CONTEXT, AttachmentStore, FILE_TOOL_PERMISSIONS, FileInputError, IMAGE_REFERENCE_PROVIDER, ImageInputError, LettaAgent, READ_LIMITS, createToolBridge, defineAgent, extractPdfText, fileTools, filesEnabled,
  historyKey, listFiles, parseRange, parseUserTurn, readFile, searchFiles, sniffImageType, userTurnContent,
} from '../src/index.js';
import { quarterlyReport } from './pdf-fixture.js';
import { png } from './png.js';
import { registry } from './fixtures.js';

/** A PDF's objects with every FlateDecode stream inflated (lengths and offsets dropped). */
function inflatePdf(pdf: Buffer): string[] {
  const text = pdf.toString('latin1');
  const objects: string[] = [];
  for (const match of text.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) {
    const body = match[2]!;
    const stream = /^([\s\S]*?)\nstream\n([\s\S]*)\nendstream$/.exec(body);
    if (!stream) { objects.push(body); continue; }
    const dict = stream[1]!.replace(/\/Length \d+/, '/Length _');
    const data = Buffer.from(stream[2]!, 'latin1');
    objects.push(`${dict}\n${/FlateDecode/.test(dict) ? inflateSync(data).toString('base64') : data.toString('latin1')}`);
  }
  return objects;
}
const FIXTURE = fileURLToPath(new URL('./fixtures/quarterly-report.pdf', import.meta.url));
const AGENT = 'agent-local-1111';
const enc = (s: string) => new TextEncoder().encode(s);
const code = (c: string) => (error: unknown) => error instanceof FileInputError && error.code === c;
async function store(conversation = 'conv-a') {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-tools-'));
  const files = new AttachmentStore(dir, AGENT, conversation);
  return { dir, files, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the committed fixture PDF is exactly what the pure-JS generator writes, and its text extracts per page', async () => {
  // Compare with deflate streams inflated: zlib builds differ in compressed bytes, not content.
  assert.deepEqual(inflatePdf(readFileSync(FIXTURE)), inflatePdf(quarterlyReport()), 'regenerate with: node --import tsx packages/ai-sdk-letta/test/pdf-fixture.ts');
  const pages = await extractPdfText(readFileSync(FIXTURE));
  assert.equal(pages.length, 5);
  assert.match(pages[1]!, /Total revenue for Q3 was 4\.2 million euros\./);
  assert.match(pages[2]!, /marketing budget for Q4 is 380,000 euros/);
  assert.equal(pages[4], '', 'the scanned page has no text layer');
  await assert.rejects(extractPdfText(enc('%PDF-1.4\ngarbage')), /could not be read/);
});

test('ranges: pages and lines, open ends, dashes and words; out-of-range input is explained', () => {
  assert.deepEqual(parseRange(undefined, 9, 'page'), { start: 1, end: 9 });
  assert.deepEqual(parseRange('3', 9, 'page'), { start: 3, end: 3 });
  assert.deepEqual(parseRange('2-4', 9, 'page'), { start: 2, end: 4 });
  assert.deepEqual(parseRange('pages 2–4', 9, 'page'), { start: 2, end: 4 });
  assert.deepEqual(parseRange('7-', 9, 'page'), { start: 7, end: 9 });
  assert.deepEqual(parseRange('lines 5..400', 9, 'line'), { start: 5, end: 9 }, 'the end is clamped');
  for (const bad of ['0', '5-2', '10', 'abc', '1,3', '-2']) assert.throws(() => parseRange(bad, 9, 'page'), code('file_range_invalid'), bad);
  assert.throws(() => parseRange('12', 9, 'page'), /this file has 9 pages/);
});

test('read_file returns only the requested PDF pages, marks the range, and shows a scanned page as an image', async () => {
  const s = await store();
  try {
    await s.files.save([{ name: 'quarterly-report.pdf', bytes: readFileSync(FIXTURE) }]);
    const page3 = await readFile(s.files, 'quarterly-report.pdf', '3');
    assert.match(page3.text, /^quarterly-report\.pdf \(PDF, 5 pages, 3 KB\): pages 3 of 5\n/);
    assert.match(page3.text, /--- Page 3 ---\nBudget\nThe marketing budget for Q4 is 380,000 euros\./);
    assert.doesNotMatch(page3.text, /Page 2|Revenue|Staffing/, 'no other page is included');
    assert.equal(page3.images, undefined);
    const two = await readFile(s.files, 'quarterly-report.pdf', '2-3');
    assert.match(two.text, /pages 2–3 of 5/); assert.match(two.text, /--- Page 2 ---/); assert.match(two.text, /--- Page 3 ---/);
    const scan = await readFile(s.files, 'quarterly-report.pdf', '5');
    assert.match(scan.text, /--- Page 5 ---\n\(no text layer\)/);
    assert.match(scan.text, /Page 5 has no text layer \(likely scanned\); its image is attached below/);
    assert.equal(scan.images?.length, 1);
    const image = Buffer.from(scan.images![0]!.data, 'base64');
    assert.equal(sniffImageType(image), 'image/png');
    assert.equal(image.readUInt32BE(16), 528, 'the page image keeps the scan\'s resolution (within the limit)');
    await assert.rejects(readFile(s.files, 'quarterly-report.pdf', '9'), code('file_range_invalid'));
    await assert.rejects(readFile(s.files, 'missing.pdf'), (e: unknown) => code('file_not_found')(e) && /Files here: "quarterly-report\.pdf"/.test((e as Error).message));
  } finally { s.cleanup(); }
});

test('read_file bounds text output, says when it is truncated, and how to continue', async () => {
  const s = await store();
  try {
    const lines = Array.from({ length: 3000 }, (_, i) => `row ${i + 1},${'x'.repeat(20)}`);
    await s.files.save([{ name: 'big.csv', bytes: enc(`${lines.join('\n')}\n`) }, { name: 'one-line.json', bytes: enc(`{"v":"${'y'.repeat(30_000)}"}`) }]);
    const first = await readFile(s.files, 'big.csv');
    assert.ok(first.text.length <= READ_LIMITS.maxChars + 600);
    const shown = Number(/lines 1–(\d+) of 3,000/.exec(first.text)![1]);
    assert.ok(shown > 100 && shown < 3000);
    assert.match(first.text, new RegExp(`\\[Truncated at the 12,000-character limit: showing lines 1–${shown}\\. To continue, call read_file with name "big\\.csv" and range "${shown + 1}-3000"\\.\\]`));
    const next = await readFile(s.files, 'big.csv', `${shown + 1}-3000`);
    assert.match(next.text, new RegExp(`^row ${shown + 1},`, 'm'));
    const tail = await readFile(s.files, 'big.csv', '2999-');
    assert.match(tail.text, /lines 2,?999–3,?000 of 3,000\n\nrow 2999,x+\nrow 3000,x+$/);
    const middle = await readFile(s.files, 'big.csv', '10-12');
    assert.match(middle.text, /\[End of the requested range\. The file continues to line 3,000\.\]/);
    const long = await readFile(s.files, 'one-line.json');
    assert.match(long.text, /Line 1 has 30,008 characters; only the first 12,000 are shown/);
  } finally { s.cleanup(); }
});

test('search_files finds passages with file and page or line, folds case and accents, and is bounded', async () => {
  const s = await store();
  try {
    await s.files.save([{ name: 'report.pdf', bytes: readFileSync(FIXTURE) }, { name: 'team.csv', bytes: enc('name,role\nInès Duarte,Budget owner\nSam Lee,Engineer\n') }, { name: 'logo.png', bytes: png(4, 4) }]);
    const budget = await searchFiles(s.files, 'budget');
    assert.match(budget.text, /^Found \d+ passages for "budget" in 2 files/);
    assert.match(budget.text, /report\.pdf, page 1: See page 3 for the budget and page 4 for staffing\./);
    assert.match(budget.text, /report\.pdf, page 3: The marketing budget for Q4 is 380,000 euros\./);
    assert.match(budget.text, /team\.csv, line 2: Inès Duarte,Budget owner/);
    const accent = await searchFiles(s.files, 'INES duarte');
    assert.match(accent.text, /report\.pdf, page 3: Budget owner: Ines Duarte\./);
    assert.match(accent.text, /team\.csv, line 2/);
    const words = await searchFiles(s.files, 'research budget million');
    assert.match(words.text, /page 3: The research budget for Q4 is 1\.1 million euros\./);
    const scoped = await searchFiles(s.files, 'budget', 'team.csv');
    assert.doesNotMatch(scoped.text, /report\.pdf/);
    const none = await searchFiles(s.files, 'kangaroo');
    assert.match(none.text, /No passages found for "kangaroo" in 2 files \(images are not searched\)/);
    await s.files.save([{ name: 'many.txt', bytes: enc(Array.from({ length: 500 }, (_, i) => `budget line ${i}`).join('\n')) }]);
    const many = await searchFiles(s.files, 'budget', 'many.txt');
    assert.match(many.text, /Found 500 passages .* showing the first 20/);
    assert.ok(many.text.length < READ_LIMITS.maxSearchChars + 500);
  } finally { s.cleanup(); }
});

test('list_files describes every file; images can be read back as images', async () => {
  const s = await store();
  try {
    assert.equal(listFiles(s.files).text, 'No files are attached to this conversation.');
    await s.files.save([{ name: 'report.pdf', bytes: readFileSync(FIXTURE) }, { name: 'shot.png', bytes: png(4, 4) }, { name: 'a.md', bytes: enc('# A\n\nB\n') }]);
    const list = listFiles(s.files).text;
    assert.match(list, /^3 files in this conversation \(\d+ KB\):\n- report\.pdf \(PDF, 5 pages, 3 KB\)\n- shot\.png \(PNG image, \d+ bytes\)\n- a\.md \(Markdown, 3 lines, 7 bytes\)/);
    const image = await readFile(s.files, 'shot.png');
    assert.equal(image.images?.[0]?.mediaType, 'image/png');
  } finally { s.cleanup(); }
});

test('the bridge binds tools to the conversation it was given, never to model-supplied paths', async () => {
  const a = await store('conv-a');
  const b = new AttachmentStore(a.dir, AGENT, 'conv-b');
  try {
    await a.files.save([{ name: 'alpha.txt', bytes: enc('alpha secret') }]);
    await b.save([{ name: 'beta.txt', bytes: enc('beta secret') }]);
    let current: AttachmentStore | undefined = a.files;
    const bridge = createToolBridge({ tools: fileTools, permissions: FILE_TOOL_PERMISSIONS, persist: () => {}, context: () => current ? { [ATTACHMENTS_CONTEXT]: current } : {} });
    const call = async (name: string, id: string, args: unknown) => { const r = await bridge.execute(name, id, args); return { text: r.content.map(c => c.text ?? '').join(''), isError: r.isError, content: r.content }; };
    assert.match((await call('list_files', '1', {})).text, /alpha\.txt/);
    assert.doesNotMatch((await call('list_files', '2', {})).text, /beta/);
    for (const [i, name] of ['../conv-b/beta.txt', `${b.directory}/beta.txt`, 'beta.txt', '../../../../etc/passwd'].entries()) {
      const result = await call('read_file', `t${i}`, { name });
      assert.equal(result.isError, true, name);
      assert.doesNotMatch(result.text, /beta secret/);
    }
    assert.doesNotMatch((await call('search_files', 's1', { query: 'beta' })).text, /beta\.txt/);
    // Switching the bound conversation switches the folder.
    current = b;
    assert.match((await call('read_file', 'r2', { name: 'beta.txt' })).text, /beta secret/);
    assert.equal((await call('read_file', 'r3', { name: 'alpha.txt' })).isError, true);
    // Without a binding the tools fail closed.
    current = undefined;
    const unbound = await call('list_files', 'u1', {});
    assert.equal(unbound.isError, true); assert.match(unbound.text, /files_unavailable/);
    // Extra arguments (a "path") are rejected by the schema before anything runs.
    current = a.files;
    assert.match((await call('read_file', 'p1', { name: 'alpha.txt', path: '/etc' })).text, /invalid_arguments/);
  } finally { a.cleanup(); }
});

test('the bridge sends page images as Letta image content, within bounds', async () => {
  const s = await store();
  try {
    await s.files.save([{ name: 'report.pdf', bytes: readFileSync(FIXTURE) }]);
    const bridge = createToolBridge({ tools: fileTools, permissions: FILE_TOOL_PERMISSIONS, persist: () => {}, timeoutMs: 20_000, context: () => ({ [ATTACHMENTS_CONTEXT]: s.files }) });
    const result = await bridge.execute('read_file', 'img', { name: 'report.pdf', range: '5' });
    assert.equal(result.isError, false);
    assert.equal(result.content[0]!.type, 'text');
    assert.deepEqual({ type: result.content[1]!.type, mimeType: result.content[1]!.mimeType }, { type: 'image', mimeType: 'image/png' });
    const text = await bridge.execute('read_file', 'txt', { name: 'report.pdf', range: '3' });
    assert.equal(text.content.length, 1);
    const missing = await bridge.execute('read_file', 'err', { name: 'nope.pdf' });
    assert.equal(missing.isError, true, 'tool-reported errors reach the model as errors');
    assert.match(missing.content[0]!.text!, /file_not_found/);
  } finally { s.cleanup(); }
});

test('file tools are opt-in: definitions must list them with permissions; filesEnabled follows read_file', () => {
  const base = { id: 'x', name: 'X', model: 'a/b', instructions: 'i' };
  assert.throws(() => defineAgent({ ...base, tools: { ...fileTools } }), /Missing permission for tool\(s\): list_files, read_file, search_files/);
  const enabled = defineAgent({ ...base, tools: { ...fileTools }, permissions: FILE_TOOL_PERMISSIONS });
  assert.equal(filesEnabled(enabled), true);
  assert.equal(filesEnabled(defineAgent({ ...base, tools: { ...fileTools }, permissions: { ...FILE_TOOL_PERMISSIONS, read_file: 'deny' } })), false);
  assert.equal(filesEnabled(defineAgent({ ...base, tools: registry, permissions: { text_stats: 'allow', approval_demo: 'ask', ask_user: 'allow' } })), false);
});

function agentFixture(attachments?: AttachmentStore) {
  const sent: SendMessage[] = [];
  const agent = new LettaAgent({ id: 'files', tools: { ...registry, ...fileTools }, attachments, open: () => ({
    send: async message => { sent.push(structuredClone(message)); }, abort: async () => {}, close: () => {},
    async *stream() {
      yield { type: 'assistant', content: 'Seen', uuid: 'a' } as SDKMessage;
      yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId: 'test' } as SDKMessage;
    },
  }) });
  return { agent, sent };
}

test('a turn with files stores them and sends only a short note; images are stored and still sent inline', async () => {
  const s = await store();
  try {
    const { agent, sent } = agentFixture(s.files);
    const pdf = readFileSync(FIXTURE);
    const image = png(8, 8);
    await agent.generate({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'What is the Q4 marketing budget?' },
      { type: 'file', mediaType: 'application/pdf', filename: 'report.pdf', data: pdf },
      { type: 'file', mediaType: 'text/csv', filename: 'team.csv', data: { type: 'url', url: new URL(`data:text/csv;base64,${Buffer.from('a,b\n').toString('base64')}`) } },
      { type: 'image', image },
    ] }] });
    assert.deepEqual(sent[0], [
      { type: 'text', text: 'What is the Q4 marketing budget?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
      { type: 'text', text: `\n\nAttached: report.pdf (PDF, 5 pages, 3 KB)\nAttached: team.csv (CSV, 1 line, 4 bytes)\nAttached: image.png (PNG image, ${image.byteLength} bytes)` },
    ]);
    assert.doesNotMatch(JSON.stringify(sent), /marketing budget for Q4/, 'file content is never inlined');
    assert.deepEqual(s.files.list().map(f => f.name), ['report.pdf', 'team.csv', 'image.png']);
    // The transcript keeps references only; history must extend it exactly (no replay).
    const transcript = agent.transcript;
    assert.doesNotMatch(JSON.stringify(transcript), /JVBER|YSxiCg/, 'no file bytes in the transcript');
    const sha = createHash('sha256').update(pdf).digest('hex');
    assert.match(JSON.stringify(transcript), new RegExp(sha));
    await agent.generate({ messages: [...transcript, { role: 'user', content: 'And the research budget?' }] });
    assert.equal(sent[1], 'And the research budget?');
    // Changing a file in history is an edit: refused.
    const edited = structuredClone(agent.transcript) as ModelMessage[];
    const first = edited[0]!.content as { type: string; filename?: string; data?: unknown }[];
    first[1] = { type: 'file', filename: 'report.pdf', data: Buffer.from('%PDF-other').toString('base64') };
    await assert.rejects(agent.generate({ messages: [...edited, { role: 'user', content: 'x' }] }), /History edits/);
    // Text-only turns are unchanged byte for byte.
    assert.equal(historyKey([{ role: 'user', content: 'hi' }]), historyKey([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
  } finally { s.cleanup(); }
});

test('a text-less turn with only a file sends just the note; a reference to a stored file reuses it', async () => {
  const s = await store();
  try {
    const { agent, sent } = agentFixture(s.files);
    await agent.generate({ messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'text/plain', filename: 'n.txt', data: Buffer.from('hello') }] }] });
    assert.equal(sent[0], 'Attached: n.txt (Text, 1 line, 5 bytes)');
    const sha = createHash('sha256').update('hello').digest('hex');
    await agent.generate({ messages: [...agent.transcript, { role: 'user', content: [{ type: 'text', text: 'again' }, { type: 'file', mediaType: 'text/plain', filename: 'n.txt', data: { type: 'reference', reference: { [IMAGE_REFERENCE_PROVIDER]: sha } } }] }] });
    assert.equal(sent[1], 'again\n\nAttached: n.txt (Text, 1 line, 5 bytes)');
    assert.equal(s.files.list().length, 1);
    await assert.rejects(agent.generate({ messages: [...agent.transcript, { role: 'user', content: [{ type: 'file', mediaType: 'text/plain', filename: 'other.txt', data: { type: 'reference', reference: { [IMAGE_REFERENCE_PROVIDER]: sha } } }] }] }), code('file_not_found'));
  } finally { s.cleanup(); }
});

test('refused files fail before anything is sent or stored, with typed errors', async () => {
  const s = await store();
  try {
    const { agent, sent } = agentFixture(new AttachmentStore(s.dir, AGENT, 'conv-a', { maxFileBytes: 1000, maxFilesPerMessage: 2, maxConversationFiles: 10, maxConversationBytes: 10_000 }));
    await assert.rejects(agent.generate({ messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'application/octet-stream', filename: 'a.bin', data: Buffer.from([0, 1, 2, 3]) }] }] }), code('file_unsupported_type'));
    await assert.rejects(agent.generate({ messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'text/plain', filename: 'big.txt', data: Buffer.alloc(1001, 97) }] }] }), code('file_too_large'));
    await assert.rejects(agent.generate({ messages: [{ role: 'user', content: Array.from({ length: 3 }, (_, i) => ({ type: 'file' as const, mediaType: 'text/plain', filename: `${i}.txt`, data: Buffer.from('x') })) }] }), code('files_too_many'));
    await assert.rejects(agent.generate({ messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'application/pdf', filename: 'r.pdf', data: new URL('https://example.com/r.pdf') }] }] }), code('file_invalid'));
    assert.equal(sent.length, 0);
    assert.equal(s.files.list().length, 0);
    await agent.generate({ prompt: 'still usable' });
    assert.equal(sent[0], 'still usable');
  } finally { s.cleanup(); }
});

test('without file tools the agent keeps the image-only behaviour and refuses other files as before', async () => {
  const { agent, sent } = agentFixture(undefined);
  await assert.rejects(agent.generate({ messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'application/pdf', data: 'JVBERi0=' }] }] }), (e: unknown) => e instanceof ImageInputError && e.code === 'image_unsupported_type');
  const image = png(4, 4);
  await agent.generate({ messages: [{ role: 'user', content: [{ type: 'image', image }] }] });
  assert.deepEqual(sent[0], [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } }], 'no note, nothing stored');
  assert.deepEqual(userTurnContent('hi').message, 'hi');
  assert.throws(() => parseUserTurn([{ type: 'file', mediaType: 'text/plain', data: 'aGk=' }]), (e: unknown) => e instanceof ImageInputError);
});
