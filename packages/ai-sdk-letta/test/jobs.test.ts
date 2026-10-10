import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  jobTools, jobsEnabled, parseJobStart, parseJobUpdate, parseJobEnd, readJobImage, sniffJobImage, defineAgent, adoptedDefinition, defaultAdoptedTools, adoptedInstructionsSection,
  JOB_TOOL_PERMISSIONS, JOBS_CONTEXT, JOBS_NOTE, JOB_LIMITS, type JobDesk, type JobUpdateRequest,
} from '../src/index.js';
import { png } from './png.js';

test('parse: goal, total and unit are cleaned; invalid input is refused', () => {
  assert.deepEqual(parseJobStart({ goal: '  Play\u202e 20\ngames ', total: 20, unit: 'games' }), { goal: 'Play 20 games', total: 20, unit: 'games' });
  assert.equal(parseJobStart({ goal: '   ' }), undefined);
  assert.equal(parseJobStart({ goal: 'x', total: -1 }), undefined);
  assert.equal(parseJobStart({ goal: 'x', total: 0 }), undefined);
  assert.equal(parseJobStart({ goal: 'x', total: Number.NaN }), undefined);
  assert.equal(parseJobStart(['x']), undefined);
  assert.equal(parseJobStart({ goal: 'x'.repeat(500) })!.goal.length, JOB_LIMITS.maxGoalCharacters);
  assert.deepEqual(parseJobUpdate({ jobId: 'job-1', done: 3, message: 'a\n\nb\u0007' }), { jobId: 'job-1', done: 3, message: 'a\nb' });
  assert.equal(parseJobUpdate({ jobId: '../x' }), undefined);
  assert.equal(parseJobUpdate({ jobId: 'j', done: -2 }), undefined);
  assert.equal(parseJobUpdate({ jobId: 'j', image: 3 }), undefined);
  assert.deepEqual(parseJobEnd({ jobId: 'j' }), { jobId: 'j', status: 'done' });
  assert.equal(parseJobEnd({ jobId: 'j', status: 'won' }), undefined);
  assert.deepEqual(parseJobEnd({ jobId: 'j', status: 'failed', result: ' Lost\n' }), { jobId: 'j', status: 'failed', result: 'Lost' });
});

