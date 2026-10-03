import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ListMessagesResult, LettaConversation } from '@letta-ai/letta-agent-sdk';
import { listNavigationEntries, searchConversations, snippet, type NavigationSource } from 'ai-sdk-letta';
import { localCommandMatches, parseLocalCommand, navigate, type NavigationScreen } from '../src/index.js';
const entries = [{ id: 'default', title: 'Default', date: 'unavailable' }, { id: 'local-conv-2', title: 'Planning', date: '2026-09-29' }];
function source(overrides: Partial<NavigationSource> = {}): NavigationSource {
  return { agentId: 'agent-local-fixture', currentId: 'default', list: async () => ({ entries, limited: false }), page: async () => ({ messages: [], hasMore: false }), validate: async () => {}, ...overrides };
}
const messages = (rows: unknown[]) => rows as ListMessagesResult['messages'];
test('slash commands only match whole leading command, never slash elsewhere or similar words', () => {
  for (const text of ['/resume', '/resume Plan', ' /search hello world ', '/help', '/SEARCH']) assert.equal(localCommandMatches(text), true);
  for (const text of ['please /resume', 'https://host/search', '/resumex', '/searching', 'foo\n/search', 'normal']) assert.equal(localCommandMatches(text), false);
  assert.deepEqual(parseLocalCommand('/search hello world'), { command: 'search', query: 'hello world' });
});
test('search uses projected human/assistant text, excludes tools, memory, reasoning, reminders', async () => {
  const result = await searchConversations(source({ page: async () => ({ hasMore: false, messages: messages([
    { id: '1', message_type: 'system_message', content: 'needle secret' },
    { id: '2', message_type: 'reasoning_message', content: 'needle secret' },
    { id: '3', message_type: 'tool_return_message', tool_return: 'needle secret' },
    { id: '4', message_type: 'user_message', content: '<system-reminder>needle secret</system-reminder>' },
    { id: '5', message_type: 'user_message', content: '{"type":"memory_warning","message":"needle secret"}' },
    { id: '6', message_type: 'assistant_message', content: 'A NEEDLE in context\u001b[31m with details' },
  ]) }) }), entries.slice(0, 1), 'needle', new AbortController().signal);
  assert.equal(result.matches.length, 1); assert.match(result.matches[0]!.snippet, /NEEDLE in context/); assert.doesNotMatch(result.matches[0]!.snippet, /secret|\x1b/);
});
test('search pagination is bounded per conversation and total, explicit LIMITED, no other agent enumeration', async () => {
  let calls = 0;
  const visited: string[] = [];
  const many = Array.from({ length: 70 }, (_, i) => ({ id: `local-conv-${i}`, title: 'x', date: '' }));
  const result = await searchConversations(source({ page: async (id, options) => {
    visited.push(id); calls++;
    return { messages: messages(Array.from({ length: options.limit! }, (_, i) => ({ id: `${calls}-${i}`, message_type: 'assistant_message', content: 'not matched' }))), hasMore: true };
  } }), many, 'needle', new AbortController().signal);
  assert.equal(result.records, 5000); assert.equal(calls, 50); assert.equal(result.scanned, 10); assert.equal(result.limited, true);
  assert.ok(visited.every(id => many.some(e => e.id === id)));
});
test('search stops on cancellation before reading next page, rejects stuck/invalid pages', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(searchConversations(source({ page: async () => { calls++; controller.abort(); return { messages: [], hasMore: false }; } }), entries, 'x', controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(searchConversations(source({ page: async () => ({ messages: [], hasMore: true }) }), entries, 'x', new AbortController().signal), /no messages/);
});
function screen(choice?: string) {
  const notices: string[] = []; let closed = false;
  return { notices, get closed() { return closed; }, ui: {
    notice: async (text: string) => { notices.push(text); }, prompt: async () => undefined,
    pick: async () => choice, busy: async (work: (signal: AbortSignal, progress: () => void) => Promise<unknown>) => work(new AbortController().signal, () => {}), close: () => { closed = true; },
  } as unknown as NavigationScreen };
}
test('resume cancellation/current selection preserve current chat and never validate or switch', async () => {
  let validations = 0;
  for (const choice of [undefined, 'default']) {
    const ui = screen(choice);
    assert.equal(await navigate('/resume', source({ validate: async () => { validations++; } }), ui.ui), undefined);
    assert.equal(ui.closed, true);
  }
  assert.equal(validations, 0);
});
test('pending/unknown target blocks switching; search result selection validates exact conversation', async () => {
  const ui = screen('local-conv-2');
  assert.equal(await navigate('/resume', source({ validate: async () => { throw new Error('uncertain'); } }), ui.ui), undefined);
  assert.equal(ui.notices.length, 1);
  let selected = '';
  assert.equal(await navigate('/search needle', source({ page: async id => ({ messages: messages([{ id: 'one', message_type: 'assistant_message', content: `needle ${id}` }]), hasMore: false }), validate: async id => { selected = id; } }), screen('1').ui), 'local-conv-2');
  assert.equal(selected, 'local-conv-2');
});
test('navigation listing scopes every page, rejects other agents and caps enumeration explicitly', async () => {
  let calls = 0;
  const result = await listNavigationEntries(async query => {
    assert.equal(query.agentId, 'mapped'); assert.equal(query.order, 'desc'); assert.equal(query.limit, 100);
    calls++;
    return Array.from({ length: 100 }, (_, i) => ({ id: `local-conv-${calls}-${i}`, agent_id: 'mapped', summary: 'title', created_at: '2026' }) as LettaConversation);
  }, 'mapped');
  assert.equal(calls, 3); assert.equal(result.entries.length, 201); assert.equal(result.limited, true);
  await assert.rejects(listNavigationEntries(async () => [{ id: 'local-conv-other', agent_id: 'not-mapped' } as LettaConversation], 'mapped'), /escaped current agent/);
  await assert.rejects(listNavigationEntries(async () => [{ id: 'repeat', agent_id: 'mapped' } as LettaConversation], 'mapped'), /repeated cursor/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listNavigationEntries(async () => { throw new Error('must not fetch'); }, 'mapped', controller.signal), { name: 'AbortError' });
  let page = 0;
  const markdown = await listNavigationEntries(async () => page++ ? [] : [{ id: 'local-conv-md', agent_id: 'mapped', summary: 'Plan *trip* to [Rome](https://example.com)' } as LettaConversation, { id: 'local-conv-empty', agent_id: 'mapped', summary: '**' } as LettaConversation], 'mapped');
  assert.deepEqual(markdown.entries.slice(1).map(e => e.title), ['Plan trip to Rome', '**']);
  // A new agent only has named conversations: `default` is not offered.
  const named = await listNavigationEntries(async () => [], 'mapped', undefined, false);
  assert.deepEqual(named.entries, []);
});

test('snippet includes surrounding context with plain-text terminal control removal', () => {
  assert.equal(snippet('before\n\x1b[31mNEEDLE\x1b[0m after', 'needle'), 'before NEEDLE after');
});

test('/resources lists the tree with sizes and marks the current conversation\'s folder', async () => {
  const { resourceLines } = await import('../src/index.js');
  assert.equal(localCommandMatches('/resources'), true);
  assert.deepEqual(parseLocalCommand('/resources'), { command: 'resources', query: '' });
  const lines = resourceLines([
    { name: 'Trip', path: 'Trip', type: 'folder', modifiedAt: '', conversationId: 'conv-1', children: [{ name: 'a.csv', path: 'Trip/a.csv', type: 'file', bytes: 2048, modifiedAt: '' }] },
    { name: 'Budget', path: 'Budget', type: 'folder', modifiedAt: '', conversationId: 'conv-2', children: [] },
    { name: 'Archive', path: 'Archive', type: 'folder', modifiedAt: '', children: [{ name: 'Old', path: 'Archive/Old', type: 'folder', modifiedAt: '', children: [{ name: 'x.pdf', path: 'Archive/Old/x.pdf', type: 'file', bytes: 3 * 1024 * 1024, modifiedAt: '' }] }] },
  ], 'Trip');
  assert.deepEqual(lines, ['Trip/  ← this conversation', '  a.csv  2 KB', 'Budget/  (conversation)', 'Archive/', '  Old/', '    x.pdf  3 MB']);
  // Without resources, the command explains itself and returns to chat.
  const shown: string[] = [];
  const screen = { notice: async (text: string) => { shown.push(text); }, close() {} } as unknown as NavigationScreen;
  assert.equal(await navigate('/resources', source(), screen), undefined);
  assert.match(shown[0]!, /no resources/);
});
