/** Adopted agents' tool sets in the app (the add and edit dialogs). */

/** What each tool set needs: MCP App development runs on web development, which runs in the sandbox. */
const TOOL_NEEDS: Record<string, readonly string[]> = { web_dev: ['sandbox'], mcp_app_dev: ['web_dev', 'sandbox'] };
/** Check or uncheck a tool set, keeping dependencies: checking one checks what it needs, unchecking one unchecks what needs it. */
export function toggleToolSet(list: readonly string[], set: string, on: boolean): string[] {
  if (on) return [...new Set([...list, set, ...(TOOL_NEEDS[set] ?? [])])];
  return list.filter(s => s !== set && !(TOOL_NEEDS[s] ?? []).includes(set));
}

/** A per-tool setting: its permission, or off (the agent does not get the tool). */
export type ToolMode = 'allow' | 'ask' | 'off';
export const TOOL_MODES: readonly ToolMode[] = ['allow', 'ask', 'off'];
/** One tool as `GET .../tools` describes it. */
export type ControlTool = { name: string; description: string; default: ToolMode; override?: ToolMode; locked?: { refuse: ToolMode[]; reason: string }; tokens: number };
/** One tool set as `GET .../tools` describes it (`fixed`: chosen in code). */
export type ControlSet = { set: string; enabled: boolean; fixed?: boolean; tools: ControlTool[]; tokens: number };
/** What `GET .../tools` answers. */
export type ToolControlData = { sets: ControlSet[]; tokens: number; tightenOnly?: boolean };

/** A tool's setting with the edited overrides. */
export const toolMode = (tool: ControlTool, overrides: Readonly<Record<string, ToolMode>>): ToolMode => overrides[tool.name] ?? tool.default;
/** Why a setting is not offered for a tool (locked, or tighten-only), or undefined. */
export function modeRefusal(tool: ControlTool, mode: ToolMode, tightenOnly = false): string | undefined {
  if (tool.locked?.refuse.includes(mode)) return tool.locked.reason;
  if (tightenOnly && mode === 'allow' && tool.default !== 'allow') return 'Set in code: it can only be tightened here.';
  if (tightenOnly && mode === 'ask' && tool.default === 'off') return 'Set in code: it can only be tightened here.';
  return undefined;
}
/** Set one tool: its default removes the override. */
export function setToolMode(overrides: Readonly<Record<string, ToolMode>>, tool: ControlTool, mode: ToolMode): Record<string, ToolMode> {
  const { [tool.name]: _old, ...rest } = overrides;
  return mode === tool.default ? rest : { ...rest, [tool.name]: mode };
}
/** Drop the overrides of one set's tools (its "Reset to defaults"). */
export function resetSet(overrides: Readonly<Record<string, ToolMode>>, set: ControlSet): Record<string, ToolMode> {
  const names = new Set(set.tools.map(t => t.name));
  return Object.fromEntries(Object.entries(overrides).filter(([name]) => !names.has(name)));
}
/** What a set costs with the edited overrides (tools turned off cost nothing). */
export const setTokens = (set: ControlSet, overrides: Readonly<Record<string, ToolMode>>) => set.tools.reduce((sum, t) => sum + (toolMode(t, overrides) === 'off' ? 0 : t.tokens), 0);
/** What the enabled sets cost. */
export const totalTokens = (sets: readonly ControlSet[], enabled: readonly string[], overrides: Readonly<Record<string, ToolMode>>) => sets.reduce((sum, s) => sum + (enabled.includes(s.set) ? setTokens(s, overrides) : 0), 0);
/** "≈ 4.1k tokens", "≈ 820 tokens". */
export const tokenLabel = (tokens: number) => `≈ ${tokens >= 10_000 ? `${Math.round(tokens / 1000)}k` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k` : tokens} tokens`;
/** The first sentence of a tool's description, at most `max` characters. */
export function shortDescription(text: string, max = 140): string {
  // A sentence ends before a capital letter (so "e.g. pip" stays whole).
  const first = text.trim().split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? '';
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}
/** The overrides of `overrides` that changed from `saved`. */
export const sameOverrides = (a: Readonly<Record<string, ToolMode>>, b: Readonly<Record<string, ToolMode>>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
