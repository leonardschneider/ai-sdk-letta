/** Pure model of MCP App views in the browser app: names, host context, display modes, sizes, message filtering. No I/O. */

/** An app tool of the agent whose calls show a view (`GET /v1/apps` → `viewTools`). */
/** `dev`: a dev app of this conversation (MCP Apps dev mode). */
export type ViewTool = { app: string; appName: string; tool: string; title?: string; dev?: true };
/** `POST /v1/threads/:id/apps/instances`: one view instance. */
export type AppInstance = {
  instance: string; sandboxUrl: string; sandboxOrigin: string; html: string;
  csp: { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[]; baseUriDomains: string[] };
  prefersBorder?: boolean;
  app: { id: string; name: string };
  tool: { name: string; title?: string; description?: string; inputSchema: Record<string, unknown> };
  input: Record<string, unknown>;
  status: 'running' | 'done' | 'cancelled';
  result?: { content?: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean; [key: string]: unknown };
  reason?: string; at: string; truncated?: boolean; changed?: boolean;
};
/** The instance route's answer when the call is not recorded (yet). */
export type NoInstance = { status: 'none' };

/** An app action waiting for a person (`GET /v1/threads/:id/apps/approvals`). */
export type AppApprovalView = {
  id: string; kind: 'call' | 'message' | 'context'; threadId: string; app: string; appName: string; toolCallId: string; createdAt: string; expiresAt: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'done' | 'failed';
  tool?: string; arguments?: Record<string, unknown>; text?: string; error?: string; decidedBy?: { id: string; name: string };
};
/** What the admin sees of an app (`GET /v1/apps`). */
export type AppStatusView = {
  id: string; name: string; version?: string; packageName?: string; status: 'starting' | 'running' | 'failed' | 'stopped'; error?: string; enabled: boolean; origins?: string[];
  tools?: { name: string; agentTool?: string; title?: string; description?: string; visibility: ('model' | 'app')[]; policy: 'allow' | 'ask' | 'deny'; resourceUri?: string }[];
  views?: { uri: string; declared: Record<string, string[] | undefined>; granted: Record<string, string[]>; fingerprint?: string }[];
};

/** Where a view shows. `panel` is the right pane; `fullscreen` and `pip` are display modes the view may ask for. */
export type Placement = 'inline' | 'panel';
export type DisplayMode = 'inline' | 'fullscreen' | 'pip';
/** Display modes this host offers. */
export const HOST_DISPLAY_MODES: readonly DisplayMode[] = ['inline', 'fullscreen', 'pip'];

/**
 * The mode a view gets when it asks for `requested` (spec: never one the
 * view did not declare, nor one the host does not offer; otherwise the
 * current mode).
 */
export function nextDisplayMode(requested: unknown, current: DisplayMode, declared: readonly string[] | undefined): DisplayMode {
  if (typeof requested !== 'string' || !(HOST_DISPLAY_MODES as readonly string[]).includes(requested)) return current;
  if (Array.isArray(declared) && !declared.includes(requested)) return current;
  return requested as DisplayMode;
}

/** Bounds of an inline view's height. */
export const INLINE_HEIGHT = { min: 48, initial: 160, max: 640 } as const;
/** The inline height for a `size-changed` height (bounded; undefined values keep the current one). */
export function inlineHeight(requested: unknown, current: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return current;
  return Math.round(Math.min(INLINE_HEIGHT.max, Math.max(INLINE_HEIGHT.min, requested)));
}

/** The theme variables a view gets (spec "Theming"): `light-dark()` pairs of the app's own palette. */
export const THEME_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
  '--color-background-primary': 'light-dark(#ffffff, #212426)',
  '--color-background-secondary': 'light-dark(#f3f3ef, #1c1e20)',
  '--color-background-tertiary': 'light-dark(#eef0ea, #2a2e30)',
  '--color-background-inverse': 'light-dark(#1d231f, #e8eae7)',
  '--color-background-info': 'light-dark(#e8f0fb, #1d2a3a)',
  '--color-background-danger': 'light-dark(#fbece7, #3a2420)',
  '--color-background-success': 'light-dark(#e6efe9, #1f3328)',
  '--color-background-warning': 'light-dark(#fbf3e2, #3a3020)',
  '--color-text-primary': 'light-dark(#1d231f, #e8eae7)',
  '--color-text-secondary': 'light-dark(#56605a, #b4bab5)',
  '--color-text-tertiary': 'light-dark(#646c66, #8d948f)',
  '--color-text-inverse': 'light-dark(#ffffff, #17191a)',
  '--color-text-info': 'light-dark(#2a5a9a, #8fb6ea)',
  '--color-text-danger': 'light-dark(#a3402a, #e0826b)',
  '--color-text-success': 'light-dark(#2f6b4f, #6fbf95)',
  '--color-text-warning': 'light-dark(#8a5a12, #e2b457)',
  '--color-border-primary': 'light-dark(#cfd3cb, #41474a)',
  '--color-border-secondary': 'light-dark(#e2e4de, #2f3335)',
  '--color-ring-primary': 'light-dark(#3d7a5c, #7cc9a0)',
  '--font-sans': 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  '--font-mono': 'ui-monospace, SFMono-Regular, Menlo, monospace',
  '--border-radius-sm': '6px', '--border-radius-md': '10px', '--border-radius-lg': '14px',
});

