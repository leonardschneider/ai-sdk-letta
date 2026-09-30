import { describe, expect, test } from "vitest";
import { convertToAiSdkMessage } from "./convert-to-ai-sdk-message";

describe("convertToAiSdkMessage", () => {
  test("maps assistant messages to text parts", () => {
    const out = convertToAiSdkMessage([
      { type: "assistant", content: "hello", uuid: "u1" },
    ] as any);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("assistant");
    expect((out[0].parts[0] as any).text).toBe("hello");
  });

  test("maps reasoning messages to reasoning parts", () => {
    const out = convertToAiSdkMessage([
      { type: "reasoning", content: "thinking", uuid: "r1" },
    ] as any);
    expect((out[0].parts[0] as any).type).toBe("reasoning");
    expect((out[0].parts[0] as any).text).toBe("thinking");
  });

  test("a tool result upgrades its matching call in place", () => {
    const out = convertToAiSdkMessage([
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "search",
        toolInput: { q: "x" },
        uuid: "u1",
      },
      {
        type: "tool_result",
        toolCallId: "tc1",
        content: "found it",
        isError: false,
        uuid: "u2",
      },
    ] as any);
    // One message for the call; the result mutates it rather than adding one.
    expect(out).toHaveLength(1);
    const part = out[0].parts[0] as any;
    expect(part.type).toBe("tool-search");
    expect(part.state).toBe("output-available");
    expect(part.output).toBe("found it");
  });

  test("an errored tool result sets output-error with errorText", () => {
    const out = convertToAiSdkMessage([
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "search",
        toolInput: {},
        uuid: "u1",
      },
      {
        type: "tool_result",
        toolCallId: "tc1",
        content: "exploded",
        isError: true,
        uuid: "u2",
      },
    ] as any);
    const part = out[0].parts[0] as any;
    expect(part.state).toBe("output-error");
    expect(part.errorText).toBe("exploded");
    expect(part.output).toBeUndefined();
  });

  test("an orphan tool result still produces a message", () => {
    const out = convertToAiSdkMessage([
      {
        type: "tool_result",
        toolCallId: "nope",
        content: "orphan",
        isError: false,
        uuid: "u1",
      },
    ] as any);
    expect(out).toHaveLength(1);
    expect((out[0].parts[0] as any).toolCallId).toBe("nope");
  });

  test("does not cross-wire two different tool calls", () => {
    const out = convertToAiSdkMessage([
      { type: "tool_call", toolCallId: "a", toolName: "one", toolInput: {}, uuid: "u1" },
      { type: "tool_call", toolCallId: "b", toolName: "two", toolInput: {}, uuid: "u2" },
      { type: "tool_result", toolCallId: "b", content: "B", isError: false, uuid: "u3" },
      { type: "tool_result", toolCallId: "a", content: "A", isError: false, uuid: "u4" },
    ] as any);
    expect(out).toHaveLength(2);
    const byId = Object.fromEntries(
      out.map((m) => [(m.parts[0] as any).toolCallId, m.parts[0] as any]),
    );
    expect(byId.a.output).toBe("A");
    expect(byId.b.output).toBe("B");
  });

  test("filters out kinds not in allowMessageTypes", () => {
    const out = convertToAiSdkMessage(
      [
        { type: "assistant", content: "kept", uuid: "u1" },
        { type: "reasoning", content: "dropped", uuid: "r1" },
      ] as any,
      { allowMessageTypes: ["assistant"] },
    );
    expect(out).toHaveLength(1);
    expect((out[0].parts[0] as any).text).toBe("kept");
  });

  test("ignores non-renderable kinds by default", () => {
    const out = convertToAiSdkMessage([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
      { type: "init" },
    ] as any);
    expect(out).toEqual([]);
  });

  describe("REST history shape (listMessages)", () => {
    test("maps user_message to role user, restoring prior user turns", () => {
      const out = convertToAiSdkMessage([
        { id: "m1", message_type: "user_message", content: "hello" },
        { id: "m2", message_type: "assistant_message", content: [{ type: "text", text: "hi!" }] },
      ] as any);
      expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect((out[0].parts[0] as any).text).toBe("hello");
      expect((out[1].parts[0] as any).text).toBe("hi!");
    });

    test("maps system_message to role system", () => {
      const out = convertToAiSdkMessage([
        { id: "s1", message_type: "system_message", content: "be brief" },
      ] as any);
      expect(out[0].role).toBe("system");
    });

    test("correlates tool_call_message with tool_return_message", () => {
      const out = convertToAiSdkMessage([
        {
          id: "t1",
          message_type: "tool_call_message",
          tool_call: { name: "search", arguments: '{"q":"x"}', tool_call_id: "call-1" },
        },
        {
          id: "t2",
          message_type: "tool_return_message",
          tool_call_id: "call-1",
          tool_return: "found",
          status: "success",
        },
      ] as any);
      expect(out).toHaveLength(1);
      const part = out[0].parts[0] as any;
      expect(part.type).toBe("tool-search");
      expect(part.input).toEqual({ q: "x" });
      expect(part.state).toBe("output-available");
      expect(part.output).toBe("found");
    });

    test("maps reasoning_message to a reasoning part", () => {
      const out = convertToAiSdkMessage([
        { id: "r1", message_type: "reasoning_message", reasoning: "thinking" },
      ] as any);
      expect((out[0].parts[0] as any).type).toBe("reasoning");
      expect((out[0].parts[0] as any).text).toBe("thinking");
    });

    test("accepts allowMessageTypes in REST naming", () => {
      const out = convertToAiSdkMessage(
        [
          { id: "m1", message_type: "user_message", content: "kept" },
          { id: "m2", message_type: "assistant_message", content: "dropped" },
        ] as any,
        { allowMessageTypes: ["user_message"] },
      );
      expect(out).toHaveLength(1);
      expect(out[0].role).toBe("user");
    });

    test("handles a mixed batch of SDK and REST messages", () => {
      const out = convertToAiSdkMessage([
        { id: "m1", message_type: "user_message", content: "q" },
        { type: "assistant", content: "a", uuid: "u1" },
      ] as any);
      expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    });
  });
});
