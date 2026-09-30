import { describe, expect, test, vi } from "vitest";
import { LettaChatModel, SessionPool } from "./letta-chat";

type Part = Record<string, any>;

/** A scripted session: yields the SDKMessages you give it. */
function fakeSession(messages: any[], hooks: Record<string, any> = {}) {
  const sent: any[] = [];
  let disposed = 0;
  return {
    sent,
    get disposed() {
      return disposed;
    },
    session: {
      async ready() {
        return {};
      },
      async abort() {},
      async send(message: any) {
        sent.push(message);
        if (hooks.sendThrows) throw hooks.sendThrows;
      },
      async *stream() {
        for (const m of messages) {
          if (m instanceof Error) throw m;
          yield m;
        }
      },
      async [Symbol.asyncDispose]() {
        disposed += 1;
      },
    },
  };
}

function fakeClient(messages: any[], hooks: Record<string, any> = {}) {
  const f = fakeSession(messages, hooks);
  const resumeSession = vi.fn(() => f.session);
  return { client: { resumeSession } as any, resumeSession, handle: f };
}

const PROMPT = [
  { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
];

function opts(extra: Record<string, any> = {}, agent: Record<string, any> = {}) {
  return {
    prompt: PROMPT,
    providerOptions: {
      letta: { agent: { id: "agent-1", ...agent } },
    },
    ...extra,
  } as any;
}

async function collect(model: LettaChatModel, o: any): Promise<Part[]> {
  const { stream } = await model.doStream(o);
  const parts: Part[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value as Part);
  }
  return parts;
}

const textOf = (parts: Part[]) =>
  parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");

