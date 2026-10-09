/** Pure model of MCP App views in the browser app: names, host context, display modes, sizes, message filtering. No I/O. */

/** An app tool of the agent whose calls show a view (`GET /v1/apps` → `viewTools`). */
/** `dev`: a dev app of this conversation (MCP Apps dev mode). */
export type ViewTool = { app: string; appName: string; tool: string; title?: string; resourceUri?: string; dev?: true };
/** May this be an app tool (`<app>__<tool>`, or a dev app's `dev_<name>__<tool>`)? The line then asks `viewTools` whether it has a view. */
export const isAppToolName = (name: string): boolean => /^(?:dev_)?[a-z][a-z0-9-]{0,23}__/.test(name);
/** `GET /v1/apps` → `devGenerations`: each running dev app's generation (it grows with every `mcp_app_dev_reload`). */
export type DevGenerations = Readonly<Record<string, number>>;
/**
 * The key of a view of `toolName`: its dev app's generation, so a reload
 * remounts open views (they render again, with the "updated" note). `0` for
 * an installed app, or a tool without a view.
 */
export function viewGeneration(viewTools: Readonly<Record<string, ViewTool>>, generations: DevGenerations, toolName: string | undefined): number {
  const view = toolName ? viewTools[toolName] : undefined;
  return view?.dev ? generations[view.app] ?? 0 : 0;
}
/** All dev generations as one key (an overlay does not know its tool: any dev reload remounts it). */
export const devGenerationsKey = (generations: DevGenerations): string => Object.keys(generations).sort().map(id => `${id}:${generations[id]}`).join(',');
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
  /** The view's saved state (`ui/state/save`): its own, or inherited from the latest call of the same app and view (`viewStateFrom`). */
  viewState?: unknown; viewStateFrom?: string;
};
/**
 * The host extension for view state: views feature-detect it in the host
 * capabilities (`experimental`), read their saved state from the host context
 * under this key (`{ state }`), and save it with the `ui/state/save` request.
 */
export const VIEW_STATE_EXTENSION = 'io.ai-sdk-letta/viewState';
export const VIEW_STATE_SAVE = 'ui/state/save';
/** The host context entry with a view's saved state (none when nothing was saved). */
export const viewStateContext = (instance: Pick<AppInstance, 'viewState'>) => 'viewState' in instance && instance.viewState !== undefined ? { [VIEW_STATE_EXTENSION]: { state: instance.viewState } } : {};
/** `ui/state/save` params: `{ state }` with any JSON value (checked again, and limited, by the server). Standard Schema, so the bridge validates it without a schema library. */
export const viewStateParams = {
  '~standard': {
    version: 1 as const, vendor: 'ai-sdk-letta', types: undefined as unknown as { input: unknown; output: { state: unknown } },
    validate: (value: unknown) => value && typeof value === 'object' && 'state' in value ? { value: value as { state: unknown } } : { issues: [{ message: 'ui/state/save needs { state }' }] },
  },
};
/** The instance route's answer when the call is not recorded (yet). */
export type NoInstance = { status: 'none' };

/** An app action waiting for a person (`GET /v1/threads/:id/apps/approvals`). */
export type AppApprovalView = {
  id: string; kind: 'call' | 'message' | 'context'; threadId: string; app: string; appName: string; toolCallId: string; createdAt: string; expiresAt: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'done' | 'failed';
  tool?: string; arguments?: Record<string, unknown>; text?: string; error?: string; decidedBy?: { id: string; name: string };
  /** "Allow always" may be offered (installed apps' tool calls). */
  grantable?: boolean;
};
/** What the admin sees of an app (`GET /v1/apps`). */
export type AppStatusView = {
  id: string; name: string; version?: string; packageName?: string; status: 'starting' | 'running' | 'failed' | 'stopped'; error?: string; enabled: boolean; origins?: string[];
  tools?: { name: string; agentTool?: string; title?: string; description?: string; visibility: ('model' | 'app')[]; policy: 'allow' | 'ask' | 'deny'; resourceUri?: string; granted?: 'tool' | 'app' }[];
  /** "Allow all from this app" was chosen; dev apps: whether calls from its views ask first. */
  grantedAll?: boolean; grantedMessages?: boolean; grantedContext?: boolean; dev?: { conversationId: string }; viewsAsk?: boolean;
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

/**
 * Damps a view's `size-changed` heights (inline). A view whose layout
 * depends on its frame (a scrollbar that comes and goes, `100vh`, fractional
 * sizes) can answer every height the host sets with another one: a feedback
 * loop the person sees as jitter. Changes of `SIZE_DAMPING.slack` px or less
 * are ignored, and a height that alternates (A → B → A within
 * `SIZE_DAMPING.window` ms) settles on the larger one and stops shrinking
 * for that window.
 */
export const SIZE_DAMPING = { slack: 2, window: 1000 } as const;
export class SizeDamper {
  private history: { height: number; at: number }[] = [];
  private holdUntil = 0;
  constructor(public current: number = INLINE_HEIGHT.initial) {}
  /** The height to apply for a requested one, or `undefined` to keep the current one. */
  next(requested: unknown, now: number): number | undefined {
    const wanted = inlineHeight(requested, this.current);
    if (Math.abs(wanted - this.current) <= SIZE_DAMPING.slack) return undefined;
    this.history = this.history.filter(entry => now - entry.at <= SIZE_DAMPING.window);
    // Shrinking back to a height seen just before (an oscillation): hold the larger one.
    if (wanted < this.current && (now < this.holdUntil || this.history.some(entry => Math.abs(entry.height - wanted) <= SIZE_DAMPING.slack))) {
      this.holdUntil = now + SIZE_DAMPING.window;
      return undefined;
    }
    this.history.push({ height: this.current, at: now });
    this.current = wanted;
    return wanted;
  }
}

/** One view per app and resource: calls of tools sharing a view are the same view. */
export const viewIdentity = (view: ViewTool): string => `${view.app}\u0000${view.resourceUri ?? view.tool}`;
/** Per app: one live view (the latest call's; default) or every call its own view. */
export type ViewPolicy = 'single' | 'every';
export const viewPolicyKey = (agentId: string, appId: string) => `ai-sdk-letta-app-views:${agentId}:${appId}`;
export const readViewPolicy = (raw: string | null | undefined): ViewPolicy => raw === 'every' ? 'every' : 'single';
/** Long IDs (UUIDs, hex or base64-like tokens of 20+ characters) shortened to their first 8 characters and an ellipsis. */
export function shortenIds(text: string): string {
  return text
    .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '$1…')
    .replace(/\b(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z_-]*[0-9])(?=[0-9_-]*[A-Za-z])([A-Za-z0-9]{8})[A-Za-z0-9_-]{12,}\b/g, '$1…');
}
/**
 * What a message from an app's view (\`ui/message\`) shows by default: its
 * first sentence or line, IDs shortened, at most \`max\` characters. The
 * agent still gets the full text; \`truncated\` says there is more to see.
 */
