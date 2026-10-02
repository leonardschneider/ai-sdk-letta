import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTOR_CONTEXT, ATLASSIAN_CONTEXT, ATLASSIAN_TOOL_PERMISSIONS, AttachmentStore, CredentialStore, LOCAL_ACTOR, ResourceStore, ToolInteractions, WORKSPACE_CONTEXT,
  adfToMarkdown, atlassianEnabled, atlassianTools, atlassianUrl, connectAtlassian, createToolBridge, defineAgent, downloadAtlassianMedia, normalizeSite, parseReference, publicStatus, readSavedDocument, responseText, testAtlassian,
  type AdfDocument, type AtlassianCredentials, type InteractionRequest, type TurnActor,
} from '../src/index.js';

const SITE = 'https://acme.atlassian.net';
const TOKEN = 'ATATT3x-secret-token-value-123';
const AGENT = 'agent-local-atl1';
const t = (text: string) => ({ type: 'text', text });
const p = (...content: object[]) => ({ type: 'paragraph', content });
const description: AdfDocument = { version: 1, type: 'doc', content: [
  { type: 'heading', attrs: { level: 2 }, content: [t('Context')] },
  p(t('Owner: '), { type: 'mention', attrs: { id: 'acc-1', text: '@Jane Doe' } }, t(' — '), { type: 'status', attrs: { text: 'IN PROGRESS', color: 'blue', localId: 's' } }),
  p(t('The second paragraph is plain.')),
  { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { id: '47b08493-e8dc-43d6-a847-a076439762e6', type: 'file', collection: '', alt: 'shot.png' } }] },
  p(t('Closing paragraph.')),
] as AdfDocument['content'] };
const pageDoc: AdfDocument = { version: 1, type: 'doc', content: [p(t('Page intro.')), { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('Keep me.'))] }, p(t('Page body.'))] as AdfDocument['content'] };
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

/** A fake Atlassian Cloud site: one issue, one page, one attachment; records every request. */
function fakeSite() {
  const state = { issue: { description: structuredClone(description), updated: '2026-10-01T10:00:00.000-0700', summary: 'Test issue' }, page: { doc: structuredClone(pageDoc), version: 3, title: 'Test page' }, token: TOKEN };
  const requests: { method: string; url: string; auth?: string; body?: unknown }[] = [];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const auth = headers.get('authorization') ?? undefined;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, url: url.href, ...(auth ? { auth } : {}), ...(body !== undefined ? { body } : {}) });
    if (url.hostname === 'api.media.atlassian.com') return auth ? json(403, {}) : new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
    if (url.origin !== SITE) return json(404, {});
    if (auth !== `Basic ${Buffer.from(`me@example.com:${state.token}`).toString('base64')}`) return json(401, { message: 'Unauthorized' });
    const path = url.pathname;
    if (path === '/rest/api/3/myself') return json(200, { accountId: 'acc-me', displayName: 'Me Example', avatarUrls: { '48x48': 'x' } });
    if (path === '/rest/api/3/issue/KAN-1' && method === 'GET') return json(200, { id: '10000', key: 'KAN-1', fields: { summary: state.issue.summary, description: state.issue.description, updated: state.issue.updated, status: { name: 'To Do' }, issuetype: { name: 'Task' }, attachment: [{ id: '10000', filename: 'shot.png', mimeType: 'image/png', size: PNG.length }] } });
    if (path === '/rest/api/3/issue/KAN-1' && method === 'PUT') { state.issue.description = body.fields.description; state.issue.updated = '2026-10-01T11:00:00.000-0700'; return new Response(null, { status: 204 }); }
    if (path === '/rest/api/3/attachment/content/10000') return new Response(null, { status: 303, headers: { Location: 'https://api.media.atlassian.com/file/47b08493-e8dc-43d6-a847-a076439762e6/binary?token=short&dl=true' } });
    if (path === '/rest/api/3/search/jql') return json(200, { issues: [{ key: 'KAN-1', fields: { summary: 'Test issue', description: state.issue.description } }] });
    if (path === '/rest/api/3/issue' && method === 'POST') return json(201, { id: '10001', key: 'KAN-2' });
    if (path === '/wiki/api/v2/pages/42' && method === 'GET') return json(200, { id: '42', title: state.page.title, status: 'current', spaceId: '7', version: { number: state.page.version }, ...(url.searchParams.get('body-format') ? { body: { atlas_doc_format: { representation: 'atlas_doc_format', value: JSON.stringify(state.page.doc) } } } : {}), _links: { webui: '/spaces/X/pages/42/Test+page', base: `${SITE}/wiki` } });
    if (path === '/wiki/api/v2/pages/42' && method === 'PUT') {
      if (body.version.number !== state.page.version + 1) return json(409, { errors: [{ title: 'Version conflict' }] });
      state.page.doc = JSON.parse(body.body.value); state.page.version = body.version.number; state.page.title = body.title; return json(200, { id: '42' });
    }
    if (path === '/wiki/api/v2/pages/42/attachments') return json(200, { results: [] });
    return json(404, { errorMessages: ['Not found'] });
  }) as typeof fetch;
  return { state, requests, fetch: fetcher };
}

