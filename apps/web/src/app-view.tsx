import React, { useEffect, useRef, useState } from 'react';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import { LoaderCircle, Maximize2, Minimize2, PanelRight, PictureInPicture2, X } from 'lucide-react';
import { api, errorCode } from './api.js';
import { acceptFrameMessage, approvalError, hostContext, inlineHeight, INLINE_HEIGHT, nextDisplayMode, openableLink, type AppApprovalView, type AppInstance, type DisplayMode, type NoInstance, type Placement } from './apps-model.js';

/**
 * One MCP App view (spec 2026-01-26): the view's HTML in a sandbox proxy
 * frame on its own origin (`s-<token>.localhost`, a new one per view), driven
 * by `@modelcontextprotocol/ext-apps`'s `AppBridge`, with no MCP client in the
 * browser: every request the view makes is sent to this app's server, which
 * decides (visibility, policy, approval) and answers. This page only relays.
 *
 * Loaded lazily (it carries the MCP SDK), only when an app's view shows.
 */

/** A postMessage transport bound to one frame: its window and its exact origin (the sandbox's), both ways. */
class FrameTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly listener = (event: MessageEvent) => {
    if (!acceptFrameMessage(event, { window: this.target(), origin: this.origin })) return;
    this.onmessage?.(event.data as JSONRPCMessage);
  };
  constructor(private readonly target: () => Window | null | undefined, private readonly origin: string) {}
  async start() { window.addEventListener('message', this.listener); }
  async send(message: JSONRPCMessage) { this.target()?.postMessage(message, this.origin); }
  async close() { window.removeEventListener('message', this.listener); this.onclose?.(); }
}

const theme = (): 'light' | 'dark' => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
type GateError = { error: { code: number; message: string } };
const fail = (error: GateError['error']) => Object.assign(new Error(error.message), { code: error.code });

/** Follow an approval until a person decides it (or it expires); its outcome for the view. */
async function settle(id: string, signal: AbortSignal): Promise<AppApprovalView & { result?: AppInstance['result'] }> {
  for (;;) {
    signal.throwIfAborted();
    const approval = await api<AppApprovalView & { result?: AppInstance['result'] }>(`/v1/apps/approvals/${encodeURIComponent(id)}?wait=1`);
    if (approval.status !== 'pending' && approval.status !== 'approved') return approval;
  }
}

export type AppFrameProps = {
  threadId: string; toolCallId: string; placement: Placement;
  /** The view asked for a display mode (fullscreen, pip) or the person chose one. */
  mode: DisplayMode; onMode(mode: DisplayMode): void;
  /** Open the same call's view in the panel. */
  onOpenPanel?(): void;
  /** Approvals of this view changed (the cards refresh). */
  onApprovals(): void;
  /** The view sent a message (allowed): refresh the conversation. */
  onSent(): void;
  /** Close (panel, fullscreen). */
  onClose?(): void;
  /** Its server-side record changed (a call finished): render again. */
  version?: string;
  /** The app's name, shown while it loads. */
  name?: string;
};

/**
 * The frame of one view and its bridge. Teardown (unmount, reload, mode
 * change of another instance) sends `ui/resource-teardown` first.
 */
