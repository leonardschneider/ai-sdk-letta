import { LanguageModelV2Prompt } from "@ai-sdk/provider";
import type { SendMessage } from "@letta-ai/letta-agent-sdk";

/**
 * Letta agents are stateful: the conversation transcript lives on the server,
 * so a turn sends only the newest user message rather than replaying history.
 * This mirrors the app-server's own stateful mode.
 */
export function convertToLettaMessage(
  prompt: LanguageModelV2Prompt,
): SendMessage {
  const lastUser = [...prompt].reverse().find((m) => m.role === "user");

  if (!lastUser) {
    throw new Error(
      "Letta provider requires at least one user message in the prompt.",
    );
  }

  const content = lastUser.content as unknown as Array<
    Record<string, unknown>
  >;

  if (typeof content === "string") {
    return content;
  }

  const parts = content.flatMap((part) => {
    if (part.type === "text") {
      return [{ type: "text" as const, text: String(part.text ?? "") }];
    }
    // Tool parts are produced by the AI SDK's own loop; the Letta agent runs
    // its tools server-side, so they are not replayed into the turn.
    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      return [];
    }
    if (part.type === "file") {
      throw new Error(
        "File content parts are not supported by the Letta provider yet.",
      );
    }
    throw new Error(`Content type ${String(part.type)} not supported`);
  });

  if (parts.length === 0) {
    throw new Error("The latest user message has no text content to send.");
  }

  // Collapse to a plain string when possible; the SDK accepts either form.
  if (parts.length === 1) {
    return parts[0].text;
  }

  return parts as SendMessage;
}
