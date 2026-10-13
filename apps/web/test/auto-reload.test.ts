import { test } from 'node:test';
import assert from 'node:assert/strict';

test('reload only when the build changed, and never while the person is typing or in a dialog', async () => {
  const { shouldReload, buildOf } = await import('../src/auto-reload.js');
  const idle = { hidden: false, typing: false, dialogOpen: false };
  assert.equal(shouldReload('a', 'a', idle), false);
  assert.equal(shouldReload(undefined, 'b', idle), false);
  assert.equal(shouldReload('a', 'b', idle), true);
  assert.equal(shouldReload('a', 'b', { ...idle, typing: true }), false);
  assert.equal(shouldReload('a', 'b', { ...idle, dialogOpen: true }), false);
  assert.equal(shouldReload('a', 'b', { hidden: true, typing: true, dialogOpen: true }), true, 'a hidden tab always may');
  assert.equal(buildOf({ build: 'abc-123' }), 'abc-123');
  for (const bad of [null, {}, { build: 5 }, { build: '<script>' }]) assert.equal(buildOf(bad), undefined);
});

/** A fake page: a build that can change, a composer, focus and visibility, and a counter of reloads. */
function page() {
  const listeners = new Map<string, () => void>();
  const store = new Map<string, string>();
  const box = { value: '' } as HTMLTextAreaElement;
  const state = { build: 'b1', reloads: 0, active: null as unknown, hidden: false, ticks: [] as (() => void)[] };
  const env = {
    fetch: (async () => ({ ok: true, json: async () => ({ build: state.build }) })) as unknown as typeof fetch,
    doc: { get activeElement() { return state.active; }, get visibilityState() { return state.hidden ? 'hidden' : 'visible'; }, querySelector: () => null,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) } as unknown as Document,
    win: { setInterval: (fn: () => void) => { state.ticks.push(fn); return 1; }, clearInterval: () => {}, location: { reload: () => { state.reloads++; } } } as unknown as Window,
    storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage,
  };
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  return { box, state, env, store, listeners, flush, tick: async () => { state.ticks[0]!(); await flush(); await flush(); } };
}

test('the watcher reloads after an update, waits while typing, and keeps an unsent message', async () => {
  const { watchBuild, takeSavedDraft, DRAFT_KEY } = await import('../src/auto-reload.js');
  const p = page();
  const stop = watchBuild(() => p.box, {}, p.env);
  await p.flush(); await p.flush();
  await p.tick();
  assert.equal(p.state.reloads, 0, 'same build: no reload');
  // Typing when the update lands: wait.
  p.state.build = 'b2'; p.box.value = 'half a message'; p.state.active = p.box;
  await p.tick();
  assert.equal(p.state.reloads, 0, 'not while typing');
  // The person leaves the box: reload now, keeping the text.
  p.state.active = null; p.listeners.get('focusout')!();
  assert.equal(p.state.reloads, 1);
  assert.equal(p.store.get(DRAFT_KEY), 'half a message');
  assert.equal(takeSavedDraft(p.env.storage), 'half a message');
  assert.equal(takeSavedDraft(p.env.storage), undefined, 'taken once');
  stop();
});

test('a page opened while the server was down reloads once it answers', async () => {
  const { watchBuild } = await import('../src/auto-reload.js');
  const p = page();
  watchBuild(() => p.box, { unreachable: true }, p.env);
  await p.flush(); await p.flush();
  assert.equal(p.state.reloads, 1);
});