describe("LettaChatModel — turn plumbing", () => {
  test("requires an agent id", async () => {
    const { client } = fakeClient([]);
    const model = new LettaChatModel(client);
    await expect(
      model.doStream({ prompt: PROMPT, providerOptions: {} } as any),
    ).rejects.toThrow(/requires an agentId/);
  });

  test("resumes the agent's default conversation when none is given", async () => {
    const { client, resumeSession } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    await collect(new LettaChatModel(client), opts());
    expect(resumeSession).toHaveBeenCalledWith("agent-1", undefined);
  });

  test("resumes a specific conversation when one is given", async () => {
    const { client, resumeSession } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    await collect(
      new LettaChatModel(client),
      opts({}, { conversationId: "conv-9" }),
    );
    expect(resumeSession).toHaveBeenCalledWith("conv-9", undefined);
  });

  test("sends only the newest user message", async () => {
    const { client, handle } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const model = new LettaChatModel(client);
    await collect(model, {
      prompt: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "newest" }] },
      ],
      providerOptions: { letta: { agent: { id: "agent-1" } } },
    } as any);
    expect(handle.sent).toEqual(["newest"]);
  });

  test("keeps the session open after a turn and reuses it", async () => {
    // Opening a session is the expensive part (subprocess spawn / websocket
    // handshake); it must survive the turn and be reused on the same key.
    const { client, handle, resumeSession } = fakeClient([
      { type: "assistant", content: "hello", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const model = new LettaChatModel(client);
    await collect(model, opts());
    expect(handle.disposed).toBe(0);
    await collect(model, opts());
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(handle.disposed).toBe(0);
  });

  test("SessionPool.close() disposes every cached session", async () => {
    const { client, handle } = fakeClient([
      { type: "assistant", content: "hello", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const pool = new SessionPool(client);
    await collect(new LettaChatModel(pool), opts());
    expect(handle.disposed).toBe(0);
    await pool.close();
    expect(handle.disposed).toBe(1);
    await pool.close(); // idempotent
    expect(handle.disposed).toBe(1);
  });

  test("evicts a session whose transport threw so the next turn reconnects", async () => {
    const f = fakeSession([new Error("socket closed")]);
    const resumeSession = vi.fn(() => f.session);
    const model = new LettaChatModel({ resumeSession } as any);
    await collect(model, opts());
    expect(f.disposed).toBe(1); // evicted
    await collect(model, opts());
    expect(resumeSession).toHaveBeenCalledTimes(2); // reconnected
  });

  test("aborts the server-side turn when the caller aborts", async () => {
    const aborted: string[] = [];
    const f = fakeSession([
      { type: "assistant", content: "hi", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    (f.session as any).abort = async () => {
      aborted.push("abort");
    };
    const client = { resumeSession: vi.fn(() => f.session) } as any;
    const controller = new AbortController();
    const model = new LettaChatModel(client);
    const { stream } = await model.doStream({
      ...opts(),
      abortSignal: controller.signal,
    });
    const reader = stream.getReader();
    // Read until real content: that proves send() ran and the listener is on.
    for (;;) {
      const { value } = await reader.read();
      if ((value as Part).type === "text-delta") break;
    }
    controller.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toEqual(["abort"]);
  });

  test("an already-aborted signal starts no turn and opens no session", async () => {
    const f = fakeSession([
      { type: "assistant", content: "should never be sent", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const resumeSession = vi.fn(() => f.session);
    const parts = await collect(new LettaChatModel({ resumeSession } as any), {
      ...opts(),
      abortSignal: AbortSignal.abort(),
    });
    // Nothing was sent, so the agent never ran; cancellation is not an error.
    expect(resumeSession).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
    expect(textOf(parts)).toBe("");
    expect(parts.find((p) => p.type === "finish")!.finishReason).toBe("other");
    expect(parts.some((p) => p.type === "error")).toBe(false);
  });

  test("brings the session up before registering abort, so abort is not a no-op", async () => {
    const order: string[] = [];
    const f = fakeSession([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    (f.session as any).ready = async () => {
      order.push("ready");
      return {};
    };
    const origSend = f.session.send;
    (f.session as any).send = async (m: any) => {
      order.push("send");
      return origSend(m);
    };
    const client = { resumeSession: vi.fn(() => f.session) } as any;
    await collect(new LettaChatModel(client), opts());
    expect(order).toEqual(["ready", "send"]);
  });

  test("cancelling the stream aborts the agent server-side", async () => {
    const aborted: string[] = [];
    const f = fakeSession([
      { type: "assistant", content: "one", uuid: "u1" },
      { type: "assistant", content: "two", uuid: "u2" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    (f.session as any).abort = async () => {
      aborted.push("abort");
    };
    const client = { resumeSession: vi.fn(() => f.session) } as any;
    const { stream } = await new LettaChatModel(client).doStream(opts());
    const reader = stream.getReader();
    await reader.read(); // stream-start
    await reader.read(); // first content part
    await reader.cancel();
    expect(aborted).toEqual(["abort"]);
    expect(f.disposed).toBe(0); // cancelled turn, session kept for reuse
  });

  test("an abort that lands mid-turn reports a cancellation, not an error", async () => {
    const f = fakeSession([
      { type: "assistant", content: "partial", uuid: "u1" },
      {
        type: "result",
        success: false,
        error: "interrupted",
        errorCode: "interrupted",
        stopReason: "interrupted",
        durationMs: 1,
        conversationId: "c",
      },
    ]);
    const client = { resumeSession: vi.fn(() => f.session) } as any;
    const controller = new AbortController();
    const model = new LettaChatModel(client);
    const { stream } = await model.doStream({
      ...opts(),
      abortSignal: controller.signal,
    });
    const reader = stream.getReader();
    await reader.read();
    controller.abort();
    const parts: Part[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value as Part);
    }
    expect(parts.some((p) => p.type === "error")).toBe(false);
    expect(parts.find((p) => p.type === "finish")!.finishReason).toBe("other");
  });

  test("disposes the session even when the stream throws", async () => {
    const { client, handle } = fakeClient([new Error("transport died")]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(handle.disposed).toBe(1);
    expect(parts.some((p) => p.type === "error")).toBe(true);
  });
});

describe("LettaChatModel — text blocks are keyed by (kind, uuid)", () => {
  test("emits a single completed assistant message as one block", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "hello world", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("hello world");
    expect(parts.filter((p) => p.type === "text-start")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "text-end")).toHaveLength(1);
  });

  test("joins per-chunk assistant messages sharing an otid into ONE block", async () => {
    // As observed on the wire: one assistant message per streamed chunk, each
    // with its OWN uuid, all sharing the otid of the logical message, with
    // per-chunk (not cumulative) content.
    const otid = "provider-assistant-0-f86a36d8";
    const { client } = fakeClient([
      { type: "assistant", content: "Hel", uuid: "letta-msg-147", otid, seqId: 1 },
      { type: "assistant", content: "lo", uuid: "letta-msg-148", otid, seqId: 2 },
      { type: "assistant", content: " world", uuid: "letta-msg-149", otid, seqId: 3 },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("Hello world");
    expect(parts.filter((p) => p.type === "text-start")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "text-end")).toHaveLength(1);
    expect(parts.find((p) => p.type === "text-start")!.id).toBe(otid);
  });

  test("falls back to uuid as the block key when a chunk has no otid", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "ab", uuid: "u1" },
      { type: "assistant", content: "c", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("abc");
    expect(parts.filter((p) => p.type === "text-start")).toHaveLength(1);
    expect(parts.find((p) => p.type === "text-start")!.id).toBe("u1");
  });

  test("a new otid starts a new block even mid-stream", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "first", uuid: "m1", otid: "o1" },
      { type: "assistant", content: " msg", uuid: "m2", otid: "o1" },
      { type: "assistant", content: "second", uuid: "m3", otid: "o2" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const starts = parts.filter((p) => p.type === "text-start").map((p) => p.id);
    expect(starts).toEqual(["o1", "o2"]);
    expect(textOf(parts)).toBe("first msgsecond");
  });

  test("a new uuid starts a new block", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "one", uuid: "u1" },
      { type: "assistant", content: "two", uuid: "u2" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const starts = parts.filter((p) => p.type === "text-start");
    expect(starts.map((p) => p.id)).toEqual(["u1", "u2"]);
    expect(parts.filter((p) => p.type === "text-end")).toHaveLength(2);
    expect(textOf(parts)).toBe("onetwo");
  });

  test("stream_event deltas append to the block for their uuid", async () => {
    const { client } = fakeClient([
      { type: "stream_event", uuid: "u1", event: { delta: { text: "hello " } } },
      { type: "stream_event", uuid: "u1", event: { delta: { text: "world" } } },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("hello world");
    expect(parts.filter((p) => p.type === "text-start")).toHaveLength(1);
  });

  test("a tool call closes the open text block", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "before", uuid: "u1" },
      { type: "tool_call", toolCallId: "t1", toolName: "x", toolInput: {}, uuid: "u2" },
      { type: "assistant", content: "after", uuid: "u3" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const types = parts.map((p) => p.type);
    expect(types.indexOf("text-end")).toBeLessThan(types.indexOf("tool-call"));
    expect(parts.filter((p) => p.type === "text-start")).toHaveLength(2);
  });

  test("closes a dangling text block when the stream ends mid-text", async () => {
    const { client } = fakeClient([
      { type: "stream_event", uuid: "u1", event: { delta: { text: "partial" } } },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(parts.filter((p) => p.type === "text-end")).toHaveLength(1);
    expect(textOf(parts)).toBe("partial");
  });

  test("empty chunks do not open blocks", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(parts.filter((p) => p.type === "text-start")).toHaveLength(0);
  });
});

describe("LettaChatModel — streamed reasoning must not leak into text", () => {
  test("routes reasoning deltas to reasoning parts, not text", async () => {
    const { client } = fakeClient([
      {
        type: "stream_event",
        uuid: "r1",
        event: { delta: { reasoning: "let me think" } },
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("");
    const reasoning = parts
      .filter((p) => p.type === "reasoning-delta")
      .map((p) => p.delta)
      .join("");
    expect(reasoning).toBe("let me think");
  });

  test("closes the reasoning block when assistant text starts", async () => {
    const { client } = fakeClient([
      {
        type: "stream_event",
        uuid: "r1",
        event: { delta: { reasoning: "thinking" } },
      },
      {
        type: "stream_event",
        uuid: "t1",
        event: { delta: { text: "answer" } },
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const order = parts.map((p) => p.type);
    expect(order).toContain("reasoning-start");
    expect(order).toContain("reasoning-end");
    expect(order.indexOf("reasoning-end")).toBeLessThan(
      order.indexOf("text-start"),
    );
    expect(textOf(parts)).toBe("answer");
  });

  test("joins per-chunk reasoning messages sharing an otid into one block", async () => {
    const { client } = fakeClient([
      { type: "reasoning", content: "step one ", uuid: "r1", otid: "ro" },
      { type: "reasoning", content: "and two", uuid: "r2", otid: "ro" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const reasoning = parts
      .filter((p) => p.type === "reasoning-delta")
      .map((p) => p.delta)
      .join("");
    expect(reasoning).toBe("step one and two");
    expect(parts.filter((p) => p.type === "reasoning-start")).toHaveLength(1);
    expect(textOf(parts)).toBe("");
  });

  test("never leaves a block open across kinds", async () => {
    const { client } = fakeClient([
      { type: "stream_event", uuid: "r1", event: { delta: { reasoning: "a" } } },
      { type: "stream_event", uuid: "t1", event: { delta: { text: "b" } } },
      { type: "stream_event", uuid: "r2", event: { delta: { reasoning: "c" } } },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    // "stream-start" is the AI SDK's own envelope, not a content block.
    const starts = parts.filter(
      (p) => p.type.endsWith("-start") && p.type !== "stream-start",
    ).length;
    const ends = parts.filter((p) => p.type.endsWith("-end")).length;
    expect(starts).toBe(ends);
    expect(starts).toBe(3);
  });
});

describe("LettaChatModel — reasoning and tools", () => {
  test("maps reasoning messages", async () => {
    const { client } = fakeClient([
      { type: "reasoning", content: "thinking...", uuid: "r1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(parts.find((p) => p.type === "reasoning-delta")?.delta).toBe(
      "thinking...",
    );
    expect(parts.filter((p) => p.type === "reasoning-start")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "reasoning-end")).toHaveLength(1);
  });

  test("maps a tool call using rawArguments when present", async () => {
    const { client } = fakeClient([
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "search",
        toolInput: { q: "x" },
        rawArguments: '{"q":"x"}',
        uuid: "u1",
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const call = parts.find((p) => p.type === "tool-call")!;
    expect(call.toolCallId).toBe("tc1");
    expect(call.toolName).toBe("search");
    expect(call.input).toBe('{"q":"x"}');
  });

  test("serializes toolInput when rawArguments is absent", async () => {
    const { client } = fakeClient([
      {
        type: "tool_call",
        toolCallId: "tc2",
        toolName: "search",
        toolInput: { q: "y" },
        uuid: "u1",
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(parts.find((p) => p.type === "tool-call")!.input).toBe('{"q":"y"}');
  });

  test("maps tool results including the error flag", async () => {
    const { client } = fakeClient([
      {
        type: "tool_result",
        toolCallId: "tc1",
        content: "boom",
        isError: true,
        uuid: "u2",
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const r = parts.find((p) => p.type === "tool-result")!;
    expect(r.toolCallId).toBe("tc1");
    expect(r.isError).toBe(true);
  });
});

describe("LettaChatModel — multi-tool turns", () => {
  test("maps two tool calls and correlates each result", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "Let me check both.", uuid: "a1" },
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "alpha",
        toolInput: { n: 1 },
        uuid: "u1",
      },
      {
        type: "tool_result",
        toolCallId: "tc1",
        content: "A",
        isError: false,
        uuid: "u2",
      },
      {
        type: "tool_call",
        toolCallId: "tc2",
        toolName: "beta",
        toolInput: { n: 2 },
        uuid: "u3",
      },
      {
        type: "tool_result",
        toolCallId: "tc2",
        content: "B",
        isError: false,
        uuid: "u4",
      },
      { type: "assistant", content: "Both done.", uuid: "a2" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());

    const calls = parts.filter((p) => p.type === "tool-call");
    const results = parts.filter((p) => p.type === "tool-result");
    expect(calls.map((c) => c.toolName)).toEqual(["alpha", "beta"]);
    expect(calls.map((c) => c.toolCallId)).toEqual(["tc1", "tc2"]);
    expect(results.map((r) => r.toolCallId)).toEqual(["tc1", "tc2"]);
    expect(results.map((r) => r.result)).toEqual(["A", "B"]);
    expect(textOf(parts)).toBe("Let me check both.Both done.");
  });

  test("handles both tool calls arriving before either result", async () => {
    const { client } = fakeClient([
      {
        type: "tool_call",
        toolCallId: "p1",
        toolName: "alpha",
        toolInput: {},
        uuid: "u1",
      },
      {
        type: "tool_call",
        toolCallId: "p2",
        toolName: "beta",
        toolInput: {},
        uuid: "u2",
      },
      {
        type: "tool_result",
        toolCallId: "p2",
        content: "second",
        isError: false,
        uuid: "u3",
      },
      {
        type: "tool_result",
        toolCallId: "p1",
        content: "first",
        isError: false,
        uuid: "u4",
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const byId = Object.fromEntries(
      parts
        .filter((p) => p.type === "tool-result")
        .map((p) => [p.toolCallId, p.result]),
    );
    // Out-of-order results must not be cross-wired.
    expect(byId).toEqual({ p1: "first", p2: "second" });
  });

  test("a failing tool among several does not fail the others", async () => {
    const { client } = fakeClient([
      {
        type: "tool_call",
        toolCallId: "ok",
        toolName: "alpha",
        toolInput: {},
        uuid: "u1",
      },
      {
        type: "tool_result",
        toolCallId: "ok",
        content: "fine",
        isError: false,
        uuid: "u2",
      },
      {
        type: "tool_call",
        toolCallId: "bad",
        toolName: "beta",
        toolInput: {},
        uuid: "u3",
      },
      {
        type: "tool_result",
        toolCallId: "bad",
        content: "exploded",
        isError: true,
        uuid: "u4",
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const results = parts.filter((p) => p.type === "tool-result");
    expect(results.find((r) => r.toolCallId === "ok")!.isError).toBe(false);
    expect(results.find((r) => r.toolCallId === "bad")!.isError).toBe(true);
    expect(parts.find((p) => p.type === "finish")!.finishReason).toBe("stop");
  });

  test("interleaves reasoning, tools and text without unbalanced blocks", async () => {
    const { client } = fakeClient([
      { type: "reasoning", content: "plan", uuid: "r1" },
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "alpha",
        toolInput: {},
        uuid: "u1",
      },
      {
        type: "tool_result",
        toolCallId: "t1",
        content: "R",
        isError: false,
        uuid: "u2",
      },
      { type: "reasoning", content: "now answer", uuid: "r2" },
      { type: "assistant", content: "done", uuid: "a1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const starts = parts.filter(
      (p) => p.type.endsWith("-start") && p.type !== "stream-start",
    ).length;
    const ends = parts.filter((p) => p.type.endsWith("-end")).length;
    expect(starts).toBe(ends);
    expect(textOf(parts)).toBe("done");
  });
});

describe("LettaChatModel — concurrency", () => {
  test("two turns on one model instance do not share block state", async () => {
    // Per-chunk assistant messages, as the SDK actually emits them.
    const sessionA = fakeSession([
      { type: "assistant", content: "AA", uuid: "a" },
      { type: "assistant", content: "A", uuid: "a" },
      { type: "result", success: true, durationMs: 1, conversationId: "ca" },
    ]);
    const sessionB = fakeSession([
      { type: "assistant", content: "BB", uuid: "b" },
      { type: "assistant", content: "B", uuid: "b" },
      { type: "result", success: true, durationMs: 1, conversationId: "cb" },
    ]);
    const resumeSession = vi.fn((id: string) =>
      id === "conv-a" ? sessionA.session : sessionB.session,
    );
    const pool = new SessionPool({ resumeSession } as any);
    const model = new LettaChatModel(pool);
    const [a, b] = await Promise.all([
      collect(model, opts({}, { conversationId: "conv-a" })),
      collect(model, opts({}, { conversationId: "conv-b" })),
    ]);

    expect(textOf(a)).toBe("AAA");
    expect(textOf(b)).toBe("BBB");
    expect(resumeSession).toHaveBeenCalledTimes(2);
    await pool.close();
    expect(sessionA.disposed).toBe(1);
    expect(sessionB.disposed).toBe(1);
  });

  test("two turns on the SAME conversation are serialised, not interleaved", async () => {
    const order: string[] = [];
    const f = fakeSession([
      { type: "assistant", content: "x", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const origSend = f.session.send;
    (f.session as any).send = async (m: any) => {
      order.push(`send:${m}`);
      await new Promise((r) => setTimeout(r, 5));
      return origSend(m);
    };
    const model = new LettaChatModel({ resumeSession: vi.fn(() => f.session) } as any);
    const turn = (text: string) =>
      collect(model, {
        prompt: [{ role: "user", content: [{ type: "text", text }] }],
        providerOptions: { letta: { agent: { id: "agent-1", conversationId: "same" } } },
      } as any);
    await Promise.all([turn("first"), turn("second")]);
    expect(order).toEqual(["send:first", "send:second"]);
  });

  test("concurrent turns each get their own session", async () => {
    const seen: string[] = [];
    const make = (tag: string) =>
      fakeSession([
        { type: "assistant", content: tag, uuid: tag },
        { type: "result", success: true, durationMs: 1, conversationId: tag },
      ]);
    const sessions = new Map([
      ["c1", make("one")],
      ["c2", make("two")],
      ["c3", make("three")],
    ]);
    const pool = new SessionPool({
      resumeSession: vi.fn((id: string) => {
        seen.push(id);
        return sessions.get(id)!.session;
      }),
    } as any);

    const model = new LettaChatModel(pool);
    const results = await Promise.all(
      ["c1", "c2", "c3"].map((id) =>
        collect(model, opts({}, { conversationId: id })),
      ),
    );

    expect(results.map(textOf)).toEqual(["one", "two", "three"]);
    expect(seen.sort()).toEqual(["c1", "c2", "c3"]);
    for (const s of sessions.values()) expect(s.disposed).toBe(0);
    await pool.close();
    for (const s of sessions.values()) expect(s.disposed).toBe(1);
  });
});

describe("LettaChatModel — non-content messages", () => {
  test("ignores lifecycle chatter without emitting parts", async () => {
    const { client } = fakeClient([
      { type: "init" },
      { type: "loop_status", status: "SENDING_API_REQUEST", activeRunIds: [] },
      { type: "queue_update", queue: [] },
      { type: "retry", attempt: 1 },
      {
        type: "loop_status",
        status: "WAITING_ON_INPUT",
        activeRunIds: [],
      },
      { type: "assistant", content: "hi", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    // Only the assistant text and the envelope should survive.
    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  test("tolerates an unknown future message type", async () => {
    const { client } = fakeClient([
      { type: "something_new_from_a_later_sdk", payload: 1 },
      { type: "assistant", content: "still fine", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("still fine");
    expect(parts.find((p) => p.type === "finish")!.finishReason).toBe("stop");
  });
});

describe("LettaChatModel — finish reasons and errors", () => {
  // The SDK only reports success:true with end_turn, tool_rule,
  // requires_approval or no stopReason; everything else arrives success:false.
  const cases: Array<[string | undefined, boolean, string]> = [
    ["end_turn", true, "stop"],
    ["tool_rule", true, "stop"],
    [undefined, true, "stop"],
    ["requires_approval", true, "tool-calls"],
    ["max_steps", false, "error"],
    ["llm_api_error", false, "error"],
  ];

  test.each(cases)(
    "stopReason %s (success=%s) -> %s",
    async (stopReason, success, expected) => {
      const { client } = fakeClient([
        {
          type: "result",
          success,
          stopReason,
          durationMs: 1,
          conversationId: "c",
          ...(success ? {} : { error: "failed" }),
        },
      ]);
      const parts = await collect(new LettaChatModel(client), opts());
      expect(parts.find((p) => p.type === "finish")!.finishReason).toBe(
        expected,
      );
    },
  );

  test("surfaces an error message as an error part", async () => {
    const { client } = fakeClient([
      { type: "error", message: "model exploded", stopReason: "error" },
      { type: "result", success: false, error: "model exploded", durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const errs = parts.filter((p) => p.type === "error");
    // The SDK sends error then a failing result for one failure: report once.
    expect(errs).toHaveLength(1);
    expect(String(errs[0].error)).toContain("model exploded");
    expect(parts.find((p) => p.type === "finish")!.finishReason).toBe("error");
  });

  test("explains approval_conflict instead of surfacing the raw code", async () => {
    const { client } = fakeClient([
      {
        type: "error",
        message: "approval_conflict",
        approvalConflict: true,
        stopReason: "error",
      },
      { type: "result", success: false, error: "approval_conflict", durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const msg = String(parts.find((p) => p.type === "error")!.error);
    expect(msg).toContain("permissionMode");
    expect(msg).toContain("canUseTool");
  });

  test("leaves unrelated errors untouched", async () => {
    const { client } = fakeClient([
      { type: "error", message: "rate limited", stopReason: "error" },
      { type: "result", success: false, error: "rate limited", durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const msg = String(parts.find((p) => p.type === "error")!.error);
    expect(msg).toContain("rate limited");
    expect(msg).not.toContain("permissionMode");
  });

  test("always terminates with exactly one finish part", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "hi", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(parts.filter((p) => p.type === "finish")).toHaveLength(1);
    expect(parts[parts.length - 1].type).toBe("finish");
  });
});

describe("LettaChatModel — warnings", () => {
  test("warns that AI SDK tools are not executed", async () => {
    const { client } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(
      new LettaChatModel(client),
      opts({ tools: [{ type: "function", name: "x" }] }),
    );
    const start = parts.find((p) => p.type === "stream-start")!;
    expect(
      start.warnings.some((w: any) => w.setting === "tools"),
    ).toBe(true);
  });

  test("warns about sampling settings owned by the agent", async () => {
    const { client } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(
      new LettaChatModel(client),
      opts({ temperature: 0.5, topP: 0.9 }),
    );
    const settings = parts
      .find((p) => p.type === "stream-start")!
      .warnings.map((w: any) => w.setting);
    expect(settings).toContain("temperature");
    expect(settings).toContain("topP");
  });
});

describe("LettaChatModel — usage and legacy-option warnings", () => {
  test("captures token counts from the usage_statistics stream event", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "hi", uuid: "u1" },
      {
        type: "stream_event",
        uuid: "u2",
        event: {
          message_type: "usage_statistics",
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          reasoning_tokens: 7,
          cached_input_tokens: 100,
        },
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const finish = parts.find((p) => p.type === "finish")!;
    expect(finish.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      reasoningTokens: 7,
      cachedInputTokens: 100,
    });
    // and the usage event itself produced no content part
    expect(textOf(parts)).toBe("hi");
  });

  test("warns about each retired REST-era agent option instead of ignoring it", async () => {
    const { client } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(
      new LettaChatModel(client),
      opts({}, { maxSteps: 5, background: true }),
    );
    const w = parts.find((p) => p.type === "stream-start")!.warnings as any[];
    const msg = w.map((x) => x.message ?? "").join(" ");
    expect(msg).toContain("maxSteps");
    expect(msg).toContain("background");
    expect(msg).toContain("providerOptions.letta.session");
  });

  test("warns that system messages are not forwarded", async () => {
    const { client, handle } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), {
      prompt: [
        { role: "system", content: "Always use Celsius." },
        { role: "user", content: [{ type: "text", text: "temp?" }] },
      ],
      providerOptions: { letta: { agent: { id: "agent-1" } } },
    } as any);
    const w = parts.find((p) => p.type === "stream-start")!.warnings as any[];
    expect(w.some((x) => /System messages are not forwarded/.test(x.message ?? ""))).toBe(true);
    expect(handle.sent).toEqual(["temp?"]); // the user turn still goes through
  });
});

describe("LettaChatModel — doGenerate", () => {
  test("accumulates text, reasoning and tool calls", async () => {
    const { client } = fakeClient([
      { type: "reasoning", content: "hmm", uuid: "r1" },
      { type: "assistant", content: "the answer", uuid: "u1" },
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "search",
        toolInput: {},
        uuid: "u2",
      },
      { type: "result", success: true, stopReason: "end_turn", durationMs: 1, conversationId: "c" },
    ]);
    const res = await new LettaChatModel(client).doGenerate(opts());
    const types = res.content.map((c: any) => c.type);
    expect(types).toContain("text");
    expect(types).toContain("reasoning");
    expect(types).toContain("tool-call");
    expect((res.content.find((c: any) => c.type === "text") as any).text).toBe(
      "the answer",
    );
    expect(res.finishReason).toBe("stop");
  });

  test("joins per-chunk assistant messages into one text content item", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "ab", uuid: "u1" },
      { type: "assistant", content: "c", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const res = await new LettaChatModel(client).doGenerate(opts());
    const texts = res.content.filter((c: any) => c.type === "text");
    expect(texts).toHaveLength(1);
    expect((texts[0] as any).text).toBe("abc");
  });

  test("accumulates reasoning into one content item per block", async () => {
    const { client } = fakeClient([
      { type: "reasoning", content: "a", uuid: "r1" },
      { type: "reasoning", content: "b", uuid: "r1" },
      { type: "reasoning", content: "c", uuid: "r1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const res = await new LettaChatModel(client).doGenerate(opts());
    const reasoning = res.content.filter((c: any) => c.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0] as any).text).toBe("abc");
  });

  test("includes tool results, not just tool calls", async () => {
    const { client } = fakeClient([
      { type: "tool_call", toolCallId: "t1", toolName: "search", toolInput: { q: 1 }, uuid: "u1" },
      { type: "tool_result", toolCallId: "t1", content: "found", isError: false, uuid: "u2" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const res = await new LettaChatModel(client).doGenerate(opts());
    const result = res.content.find((c: any) => c.type === "tool-result") as any;
    expect(result).toBeDefined();
    expect(result.toolCallId).toBe("t1");
    expect(result.toolName).toBe("search");
    expect(result.result).toBe("found");
    expect(result.providerExecuted).toBe(true);
  });

  test("returns an empty content array for a silent turn", async () => {
    const { client } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const res = await new LettaChatModel(client).doGenerate(opts());
    expect(res.content).toEqual([]);
  });
});
