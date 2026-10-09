/**
 * Pure model of the right side panel: one column right of the chat with tabs
 * (Resources, Preview, and one tab per MCP App view opened in the panel).
 * One width, one open/closed state (desktop, persisted), one active tab.
 * App tabs belong to a conversation: only the open conversation's show.
 * No I/O; `main.tsx` persists what these functions return.
 */

/** A tab: `resources`, `preview`, or `app:<toolCallId>`. */
export type SideTab = 'resources' | 'preview' | `app:${string}`;
/** An app view opened in the panel: its tool call, and its tool (for the label). */
export type AppTab = { id: string; tool: string };
/** Persisted state (desktop). On a phone the panel is a drawer: `open` there is not persisted. */
export type SidePanel = { open: boolean; width: number; tab: SideTab; apps: Record<string, AppTab[]> };

export const SIDE_PANEL_KEY = 'ai-sdk-letta-side-panel';
/** The widest bounds of the three former panels (Resources 240–640, Preview and App 320–1200). CSS caps it at 60vw too. */
export const SIDE_WIDTH = { min: 240, max: 1200, initial: 360 } as const;
/** Kept per conversation, and conversations remembered (the most recent ones). */
export const MAX_APP_TABS = 8;
export const MAX_THREADS = 30;
export const DEFAULT_SIDE_PANEL: SidePanel = { open: false, width: SIDE_WIDTH.initial, tab: 'resources', apps: {} };

export const clampSideWidth = (width: number) => Math.round(Math.min(SIDE_WIDTH.max, Math.max(SIDE_WIDTH.min, Number.isFinite(width) ? width : SIDE_WIDTH.initial)));
export const appTab = (toolCallId: string): SideTab => `app:${toolCallId}`;
export const appTabId = (tab: SideTab): string | undefined => tab.startsWith('app:') ? tab.slice(4) : undefined;
const isTab = (value: unknown): value is SideTab => value === 'resources' || value === 'preview' || (typeof value === 'string' && value.startsWith('app:') && value.length > 4 && value.length < 300);

const parse = (raw: string | null | undefined): Record<string, unknown> | undefined => {
  try { const value = JSON.parse(raw ?? '') as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; } catch { return undefined; }
};

/**
 * The persisted state, or (first visit after the update) one migrated from
 * the former panels' keys: the Resources width, and whichever was open.
 */
export function readSidePanel(raw: string | null, legacy: { layout?: string | null; preview?: string | null } = {}): SidePanel {
  const value = parse(raw);
  if (!value) {
    const layout = parse(legacy.layout), preview = parse(legacy.preview);
    const previewOpen = preview?.open === true, resourcesOpen = layout?.resources === true;
    return { ...DEFAULT_SIDE_PANEL, width: clampSideWidth(Number(layout?.resourcesWidth ?? SIDE_WIDTH.initial)), open: previewOpen || resourcesOpen, tab: previewOpen && !resourcesOpen ? 'preview' : 'resources', apps: {} };
  }
  const apps: Record<string, AppTab[]> = {};
  if (value.apps && typeof value.apps === 'object') {
    for (const [thread, list] of Object.entries(value.apps as Record<string, unknown>).slice(-MAX_THREADS)) {
      if (!Array.isArray(list)) continue;
      const tabs = list.filter((t): t is AppTab => !!t && typeof (t as AppTab).id === 'string' && typeof (t as AppTab).tool === 'string').slice(-MAX_APP_TABS).map(t => ({ id: t.id, tool: t.tool }));
      if (tabs.length) apps[thread] = tabs;
    }
  }
  return { open: typeof value.open === 'boolean' ? value.open : false, width: clampSideWidth(Number(value.width)), tab: isTab(value.tab) ? value.tab : 'resources', apps };
}

/** What the open conversation offers: Resources and Preview when enabled; app tabs of this conversation. */
export type SideContext = { threadId?: string; resources: boolean; preview: boolean; apps?: boolean };

