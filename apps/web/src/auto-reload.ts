/**
 * Reload the app when the server's build changes (a restart or a rebuilt web
 * app; see the server's `GET /build.json`). The page polls the build ID; when
 * it differs from the one it loaded with, it reloads — at once when the tab is
 * hidden or idle, else as soon as it is (never mid-typing: an unsent message
 * is saved first and restored after the reload).
 */

/** How often the page checks the build (ms). */
export const BUILD_POLL_MS = 15_000;
/** Where an unsent message waits across a reload (this tab only). */
export const DRAFT_KEY = 'ai-sdk-letta-reload-draft';

/** The build ID from a `/build.json` body, else undefined. */
export function buildOf(body: unknown): string | undefined {
  const b = (body as { build?: unknown } | null)?.build;
  return typeof b === 'string' && /^[\w-]{1,80}$/.test(b) ? b : undefined;
}

/**
 * Whether to reload now: the build changed (both known and different), and
 * the person is not mid-action (the composer is not focused with text in it,
 * no dialog or menu is open). A hidden tab always may.
 */
export function shouldReload(loaded: string | undefined, now: string | undefined, state: { hidden: boolean; typing: boolean; dialogOpen: boolean }): boolean {
  if (!loaded || !now || loaded === now) return false;
  if (state.hidden) return true;
  return !state.typing && !state.dialogOpen;
}

type Env = { fetch: typeof fetch; doc: Document; win: Window; storage: Storage };

/** Start watching; returns a stop function. `composer()` gives the main message box; `unreachable`: the page loaded while the server was down. */
export function watchBuild(composer: () => HTMLTextAreaElement | null, options: { unreachable?: boolean } = {}, env: Env = { fetch: (...a) => fetch(...a), doc: document, win: window, storage: sessionStorage }): () => void {
  // Opened while the server was down: reload as soon as any build answers.
  let loaded: string | undefined = options.unreachable ? 'unreachable' : undefined;
  let pending: string | undefined;
  let stopped = false;
  const check = async () => {
    if (stopped) return;
    try {
      const response = await env.fetch('/build.json', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return;
      const now = buildOf(await response.json());
      if (!now) return;
      if (!loaded) { loaded = now; return; }
      if (now !== loaded) pending = now;
    } catch { /* the server is restarting: try again later */ }
    tryReload();
  };
  const tryReload = () => {
    if (stopped || !pending) return;
    const box = composer();
    const typing = !!box && env.doc.activeElement === box && !!box.value.trim();
    const dialogOpen = !!env.doc.querySelector('[role=dialog][open], dialog[open], [role=menu]');
    if (!shouldReload(loaded, pending, { hidden: env.doc.visibilityState === 'hidden', typing, dialogOpen })) return;
    if (box?.value.trim()) env.storage.setItem(DRAFT_KEY, box.value);
    stopped = true;
    env.win.location.reload();
  };
  const timer = env.win.setInterval(() => { void check(); }, BUILD_POLL_MS);
  const onVisible = () => { if (env.doc.visibilityState === 'visible') void check(); else tryReload(); };
  const onBlur = () => tryReload();
  env.doc.addEventListener('visibilitychange', onVisible);
  env.doc.addEventListener('focusout', onBlur);
  void check();
  return () => { stopped = true; env.win.clearInterval(timer); env.doc.removeEventListener('visibilitychange', onVisible); env.doc.removeEventListener('focusout', onBlur); };
}

/** An unsent message saved before a reload (taken once), else undefined. */
export function takeSavedDraft(storage: Storage = sessionStorage): string | undefined {
  const text = storage.getItem(DRAFT_KEY) ?? undefined;
  storage.removeItem(DRAFT_KEY);
  return text || undefined;
}