function setup(options: { actor?: TurnActor | null; connect?: boolean; onPrompt?: (request: InteractionRequest) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-atl-'));
  const store = new CredentialStore(join(root, 'credentials'));
  const site = fakeSite();
  const resources = ResourceStore.open(join(root, 'resources'), AGENT);
  const workspace = new AttachmentStore(resources, 'conv-a', { title: 'Chat' });
  const actor = options.actor === undefined ? LOCAL_ACTOR : options.actor ?? undefined;
  const credentials: AtlassianCredentials = { site: SITE, email: 'me@example.com', token: TOKEN, savedAt: new Date().toISOString(), status: 'ok', accountName: 'Me Example' };
  if (options.connect !== false) store.saveAtlassian(LOCAL_ACTOR.id, credentials);
  const interactions = new ToolInteractions();
  const prompts: InteractionRequest[] = [];
  let answer = true;
  interactions.connect(async request => { prompts.push(request); options.onPrompt?.(request); return { id: request.id, approved: answer }; });
  const context = () => Object.freeze({ [ATLASSIAN_CONTEXT]: { store, fetch: site.fetch }, [WORKSPACE_CONTEXT]: workspace, ...(actor ? { [ACTOR_CONTEXT]: actor } : {}) });
  const bridge = createToolBridge({ tools: atlassianTools, permissions: ATLASSIAN_TOOL_PERMISSIONS, interactions, context, timeoutMs: 10_000 });
  let n = 0;
  const run = async (name: string, args: unknown) => { const r = await bridge.execute(name, `call-${++n}`, args); return { text: r.content.map(c => c.type === 'text' ? c.text : '').join(''), isError: r.isError }; };
  return { root, store, site, workspace, prompts, run, deny: () => { answer = false; }, allow: () => { answer = true; }, credentials, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('credentials: stored 0600 in a 0700 directory, atomically, per user; the public status never includes the token', async () => {
  const s = setup({ connect: false });
  try {
    const status = await connectAtlassian(s.store, 'user-a', { site: 'acme.atlassian.net', email: 'me@example.com', token: TOKEN }, { fetch: s.site.fetch });
    assert.deepEqual({ ...status, savedAt: 'x', checkedAt: 'x' }, { connected: true, site: SITE, email: 'me@example.com', accountName: 'Me Example', savedAt: 'x', checkedAt: 'x', status: 'ok' });
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
    const folder = join(s.root, 'credentials', 'atlassian');
    const files = readdirSync(folder);
    assert.equal(files.length, 1, 'no temporary file left behind');
    assert.equal(statSync(folder).mode & 0o777, 0o700);
    assert.equal(statSync(join(s.root, 'credentials')).mode & 0o777, 0o700);
    assert.equal(statSync(join(folder, files[0]!)).mode & 0o777, 0o600);
    assert.equal(files[0]!.includes('user-a'), false, 'file names do not reveal user IDs');
    // Per-user isolation: another user sees nothing, and a copied file is not accepted under another name.
    assert.equal(s.store.atlassian('user-b'), undefined);
    const other = new CredentialStore(join(s.root, 'credentials'));
    other.saveAtlassian('user-b', { ...s.credentials, token: 'other-token' });
    assert.equal(s.store.atlassian('user-a')!.token, TOKEN);
    assert.equal(s.store.atlassian('user-b')!.token, 'other-token');
    const [a, b] = ['user-a', 'user-b'].map(id => readdirSync(folder).find(f => readFileSync(join(folder, f), 'utf8').includes(`"userId":"${id}"`))!);
    writeFileSync(join(folder, b!), readFileSync(join(folder, a!)));
    assert.equal(s.store.atlassian('user-b'), undefined, 'a record names its owner');
    // A wrong token is never stored.
    await assert.rejects(connectAtlassian(s.store, 'user-c', { site: SITE, email: 'me@example.com', token: 'wrong' }, { fetch: s.site.fetch }), /rejected/);
    assert.equal(s.store.atlassian('user-c'), undefined);
    // Only Atlassian Cloud sites.
    for (const site of ['http://acme.atlassian.net', 'https://evil.com', 'https://acme.atlassian.net.evil.com', 'https://user@acme.atlassian.net', 'https://acme.atlassian.net:8443']) assert.throws(() => normalizeSite(site), /Atlassian Cloud|Enter your site/);
    assert.equal(publicStatus(undefined).connected, false);
    assert.equal(s.store.deleteAtlassian('user-a'), true);
    assert.equal(s.store.atlassian('user-a'), undefined);
    assert.equal(s.store.deleteAtlassian('user-a'), false);
  } finally { s.cleanup(); }
});

test('401: marks the token rejected; tools then tell the user to replace it; test connection reports it', async () => {
  const s = setup();
  try {
    s.site.state.token = 'rotated';
    const first = await s.run('atlassian_request', { method: 'GET', path: '/rest/api/3/myself' });
    assert.equal(first.isError, true);
    assert.match(first.text, /token_rejected.*replace it in "Connect Atlassian"/);
    assert.equal(s.store.atlassian(LOCAL_ACTOR.id)!.status, 'rejected');
    const before = s.site.requests.length;
    const second = await s.run('atlassian_fetch', { ref: 'KAN-1' });
    assert.match(second.text, /token_rejected/);
    assert.equal(s.site.requests.length, before, 'a rejected token is not tried again until replaced');
    assert.equal((await testAtlassian(s.store, LOCAL_ACTOR.id, { fetch: s.site.fetch })).connected && (await testAtlassian(s.store, LOCAL_ACTOR.id, { fetch: s.site.fetch }) as { status: string }).status, 'rejected');
    s.site.state.token = TOKEN;
    const fixed = await testAtlassian(s.store, LOCAL_ACTOR.id, { fetch: s.site.fetch });
    assert.equal(fixed.connected && fixed.status, 'ok');
  } finally { s.cleanup(); }
});

test('tools act as the turn\'s user: not connected, and unattended runs, are refused with a clear message', async () => {
  const nobody = setup({ actor: null });
  try {
    const r = await nobody.run('atlassian_request', { method: 'GET', path: '/rest/api/3/myself' });
    assert.equal(r.isError, true);
    assert.match(r.text, /no_user.*not started by a person/);
    assert.equal(nobody.site.requests.length, 0);
  } finally { nobody.cleanup(); }
  const other = setup({ actor: { id: 'user-mia', name: 'Mia' } });
  try {
    const r = await other.run('atlassian_fetch', { ref: 'KAN-1' });
    assert.match(r.text, /not_connected.*Atlassian is not connected for Mia.*Connect Atlassian/);
    assert.equal(other.site.requests.length, 0, 'never falls back to someone else\'s token');
  } finally { other.cleanup(); }
});

test('path allowlist: only the user\'s site and the Jira and Confluence REST APIs', () => {
  for (const ok of ['/rest/api/3/issue/KAN-1?fields=summary', '/wiki/api/v2/pages/1', '/wiki/rest/api/search?cql=type%3Dpage', '/rest/api/3/search/jql?jql=project%20%3D%20KAN']) assert.equal(atlassianUrl(SITE, ok).origin, SITE);
  for (const bad of ['https://evil.com/rest/api/3/myself', '//evil.com/rest/api/3/myself', '/rest/api/2/issue/X', '/rest/api/3/../../admin', '/rest/api/3/%2e%2e/x', '/rest/api/3/a%2fb', '/secure/admin', '/wiki/plugins/x', 'rest/api/3/myself', '/rest/api/3/x\\y', '/rest/api/3/x\n', '/wiki/api/v2/./pages', '/rest/api/3/x#y', '/rest/auth/1/session'])
    assert.throws(() => atlassianUrl(SITE, bad), /path|allowed|REST/, bad);
});

test('atlassian_request: GET runs without asking and returns ADF as Markdown; changes ask with a readable preview', async () => {
  const s = setup();
  try {
    const read = await s.run('atlassian_request', { method: 'GET', path: '/rest/api/3/search/jql?jql=project=KAN&fields=summary,description' });
    assert.equal(read.isError, false);
    assert.equal(s.prompts.length, 0);
    assert.match(read.text, /GET .* → 200/);
    assert.match(read.text, /The second paragraph is plain\./);
    assert.equal(read.text.includes('"type":"paragraph"') || read.text.includes('"type": "paragraph"'), false, 'no raw ADF');
    const write = await s.run('atlassian_request', { method: 'POST', path: '/rest/api/3/issue', body: { fields: { summary: 'New', project: { key: 'KAN' }, description: { $markdown: 'Hello **world**' } } } });
    assert.equal(write.isError, false, write.text);
    assert.equal(s.prompts.length, 1);
    const prompt = s.prompts[0]!;
    assert.equal(prompt.kind, 'approval');
    assert.equal(prompt.preview?.kind, 'atlassian-request');
    assert.match(prompt.preview!.text, /POST https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue/);
    assert.match(prompt.preview!.text, /Hello \*\*world\*\*/);
    assert.equal(prompt.onBehalfOf, LOCAL_ACTOR.id);
    const sent = s.site.requests.find(r => r.method === 'POST')!;
    assert.equal((sent.body as { fields: { description: AdfDocument } }).fields.description.type, 'doc', '$markdown became ADF');
    // Denied: nothing is sent.
    s.deny();
    const denied = await s.run('atlassian_request', { method: 'DELETE', path: '/rest/api/3/issue/KAN-1' });
    assert.match(denied.text, /user_denied/);
    assert.equal(s.site.requests.some(r => r.method === 'DELETE'), false);
    // Off-site paths are refused before anyone is asked.
    const before = s.prompts.length;
    const offsite = await s.run('atlassian_request', { method: 'POST', path: '/rest/api/2/issue', body: {} });
    assert.match(offsite.text, /path_not_allowed/);
    assert.equal(s.prompts.length, before);
    // The token never reaches the model or a prompt.
    assert.equal(JSON.stringify(s.prompts).includes(TOKEN), false);
    assert.equal([read, write, denied, offsite].some(r => r.text.includes(TOKEN) || r.text.includes(Buffer.from(`me@example.com:${TOKEN}`).toString('base64'))), false);
    // Redirects are never followed with the token.
    assert.equal(s.site.requests.filter(r => !r.url.startsWith(SITE)).some(r => r.auth), false);
  } finally { s.cleanup(); }
});

test('responseText drops noise and truncates with a notice', () => {
  const text = responseText({ self: 'x', avatarUrls: {}, issues: Array.from({ length: 400 }, (_, i) => ({ key: `K-${i}`, fields: { summary: 'Summary text that is long enough' } })) }, 2000);
  assert.ok(text.length < 2300);
  assert.match(text, /\[Truncated: [\d,]+ more characters/);
  assert.equal(text.includes('avatarUrls'), false);
});

test('parseReference: keys, page IDs and links on the user\'s site only', () => {
  assert.deepEqual(parseReference('kan-12', SITE), { product: 'jira', key: 'KAN-12' });
  assert.deepEqual(parseReference(`${SITE}/browse/KAN-3`, SITE), { product: 'jira', key: 'KAN-3' });
  assert.deepEqual(parseReference(`${SITE}/jira/software/projects/KAN/boards/1?selectedIssue=KAN-4`, SITE), { product: 'jira', key: 'KAN-4' });
  assert.deepEqual(parseReference(`${SITE}/wiki/spaces/MFS/pages/458754/Title`, SITE), { product: 'confluence', id: '458754' });
  assert.deepEqual(parseReference('458754', SITE), { product: 'confluence', id: '458754' });
  assert.throws(() => parseReference('https://other.atlassian.net/browse/KAN-1', SITE), /connected site/);
});

test('fetch + update (Jira): saves .md and .adf.json; one edited paragraph is the only change; approval shows it; deny writes nothing', async () => {
  const s = setup();
  try {
    const fetched = await s.run('atlassian_fetch', { ref: 'KAN-1' });
    assert.equal(fetched.isError, false, fetched.text);
    assert.match(fetched.text, /Saved KAN-1\.md \(Markdown\) and KAN-1\.adf\.json/);
    assert.match(fetched.text, /\[image: shot\.png\]/, 'media named by their attachment (mapped through the content redirect)');
    const saved = readSavedDocument(s.workspace.read('KAN-1.adf.json').bytes.toString('utf8'))!;
    assert.equal(saved.source.product, 'jira');
    assert.equal(saved.media['47b08493-e8dc-43d6-a847-a076439762e6']?.download, '/rest/api/3/attachment/content/10000');
    const md = s.workspace.read('KAN-1.md').bytes.toString('utf8');
    assert.match(md, /^<!-- Jira KAN-1: Test issue · https:\/\/acme\.atlassian\.net\/browse\/KAN-1/);
    assert.equal(s.prompts.length, 0, 'reads never ask');

    s.deny();
    const denied = await s.run('atlassian_update', { file: 'KAN-1.md', edits: [{ find: 'The second paragraph is plain.', replace: 'The second paragraph was edited.' }] });
    assert.match(denied.text, /user_denied/);
    assert.equal(s.site.requests.some(r => r.method === 'PUT'), false);
    assert.equal(s.prompts.length, 1);
    const preview = s.prompts[0]!.preview!;
    assert.equal(preview.kind, 'atlassian-edit');
    assert.match(preview.text, /- The second paragraph is plain\.\n\+ The second paragraph was edited\./);
    assert.equal((preview.data!.changes as unknown[]).length, 1);

    s.allow();
    const updated = await s.run('atlassian_update', { file: 'KAN-1.md', edits: [{ find: 'The second paragraph is plain.', replace: 'The second paragraph was edited.' }] });
    assert.equal(updated.isError, false, updated.text);
    assert.match(updated.text, /Updated KAN-1 \(description\): 1 changed block/);
    const after = s.site.state.issue.description;
    assert.equal(after.content.length, description.content.length);
    for (const i of [0, 1, 3, 4]) assert.deepEqual(after.content[i], description.content[i], `block ${i} unchanged`);
    assert.equal(adfToMarkdown({ version: 1, type: 'doc', content: [after.content[2]!] }), 'The second paragraph was edited.\n');
    // The local copy follows the new version.
    assert.match(s.workspace.read('KAN-1.md').bytes.toString('utf8'), /was edited/);
    const unchanged = await s.run('atlassian_update', { file: 'KAN-1.md' });
    assert.match(unchanged.text, /no changes/);
  } finally { s.cleanup(); }
});

test('update refuses edits touching a mention or status, naming them, before anyone is asked', async () => {
  const s = setup();
  try {
    await s.run('atlassian_fetch', { ref: 'KAN-1' });
    const r = await s.run('atlassian_update', { file: 'KAN-1.md', edits: [{ find: 'Owner: @Jane Doe', replace: 'Owner: Jane' }] });
    assert.equal(r.isError, true);
    assert.match(r.text, /mention @Jane Doe/);
    assert.match(r.text, /status "IN PROGRESS"/);
    assert.match(r.text, /Nothing was written/);
    assert.equal(s.prompts.length, 0);
    assert.equal(s.site.requests.some(r => r.method === 'PUT'), false);
    const missing = await s.run('atlassian_update', { file: 'KAN-1.md', edits: [{ find: 'not in the file', replace: 'x' }] });
    assert.match(missing.text, /not in the file/);
  } finally { s.cleanup(); }
});

test('concurrency (Jira): a description changed since fetch is a conflict; a change while deciding too', async () => {
  const s = setup();
  try {
    await s.run('atlassian_fetch', { ref: 'KAN-1' });
    s.site.state.issue.description = { ...description, content: [...description.content, p(t('Added by someone else.'))] } as AdfDocument;
    s.site.state.issue.updated = '2026-10-01T10:30:00.000-0700';
    const r = await s.run('atlassian_update', { file: 'KAN-1.md', edits: [{ find: 'Closing paragraph.', replace: 'Closing, edited.' }] });
    assert.match(r.text, /conflict.*changed in Jira since it was fetched/);
    assert.equal(s.prompts.length, 0);
    assert.equal(s.site.requests.some(x => x.method === 'PUT'), false);
    // Only `updated` moved (a comment, a status change): the description is the same, so the update goes ahead.
    await s.run('atlassian_fetch', { ref: 'KAN-1' });
    s.site.state.issue.updated = '2026-10-01T10:45:00.000-0700';
    const ok = await s.run('atlassian_update', { file: 'KAN-1.md', edits: [{ find: 'Closing paragraph.', replace: 'Closing, edited.' }] });
    assert.equal(ok.isError, false, ok.text);
  } finally { s.cleanup(); }
  // Someone edits the description while the user reads the approval card: checked again right before writing.
  let site: ReturnType<typeof fakeSite> | undefined;
  const race = setup({ onPrompt: () => { site!.state.issue.description = { ...description, content: [p(t('Rewritten meanwhile.'))] } as AdfDocument; site!.state.issue.updated = '2026-10-01T12:00:00.000-0700'; } });
  site = race.site;
  try {
    await race.run('atlassian_fetch', { ref: 'KAN-1' });
    const r = await race.run('atlassian_update', { file: 'KAN-1.md', edits: [{ find: 'Closing paragraph.', replace: 'Closing, edited.' }] });
    assert.equal(race.prompts.length, 1);
    assert.match(r.text, /conflict/);
    assert.equal(race.site.requests.some(x => x.method === 'PUT'), false);
  } finally { race.cleanup(); }
});

test('fetch + update (Confluence): version + 1, panel kept; a stale version is a conflict', async () => {
  const s = setup();
  try {
    const fetched = await s.run('atlassian_fetch', { ref: `${SITE}/wiki/spaces/X/pages/42/Test+page` });
    assert.equal(fetched.isError, false, fetched.text);
    assert.match(fetched.text, /Saved Test page\.md/);
    const r = await s.run('atlassian_update', { file: 'Test page.md', edits: [{ find: 'Page body.', replace: 'Page body, edited.' }] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Now version 4/);
    const put = s.site.requests.find(x => x.method === 'PUT')!;
    assert.equal((put.body as { version: { number: number } }).version.number, 4);
    assert.equal(typeof (put.body as { body: { value: unknown } }).body.value, 'string', 'Confluence takes stringified ADF');
    assert.deepEqual(s.site.state.page.doc.content[1], pageDoc.content[1], 'the panel is untouched');
    // Someone else saves version 5; our copy is at 4.
    s.site.state.page.version = 5;
    const stale = await s.run('atlassian_update', { file: 'Test page.md', edits: [{ find: 'Page intro.', replace: 'Intro, edited.' }] });
    assert.match(stale.text, /conflict.*now version 5, fetched 4/);
    const panel = await s.run('atlassian_update', { file: 'Test page.md', edits: [{ find: 'Keep me.', replace: 'Changed.' }] });
    assert.match(panel.text, /info panel/);
  } finally { s.cleanup(); }
});

test('media preview download: the viewer\'s token goes only to the site; the media redirect is followed without it', async () => {
  const s = setup();
  try {
    await s.run('atlassian_fetch', { ref: 'KAN-1' });
    const saved = readSavedDocument(s.workspace.read('KAN-1.adf.json').bytes.toString('utf8'))!;
    s.site.requests.length = 0;
    const image = await downloadAtlassianMedia(s.credentials, saved, '47b08493-e8dc-43d6-a847-a076439762e6', { fetch: s.site.fetch });
    assert.equal(image.mediaType, 'image/png');
    assert.deepEqual(s.site.requests.map(r => [new URL(r.url).hostname, !!r.auth]), [['acme.atlassian.net', true], ['api.media.atlassian.com', false]]);
    await assert.rejects(downloadAtlassianMedia(s.credentials, saved, 'unknown', { fetch: s.site.fetch }), /No such image/);
    const tampered = { ...saved, media: { x: { name: 'x', download: 'https://evil.com/a.png' } } };
    await assert.rejects(downloadAtlassianMedia(s.credentials, tampered, 'x', { fetch: s.site.fetch }), /Not an attachment/);
  } finally { s.cleanup(); }
});

test('definitions: opt-in, fail-closed defaults (reads allow, update asks)', () => {
  assert.deepEqual(ATLASSIAN_TOOL_PERMISSIONS, { atlassian_request: 'allow', atlassian_fetch: 'allow', atlassian_update: 'ask' });
  const definition = defineAgent({ id: 'atl', name: 'Atl', model: 'a/b', instructions: 'x', tools: { ...atlassianTools }, permissions: { ...ATLASSIAN_TOOL_PERMISSIONS } });
  assert.equal(atlassianEnabled(definition), true);
  assert.equal(atlassianEnabled(defineAgent({ id: 'atl', name: 'Atl', model: 'a/b', instructions: 'x', tools: { ...atlassianTools }, permissions: { atlassian_request: 'deny', atlassian_fetch: 'deny', atlassian_update: 'deny' } })), false);
  assert.throws(() => defineAgent({ id: 'atl', name: 'Atl', model: 'a/b', instructions: 'x', tools: { ...atlassianTools }, permissions: { atlassian_request: 'allow' } }), /Missing permission/);
  // A tool's own policy can only be stricter: atlassian_request with 'allow' still asks for changes (tested above); with 'deny' it is never exposed.
  const bridge = createToolBridge({ tools: atlassianTools, permissions: { atlassian_request: 'deny', atlassian_fetch: 'allow', atlassian_update: 'ask' } });
  assert.deepEqual(bridge.allowedTools.sort(), ['atlassian_fetch', 'atlassian_update']);
});
