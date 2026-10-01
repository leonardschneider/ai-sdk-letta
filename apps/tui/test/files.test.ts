import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_LIMITS } from 'ai-sdk-letta';
import { notices, readFilePath, terminalAttachments, withinBudget } from '../src/attachments.js';
import { withFileLabels } from '../src/terminal.js';

const PDF = readFileSync(fileURLToPath(new URL('../../../packages/ai-sdk-letta/test/fixtures/quarterly-report.pdf', import.meta.url)));

test('restored history: the attachment note becomes [File: name] labels; images keep [Image]', () => {
  const [user, assistant] = withFileLabels([
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'What is on page 3?\n\nAttached: report.pdf (PDF, 5 pages, 3 KB)\nAttached: team.csv (CSV, 2 lines, 19 bytes)' }] },
    { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Attached: x (y)' }] },
  ]);
  assert.deepEqual(user!.parts, [{ type: 'text', text: '[File: report.pdf]' }, { type: 'text', text: '[File: team.csv]' }, { type: 'text', text: 'What is on page 3?' }]);
  assert.deepEqual(assistant!.parts, [{ type: 'text', text: 'Attached: x (y)' }], 'assistant text is untouched');
  const [withImage] = withFileLabels([{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Look\n\nAttached: shot.png (PNG image, 75 bytes)' }, { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }] }]);
  assert.deepEqual(withImage!.parts.map(p => p.type === 'text' ? p.text : p.type), ['Look', 'file'], 'a saved image is not listed twice');
});

test('dropped document paths attach when the agent has file tools; content decides the type', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-tui-files-'));
  try {
    writeFileSync(join(dir, 'Quarterly Report.pdf'), PDF);
    writeFileSync(join(dir, 'team.csv'), 'name,role\nAna,Lead\n');
    writeFileSync(join(dir, 'fake.pdf'), 'not a pdf');
    writeFileSync(join(dir, 'tool.txt'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
    writeFileSync(join(dir, 'deck.pptx'), 'PK\u0003\u0004');
    const pdf = await readFilePath(join(dir, 'Quarterly Report.pdf'));
    assert.deepEqual({ mediaType: pdf.mediaType, filename: pdf.filename }, { mediaType: 'application/pdf', filename: 'Quarterly Report.pdf' });
    assert.equal(Buffer.from(pdf.url.split(',')[1]!, 'base64').equals(PDF), true);
    const files = terminalAttachments({ files: true });
    const dropped = await files.fromText!(`${join(dir, 'Quarterly\\ Report.pdf')} '${join(dir, 'team.csv')}'`, { attached: [] });
    assert.deepEqual(dropped?.files?.map(f => [f.filename, f.mediaType]), [['Quarterly Report.pdf', 'application/pdf'], ['team.csv', 'text/csv']]);
    assert.deepEqual(await files.fromText!(join(dir, 'fake.pdf'), { attached: [] }), { notice: notices.fileUnreadable });
    assert.deepEqual(await files.fromText!(join(dir, 'tool.txt'), { attached: [] }), { notice: notices.fileUnsupported });
    assert.deepEqual(await files.fromText!(join(dir, 'deck.pptx'), { attached: [] }), { notice: notices.fileUnsupported });
    assert.equal(await files.fromText!(join(dir, 'missing.pdf'), { attached: [] }), undefined, 'a path that does not exist stays typed text');
    assert.equal(await files.fromText!('just some words', { attached: [] }), undefined);
    // Without file tools, document paths stay text (images only, as before).
    assert.equal(await terminalAttachments().fromText!(join(dir, 'team.csv'), { attached: [] }), undefined);
    // Per-message file count.
    const many = Array.from({ length: FILE_LIMITS.maxFilesPerMessage }, () => dropped!.files![1]!);
    assert.equal(withinBudget(many, [dropped!.files![1]!]), notices.filesTooMany);
    assert.equal(withinBudget(many.slice(1), [dropped!.files![1]!]), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
