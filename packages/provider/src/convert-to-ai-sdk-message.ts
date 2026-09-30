import type { SDKMessage } from "@letta-ai/letta-agent-sdk";
import {
  UIMessage,
  TextUIPart,
  ToolUIPart,
  ReasoningUIPart,
} from "ai";

type DynamicToolType = `tool-${string}`;

/**
 * A message as returned by the SDK's history APIs (`session.listMessages()`,
 * `conversations.listMessages()`): the REST shape, discriminated by
 * `message_type`. Only the fields this converter reads are declared.
 */
export interface LettaHistoryMessage {
  id: string;
  message_type?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  reasoning?: string;
  tool_call?: { name?: string; arguments?: string; tool_call_id?: string };
  tool_return?: string;
  tool_call_id?: string;
  status?: string;
}

/** Kinds the converter understands, in either vocabulary. */
export type ConvertibleMessageType =
  | "user"
  | "system"
  | "assistant"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "user_message"
  | "system_message"
  | "assistant_message"
  | "reasoning_message"
  | "tool_call_message"
  | "tool_return_message";

export interface ConvertToAiSdkMessageOptions {
  /** Kinds to keep, in SDK or REST naming. Defaults to everything renderable. */
  allowMessageTypes?: ConvertibleMessageType[];
}

type Normalized =
  | { kind: "user" | "system" | "assistant" | "reasoning"; id: string; text: string }
  | { kind: "tool_call"; id: string; toolCallId: string; toolName: string; input: unknown }
  | { kind: "tool_result"; id: string; toolCallId: string; output: string; isError: boolean };

const REST_TO_KIND: Record<string, Normalized["kind"]> = {
  user_message: "user",
  system_message: "system",
  assistant_message: "assistant",
  reasoning_message: "reasoning",
  tool_call_message: "tool_call",
  tool_return_message: "tool_result",
};

const DEFAULT_ALLOWED: Normalized["kind"][] = [
  "user",
  "system",
  "assistant",
  "reasoning",
  "tool_call",
  "tool_result",
];

function textOf(content: LettaHistoryMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

function parseArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Bring either message shape to one internal form, or null if not renderable. */
function normalize(m: SDKMessage | LettaHistoryMessage): Normalized | null {
  // SDK live-stream shape.
  if ("type" in m && typeof m.type === "string") {
    const s = m as SDKMessage;
    switch (s.type) {
      case "assistant":
        return { kind: "assistant", id: s.uuid, text: s.content };
      case "reasoning":
        return { kind: "reasoning", id: s.uuid, text: s.content };
      case "tool_call":
        return {
          kind: "tool_call",
          id: s.uuid,
          toolCallId: s.toolCallId,
          toolName: s.toolName,
          input: s.toolInput ?? {},
        };
      case "tool_result":
        return {
          kind: "tool_result",
          id: s.uuid,
          toolCallId: s.toolCallId,
          output: s.content,
          isError: s.isError,
        };
      default:
        return null;
    }
  }

  // REST history shape.
  const r = m as LettaHistoryMessage;
  const kind = r.message_type ? REST_TO_KIND[r.message_type] : undefined;
  switch (kind) {
    case "user":
    case "system":
    case "assistant":
      return { kind, id: r.id, text: textOf(r.content) };
    case "reasoning":
      return { kind, id: r.id, text: r.reasoning ?? textOf(r.content) };
    case "tool_call":
      return {
        kind,
        id: r.id,
        toolCallId: r.tool_call?.tool_call_id ?? r.id,
        toolName: r.tool_call?.name ?? "",
        input: parseArgs(r.tool_call?.arguments),
      };
    case "tool_result":
      return {
        kind,
        id: r.id,
        toolCallId: r.tool_call_id ?? r.id,
        output: r.tool_return ?? textOf(r.content),
        isError: r.status === "error",
      };
    default:
      return null;
  }
}

/**
 * Convert Letta messages — either the SDK's live `SDKMessage`s or the REST
 * shape returned by the history APIs — into AI SDK UI messages for rendering.
 *
 * Tool calls and their results are correlated by `toolCallId` so a result
 * upgrades the matching call part to `output-available` rather than appearing
 * as a separate message.
 */
export function convertToAiSdkMessage(
  messages: Array<SDKMessage | LettaHistoryMessage>,
  options: ConvertToAiSdkMessageOptions = {},
): UIMessage[] {
  const allowed = new Set<Normalized["kind"]>(
    options.allowMessageTypes
      ? options.allowMessageTypes.map(
          (t) => (REST_TO_KIND[t] ?? t) as Normalized["kind"],
        )
      : DEFAULT_ALLOWED,
  );

  const result: UIMessage[] = [];
  const toolParts = new Map<string, ToolUIPart>();

  for (const raw of messages) {
    const n = normalize(raw);
    if (!n || !allowed.has(n.kind)) continue;

    switch (n.kind) {
      case "user":
      case "system":
      case "assistant": {
        if (!n.text) break;
        const part: TextUIPart = { type: "text", text: n.text };
        result.push({ id: n.id, role: n.kind, parts: [part] } as UIMessage);
        break;
      }

      case "reasoning": {
        if (!n.text) break;
        const part: ReasoningUIPart = { type: "reasoning", text: n.text };
        result.push({ id: n.id, role: "assistant", parts: [part] } as UIMessage);
        break;
      }

      case "tool_call": {
        const part = {
          type: `tool-${n.toolName}` as DynamicToolType,
          toolCallId: n.toolCallId,
          state: "input-available",
          input: n.input,
        } as ToolUIPart;
        toolParts.set(n.toolCallId, part);
        result.push({ id: n.id, role: "assistant", parts: [part] } as UIMessage);
        break;
      }

      case "tool_result": {
        const outcome = n.isError
          ? { state: "output-error", errorText: n.output }
          : { state: "output-available", output: n.output };
        const pending = toolParts.get(n.toolCallId);
        if (pending) {
          // Upgrade the existing call part in place.
          Object.assign(pending, outcome);
          toolParts.delete(n.toolCallId);
        } else {
          result.push({
            id: n.id,
            role: "assistant",
            parts: [
              {
                type: "tool-unknown" as DynamicToolType,
                toolCallId: n.toolCallId,
                ...outcome,
              } as ToolUIPart,
            ],
          } as UIMessage);
        }
        break;
      }
    }
  }

  return result;
}