export default function AppFrame({ threadId, toolCallId, placement, mode, onMode, onOpenPanel, onApprovals, onSent, onClose, version, name: knownName }: AppFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>(INLINE_HEIGHT.initial);
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'failed'; error?: string; instance?: AppInstance }>({ phase: 'loading' });
  const [declared, setDeclared] = useState<string[] | undefined>();
  const bridgeRef = useRef<AppBridge | undefined>(undefined);
  const modeRef = useRef(mode); modeRef.current = mode;
  const callbacks = useRef({ onMode, onApprovals, onSent }); callbacks.current = { onMode, onApprovals, onSent };

  useEffect(() => {
    let disposed = false;
    const control = new AbortController();
    let bridge: AppBridge | undefined;
    let instanceId: string | undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => { void bridge?.sendHostContextChange({ theme: theme() }); };
    (async () => {
      let instance: AppInstance;
      try {
        // A call that is starting is recorded a moment later: ask again while it runs (a finished call is there at once).
        let answer: AppInstance | NoInstance;
        for (let attempt = 0; ; attempt++) {
          answer = await api<AppInstance | NoInstance>(`/v1/threads/${encodeURIComponent(threadId)}/apps/instances`, { toolCallId, placement });
          if ((answer as AppInstance).instance || disposed || version !== 'running' || attempt >= 40) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (disposed) return;
        if (!(answer as AppInstance).instance) { setState({ phase: 'failed', error: version === 'running' ? 'Waiting for the app…' : 'No view for this call: it did not run, or it is no longer available.' }); return; }
        instance = answer as AppInstance;
      }
      catch (error) {
        const code = errorCode(error);
        if (!disposed) setState({ phase: 'failed', error: code === 'app_disabled' ? 'This app is disabled.' : code === 'app_unavailable' ? 'The app is not running. It may still be starting, or it failed to start (see Apps).' : code === 'not_found' ? 'No view for this call: it did not run, or it is no longer available.' : 'Couldn’t load the app.' });
        return;
      }
      if (disposed) return;
      instanceId = instance.instance;
      const iframe = frame.current!;
      const width = () => box.current?.clientWidth ?? 600;
      const relay = async <T,>(action: string, params: unknown): Promise<T> => {
        const answer = await api<{ result?: T; pending?: string } & Partial<GateError>>(`/v1/apps/instances/${instance.instance}/${action}`, params ?? {});
        if (answer.error) throw fail(answer.error);
        if (answer.pending) {
          callbacks.current.onApprovals();
          const settled = await settle(answer.pending, control.signal);
          callbacks.current.onApprovals();
          if (settled.status !== 'done') throw fail({ code: -32000, message: approvalError(settled) });
          if (action === 'message') callbacks.current.onSent();
          return (settled.result ?? {}) as T;
        }
        return answer.result as T;
      };
      bridge = new AppBridge(null, { name: 'ai-sdk-letta', version: '1' }, {
        serverTools: {}, serverResources: {}, logging: {}, openLinks: {}, message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} },
        sandbox: { csp: instance.csp },
      }, { hostContext: hostContext({ theme: theme(), displayMode: modeRef.current, placement, width: width(), ...(placement === 'panel' ? { height: box.current?.clientHeight ?? 600 } : {}), toolCallId, tool: instance.tool, locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, touch: matchMedia('(pointer: coarse)').matches }) as never });
      bridgeRef.current = bridge;
      bridge.oncalltool = params => relay('call', params);
      bridge.onreadresource = params => relay('read', params);
      bridge.onmessage = async params => { await relay('message', params); return {}; };
      bridge.onupdatemodelcontext = async params => { await relay('context', params); return {}; };
      bridge.onloggingmessage = params => { void api(`/v1/apps/instances/${instance.instance}/log`, params).catch(() => {}); };
      bridge.onopenlink = async ({ url }) => {
        const href = openableLink(url, location.origin);
        if (!href) throw fail({ code: -32000, message: 'Invalid URL' });
        // A new tab without opener or referrer: the app never learns about this page.
        const opened = window.open(href, '_blank', 'noopener,noreferrer');
        if (opened === null && !window.confirm(`Open ${href}?`)) throw fail({ code: -32000, message: 'Link opening denied by user' });
        return {};
      };
      bridge.onsizechange = ({ height: h }) => { if (placement === 'inline' && modeRef.current === 'inline') setHeight(current => inlineHeight(h, current)); };
      bridge.onrequestdisplaymode = async ({ mode: wanted }) => {
        const next = nextDisplayMode(wanted, modeRef.current, bridge?.getAppCapabilities()?.availableDisplayModes);
        if (next !== modeRef.current) callbacks.current.onMode(next);
        return { mode: next };
      };
      bridge.onrequestteardown = () => { if (placement === 'panel' || modeRef.current !== 'inline') callbacks.current.onMode('inline'); };
      const proxyReady = new Promise<void>(resolve => { bridge!.onsandboxready = () => resolve(); });
      const initialized = new Promise<void>(resolve => { bridge!.oninitialized = () => resolve(); });
      await bridge.connect(new FrameTransport(() => iframe.contentWindow, instance.sandboxOrigin));
      iframe.src = instance.sandboxUrl;
      await proxyReady;
      if (disposed) return;
      await bridge.sendSandboxResourceReady({ html: instance.html, csp: instance.csp });
      await initialized;
      if (disposed) return;
      setDeclared(bridge.getAppCapabilities()?.availableDisplayModes as string[] | undefined);
      setState({ phase: 'ready', instance });
      // Spec: complete tool input after initialization, then the result (or the cancellation).
      await bridge.sendToolInput({ arguments: instance.input });
      if (instance.status === 'done' && instance.result) await bridge.sendToolResult(instance.result as never);
      else if (instance.status === 'cancelled') await bridge.sendToolCancelled({ reason: instance.reason ?? 'cancelled' });
      media.addEventListener('change', onTheme);
    })().catch(error => { if (!disposed) setState(s => s.phase === 'ready' ? s : { phase: 'failed', error: error instanceof Error && error.message ? 'The app’s view failed to start.' : 'Couldn’t load the app.' }); });
    return () => {
      disposed = true;
      control.abort();
      media.removeEventListener('change', onTheme);
      const current = bridge;
      bridgeRef.current = undefined;
      if (current) void current.teardownResource({}, { timeout: 1000 }).catch(() => {}).finally(() => { void current.close(); });
      if (instanceId) void api(`/v1/apps/instances/${instanceId}/close`, {}).catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, toolCallId, placement, version]);

  // Mode or size changes reach the view as host context.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge || state.phase !== 'ready') return;
    const node = box.current;
    void bridge.sendHostContextChange({ displayMode: mode, containerDimensions: mode !== 'inline' || placement === 'panel' ? { width: node?.clientWidth ?? 600, height: node?.clientHeight ?? 600 } : { maxWidth: node?.clientWidth ?? 600, maxHeight: INLINE_HEIGHT.max } });
  }, [mode, placement, state.phase]);
  useEffect(() => {
    const node = box.current;
    if (!node || state.phase !== 'ready' || (placement === 'inline' && mode === 'inline')) return;
    const observer = new ResizeObserver(() => { void bridgeRef.current?.sendHostContextChange({ containerDimensions: { width: node.clientWidth, height: node.clientHeight } }); });
    observer.observe(node);
    return () => observer.disconnect();
  }, [mode, placement, state.phase]);

  const fixed = placement === 'panel' || mode !== 'inline';
  const canFullscreen = !declared || declared.includes('fullscreen');
  const canPip = !!declared?.includes('pip');
  const name = state.instance?.app.name ?? knownName ?? 'App';
  return <div className="appview" data-placement={placement} data-mode={mode} data-border={state.instance?.prefersBorder === false ? 'none' : undefined} data-phase={state.phase}>
    <div className="appview-bar">
      <span className="app-badge" title="An interactive view of an MCP App: its content comes from the app">App</span>
      <span className="appview-name" title={state.instance ? `${state.instance.app.name} · ${state.instance.tool.title ?? state.instance.tool.name}` : undefined}>{name}{state.instance && <span className="muted"> · {state.instance.tool.title ?? state.instance.tool.name}</span>}</span>
      {state.instance?.changed && <span className="appview-note" title="The app’s view changed since this call ran">updated</span>}
      <span className="appview-tools">
        {placement === 'inline' && mode === 'inline' && onOpenPanel && <button type="button" className="icon-btn small" aria-label="Open in panel" title="Open in panel" onClick={onOpenPanel}><PanelRight size={14}/></button>}
        {canPip && mode !== 'pip' && <button type="button" className="icon-btn small" aria-label="Picture in picture" title="Picture in picture" onClick={() => onMode('pip')}><PictureInPicture2 size={14}/></button>}
        {canFullscreen && mode !== 'fullscreen' && <button type="button" className="icon-btn small" aria-label="Full screen" title="Full screen" onClick={() => onMode('fullscreen')}><Maximize2 size={14}/></button>}
        {mode !== 'inline' && <button type="button" className="icon-btn small" aria-label="Exit full screen" title={mode === 'pip' ? 'Back inline' : 'Exit full screen (Esc)'} onClick={() => onMode('inline')}><Minimize2 size={14}/></button>}
        {onClose && <button type="button" className="icon-btn small" aria-label="Close app" title="Close" onClick={onClose}><X size={14}/></button>}
      </span>
    </div>
    <div ref={box} className="appview-stage" style={fixed ? undefined : { height }}>
      {state.phase === 'loading' && <div className="appview-wait" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true"/>Loading {name}…</div>}
      {state.phase === 'failed' && <div className="appview-wait" role="alert">{state.error}</div>}
      <iframe ref={frame} className="appview-frame" title={`${name} (MCP App)`} hidden={state.phase === 'failed'}
        sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'"/>
    </div>
  </div>;
}
