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
export type ModelOption = {
  handle: string; label: string; provider: string; providerLabel: string; contextWindow?: number;
  /** The settings of its default tier. */
  settings: Record<string, unknown>;
  /** The reasoning efforts it offers (one per catalog tier, in {@link EFFORT_ORDER}); empty when it has no effort setting. */
  efforts: ModelEffort[];
  /** Its catalog tiers by effort (server only): the `updateArgs` to build the settings of a chosen effort. */
  tiers: { effort: string; updateArgs: Record<string, unknown> }[];
};
/** One reasoning effort of a model: its value (`none` … `max`), a label, the tier's context window, and whether it is the default tier. */
export type ModelEffort = { value: string; label: string; contextWindow?: number; default?: boolean };
/** What the browser gets (no settings or tier arguments). */
export type PublicModel = Omit<ModelOption, 'settings' | 'tiers'>;
export const publicModel = ({ settings: _settings, tiers: _tiers, ...rest }: ModelOption): PublicModel => rest;

/** Reasoning efforts, lowest first (the order the app shows them in). */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT_LABELS: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
/** A reasoning effort value the app accepts. */
export const EFFORT_VALUE = /^[a-z]{1,20}$/;

/**
 * The reasoning effort in a Letta agent's `model_settings`: OpenAI and the
 * ChatGPT subscription keep it in `reasoning.reasoning_effort`, Anthropic in
 * `effort`. `undefined` when there is none.
 */
export function effortOf(settings: unknown): string | undefined {
  if (!settings || typeof settings !== 'object') return undefined;
  const s = settings as { reasoning?: { reasoning_effort?: unknown }; effort?: unknown };
  const effort = s.reasoning?.reasoning_effort ?? s.effort;
  return typeof effort === 'string' && EFFORT_VALUE.test(effort) ? effort : undefined;
}

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
 * the app knows, available to this user. Each handle's default tier is the
 * catalog's default, else "medium", else the first; every tier with a
 * `reasoning_effort` becomes one of its {@link ModelOption.efforts}.
 */
export function modelOptions(entries: readonly Entry[], options: { available?: readonly string[] | null; anthropicOAuth?: boolean } = {}): ModelOption[] {
  const available = options.available ? new Set(options.available) : undefined;
  const byHandle = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (typeof entry.handle !== 'string' || !MODEL_HANDLE.test(entry.handle) || (available && !available.has(entry.handle))) continue;
    byHandle.set(entry.handle, [...(byHandle.get(entry.handle) ?? []), entry]);
  }
  const windowOf = (entry: Entry) => { const window = entry.updateArgs?.context_window; return typeof window === 'number' && window > 0 ? window : undefined; };
  const rank = (effort: string) => { const i = (EFFORT_ORDER as readonly string[]).indexOf(effort); return i < 0 ? EFFORT_ORDER.length : i; };
  return [...byHandle].map(([handle, tiers]) => {
    const tier = tiers.find(t => t.isDefault === true) ?? tiers.find(t => t.updateArgs?.reasoning_effort === 'medium') ?? tiers[0]!;
    const window = windowOf(tier);
    const byEffort = new Map<string, Entry>();
    for (const t of tiers) {
      const effort = t.updateArgs?.reasoning_effort;
      if (typeof effort === 'string' && EFFORT_VALUE.test(effort) && (!byEffort.has(effort) || t === tier)) byEffort.set(effort, t);
    }
    const ordered = [...byEffort].sort(([a], [b]) => rank(a) - rank(b));
    const defaultEffort = typeof tier.updateArgs?.reasoning_effort === 'string' ? tier.updateArgs.reasoning_effort : undefined;
    return { handle, label: typeof tier.label === 'string' && tier.label ? tier.label : handle.split('/').slice(1).join('/'), provider: handle.split('/')[0]!, providerLabel: providerLabel(handle, options),
      ...(window ? { contextWindow: window } : {}), settings: modelSettings(handle, tier.updateArgs),
      efforts: ordered.map(([value, t]) => { const w = windowOf(t); return { value, label: EFFORT_LABELS[value] ?? value, ...(w ? { contextWindow: w } : {}), ...(value === defaultEffort ? { default: true } : {}) }; }),
      tiers: ordered.map(([effort, t]) => ({ effort, updateArgs: { ...(t.updateArgs ?? {}) } })) };
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