/** The tabs shown, in order: Resources, Preview, then the conversation's apps in the order they were opened. */
export function visibleTabs(state: SidePanel, context: SideContext): SideTab[] {
  const tabs: SideTab[] = [];
  if (context.resources) tabs.push('resources');
  if (context.preview && context.threadId) tabs.push('preview');
  if (context.threadId && context.apps !== false) for (const app of state.apps[context.threadId] ?? []) tabs.push(appTab(app.id));
  return tabs;
}
/** The tab that shows: the chosen one if it is there, else the first non-app tab, else none. */
export function activeTab(state: SidePanel, context: SideContext): SideTab | undefined {
  const tabs = visibleTabs(state, context);
  if (tabs.includes(state.tab)) return state.tab;
  return tabs.find(tab => !appTabId(tab));
}
/** Is the panel showing (open, with a tab to show)? */
export const isShown = (state: SidePanel, context: SideContext) => state.open && !!activeTab(state, context);

/** Select a tab and open the panel. */
export const select = (state: SidePanel, tab: SideTab): SidePanel => ({ ...state, open: true, tab });
/** A header button (or ⌘⇧E): its tab is showing → close the panel; else open it on that tab. */
export function toggle(state: SidePanel, tab: SideTab, context: SideContext): SidePanel {
  return isShown(state, context) && activeTab(state, context) === tab ? { ...state, open: false } : select(state, tab);
}
export const close = (state: SidePanel): SidePanel => state.open ? { ...state, open: false } : state;

/** "Open in panel": adds the app tab to the conversation (once), selects it and opens the panel. */
export function openApp(state: SidePanel, threadId: string, app: AppTab): SidePanel {
  const list = state.apps[threadId] ?? [];
  const next = list.some(t => t.id === app.id) ? list : [...list, app].slice(-MAX_APP_TABS);
  const { [threadId]: _, ...others } = state.apps;
  // The conversation used last goes last, so the oldest are forgotten first.
  const apps = Object.fromEntries([...Object.entries(others).slice(-(MAX_THREADS - 1)), [threadId, next]]);
  return { ...state, open: true, tab: appTab(app.id), apps };
}
/**
 * Close an app tab (its ×, the view's close, "Show here", or going full
 * screen). Closing the active one selects the app tab next to it; with no
 * app tab left the panel closes (as the former app panel did), on the tab
 * shown before.
 */
export function closeApp(state: SidePanel, threadId: string, toolCallId: string): SidePanel {
  const list = state.apps[threadId] ?? [];
  const index = list.findIndex(t => t.id === toolCallId);
  if (index < 0) return state;
  const rest = list.filter(t => t.id !== toolCallId);
  const apps = { ...state.apps };
  if (rest.length) apps[threadId] = rest; else delete apps[threadId];
  if (state.tab !== appTab(toolCallId)) return { ...state, apps };
  const neighbour = rest[Math.min(index, rest.length - 1)];
  return neighbour ? { ...state, apps, tab: appTab(neighbour.id) } : { ...state, apps, open: false, tab: 'resources' };
}
/** Is this call shown in the panel (a tab of the conversation)? */
export const hasApp = (state: SidePanel, threadId: string | undefined, toolCallId: string) => !!threadId && (state.apps[threadId] ?? []).some(t => t.id === toolCallId);
export const appsOf = (state: SidePanel, threadId: string | undefined): AppTab[] => threadId ? state.apps[threadId] ?? [] : [];

/**
 * The dev server auto-open rule: a dev server that starts (or restarts) in
 * the open conversation opens the Preview tab, once per start; closing it
 * again is respected until the next start. The first status of a
 * conversation is only remembered (opening a conversation whose server
 * still runs does not pop the panel open).
 */
export type Announced = { thread?: string; started?: string };
export function announce(previous: Announced, threadId: string, started: string | undefined): { next: Announced; open: boolean } {
  const next = { thread: threadId, ...(started ? { started } : {}) };
  return { next, open: previous.thread === threadId && !!started && started !== previous.started };
}

/** Arrow-key navigation in the tab strip: the tab to focus, or undefined for other keys. */
export function tabKey(tabs: readonly SideTab[], current: SideTab, key: string): SideTab | undefined {
  const index = tabs.indexOf(current);
  if (!tabs.length) return undefined;
  if (key === 'ArrowRight' || key === 'ArrowDown') return tabs[(index + 1) % tabs.length];
  if (key === 'ArrowLeft' || key === 'ArrowUp') return tabs[(index - 1 + tabs.length) % tabs.length];
  if (key === 'Home') return tabs[0];
  if (key === 'End') return tabs[tabs.length - 1];
  return undefined;
}
