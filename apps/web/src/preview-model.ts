/** Pure model of the Preview pane (web app development): status, address bar, layout. No I/O. */

/** `GET /v1/threads/:id/preview`. */
export type PreviewStatus =
  | { enabled: false }
  | { enabled: true; previewUrl: string; container: 'stopped' | 'starting' | 'running'; devServer?: { folder: string; command: string; startedAt: string }; origins: string[] };

/** Device sizes of the preview frame. */
export type PreviewDevice = 'desktop' | 'phone';
export const PHONE_WIDTH = 390;

/** Persisted Preview pane layout (desktop): open or closed, its width, the device. */
export type PreviewLayout = { open: boolean; width: number; device: PreviewDevice };
export const PREVIEW_LAYOUT_KEY = 'ai-sdk-letta-preview';
export const PREVIEW_WIDTH = { min: 320, max: 1200, initial: 560 } as const;
export const DEFAULT_PREVIEW_LAYOUT: PreviewLayout = { open: false, width: PREVIEW_WIDTH.initial, device: 'desktop' };
export const clampPreviewWidth = (width: number) => Math.round(Math.min(PREVIEW_WIDTH.max, Math.max(PREVIEW_WIDTH.min, Number.isFinite(width) ? width : PREVIEW_WIDTH.initial)));
export function readPreviewLayout(raw: string | null): PreviewLayout {
  try {
    const value = JSON.parse(raw ?? '') as Partial<PreviewLayout>;
    return { open: typeof value.open === 'boolean' ? value.open : DEFAULT_PREVIEW_LAYOUT.open, width: clampPreviewWidth(Number(value.width)), device: value.device === 'phone' ? 'phone' : 'desktop' };
  } catch { return { ...DEFAULT_PREVIEW_LAYOUT }; }
}

/** Is a dev server running in this conversation? */
export const devServerRunning = (status: PreviewStatus | undefined): status is Extract<PreviewStatus, { enabled: true }> & { devServer: NonNullable<Extract<PreviewStatus, { enabled: true }>['devServer']> } =>
  !!status && status.enabled && !!status.devServer && status.container === 'running';

/**
 * What the address bar shows for a frame URL: the path, query and hash on
 * the preview origin (`/`, `/about?x=1`).
 */
export function addressOf(url: string, previewUrl: string): string {
  try {
    const target = new URL(url), base = new URL(previewUrl);
    return target.origin === base.origin ? `${target.pathname}${target.search}${target.hash}` || '/' : '/';
  } catch { return '/'; }
}

/**
 * The frame URL for what someone typed in the address bar: a path on the
 * preview origin. Anything that leaves the preview origin (another host, a
 * scheme, `//host`) is refused with `undefined`.
 */
export function frameUrl(typed: string, previewUrl: string): string | undefined {
  const value = typed.trim() || '/';
  if (value.length > 2000 || /[\u0000-\u001f]/.test(value)) return undefined;
  let base: URL;
  try { base = new URL(previewUrl); } catch { return undefined; }
  // A full URL is accepted only on the preview's own origin (or the dev server's address the agent uses).
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    try {
      const url = new URL(value);
      if (url.origin === base.origin) return url.href;
      if (/^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(url.origin)) return new URL(`${url.pathname}${url.search}${url.hash}`, base).href;
    } catch { /* not a URL */ }
    return undefined;
  }
  const url = new URL(value.startsWith('/') ? value : `/${value}`, base);
  return url.origin === base.origin ? url.href : undefined;
}

/** "cdn.jsdelivr.net" for "https://cdn.jsdelivr.net" (with the port when not 443). */
export const originLabel = (origin: string) => origin.replace(/^https:\/\//, '');

/** The folder a dev server runs in, as the user sees it: relative to /workspace. */
export const folderLabel = (folder: string) => folder.replace(/^\/workspace\/?/, '') || '/workspace';

/** A short state line for the pane's header. */
export function statusLine(status: PreviewStatus | undefined): string {
  if (!status || !status.enabled) return '';
  if (devServerRunning(status)) return `Live · ${folderLabel(status.devServer.folder)}`;
  if (status.container === 'starting') return 'Starting…';
  return 'No dev server';
}