export function appMessageSummary(text: string, max = 80): { summary: string; truncated: boolean } {
  const full = text.trim().replace(/\r\n?/g, '\n');
  const line = full.split('\n').find(l => l.trim())?.trim() ?? '';
  // The first sentence: up to a period, ! or ? followed by a space and a capital (not "e.g. this" or "1.5").
  const sentence = /^(.+?[.!?])(?=\s+\p{Lu})/u.exec(line)?.[1] ?? line;
  let summary = shortenIds(sentence).replace(/\s+/g, ' ');
  let cut = false;
  if (summary.length > max) {
    const room = summary.slice(0, max - 1);
    const space = room.lastIndexOf(' ');
    summary = `${(space > max * 0.6 ? room.slice(0, space) : room).replace(/[\s,;:.-]+$/, '')}…`;
    cut = true;
  }
  return { summary, truncated: cut || summary !== full.replace(/\s+/g, ' ') };
}
/** A call of a tool with a view, in conversation order; `phase`: running until its result arrives. */
export type ViewCall = { id: string; tool: string; phase?: 'running' | 'done' };
/**
 * Should a view ask for its instance again after \`{ status: 'none' }\`?
 * While its call runs (it is recorded a moment after the agent streams it),
 * and briefly when the phase is unknown (a panel or full-screen view that
 * was just retargeted to a new call): a call that is streaming is not
 * recorded yet, and one answer of "none" must not leave "No view" for good.
 */
export function retryInstance(version: string | undefined, attempt: number): boolean {
  if (version === 'running') return attempt < 40;
  return version === undefined && attempt < 12;
}
/** "Show this one": the call chosen for a view, while `newest` is still its newest call. */
export type ViewPins = Readonly<Record<string, { id: string; newest: string }>>;
/**
 * The live call of each view (by `viewIdentity`): the newest call, unless
 * the person chose an earlier one since (until a newer call comes). Views
 * of apps whose policy is `every` are not listed: each call shows its own.
 */
export function liveViews(calls: readonly ViewCall[], viewTools: Readonly<Record<string, ViewTool>>, policy: (appId: string) => ViewPolicy, pins: ViewPins = {}): Record<string, string> {
  const newest: Record<string, string> = {};
  const known = new Set<string>();
  for (const call of calls) {
    const view = viewTools[call.tool];
    if (!view || policy(view.app) === 'every') continue;
    const key = viewIdentity(view);
    newest[key] = call.id;
    known.add(`${key}\u0000${call.id}`);
  }
  const live: Record<string, string> = {};
  for (const [key, id] of Object.entries(newest)) {
    const pin = pins[key];
    live[key] = pin && pin.newest === id && known.has(`${key}\u0000${pin.id}`) ? pin.id : id;
  }
  return live;
}
/** The live call for `toolCallId`'s view (itself when every call shows its own view). */
export function liveCallOf(live: Readonly<Record<string, string>>, viewTools: Readonly<Record<string, ViewTool>>, tool: string, toolCallId: string): string {
  const view = viewTools[tool];
  return (view && live[viewIdentity(view)]) ?? toolCallId;
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
