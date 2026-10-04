import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { ThreadRuntime, TeamDirectory, guiApp, teamApp, PREVIEW_CSP, type RuntimeHost, type TeamAgent } from '../src/index.js';
import { ProjectFolder, PROJECT_LIMITS, parseStatus, projectPath } from '../src/project.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv }).toString();

/** A small git project with a .gitignore, nested folders, Markdown, an image, an outside symlink and an inside one. */
function project(options: { git?: boolean } = { git: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-project-'));
  const root = join(dir, 'site');
  const outside = join(dir, 'outside');
  mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'top secret\n');
  mkdirSync(join(root, 'content', 'posts'), { recursive: true });
  mkdirSync(join(root, 'public'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(root, 'static', 'img'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '/public/\n*.log\ncontent/drafts/\n');
  writeFileSync(join(root, 'README.md'), '# Site\n\nHello.\n');
  writeFileSync(join(root, 'content', 'posts', 'first.md'), '# First post\n');
  writeFileSync(join(root, 'content', 'posts', 'tracked.log'), 'tracked though ignored\n');
  mkdirSync(join(root, 'content', 'drafts'));
  writeFileSync(join(root, 'content', 'drafts', 'wip.md'), 'draft\n');
  writeFileSync(join(root, 'public', 'index.html'), '<p>built</p>');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  writeFileSync(join(root, 'dist', 'bundle.js'), 'x');
  writeFileSync(join(root, 'debug.log'), 'noise');
  writeFileSync(join(root, 'static', 'img', 'dot.png'), PNG);
  writeFileSync(join(root, 'page.html'), '<script>document.title="PWNED"</script><p>hi</p>');
  symlinkSync(outside, join(root, 'escape'));
  symlinkSync(join(outside, 'secret.txt'), join(root, 'secret-link.txt'));
  symlinkSync('README.md', join(root, 'readme-link.md'));
  symlinkSync('.git', join(root, 'git-link'));
  if (options.git !== false) {
    git(root, 'init', '-q');
    git(root, 'add', '.gitignore', 'README.md', 'content/posts/first.md', 'static', 'page.html');
    git(root, 'add', '-f', 'content/posts/tracked.log');
    git(root, 'commit', '-qm', 'init');
    writeFileSync(join(root, 'README.md'), '# Site\n\nChanged by the agent.\n');
    writeFileSync(join(root, 'content', 'posts', 'second.md'), '# New\n');
  } else rmSync(join(root, 'git-link'));
  return { dir, root, outside, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
/** A fingerprint of everything under a folder (names, sizes, contents), to prove nothing was written. */
function fingerprint(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string) => { for (const name of readdirSync(dir).sort()) { const path = join(dir, name); const info = statSync(path, { throwIfNoEntry: false }); hash.update(`${path}\0${info?.size}\0${info?.mtimeMs}\0`); if (info?.isDirectory() && !path.endsWith('escape') && !path.endsWith('git-link')) walk(path); else if (info?.isFile()) hash.update(readFileSync(path)); } };
  walk(root);
  return hash.digest('hex');
}

test('project paths: no traversal, no control characters; the top is allowed only for listings', () => {
  assert.deepEqual(projectPath('', true), []);
  assert.deepEqual(projectPath('/content/posts/', true), ['content', 'posts']);
  for (const bad of ['..', 'a/../b', './a', 'a//b', 'a\0b', 'a\\b', 'x'.repeat(PROJECT_LIMITS.maxPathChars + 1), 42, undefined]) assert.throws(() => projectPath(bad, true), /file_name_invalid/, String(bad).slice(0, 20));
  assert.throws(() => projectPath('', false), /file_name_invalid/);
});

test('listing is lazy, hides .git, node_modules and .gitignore matches, keeps tracked files, and shows git status', async () => {
  const p = project();
  try {
    const before = fingerprint(p.root);
    const folder = new ProjectFolder(p.root);
    const top = await folder.list('');
    assert.equal(top.name, 'site'); assert.equal(top.git, true);
    const names = top.entries.map(e => e.name);
    // Folders first (`dist` is not in this .gitignore), then files; a link outside is listed as a file.
    assert.deepEqual(names, ['content', 'dist', 'static', '.gitignore', 'escape', 'page.html', 'readme-link.md', 'README.md', 'secret-link.txt']);
    for (const hidden of ['.git', 'node_modules', 'public', 'debug.log', 'git-link']) assert.ok(!names.includes(hidden), `${hidden} is hidden`);
    // Only the top level: no children are read.
    assert.ok(top.entries.every(e => !('children' in e)));
    const readme = top.entries.find(e => e.name === 'README.md')!;
    assert.equal(readme.status, 'modified'); assert.ok(readme.bytes! > 0);
    assert.equal(top.entries.find(e => e.name === 'content')!.status, 'changed', 'a folder holding changes');
    assert.equal(top.entries.find(e => e.name === 'static')!.status, undefined);
    assert.ok((top.changes ?? 0) >= 2);
    // Links: one inside is followed; ones outside are listed without anything about their target.
    assert.deepEqual(top.entries.find(e => e.name === 'escape'), { name: 'escape', path: 'escape', type: 'file', link: 'outside' });
    assert.deepEqual(top.entries.find(e => e.name === 'secret-link.txt'), { name: 'secret-link.txt', path: 'secret-link.txt', type: 'file', link: 'outside' });
    assert.equal(top.entries.find(e => e.name === 'readme-link.md')?.link, 'inside');
    const posts = await folder.list('content/posts');
    assert.deepEqual(posts.entries.map(e => [e.name, e.status ?? '']), [['first.md', ''], ['second.md', 'untracked'], ['tracked.log', '']]);
    const content = await folder.list('content');
    assert.deepEqual(content.entries.map(e => e.name), ['posts'], 'content/drafts/ is ignored');
    await assert.rejects(folder.list('content/drafts'), /file_not_found/);
    await assert.rejects(folder.list('node_modules'), /file_not_found/);
    await assert.rejects(folder.list('.git'), /file_not_found/);
    await assert.rejects(folder.list('public'), /file_not_found/);
    // Outside: refused, by link or by traversal.
    await assert.rejects(folder.list('escape'), (e: Error & { status?: number }) => e.message === 'project_outside' && e.status === 403);
    await assert.rejects(folder.list('../outside'), /file_name_invalid/);
    // Nothing was written: not the files, not the index (no optional locks).
    assert.equal(fingerprint(p.root), before);
  } finally { p.cleanup(); }
});

test('entries per directory are capped, with more pages', async () => {
  const p = project();
  try {
    mkdirSync(join(p.root, 'many'));
    for (let i = 0; i < 250; i++) writeFileSync(join(p.root, 'many', `f${i}.txt`), 'x');
    const folder = new ProjectFolder(p.root);
    const first = await folder.list('many');
    assert.equal(first.entries.length, PROJECT_LIMITS.pageSize); assert.equal(first.total, 250); assert.equal(first.more, true);
    assert.deepEqual(first.entries.slice(0, 3).map(e => e.name), ['f0.txt', 'f1.txt', 'f2.txt'], 'natural order');
    const next = await folder.list('many', first.entries.length);
    assert.equal(next.entries.length, 50); assert.equal(next.more, false);
    assert.equal((await folder.list('many', 0, 10_000)).entries.length, 250, 'a page is at most maxPageSize');
  } finally { p.cleanup(); }
});

test('reading: by content type, size-capped, ignored and hidden paths not found, links outside refused', async () => {
  const p = project();
  try {
    const folder = new ProjectFolder(p.root);
    const md = await folder.read('content/posts/first.md', 1024);
    assert.equal(md.kind, 'text'); assert.equal(md.bytes.toString(), '# First post\n');
    assert.equal((await folder.read('static/img/dot.png', 1024)).kind, 'image');
    assert.equal((await folder.read('readme-link.md', 1024)).name, 'readme-link.md', 'a link inside the project is fine');
    await assert.rejects(folder.read('README.md', 4), (e: Error & { status?: number }) => e.message === 'file_too_large' && e.status === 413);
    await assert.rejects(folder.read('secret-link.txt', 1024), (e: Error & { status?: number }) => e.message === 'project_outside' && e.status === 403);
    await assert.rejects(folder.read('escape/secret.txt', 1024), /project_outside/);
    await assert.rejects(folder.read('git-link/config', 1024), /file_not_found/, 'a link to .git is still .git');
    await assert.rejects(folder.read('.git/config', 1024), /file_not_found/);
    await assert.rejects(folder.read('node_modules/pkg/index.js', 1024), /file_not_found/);
    await assert.rejects(folder.read('public/index.html', 1024), /file_not_found/, 'ignored by .gitignore');
    await assert.rejects(folder.read('debug.log', 1024), /file_not_found/);
    assert.equal((await folder.read('content/posts/tracked.log', 1024)).kind, 'text', 'tracked files stay readable even when ignored');
    await assert.rejects(folder.read('content', 1024), /file_not_found/, 'a folder is not a file');
    await assert.rejects(folder.read('missing.md', 1024), /file_not_found/);
  } finally { p.cleanup(); }
});

test('outside a git repository, a default ignore list applies', async () => {
  const p = project({ git: false });
  try {
    const top = await new ProjectFolder(p.root).list('');
    const names = top.entries.map(e => e.name);
    assert.equal(top.git, false);
    for (const hidden of ['node_modules', 'dist']) assert.ok(!names.includes(hidden), hidden);
    assert.ok(names.includes('public') && names.includes('debug.log'), '.gitignore is git’s; without git it is not used');
    assert.ok(top.entries.every(e => e.status === undefined));
  } finally { p.cleanup(); }
});

test('git status parsing', () => {
  const status = parseStatus(' M a/b.md\0?? new/\0A  c.txt\0 D d.txt\0?? e.txt\0');
  assert.equal(status.count, 5);
  assert.equal(status.of('a/b.md', false), 'modified');
  assert.equal(status.of('a', true), 'changed');
  assert.equal(status.of('new', true), 'untracked');
  assert.equal(status.of('new/x.md', false), 'untracked');
  assert.equal(status.of('c.txt', false), 'added');
  assert.equal(status.of('d.txt', false), 'deleted');
  assert.equal(status.of('e.txt', false), 'untracked');
  assert.equal(status.of('z', true), undefined);
});

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const host = (project?: string): RuntimeHost => ({ ...(project ? { project } : {}), async open() { throw new Error('unused'); }, async close() {} });

test('HTTP (single-user): project routes need the session; previews are sandboxed, downloads attachments; outside links refused; never writes', async () => {
  const p = project();
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-project-app-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const runtime = new ThreadRuntime(host(p.root), join(dir, 'state.json'), 'owner');
  const server = guiApp(runtime, 'owner', 0, dir, { id: 'x', name: 'X', files: true, project: 'site' }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const before = fingerprint(p.root);
    const session = await fetch(`${base}/api/session`);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf, agent } = await session.json() as { csrf: string; agent: { project?: string } };
    assert.equal(agent.project, 'site', 'the session names the project');
    const get = (path: string, headers: Record<string, string> = { cookie }) => fetch(`${base}/api/v1/project/${path}`, { headers });
    assert.equal((await get('list?path=')).status, 200);
    assert.equal((await get('list', {})).status, 401, 'session required');
    assert.equal((await get('file?path=README.md', {})).status, 401);
    assert.equal((await get('preview?path=README.md', {})).status, 401);
    const top = await (await get('list')).json() as { entries: { name: string }[] };
    assert.ok(top.entries.some(e => e.name === 'README.md'));
    // Read-only: no write route exists (POST is refused without CSRF, and 404s with it).
    assert.equal((await fetch(`${base}/api/v1/project/list`, { method: 'POST', headers: { cookie } })).status, 403, 'CSRF required');
    for (const route of ['upload', 'move', 'delete', 'folders']) assert.equal((await fetch(`${base}/api/v1/project/${route}`, { method: 'POST', headers: { cookie, origin: base, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: '{}' })).status, 404, route);
    const md = await get('preview?path=content/posts/first.md');
    assert.equal(md.status, 200); assert.equal(md.headers.get('content-type'), 'text/plain; charset=utf-8');
    const html = await get('preview?path=page.html');
    assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(html.headers.get('content-security-policy'), PREVIEW_CSP);
    assert.match(html.headers.get('content-disposition')!, /^inline;/);
    const image = await get('preview?path=static/img/dot.png');
    assert.equal(image.headers.get('content-type'), 'image/png');
    const download = await get('file?path=page.html');
    assert.equal(download.headers.get('content-type'), 'text/plain; charset=utf-8', 'downloads never serve HTML');
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.equal((await get('file?path=secret-link.txt')).status, 403, 'outside link refused');
    assert.equal((await get('preview?path=escape/secret.txt')).status, 403);
    assert.equal((await get(`file?path=${encodeURIComponent('../outside/secret.txt')}`)).status, 400);
    assert.equal((await get('file?path=.git/config')).status, 404);
    assert.equal((await get('list?path=escape')).status, 403);
    assert.equal(fingerprint(p.root), before, 'nothing written');
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.close(); rmSync(dir, { recursive: true, force: true }); p.cleanup();
  }
});

test('HTTP: an agent without a project folder answers project_none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-project-none-'));
  const runtime = new ThreadRuntime(host(), join(dir, 'state.json'), 'owner');
  try {
    await assert.rejects(runtime.projectList('owner', ''), (e: Error & { status?: number }) => e.message === 'project_none' && e.status === 404);
    await assert.rejects(runtime.projectList('intruder', ''), /forbidden/);
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP (team): project routes need membership of the agent', async () => {
  const p = project();
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-project-team-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const directory = new TeamDirectory(join(dir, 'team', 'team.json'), ['owner@example.com']);
  directory.bootstrap(['alpha']);
  const runtime = new ThreadRuntime({ ...host(p.root), parallel: true }, join(dir, 'state.json'), 'team', { queue: true, parallel: true });
  const agents = new Map<string, TeamAgent>([['alpha', { info: { id: 'alpha', name: 'Alpha', project: 'site' }, runtime }]]);
  const server = teamApp({ port: 0, assets, agents, directory, origins: ['https://machine.example.ts.net'] }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const get = (login: string | undefined, path: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${address.port}${path}`, { headers: { host: 'machine.example.ts.net', ...(login ? { 'tailscale-user-login': login, 'tailscale-user-name': login } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, text }));
    });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal((await get(undefined, '/api/agents/alpha/v1/project/list')).status, 401);
    assert.equal((await get('otto@example.com', '/api/agents/alpha/v1/project/list')).status, 404, 'not a member: same as unknown');
    assert.equal((await get('otto@example.com', '/api/agents/alpha/v1/project/file?path=README.md')).status, 404);
    const listed = await get('owner@example.com', '/api/agents/alpha/v1/project/list');
    assert.equal(listed.status, 200); assert.match(listed.text, /README\.md/);
    const session = JSON.parse((await get('owner@example.com', '/api/session')).text) as { agents: { project?: string }[] };
    assert.equal(session.agents[0]!.project, 'site');
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.close(); rmSync(dir, { recursive: true, force: true }); p.cleanup();
  }
});
