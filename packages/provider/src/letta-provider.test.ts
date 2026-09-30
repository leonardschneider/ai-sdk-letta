import { describe, expect, it, vi } from "vitest";

// The provider constructs a real client on import, so stub the SDK rather
// than opening sockets. Records the options each provider was built with.
const constructed: any[] = [];
vi.mock("@letta-ai/letta-agent-sdk", () => ({
  LettaAgentClient: class {
    options: any;
    constructor(options: any) {
      this.options = options;
      constructed.push(options);
    }
  },
  extractStreamTextDelta: () => null,
}));

const { createLetta, lettaCloud, lettaLocal, lettaRemote } = await import(
  "./letta-provider"
);
const { LettaChatModel } = await import("./letta-chat");

describe("createLetta", () => {
  it("defaults to Letta Cloud, as the previous provider did", () => {
    constructed.length = 0;
    createLetta()();
    expect(constructed[0]).toEqual({ backend: "cloud" });
  });

  it("creates the client lazily, not at createLetta() time", () => {
    constructed.length = 0;
    const provider = createLetta();
    expect(constructed).toHaveLength(0);
    provider();
    expect(constructed).toHaveLength(1);
    provider();
    expect(constructed).toHaveLength(1); // shared across models
  });

  it("passes options straight through to the client", () => {
    constructed.length = 0;
    createLetta({ backend: "remote", url: "ws://x:1", authToken: "t" } as any)();
    expect(constructed[0]).toMatchObject({
      backend: "remote",
      url: "ws://x:1",
      authToken: "t",
    });
  });

  it("rejects the retired REST option shape with migration guidance", () => {
    expect(() =>
      createLetta({ baseUrl: "https://custom.letta.com", token: "x" } as any),
    ).toThrow(/retired REST transport.*lettaRemote/s);
  });

  it("close() resolves and is safe to call before any session exists", async () => {
    const provider = createLetta();
    await expect(provider.close()).resolves.toBeUndefined();
    await expect(provider[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it("exposes the underlying client and the tool helper", () => {
    const provider = createLetta();
    expect(provider.client).toBeDefined();
    expect(typeof provider.tool).toBe("function");
  });
});

describe("provider call signature", () => {
  it("returns a LettaChatModel", () => {
    const model = createLetta()();
    expect(model).toBeInstanceOf(LettaChatModel);
    expect(model.specificationVersion).toBe("v2");
    expect(model.provider).toBe("letta");
  });

  it("throws when called with new", () => {
    const provider = createLetta();
    expect(() => new (provider as any)()).toThrow(/cannot be called with the new/);
  });

  it("throws when passed a model id", () => {
    const provider = createLetta();
    expect(() => (provider as any)("some-model")).toThrow(
      /does not accept model parameters/,
    );
  });

  it("throws when passed several parameters", () => {
    const provider = createLetta();
    expect(() => (provider as any)("a", "b")).toThrow(
      /does not accept model parameters/,
    );
  });

  it("returns a fresh model instance per call", () => {
    const provider = createLetta();
    expect(provider()).not.toBe(provider());
  });
});

describe("lettaRemote", () => {
  it("selects the remote backend and forwards the url and token", () => {
    constructed.length = 0;
    lettaRemote({ url: "ws://host:4500", authToken: "cap-token" })();
    expect(constructed[0]).toEqual({
      backend: "remote",
      url: "ws://host:4500",
      authToken: "cap-token",
    });
  });

  it("forwards an explicit WebSocket implementation", () => {
    constructed.length = 0;
    const FakeWs = class {} as any;
    lettaRemote({ url: "ws://host:4500", WebSocket: FakeWs })();
    expect(constructed[0].WebSocket).toBe(FakeWs);
  });

  it("forwards requestTimeoutMs", () => {
    constructed.length = 0;
    lettaRemote({ url: "ws://host:4500", requestTimeoutMs: 1234 })();
    expect(constructed[0].requestTimeoutMs).toBe(1234);
  });

  it("produces a usable provider", () => {
    const provider = lettaRemote({ url: "ws://host:4500" });
    expect(provider()).toBeInstanceOf(LettaChatModel);
  });
});

describe("prebuilt providers", () => {
  it("lettaCloud and lettaLocal are callable providers", () => {
    expect(typeof lettaCloud).toBe("function");
    expect(typeof lettaLocal).toBe("function");
    expect(lettaCloud()).toBeInstanceOf(LettaChatModel);
    expect(lettaLocal()).toBeInstanceOf(LettaChatModel);
  });

  it("both expose client and tool", () => {
    for (const p of [lettaCloud, lettaLocal]) {
      expect(p.client).toBeDefined();
      expect(typeof p.tool).toBe("function");
    }
  });
});
