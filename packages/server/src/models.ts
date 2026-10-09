import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';
import { localBackendDirectory } from 'ai-sdk-letta';

/** Model handles the app offers (the providers it knows how to label and configure). */
export const MODEL_HANDLE = /^(anthropic|openai|openai-codex|google[^/]*)\/[\w.:-]{1,120}$/;
/** How long the model list is kept (`client.models.list()` starts a Letta Code app server). */
export const MODEL_CACHE_MS = 5 * 60_000;

/**
 * One model the local Letta backend offers: its handle, the catalog's label,
 * its provider (with a friendly label), context window, and the Letta
 * `model_settings` to send when an agent switches to it.
 */
export type ModelOption = { handle: string; label: string; provider: string; providerLabel: string; contextWindow?: number; settings: Record<string, unknown> };
/** What the browser gets (no settings). */
export type PublicModel = Omit<ModelOption, 'settings'>;
export const publicModel = ({ settings: _settings, ...rest }: ModelOption): PublicModel => rest;

/** A catalog entry as `client.models.list()` returns it. */
type Entry = { handle?: unknown; label?: unknown; isDefault?: unknown; updateArgs?: Record<string, unknown> };

/**
 * The friendly provider label of a handle: "ChatGPT subscription"
 * (`openai-codex/…`), "Claude subscription" (the anthropic provider signed in
 * with OAuth) or "Anthropic" (an API key), "OpenAI API", "Google".
 */
export function providerLabel(handle: string, options: { anthropicOAuth?: boolean } = {}): string {
  const provider = handle.split('/')[0] ?? '';
  if (provider === 'openai-codex') return 'ChatGPT subscription';
  if (provider === 'anthropic') return options.anthropicOAuth ? 'Claude subscription' : 'Anthropic';
  if (provider === 'openai') return 'OpenAI API';
  if (provider.startsWith('google')) return 'Google';
  return provider;
}

/** Whether the local backend's anthropic provider is signed in with OAuth (a Claude subscription). Only the auth type is read. */
export function anthropicOAuth(backendDirectory = localBackendDirectory()): boolean {
  try {
    const auth = JSON.parse(readFileSync(join(backendDirectory, 'providers', 'auth.json'), 'utf8')) as { providers?: Record<string, { provider_type?: unknown; auth?: { type?: unknown } }> };
    return Object.values(auth.providers ?? {}).some(p => p?.provider_type === 'anthropic' && p.auth?.type === 'oauth');
  } catch { return false; }
}

/**
 * The `model_settings` Letta needs for a handle, as Letta Code builds them
 * (`buildModelSettings`): the provider type must match the model's provider,
 * so switching provider rebuilds them (the old provider's settings are never
 * kept). Reasoning follows the catalog entry's tier.
 */
export function modelSettings(handle: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  const provider = handle.split('/')[0] ?? '';
  const effort = typeof args.reasoning_effort === 'string' ? args.reasoning_effort : undefined;
  if (provider === 'openai-codex' || provider === 'openai') {
    return { provider_type: provider === 'openai-codex' ? 'chatgpt_oauth' : 'openai', parallel_tool_calls: true, ...(effort ? { reasoning: { reasoning_effort: effort } } : {}) };
  }
  if (provider === 'anthropic') {
    return { provider_type: 'anthropic', parallel_tool_calls: true, ...(effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max' ? { effort } : {}),
      ...(typeof args.enable_reasoner === 'boolean' ? { thinking: { type: args.enable_reasoner ? 'enabled' : 'disabled' } } : {}) };
  }
  if (provider.startsWith('google')) return { provider_type: provider === 'google_vertex' || provider === 'google-vertex' ? 'google_vertex' : 'google_ai', parallel_tool_calls: true };
  return { parallel_tool_calls: true };
}

/**
 * The models of a catalog (one per handle, in catalog order): the providers
 * the app knows, available to this user. Each handle's tier is the default
 * one, else "medium", else the first.
 */
export function modelOptions(entries: readonly Entry[], options: { available?: readonly string[] | null; anthropicOAuth?: boolean } = {}): ModelOption[] {
  const available = options.available ? new Set(options.available) : undefined;
  const byHandle = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (typeof entry.handle !== 'string' || !MODEL_HANDLE.test(entry.handle) || (available && !available.has(entry.handle))) continue;
    byHandle.set(entry.handle, [...(byHandle.get(entry.handle) ?? []), entry]);
  }
  return [...byHandle].map(([handle, tiers]) => {
    const tier = tiers.find(t => t.isDefault === true) ?? tiers.find(t => t.updateArgs?.reasoning_effort === 'medium') ?? tiers[0]!;
    const window = tier.updateArgs?.context_window;
    return { handle, label: typeof tier.label === 'string' && tier.label ? tier.label : handle.split('/').slice(1).join('/'), provider: handle.split('/')[0]!, providerLabel: providerLabel(handle, options),
      ...(typeof window === 'number' && window > 0 ? { contextWindow: window } : {}), settings: modelSettings(handle, tier.updateArgs) };
  }).slice(0, 120);
}

let cached: { at: number; value: Promise<ModelOption[]> } | undefined;
/**
 * The local Letta backend's models (see {@link modelOptions}), cached for
 * {@link MODEL_CACHE_MS}. A failed lookup is not cached.
 */
export function localModels(now = Date.now()): Promise<ModelOption[]> {
  if (cached && now - cached.at < MODEL_CACHE_MS) return cached.value;
  const value = (async () => {
    const client = new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', requestTimeoutMs: 30_000 } });
    try { const list = await client.models.list(); return modelOptions(list.entries, { available: list.availableHandles, anthropicOAuth: anthropicOAuth() }); }
    finally { await client.close(); }
  })();
  cached = { at: now, value };
  value.catch(() => { if (cached?.value === value) cached = undefined; });
  return value;
}