test('sniff: PNG, JPEG, WebP and SVG by content only', () => {
  assert.equal(sniffJobImage(png()), 'image/png');
  assert.equal(sniffJobImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffJobImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffJobImage(Buffer.from('<?xml version="1.0"?>\n<!-- chart -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(sniffJobImage(Buffer.from('<html><svg></svg></html>')), undefined);
  assert.equal(sniffJobImage(Buffer.from('GIF89a')), undefined);
});

test('image path guard: inside the workspace or project only, size and type checked', () => {
  const root = mkdtempSync(join(tmpdir(), 'jobs-img-'));
  try {
    const workspace = join(root, 'ws'); const folder = join(workspace, 'Chat'); const project = join(root, 'proj'); const outside = join(root, 'outside');
    for (const d of [folder, project, outside]) mkdirSync(d, { recursive: true });
    writeFileSync(join(folder, 'chart.png'), png());
    writeFileSync(join(project, 'board.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(outside, 'secret.png'), png());
    writeFileSync(join(folder, 'notes.txt'), 'hello');
    writeFileSync(join(folder, 'big.png'), Buffer.concat([png(), Buffer.alloc(JOB_LIMITS.maxImageBytes)]));
    symlinkSync(join(outside, 'secret.png'), join(folder, 'link.png'));
    symlinkSync(outside, join(folder, 'escape'));
    const paths = { workspace, folder, project };
    assert.equal(readJobImage('chart.png', paths).mediaType, 'image/png');
    assert.equal(readJobImage('/workspace/Chat/chart.png', paths).mediaType, 'image/png');
    assert.equal(readJobImage('/project/board.svg', paths).mediaType, 'image/svg+xml');
    const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (error) { return (error as { code?: string }).code; } };
    assert.equal(code(() => readJobImage('../../outside/secret.png', paths)), 'image_outside');
    assert.equal(code(() => readJobImage(join(outside, 'secret.png'), paths)), 'image_outside');
    assert.equal(code(() => readJobImage('/etc/passwd', paths)), 'image_outside');
    assert.equal(code(() => readJobImage('link.png', paths)), 'image_outside');
    assert.equal(code(() => readJobImage('escape/secret.png', paths)), 'image_outside');
    assert.equal(code(() => readJobImage('/project/board.svg', { workspace, folder })), 'image_outside');
    assert.equal(code(() => readJobImage('notes.txt', paths)), 'image_unsupported');
    assert.equal(code(() => readJobImage('missing.png', paths)), 'image_not_found');
    assert.equal(code(() => readJobImage('big.png', paths)), 'image_too_large');
    assert.equal(code(() => readJobImage('chart.png')), 'image_outside');
    // Data URLs: small images only, content checked.
    assert.equal(readJobImage(`data:image/png;base64,${png().toString('base64')}`).mediaType, 'image/png');
    assert.equal(code(() => readJobImage(`data:image/png;base64,${Buffer.from('nope').toString('base64')}`)), 'image_unsupported');
    assert.equal(code(() => readJobImage('data:text/html;base64,PGh0bWw+')), 'image_unsupported');
    assert.equal(code(() => readJobImage(`data:image/png;base64,${Buffer.alloc(JOB_LIMITS.maxDataUrlBytes + 10).toString('base64')}`)), 'image_too_large');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tools: tiny results, bound desk, image re-read from the last path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jobs-tools-'));
  try {
    const folder = join(root, 'Chat'); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'chart.png'), png(4, 4, [1, 2, 3]));
    const calls: { kind: string; id?: string; request?: unknown }[] = [];
    let ref: string | undefined;
    const desk: JobDesk = {
      start: request => { calls.push({ kind: 'start', request }); return { id: 'job-1' }; },
      update: (id, request: JobUpdateRequest) => { calls.push({ kind: 'update', id, request }); if (request.imageRef) ref = request.imageRef; },
      end: (id, request) => { calls.push({ kind: 'end', id, request }); },
      imageRef: () => ref,
    };
    const context = { [JOBS_CONTEXT]: { desk, conversationId: 'c-1', paths: () => ({ workspace: root, folder }) } };
    const run = (name: keyof typeof jobTools, input: unknown, ctx: Record<string, unknown> | undefined = context) => (jobTools[name].execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 't', messages: [], context: ctx });
    assert.deepEqual(await run('job_start', { goal: 'Play', total: 20, unit: 'games' }), { jobId: 'job-1' });
    assert.deepEqual(await run('job_update', { jobId: 'job-1', done: 1, message: 'game 1 won', image: 'chart.png' }), { ok: true });
    const first = calls[1]!.request as JobUpdateRequest;
    assert.equal(first.image?.mediaType, 'image/png'); assert.equal(first.imageRef, 'chart.png');
    // No image given: the last file is read again (the picture follows the file).
    writeFileSync(join(folder, 'chart.png'), png(8, 8, [9, 9, 9]));
    assert.deepEqual(await run('job_update', { jobId: 'job-1', done: 2 }), { ok: true });
    assert.equal((calls[2]!.request as JobUpdateRequest).image?.bytes.length, png(8, 8, [9, 9, 9]).length);
    assert.deepEqual(await run('job_update', { jobId: 'job-1', image: '/etc/passwd' }), { error: 'image_outside', message: 'The image must be a file under /workspace, /project or the conversation folder.' });
    assert.deepEqual(await run('job_end', { jobId: 'job-1', result: 'Won 14' }), { ok: true });
    assert.deepEqual(await run('job_start', { goal: 'x' }, {}), { error: 'jobs_unavailable', message: 'Jobs are not available here; report progress in your reply instead.' });
    assert.equal(((await run('job_update', { jobId: 'job-1', done: -1 })) as { error: string }).error, 'invalid_input');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('definitions: jobs allowed by default for adopted agents, with the note', () => {
  assert.deepEqual(JOB_TOOL_PERMISSIONS, { job_start: 'allow', job_update: 'allow', job_end: 'allow' });
  assert.ok(defaultAdoptedTools().includes('jobs'));
  const adopted = adoptedDefinition({ definitionId: 'a', agentId: 'agent-local-00000000-0000-4000-8000-000000000000', name: 'A', model: 'openai/gpt', tools: defaultAdoptedTools(), adoptedAt: new Date().toISOString() });
  assert.ok(jobsEnabled(adopted));
  assert.ok(adoptedInstructionsSection(Object.keys(adopted.tools), 'policy').includes(JOBS_NOTE));
  const plain = defineAgent({ id: 'p', name: 'P', model: 'openai/gpt', instructions: 'x', tools: {}, permissions: {} });
  assert.equal(jobsEnabled(plain), false);
});
