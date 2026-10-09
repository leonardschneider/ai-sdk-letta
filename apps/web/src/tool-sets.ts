/** Adopted agents' tool sets in the app (the add and edit dialogs). */

/** What each tool set needs: MCP App development runs on web development, which runs in the sandbox. */
const TOOL_NEEDS: Record<string, readonly string[]> = { web_dev: ['sandbox'], mcp_app_dev: ['web_dev', 'sandbox'] };
/** Check or uncheck a tool set, keeping dependencies: checking one checks what it needs, unchecking one unchecks what needs it. */
export function toggleToolSet(list: readonly string[], set: string, on: boolean): string[] {
  if (on) return [...new Set([...list, set, ...(TOOL_NEEDS[set] ?? [])])];
  return list.filter(s => s !== set && !(TOOL_NEEDS[s] ?? []).includes(set));
}