/** The host context a view starts with (and gets again when the theme, mode or size changes). */
export function hostContext(options: { theme: 'light' | 'dark'; displayMode: DisplayMode; placement: Placement; width: number; height?: number; toolCallId: string; tool: AppInstance['tool']; locale?: string; timeZone?: string; touch?: boolean }) {
  const fixed = options.placement === 'panel' || options.displayMode !== 'inline';
  return {
    theme: options.theme, platform: 'web' as const, displayMode: options.displayMode, availableDisplayModes: [...HOST_DISPLAY_MODES],
    styles: { variables: { ...THEME_VARIABLES } },
    containerDimensions: fixed && options.height ? { width: Math.round(options.width), height: Math.round(options.height) } : { maxWidth: Math.round(options.width), maxHeight: INLINE_HEIGHT.max },
    ...(options.locale ? { locale: options.locale } : {}), ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    userAgent: 'ai-sdk-letta', deviceCapabilities: { touch: !!options.touch, hover: !options.touch },
    toolInfo: { id: options.toolCallId, tool: { name: options.tool.name, ...(options.tool.title ? { title: options.tool.title } : {}), ...(options.tool.description ? { description: options.tool.description } : {}), inputSchema: options.tool.inputSchema } },
  };
}

/**
 * Messages from a view's frame that the app relays: JSON-RPC 2.0 objects
 * only, from exactly that frame's window and origin (its sandbox origin).
 * Anything else (another frame, the right window with a forged origin, a
 * different shape) is dropped.
 */
export function acceptFrameMessage(event: { source: unknown; origin: string; data: unknown }, frame: { window: unknown; origin: string }): boolean {
  if (!frame.window || event.source !== frame.window || event.origin !== frame.origin) return false;
  const data = event.data as { jsonrpc?: unknown } | null;
  return !!data && typeof data === 'object' && data.jsonrpc === '2.0';
}

/** `ui/open-link`: http(s) URLs only (never javascript:, data:, the app itself, or local names). */
export function openableLink(value: unknown, appOrigin: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password || url.origin === appOrigin || /(^|\.)localhost$/i.test(url.hostname)) return undefined;
  return url.href;
}

/** The label of a tool line whose tool shows an app's view. */
export function appToolLabel(view: ViewTool, phase: 'running' | 'done' | 'error'): string {
  const name = view.title ?? view.tool.replace(/[_-]+/g, ' ');
  return phase === 'running' ? `${view.appName}: ${name}…` : phase === 'error' ? `${view.appName}: ${name} failed` : `${view.appName}: ${name}`;
}

/** What an approval card says. */
export function approvalTitle(approval: Pick<AppApprovalView, 'kind' | 'appName' | 'tool'>): string {
  if (approval.kind === 'call') return `${approval.appName} wants to run ${approval.tool ?? 'a tool'}`;
  if (approval.kind === 'message') return `${approval.appName} wants to send a message to the agent`;
  return `${approval.appName} wants to give the agent context`;
}
/** The error a view gets for a denied, expired or failed approval. */
export function approvalError(approval: Pick<AppApprovalView, 'status' | 'error'>): string {
  return approval.status === 'denied' ? 'The person denied this action.' : approval.status === 'expired' ? 'Nobody answered in time.' : approval.error ?? 'The action failed.';
}

/** Persisted layout of the app panel (desktop): its width. */
export const APP_PANEL_KEY = 'ai-sdk-letta-app-panel';
export const APP_PANEL_WIDTH = { min: 320, max: 1200, initial: 520 } as const;
export const clampAppPanelWidth = (width: number) => Math.round(Math.min(APP_PANEL_WIDTH.max, Math.max(APP_PANEL_WIDTH.min, Number.isFinite(width) ? width : APP_PANEL_WIDTH.initial)));
