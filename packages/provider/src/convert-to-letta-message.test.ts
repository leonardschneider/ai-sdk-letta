import { describe, expect, test } from "vitest";
import { convertToLettaMessage } from "./convert-to-letta-message";

const user = (parts: any[]) => ({ role: "user" as const, content: parts });

describe("convertToLettaMessage", () => {
  test("returns the newest user message as a plain string", () => {
    expect(
      convertToLettaMessage([user([{ type: "text", text: "hello" }])] as any),
    ).toBe("hello");
  });

  test("ignores everything before the newest user message", () => {
    const result = convertToLettaMessage([
      user([{ type: "text", text: "old" }]),
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      user([{ type: "text", text: "newest" }]),
    ] as any);
    expect(result).toBe("newest");
  });

  test("ignores a trailing assistant message", () => {
    const result = convertToLettaMessage([
      user([{ type: "text", text: "the question" }]),
      { role: "assistant", content: [{ type: "text", text: "trailing" }] },
    ] as any);
    expect(result).toBe("the question");
  });

  test("skips tool parts inside a user message", () => {
    const result = convertToLettaMessage([
      user([
        { type: "tool-result", toolCallId: "t1", output: "x" },
        { type: "text", text: "after the tool" },
      ]),
    ] as any);
    expect(result).toBe("after the tool");
  });

  test("keeps multiple text parts as a content array", () => {
    const result = convertToLettaMessage([
      user([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ] as any);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
  });

  test("throws when there is no user message", () => {
    expect(() =>
      convertToLettaMessage([
        { role: "system", content: "you are helpful" },
      ] as any),
    ).toThrow(/requires at least one user message/);
  });

  test("throws when the newest user message has no text", () => {
    expect(() =>
      convertToLettaMessage([
        user([{ type: "tool-result", toolCallId: "t1", output: "x" }]),
      ] as any),
    ).toThrow(/no text content/);
  });

  test("throws a clear error for unsupported file parts", () => {
    expect(() =>
      convertToLettaMessage([
        user([{ type: "file", mediaType: "image/png", data: "..." }]),
      ] as any),
    ).toThrow(/File content parts are not supported/);
  });

  test("throws for an unknown part type", () => {
    expect(() =>
      convertToLettaMessage([user([{ type: "wat" }])] as any),
    ).toThrow(/not supported/);
  });
});
