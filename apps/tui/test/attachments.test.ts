import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { IMAGE_LIMITS } from 'ai-sdk-letta';
import { notices, parsePastedPaths, readClipboard, terminalAttachments, withinBudget } from '../src/attachments.js';

function png(): Buffer {
  const chunk = (type: string, data: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}
const exec = (outputs: Record<string, { stdout: string | Buffer; code?: number } | 'missing'>, calls: string[][] = []) => async (command: string, args: string[]) => {
  calls.push([command, ...args]);
  const key = Object.keys(outputs).find(k => [command, ...args].join(' ').includes(k));
  const out = key ? outputs[key] : 'missing';
  if (out === 'missing') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return { stdout: Buffer.isBuffer(out.stdout) ? out.stdout : Buffer.from(out.stdout), code: out.code ?? 0 };
};

test('pasted/dropped paths: escaped, quoted, file URLs, several, home; plain text is not a path', () => {
  assert.deepEqual(parsePastedPaths('/Users/me/My\\ Photo\\ \\(1\\).png'), ['/Users/me/My Photo (1).png']);
  assert.deepEqual(parsePastedPaths(`'/tmp/it'\\''s.png'`), ["/tmp/it's.png"]);
  assert.deepEqual(parsePastedPaths('"/tmp/a b.jpg" /tmp/c.webp'), ['/tmp/a b.jpg', '/tmp/c.webp']);
  assert.deepEqual(parsePastedPaths('/tmp/a.png\n/tmp/b.png\n'), ['/tmp/a.png', '/tmp/b.png']);
  assert.deepEqual(parsePastedPaths('file:///tmp/My%20Shot.png'), ['/tmp/My Shot.png']);
  assert.deepEqual(parsePastedPaths('~/Desktop/shot.png', '/home/me'), ['/home/me/Desktop/shot.png']);
  assert.deepEqual(parsePastedPaths('./shot.png'), ['./shot.png']);
  assert.equal(parsePastedPaths('look at /tmp/a.png please'), undefined);
  assert.equal(parsePastedPaths('hello world'), undefined);
  assert.equal(parsePastedPaths('"/tmp/unterminated.png'), undefined);
  assert.equal(parsePastedPaths('file://remote-host/tmp/a.png'), undefined);
  assert.equal(parsePastedPaths(''), undefined);
});

test('fromText attaches existing image files, validates content, leaves other text alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-attach-'));
  try {
    writeFileSync(join(dir, 'a b.png'), png());
    writeFileSync(join(dir, 'fake.png'), '<svg/>');
    writeFileSync(join(dir, 'big.png'), Buffer.concat([png(), Buffer.alloc(IMAGE_LIMITS.maxImageBytes)]));
    writeFileSync(join(dir, 'pic.heic'), 'x');
    const { fromText } = terminalAttachments();
    const ok = await fromText!(join(dir, 'a\\ b.png'), { attached: [] });
    assert.equal(ok?.files?.length, 1);
    assert.equal(ok!.files![0]!.mediaType, 'image/png');
    assert.equal(ok!.files![0]!.filename, 'a b.png');
    assert.match(ok!.files![0]!.url, /^data:image\/png;base64,/);
    assert.deepEqual(await fromText!(join(dir, 'fake.png'), { attached: [] }), { notice: notices.unsupported });
    assert.deepEqual(await fromText!(join(dir, 'big.png'), { attached: [] }), { notice: notices.tooLarge });
    assert.deepEqual(await fromText!(join(dir, 'pic.heic'), { attached: [] }), { notice: notices.unsupported });
    // Missing files, non-image paths and prose stay typed text.
    assert.equal(await fromText!(join(dir, 'missing.png'), { attached: [] }), undefined);
    assert.equal(await fromText!(join(dir, 'notes.txt'), { attached: [] }), undefined);
    assert.equal(await fromText!('just some pasted text', { attached: [] }), undefined);
    // Count limit.
    const four = Array.from({ length: IMAGE_LIMITS.maxImages }, () => ok!.files![0]!);
    assert.deepEqual(await fromText!(join(dir, 'a\\ b.png'), { attached: four }), { notice: notices.tooMany });
    assert.equal(withinBudget([], four), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('macOS clipboard: image, copied files, nothing, failure', async () => {
  const image = png();
  const withImage = async (command: string, args: string[]) => { writeFileSync(args.at(-1)!, image); return { stdout: Buffer.from('IMAGE\n'), code: 0 }; };
  const got = await readClipboard('darwin', withImage);
  assert.ok('image' in got && got.image.equals(image));
  assert.deepEqual(await readClipboard('darwin', exec({ osascript: { stdout: 'NONE' } })), { none: notices.noImage });
  assert.deepEqual(await readClipboard('darwin', exec({ osascript: { stdout: 'FILES\n/tmp/a.png\n/tmp/b b.png' } })), { paths: ['/tmp/a.png', '/tmp/b b.png'] });
  assert.deepEqual(await readClipboard('darwin', exec({ osascript: { stdout: '', code: 1 } })), { none: notices.clipboardFailed });
  // The Ctrl+V handler turns these into files or a gentle notice, never a throw.
  const { fromClipboard } = terminalAttachments({ platform: 'darwin', exec: withImage });
  const result = await fromClipboard!({ attached: [] });
  assert.equal(result.files?.[0]?.mediaType, 'image/png');
  assert.deepEqual(await terminalAttachments({ platform: 'darwin', exec: exec({ osascript: { stdout: 'NONE' } }) }).fromClipboard!({ attached: [] }), { notice: notices.noImage });
  assert.deepEqual(await terminalAttachments({ platform: 'darwin', exec: async () => { throw new Error('boom'); } }).fromClipboard!({ attached: [] }), { notice: notices.unreadable });
});

test('Linux clipboard: wl-paste on Wayland, xclip on X11, graceful without tools or display', async () => {
  const saved = { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, DISPLAY: process.env.DISPLAY };
  try {
    process.env.WAYLAND_DISPLAY = 'wayland-0'; delete process.env.DISPLAY;
    const calls: string[][] = [];
    const got = await readClipboard('linux', exec({ '--list-types': { stdout: 'text/plain\nimage/png\n' }, '--type image/png': { stdout: png() } }, calls));
    assert.ok('image' in got);
    assert.deepEqual(calls[1], ['wl-paste', '--no-newline', '--type', 'image/png']);
    assert.deepEqual(await readClipboard('linux', exec({ '--list-types': { stdout: 'text/plain\n' } })), { none: notices.noImage });
    assert.deepEqual(await readClipboard('linux', exec({ '--list-types': { stdout: 'text/uri-list\n' }, '--type text/uri-list': { stdout: 'file:///tmp/a%20b.png\r\n' } })), { paths: ['/tmp/a b.png'] });
    delete process.env.WAYLAND_DISPLAY; process.env.DISPLAY = ':0';
    const x = await readClipboard('linux', exec({ TARGETS: { stdout: 'TARGETS\nimage/jpeg\n' }, '-t image/jpeg -o': { stdout: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) } }));
    assert.ok('image' in x);
    // No clipboard tool installed, or no display at all.
    assert.deepEqual(await readClipboard('linux', exec({})), { none: notices.noTool });
    delete process.env.DISPLAY;
    assert.deepEqual(await readClipboard('linux', exec({})), { none: notices.noTool });
    assert.deepEqual(await readClipboard('win32', exec({})), { none: notices.unsupportedPlatform });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('clipboard images are validated like files', async () => {
  const withBytes = (bytes: Buffer) => async (_c: string, args: string[]) => { writeFileSync(args.at(-1)!, bytes); return { stdout: Buffer.from('IMAGE'), code: 0 }; };
  assert.deepEqual(await terminalAttachments({ platform: 'darwin', exec: withBytes(Buffer.from('not an image')) }).fromClipboard!({ attached: [] }), { notice: notices.unsupported });
  assert.deepEqual(await terminalAttachments({ platform: 'darwin', exec: withBytes(Buffer.concat([png(), Buffer.alloc(IMAGE_LIMITS.maxImageBytes)])) }).fromClipboard!({ attached: [] }), { notice: notices.tooLarge });
});
