import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { SDKMessage, SendMessage } from '@letta-ai/letta-agent-sdk';
import type { UIMessage } from 'ai';
import { LettaAgent, ToolInteractions } from 'ai-sdk-letta';
import { ThreadRuntime, TeamDirectory, teamApp, tailscaleIdentity, decodeHeaderValue, servedOrigin, RuntimeFault, MAX_QUEUED, type RuntimeHost, type TeamAgent, type RunAuthor } from '../src/index.js';
import { tools } from './fixtures.js';

/* ------------------------------------------------------------------ */
/* Fixture: a parallel host whose turns wait until released             */
/* ------------------------------------------------------------------ */

type Sent = { conversationId: string; text: string; otid?: string; at: number };
function parallelFixture(options: { queue?: boolean; parallel?: boolean } = { queue: true, parallel: true }) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-team-'));
  const filename = join(directory, 'state.json');
  const conversations = new Map<string, UIMessage[]>();
  const sent: Sent[] = [];
  const gates = new Map<string, () => void>();
  let active = 0, peak = 0, opens = 0;
  const host: RuntimeHost = {
    parallel: true,
    async close() {},
    async open(target) {
      opens++;
      const conversationId = 'conversationId' in target ? target.conversationId : `local-conv-${randomUUID()}`;
      if (!conversations.has(conversationId)) conversations.set(conversationId, []);
      const history = conversations.get(conversationId)!;
      const interactions = new ToolInteractions();
      let input = '';
      let otid: string | undefined;
      const agent = new LettaAgent({ id: 'fixture', tools, lettaAgentId: 'agent-local-team', interactions, open: signal => ({
        async send(message: SendMessage, options?: { otid?: string }) {
          input = typeof message === 'string' ? message : message.map(item => item.type === 'text' ? item.text : '').join('');
          otid = options?.otid;
          sent.push({ conversationId, text: input, otid, at: Date.now() });
          history.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: input }], metadata: { otid } });
        },
        async abort() {}, close() {},
        async *stream() {
          active++; peak = Math.max(peak, active);
          try {
            if (input.includes('approve')) {
              yield { type: 'tool_call', toolCallId: 'tool-1', toolName: 'text_stats', toolInput: { text: 'x' }, uuid: '1' } as SDKMessage;
              const response = await interactions.request({ toolCallId: 'tool-1', tool: 'text_stats', kind: 'approval', title: 'Allow?' }, signal);
              yield { type: 'tool_result', toolCallId: 'tool-1', content: JSON.stringify({ approved: response.approved }), uuid: '2' } as SDKMessage;
            }
            if (input.includes('hold')) await new Promise<void>(resolve => { gates.set(conversationId, resolve); signal.addEventListener('abort', () => resolve(), { once: true }); });
            yield { type: 'assistant', content: 'Done', uuid: '3' } as SDKMessage;
            history.push({ id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Done' }] });
            yield { type: 'result', success: true, uuid: '4', durationMs: 1, conversationId } as SDKMessage;
          } finally { active--; }
        },
      }) });
      return { agent, agentId: 'agent-local-team', conversationId, history: structuredClone(history), reload: async () => structuredClone(history), close: async () => { agent.close(); } };
    },
  };
  const runtime = new ThreadRuntime(host, filename, 'team', options);
  return { runtime, host, filename, sent, conversations, peak: () => peak, opens: () => opens, release: (conversationId: string) => { gates.get(conversationId)?.(); gates.delete(conversationId); }, gates,
    cleanup: async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean, label = 'condition') {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Fixture deadline: ${label}`);
}
const alice: RunAuthor = { id: 'u-alice', login: 'alice@example.com', name: 'Alice Example' };
const bob: RunAuthor = { id: 'u-bob', login: 'bob@example.com', name: 'Bob Example' };
const turn = (threadId: string, text: string) => ({ id: randomUUID(), threadId, text, parentRunId: null });

/* ------------------------------------------------------------------ */
/* Identity trust                                                      */
/* ------------------------------------------------------------------ */

test('Tailscale identity headers are trusted only on loopback connections, and only when well formed', () => {
  const headers = { 'tailscale-user-login': 'Alice@Example.com', 'tailscale-user-name': 'Alice Example', 'tailscale-user-profile-pic': 'https://example.com/a.png' };
  assert.deepEqual(tailscaleIdentity(headers, '127.0.0.1'), { login: 'alice@example.com', name: 'Alice Example', avatar: 'https://example.com/a.png' });
  assert.deepEqual(tailscaleIdentity(headers, '::1')?.login, 'alice@example.com');
  assert.deepEqual(tailscaleIdentity(headers, '::ffff:127.0.0.1')?.login, 'alice@example.com');
  // From the network (tailnet, LAN): never believed, whatever the headers say.
  for (const address of ['100.111.255.108', '192.168.1.10', 'fd7a:115c:a1e0::1', '::ffff:100.64.0.1', undefined]) assert.equal(tailscaleIdentity(headers, address), undefined, String(address));
  // Funnel (public internet) never authenticates; malformed or repeated values are refused.
  assert.equal(tailscaleIdentity({ ...headers, 'tailscale-funnel-request': '?1' }, '127.0.0.1'), undefined);
  for (const login of ['', 'no-at-sign', 'a b@example.com', '<script>@x', 'x'.repeat(200) + '@x']) assert.equal(tailscaleIdentity({ ...headers, 'tailscale-user-login': login }, '127.0.0.1'), undefined, login);
  assert.equal(tailscaleIdentity({ ...headers, 'tailscale-user-login': ['a@x', 'b@x'] } as never, '127.0.0.1'), undefined);
  // Names: RFC 2047 decoded, controls and bidi removed; avatars only https.
  assert.equal(decodeHeaderValue('=?utf-8?q?Ferris_B=C3=BCller?='), 'Ferris Büller');
  assert.equal(tailscaleIdentity({ ...headers, 'tailscale-user-name': '=?utf-8?q?Ferris_B=C3=BCller?=' }, '127.0.0.1')?.name, 'Ferris Büller');
  assert.equal(tailscaleIdentity({ ...headers, 'tailscale-user-name': 'Eve\u202e\u0007 Admin' }, '127.0.0.1')?.name, 'Eve Admin');
  assert.equal(tailscaleIdentity({ ...headers, 'tailscale-user-profile-pic': 'javascript:alert(1)' }, '127.0.0.1')?.avatar, undefined);
  assert.equal(tailscaleIdentity({ ...headers, 'tailscale-user-profile-pic': 'http://example.com/a.png' }, '127.0.0.1')?.avatar, undefined);
  assert.equal(tailscaleIdentity({ 'tailscale-user-login': 'carol@github' }, '127.0.0.1')?.name, 'carol');
});

test('served origins are plain http(s) origins', () => {
  assert.deepEqual(servedOrigin('https://Machine.tail1.ts.net'), { origin: 'https://machine.tail1.ts.net', host: 'machine.tail1.ts.net' });
  assert.deepEqual(servedOrigin('http://machine.tail1.ts.net:8443/'), { origin: 'http://machine.tail1.ts.net:8443', host: 'machine.tail1.ts.net:8443' });
  for (const bad of ['machine.ts.net', 'ftp://x', 'https://x/path', 'https://u:p@x', 'https://x?q', 'https://x#f']) assert.throws(() => servedOrigin(bad), /Invalid served origin/, bad);
});

/* ------------------------------------------------------------------ */
/* Directory                                                           */
/* ------------------------------------------------------------------ */

test('directory: owners bootstrap as admins; admins add, promote, demote and remove; guards hold; state is durable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-directory-'));
  try {
    const file = join(dir, 'team', 'team.json');
    const directory = new TeamDirectory(file, ['Owner@Example.com']);
    directory.bootstrap(['a1', 'a2']);
    assert.equal(directory.signIn({ login: 'stranger@example.com', name: 'Stranger' }), undefined, 'no record for people without an agent');
    const owner = directory.signIn({ login: 'owner@example.com', name: 'Olivia Owner' })!;
    assert.equal(owner.name, 'Olivia Owner');
    assert.deepEqual(directory.agentsOf(owner.id, ['a1', 'a2', 'a3']), [{ agentId: 'a1', role: 'admin' }, { agentId: 'a2', role: 'admin' }]);
    const added = directory.addMember('a1', owner, { login: ' Bob@Example.com ' });
    assert.deepEqual({ login: added.login, role: added.role, pending: added.pending }, { login: 'bob@example.com', role: 'member', pending: true });
    assert.equal(directory.addMember('a1', owner, { login: 'bob@example.com' }).id, added.id, 'adding twice is a no-op');
    const bobUser = directory.signIn({ login: 'bob@example.com', name: 'Bob B' })!;
    assert.equal(bobUser.id, added.id); assert.equal(directory.members('a1').find(m => m.id === added.id)!.pending, false);
    assert.deepEqual(directory.agentsOf(bobUser.id, ['a1', 'a2']), [{ agentId: 'a1', role: 'member' }]);
    // Non-admins cannot manage members, but may leave.
    assert.throws(() => directory.addMember('a1', bobUser, { login: 'carol@example.com' }), (e: unknown) => e instanceof RuntimeFault && e.code === 'admin_required' && e.status === 403);
    assert.throws(() => directory.setRole('a1', bobUser, bobUser.id, { role: 'admin' }), /admin_required/);
    assert.throws(() => directory.removeMember('a1', bobUser, owner.id), /admin_required/);
    assert.throws(() => directory.addMember('a2', bobUser, { login: 'x@y' }), /admin_required/, 'not a member of a2 at all');
    // Admin promotes Bob; Bob (now admin) can add; owners can never be demoted or removed.
    directory.setRole('a1', owner, bobUser.id, { role: 'admin' });
    assert.equal(directory.addMember('a1', bobUser, { login: 'carol@example.com', role: 'member' }).login, 'carol@example.com');
    assert.throws(() => directory.setRole('a1', bobUser, owner.id, { role: 'member' }), /owner_is_admin/);
    assert.throws(() => directory.removeMember('a1', bobUser, owner.id), /owner_is_admin/);
    directory.setRole('a1', owner, bobUser.id, { role: 'member' });
    directory.removeMember('a1', bobUser, bobUser.id);
    assert.deepEqual(directory.agentsOf(bobUser.id, ['a1']), []);
    // Validation.
    for (const body of [{}, { login: 'no-at' }, { login: 'a@b', role: 'owner' }, null]) assert.throws(() => directory.addMember('a1', owner, body), /invalid_/);
    // Durable, private file, and reloadable.
    assert.equal((readFileSync(file, 'utf8').length > 0), true);
    const again = new TeamDirectory(file, ['owner@example.com']);
    assert.deepEqual(again.members('a1').map(m => m.login).sort(), ['carol@example.com', 'owner@example.com']);
    // The last admin cannot step down when no owner is configured for the agent.
    const solo = new TeamDirectory(join(dir, 'solo.json'), ['solo@example.com']);
    solo.bootstrap(['s']);
    const soloUser = solo.signIn({ login: 'solo@example.com', name: 'Solo' })!;
    assert.throws(() => new TeamDirectory(join(dir, 'bad.json'), ['not a login']), /Invalid owner login/);
    assert.throws(() => solo.removeMember('s', soloUser, soloUser.id), /owner_is_admin/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ */
/* Runtime: queue, parallelism, authors                                */
/* ------------------------------------------------------------------ */

test('within one conversation turns queue visibly and run in order; across conversations they run in parallel', async () => {
  const f = parallelFixture();
  try {
    const one = randomUUID(), two = randomUUID();
    await f.runtime.create('team', one, 'One', alice); await f.runtime.create('team', two, 'Two', bob);
    const first = turn(one, 'hold first'), second = turn(one, 'second'), third = turn(one, 'third');
    assert.equal((await f.runtime.start('team', first, alice)).status, 'queued');
    await until(() => f.runtime.events('team', first.id, 0).status === 'running', 'first running');
    // Bob sends while Alice's turn runs: queued, not refused, no parentRunId needed.
    assert.equal((await f.runtime.start('team', second, bob)).status, 'queued');
    assert.equal((await f.runtime.start('team', third, alice)).status, 'queued');
    const view = await f.runtime.view('team', one) as { queue: { id: string; author?: RunAuthor; input: string }[]; live: { author?: RunAuthor } };
    assert.deepEqual(view.queue.map(q => [q.input, q.author?.name]), [['second', 'Bob Example'], ['third', 'Alice Example']]);
    assert.equal(view.live.author?.name, 'Alice Example');
    assert.deepEqual((f.runtime.list('team').find(t => t.id === one) as { queued?: number }).queued, 2);
    // Another conversation runs at the same time.
    const other = turn(two, 'hold other');
    await f.runtime.start('team', other, bob);
    await until(() => f.peak() >= 2, 'two turns at once');
    f.release(f.sent.find(s => s.text.includes('hold other'))!.conversationId);
    f.release(f.sent.find(s => s.text.includes('hold first'))!.conversationId);
    await until(() => f.runtime.events('team', third.id, 0).status === 'completed', 'queue drained');
    const order = f.sent.filter(s => s.conversationId === f.sent.find(x => x.text.includes('hold first'))!.conversationId).map(s => s.text.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\n/, ''));
    assert.deepEqual(order, ['hold first', 'second', 'third']);
    // Parents chain in delivery order; each turn carries its OTID (= run ID) and tells the agent who speaks.
    const runs = JSON.parse(readFileSync(f.filename, 'utf8')).runs as { id: string; parentRunId: string | null; author?: RunAuthor }[];
    assert.equal(runs.find(r => r.id === second.id)!.parentRunId, first.id);
    assert.equal(runs.find(r => r.id === third.id)!.parentRunId, second.id);
    assert.equal(f.sent.find(s => s.text.endsWith('second'))!.otid, second.id);
    assert.match(f.sent.find(s => s.text.endsWith('second'))!.text, /^<system-reminder>\nThis message is from Bob Example \(bob@example\.com\)\./);
    assert.deepEqual(runs.find(r => r.id === second.id)!.author, bob);
    // Authors survive a reload: history shows them on the user turns (matched by OTID).
    const history = await f.runtime.history('team', one);
    const users = history.messages.filter(m => m.role === 'user').map(m => (m.metadata as { author?: RunAuthor }).author?.name);
    assert.deepEqual(users, ['Alice Example', 'Bob Example', 'Alice Example']);
    assert.equal(history.lastRunId, third.id);
    // A thread records who started it.
    assert.deepEqual((f.runtime.list('team').find(t => t.id === two) as { createdBy?: RunAuthor }).createdBy, bob);
  } finally { await f.cleanup(); }
});

test('queue limits, cancelling a queued turn, failure withdraws what waits, restart never sends queued turns', async () => {
  const f = parallelFixture();
  try {
    const id = randomUUID(); await f.runtime.create('team', id, 'Queue', alice);
    const head = turn(id, 'hold head'); await f.runtime.start('team', head, alice);
    await until(() => f.runtime.events('team', head.id, 0).status === 'running');
    const waiting: ReturnType<typeof turn>[] = [];
    for (let i = 0; i < MAX_QUEUED; i++) { const t = turn(id, `q${i}`); waiting.push(t); await f.runtime.start('team', t, bob); }
    await assert.rejects(f.runtime.start('team', turn(id, 'overflow'), bob), (e: unknown) => e instanceof RuntimeFault && e.code === 'queue_full' && e.status === 429);
    // Same ID, same author: idempotent. Different author: conflict.
    assert.equal((await f.runtime.start('team', waiting[0]!, bob)).status, 'queued');
    await assert.rejects(f.runtime.start('team', waiting[0]!, alice), /id_conflict/);
    // Cancel one queued turn: it is withdrawn and never sent.
    f.runtime.cancel('team', waiting[0]!.id);
    assert.equal(f.runtime.events('team', waiting[0]!.id, 0).status, 'cancelled');
    assert.equal(f.runtime.events('team', waiting[0]!.id, 0).events.at(-1)?.data.code, 'cancelled');
    // The running turn is stopped: everything behind it is withdrawn ("not sent"), the conversation becomes read-only.
    f.runtime.cancel('team', head.id);
    await until(() => waiting.slice(1).every(t => f.runtime.events('team', t.id, 0).status === 'cancelled'), 'withdrawn');
    assert.deepEqual(new Set(waiting.slice(1).map(t => f.runtime.events('team', t.id, 0).events.at(-1)?.data.code)), new Set(['not_sent']));
    assert.equal(f.sent.length, 1);
    await assert.rejects(f.runtime.start('team', turn(id, 'after failure'), alice), /delivery_uncertain/);
    // Withdrawn turns are not part of the conversation's view.
    const view = await f.runtime.view('team', id) as { status: string; lastRunId: string; queue: unknown[] };
    assert.equal(view.status, 'cancelled'); assert.equal(view.lastRunId, head.id); assert.deepEqual(view.queue, []);
    // Restart: a run left queued in state is withdrawn, never sent.
    const other = randomUUID(); await f.runtime.create('team', other, 'Restart', alice);
    await f.runtime.close();
    const state = JSON.parse(readFileSync(f.filename, 'utf8'));
    state.runs.push({ id: randomUUID(), threadId: other, input: 'left over', parentRunId: null, status: 'queued', events: [], author: alice });
    writeFileSync(f.filename, JSON.stringify(state));
    const restored = new ThreadRuntime(f.host, f.filename, 'team', { queue: true, parallel: true });
    const left = restored.list('team').find(t => t.id === other) as { queued?: number };
    assert.equal(left.queued, undefined);
    assert.equal(JSON.parse(readFileSync(f.filename, 'utf8')).runs.at(-1).status, 'cancelled');
    assert.equal(f.sent.length, 1);
    await restored.close();
  } finally { await f.cleanup(); }
});

test('change notifications wake waiting clients; streamed text is compacted with stable sequence numbers', async () => {
  const f = parallelFixture();
  try {
    const version = f.runtime.version;
    const woke = f.runtime.waitForChange(version, 5000);
    const id = randomUUID(); await f.runtime.create('team', id, 'Changes', alice);
    assert.ok(await woke > version);
    assert.equal(await f.runtime.waitForChange(-5, 10), f.runtime.version, 'stale cursor answers at once');
    const run = turn(id, 'plain'); await f.runtime.start('team', run, alice);
    await until(() => f.runtime.events('team', run.id, 0).status === 'completed');
    const { events } = f.runtime.events('team', run.id, 0);
    const last = events.at(-1)!.sequence;
    assert.deepEqual(f.runtime.events('team', run.id, last).events, []);
    assert.throws(() => f.runtime.events('team', run.id, last + 1), /invalid_cursor/);
  } finally { await f.cleanup(); }
});

test('single-user runtime is unchanged: one turn at a time, no queue, no authors in summaries', async () => {
  const f = parallelFixture({});
  try {
    const id = randomUUID(); await f.runtime.create('team', id, 'Single');
    const first = turn(id, 'hold'); assert.equal((await f.runtime.start('team', first)).status, 'running');
    await until(() => f.gates.size === 1, 'held');
    await assert.rejects(f.runtime.start('team', { ...turn(id, 'second'), parentRunId: first.id }), /delivery_uncertain/);
    const other = randomUUID();
    await assert.rejects(f.runtime.create('team', other, 'Busy'), /runtime_busy/);
    assert.deepEqual(Object.keys(f.runtime.list('team')[0]!).sort(), ['archived', 'createdAt', 'id', 'lastActivityAt', 'latex', 'state', 'title']);
    f.release(f.sent[0]!.conversationId);
    await until(() => f.runtime.events('team', first.id, 0).status === 'completed');
    assert.equal(f.sent[0]!.otid, undefined, 'no OTID or speaker note in single-user mode');
    assert.equal(f.sent[0]!.text, 'hold');
  } finally { await f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* HTTP: every route enforces membership; answers enforce authorship    */
/* ------------------------------------------------------------------ */

async function teamServer() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-letta-teamapp-'));
  const assets = join(dir, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html>');
  const directory = new TeamDirectory(join(dir, 'team', 'team.json'), ['owner@example.com']);
  directory.bootstrap(['alpha', 'beta']);
  const a = parallelFixture(), b = parallelFixture();
  const agents = new Map<string, TeamAgent>([
    ['alpha', { info: { id: 'alpha', name: 'Alpha', approvalTools: ['text_stats'] }, runtime: a.runtime }],
    ['beta', { info: { id: 'beta', name: 'Beta' }, runtime: b.runtime }],
  ]);
  const server = teamApp({ port: 0, assets, agents, directory, origins: ['https://machine.example.ts.net'] }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const people = {
    owner: { 'tailscale-user-login': 'owner@example.com', 'tailscale-user-name': 'Olivia Owner' },
    member: { 'tailscale-user-login': 'mia@example.com', 'tailscale-user-name': 'Mia Member' },
    outsider: { 'tailscale-user-login': 'otto@example.com', 'tailscale-user-name': 'Otto Outsider' },
  };
  // Served requests arrive from tailscale serve on loopback with the served Host.
  const call = async (who: keyof typeof people | undefined, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { host: 'machine.example.ts.net', ...(who ? people[who] : {}), ...extra };
    let csrf = '';
    if (who && method !== 'GET') {
      const session = await (await raw('GET', '/api/session', { ...headers })).json() as { csrf?: string };
      csrf = session.csrf ?? '';
      headers.origin ??= 'https://machine.example.ts.net';
      headers['x-csrf-token'] ??= csrf;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    return raw(method, path, headers, body === undefined ? undefined : JSON.stringify(body));
  };
  // fetch() cannot set Host; use node:http.
  const raw = (method: string, path: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; json(): Promise<unknown>; text: string }>((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; if (res.headers['content-type']?.includes('ndjson') && text.includes('\n')) { res.destroy(); } });
      const done = () => resolve({ status: res.statusCode!, text, json: async () => JSON.parse(text) });
      res.on('end', done); res.on('close', done);
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  return { base, call, raw, directory, a, b, people,
    cleanup: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await a.cleanup(); await b.cleanup(); rmSync(dir, { recursive: true, force: true }); } };
}

test('team HTTP: identity, Host/Origin/CSRF, agent list, and membership on every agent route (table-driven)', async () => {
  const t = await teamServer();
  try {
    // No identity: 401 everywhere under /api.
    assert.equal((await t.call(undefined, 'GET', '/api/session')).status, 401);
    // Identity headers from the network are ignored (the app only listens on loopback, but the rule is enforced anyway).
    // Foreign Host and cross-site requests are refused.
    assert.equal((await t.call('owner', 'GET', '/api/session', undefined, { host: 'evil.test' })).status, 403);
    assert.equal((await t.call('owner', 'GET', '/api/session', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await t.call('owner', 'GET', '/api/session', undefined, { origin: 'https://evil.test' })).status, 403);
    // Owner sees both agents as admin; an outsider sees none and gets no CSRF token.
    const owner = await (await t.call('owner', 'GET', '/api/session')).json() as { mode: string; user: { id: string; name: string }; agents: { id: string; role: string }[]; csrf: string };
    assert.equal(owner.mode, 'team'); assert.equal(owner.user.name, 'Olivia Owner');
    assert.deepEqual(owner.agents.map(a => [a.id, a.role]), [['alpha', 'admin'], ['beta', 'admin']]);
    const outsider = await (await t.call('outsider', 'GET', '/api/session')).json() as { agents: unknown[]; csrf?: string; user: { login: string } };
    assert.deepEqual(outsider.agents, []); assert.equal(outsider.csrf, undefined); assert.equal(outsider.user.login, 'otto@example.com');
    // Mutations need the exact origin and the person's CSRF token.
    assert.equal((await t.call('owner', 'POST', '/api/agents/alpha/v1/threads', { id: randomUUID(), title: 'x' }, { 'x-csrf-token': 'nope' })).status, 403);
    assert.equal((await t.call('owner', 'POST', '/api/agents/alpha/v1/threads', { id: randomUUID(), title: 'x' }, { origin: 'http://machine.example.ts.net' })).status, 403);
    // Owner adds Mia to alpha only.
    assert.equal((await t.call('owner', 'POST', '/api/agents/alpha/members', { login: 'mia@example.com' })).status, 201);
    const mia = await (await t.call('member', 'GET', '/api/session')).json() as { agents: { id: string; role: string }[]; csrf: string };
    assert.deepEqual(mia.agents.map(a => [a.id, a.role]), [['alpha', 'member']]);
    // A thread with a turn in alpha, to address real IDs.
    const thread = randomUUID();
    assert.equal((await t.call('owner', 'POST', '/api/agents/alpha/v1/threads', { id: thread, title: 'Shared' })).status, 201);
    const run = randomUUID();
    assert.equal((await t.call('owner', 'POST', '/api/agents/alpha/v1/runs', { id: run, threadId: thread, text: 'hello', parentRunId: null })).status, 202);
    await until(() => t.a.runtime.events('team', run, 0).status === 'completed');
    // Every agent route, for an outsider (never a member) and for a member of another agent: 404 (indistinguishable from an unknown agent).
    const routes: [string, string, unknown?][] = [
      ['GET', '/v1/capabilities'], ['GET', '/v1/threads'], ['POST', '/v1/threads', { id: randomUUID(), title: 'x' }],
      ['PATCH', `/v1/threads/${thread}`, { title: 'Hijacked' }], ['GET', `/v1/threads/${thread}/history`], ['GET', `/v1/threads/${thread}/view`],
      ['POST', `/v1/threads/${thread}/typing`, { typing: true }],
      ['GET', `/v1/threads/${thread}/files`], ['GET', `/v1/threads/${thread}/files/a.txt`],
      ['POST', '/v1/runs', { id: randomUUID(), threadId: thread, text: 'x', parentRunId: null }], ['POST', `/v1/runs/${run}/answer`, { id: 'x', approved: true }],
      ['POST', `/v1/runs/${run}/cancel`, {}], ['GET', `/v1/runs/${run}/events`], ['GET', '/v1/changes?since=0'],
      ['POST', '/v1/uploads'], ['GET', '/v1/resources'], ['GET', '/v1/resources/history'], ['POST', '/v1/resources/upload'], ['POST', '/v1/resources/folders', { parent: '', name: 'x' }],
      ['POST', '/v1/resources/move', { from: 'a', to: 'b' }], ['POST', '/v1/resources/delete', { path: 'a' }], ['POST', '/v1/resources/restore', { path: 'a', commit: 'b' }],
      ['GET', '/v1/resources/file?path=a'], ['GET', '/v1/resources/preview?path=a'],
      ['GET', '/members'], ['POST', '/members', { login: 'x@y' }], ['PATCH', `/members/${owner.user.id}`, { role: 'member' }], ['DELETE', `/members/${owner.user.id}`],
    ];
    for (const [method, path, body] of routes) {
      for (const [who, agent] of [['outsider', 'alpha'], ['member', 'beta'], ['owner', 'nonexistent']] as const) {
        const response = await t.call(who, method, `/api/agents/${agent}${path}`, body);
        // Outsiders have no CSRF token, so their mutations stop at 403 before membership; reads are 404.
        const expected = who === 'outsider' && method !== 'GET' ? 403 : 404;
        assert.equal(response.status, expected, `${who} ${method} ${agent}${path}`);
      }
    }
    // Nothing leaked into alpha from the refused requests.
    assert.equal((t.a.runtime.list('team').find(x => x.id === thread))!.title, 'Shared');
    assert.equal(t.a.runtime.events('team', run, 0).status, 'completed');
    assert.deepEqual(t.a.runtime.list('team').map(x => x.id), [thread]);
    // A member of alpha reads and writes everything shared in alpha.
    for (const path of ['/v1/capabilities', '/v1/threads', `/v1/threads/${thread}/history`, `/v1/threads/${thread}/view`, '/v1/changes?since=-1', '/members']) {
      assert.equal((await t.call('member', 'GET', `/api/agents/alpha${path}`)).status, 200, `member GET alpha${path}`);
    }
    assert.equal((await t.call('member', 'PATCH', `/api/agents/alpha/v1/threads/${thread}`, { title: 'Renamed by Mia' })).status, 200);
    // The member sees the owner's conversation with its author.
    const view = await (await t.call('member', 'GET', `/api/agents/alpha/v1/threads/${thread}/view`)).json() as { messages: { role: string; metadata?: { author?: { name: string } } }[] };
    assert.equal(view.messages.find(m => m.role === 'user')?.metadata?.author?.name, 'Olivia Owner');
  } finally { await t.cleanup(); }
});

test('team HTTP: only the triggering user or an admin can answer or stop a turn; members cannot manage members', async () => {
  const t = await teamServer();
  try {
    await t.call('owner', 'POST', '/api/agents/alpha/members', { login: 'mia@example.com' });
    await t.call('owner', 'POST', '/api/agents/alpha/members', { login: 'max@example.com' });
    const max = { 'tailscale-user-login': 'max@example.com', 'tailscale-user-name': 'Max Member' };
    (t.people as Record<string, Record<string, string>>).max = max;
    const thread = randomUUID();
    await t.call('member', 'POST', '/api/agents/alpha/v1/threads', { id: thread, title: 'Approvals' });
    const ask = async (who: 'member' | 'owner') => {
      const id = randomUUID();
      assert.equal((await t.call(who, 'POST', '/api/agents/alpha/v1/runs', { id, threadId: thread, text: 'approve this', parentRunId: null })).status, 202);
      await until(() => t.a.runtime.events('team', id, 0).events.some(e => e.type === 'interaction'), 'interaction');
      const request = t.a.runtime.events('team', id, 0).events.find(e => e.type === 'interaction')!.data as { id: string };
      return { id, request };
    };
    // Mia's turn: Max (another member) is refused; Mia can answer.
    const first = await ask('member');
    const refused = await t.call('max' as never, 'POST', `/api/agents/alpha/v1/runs/${first.id}/answer`, { id: first.request.id, approved: true });
    assert.equal(refused.status, 403); assert.match(refused.text, /not_your_turn/);
    assert.equal((await t.call('max' as never, 'POST', `/api/agents/alpha/v1/runs/${first.id}/cancel`, {})).status, 403);
    assert.equal(t.a.runtime.events('team', first.id, 0).status, 'running', 'refused answer changed nothing');
    assert.equal((await t.call('member', 'POST', `/api/agents/alpha/v1/runs/${first.id}/answer`, { id: first.request.id, approved: true })).status, 200);
    await until(() => t.a.runtime.events('team', first.id, 0).status === 'completed');
    // Mia's next turn: the owner (admin) may answer it.
    const second = await ask('member');
    assert.equal((await t.call('owner', 'POST', `/api/agents/alpha/v1/runs/${second.id}/answer`, { id: second.request.id, approved: false })).status, 200);
    await until(() => t.a.runtime.events('team', second.id, 0).status === 'completed');
    // Members cannot manage members (and get 403, not 404: they can see the list).
    assert.equal((await t.call('member', 'GET', '/api/agents/alpha/members')).status, 200);
    for (const [method, path, body] of [['POST', '/members', { login: 'eve@example.com' }], ['PATCH', '/members/x', { role: 'admin' }]] as const) {
      const response = await t.call('member', method, `/api/agents/alpha${path}`, body);
      assert.equal(response.status, 403, `${method} ${path}`); assert.match(response.text, /admin_required/);
    }
    const members = await (await t.call('owner', 'GET', '/api/agents/alpha/members')).json() as { members: { id: string; login: string; role: string }[] };
    const maxId = members.members.find(m => m.login === 'max@example.com')!.id;
    assert.equal((await t.call('member', 'DELETE', `/api/agents/alpha/members/${maxId}`)).status, 403);
    // Admin promotes Max; Max can now answer anyone's approval.
    assert.equal((await t.call('owner', 'PATCH', `/api/agents/alpha/members/${maxId}`, { role: 'admin' })).status, 200);
    const third = await ask('member');
    assert.equal((await t.call('max' as never, 'POST', `/api/agents/alpha/v1/runs/${third.id}/answer`, { id: third.request.id, approved: true })).status, 200);
    await until(() => t.a.runtime.events('team', third.id, 0).status === 'completed');
    // Removing a member takes effect at once.
    assert.equal((await t.call('owner', 'DELETE', `/api/agents/alpha/members/${maxId}`)).status, 200);
    assert.equal((await t.call('max' as never, 'GET', '/api/agents/alpha/v1/threads')).status, 404);
  } finally { await t.cleanup(); }
});

test('team HTTP: a direct (non-loopback) connection cannot claim an identity', async () => {
  // The app binds to 127.0.0.1, so a tailnet peer cannot reach it directly; the rule is still checked per connection.
  assert.equal(tailscaleIdentity({ 'tailscale-user-login': 'owner@example.com' }, '100.64.0.7'), undefined);
});
