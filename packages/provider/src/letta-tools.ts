import { z } from "zod";
import { Tool, ToolSet } from "ai";

/**
 * Collection of tool placeholders keyed by tool name.
 * This type is compatible with AI SDK's ToolSet.
 */
export type LettaToolCollection = ToolSet;

/**
 * Creates a tool placeholder for Letta.
 * Since Letta handles tool execution on their backend, this creates a placeholder
 * that satisfies the Vercel AI SDK's type requirements.
 *
 * @param name - The name of the tool
 * @param options - Optional configuration options for the tool
 * @returns A tool placeholder compatible with Vercel AI SDK
 *
 * @example
 * ```typescript
 * // Basic tool
 * const webSearch = lettaLocal.tool("web_search");
 *
 * // Tool with description
 * const myTool = lettaLocal.tool("my_custom_tool", {
 *   description: "Does something useful"
 * });
 *
 * // Tool with description and schema
 * const analytics = lettaLocal.tool("analytics", {
 *   description: "Track analytics events",
 *   inputSchema: z.object({
 *     event: z.string(),
 *     properties: z.record(z.any()),
 *   }),
 * });
 * ```
 */
export function tool(
  name: string,
  options: Partial<Tool<any, any>> = {},
): Tool<any, any> {
  const { description = `${name} tool`, inputSchema = z.any() } = options;

  // No default `execute`. The Letta agent runs the tool on its own side and
  // the provider emits the real tool-result; if this placeholder also had an
  // execute, the AI SDK would run it and emit a SECOND, meaningless result.
  // Registering it without execute is purely so the AI SDK recognises the
  // tool name — otherwise it raises AI_NoSuchToolError on the tool-call part.
  const placeholder: Tool<any, any> = {
    description,
    inputSchema,
    onInputAvailable: undefined,
    onInputStart: undefined,
    onInputDelta: undefined,
  } as Tool<any, any>;

  if (options.execute) {
    (placeholder as { execute?: unknown }).execute = options.execute;
  }

  return placeholder;
}
