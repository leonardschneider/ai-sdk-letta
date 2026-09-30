import {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import {
  LettaAgentClient,
  extractStreamTextDelta,
  type LettaCodeSession,
  type LettaCodeClientSessionOptions,
  type SDKMessage,
} from "@letta-ai/letta-agent-sdk";
import { convertToLettaMessage } from "./convert-to-letta-message";

export interface LettaProviderOptions {
  letta: {
    agent: {
      /** Required. The Letta agent to run this turn against. */
      id?: string;
      /**
       * Target a specific conversation on that agent. Omit to use the agent's
       * default conversation. Give each end user their own conversation id to
       * get isolated transcripts over one shared agent memory.
       */
      conversationId?: string;
    };
    /**
     * Passed through to createSession/resumeSession — model override,
     * permissionMode, allowedTools, client-executed `tools`, mcpServers, cwd.
     *
     * Sessions are cached per agent/conversation and reused across turns, so
     * these options take effect when the session is first opened.
     */
    session?: LettaCodeClientSessionOptions;
  };
}

type TurnArgs = {
  agentId: string;
  conversationId?: string;
  sessionOptions?: LettaCodeClientSessionOptions;
  message: ReturnType<typeof convertToLettaMessage>;
  warnings: LanguageModelV2CallWarning[];
};

const UNKNOWN_USAGE: LanguageModelV2Usage = {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
};

/**
 * Options the REST-era provider accepted under `providerOptions.letta.agent`.
 * None map onto the app-server session; say so rather than ignore them.
 */
const LEGACY_AGENT_OPTIONS = [
  "background",
  "maxSteps",
  "useAssistantMessage",
  "assistantMessageToolName",
  "assistantMessageToolKwarg",
  "includeReturnMessageTypes",
  "enableThinking",
  "streamTokens",
  "includePings",
] as const;

/**
 * Letta's default permission mode requires a human to approve tool calls.
 * A provider running under generateText/streamText has no approver attached,
 * so any tool-using turn dies with a bare "approval_conflict". Say what to do
 * about it instead of surfacing the raw code.
 */
function explainError(
  raw: string,
  message: { approvalConflict?: boolean; errorCode?: string },
): string {
  const isApproval =
    message.approvalConflict === true ||
    message.errorCode === "approval_conflict" ||
    message.errorCode === "approval_conflict_terminal" ||
    /approval_conflict/i.test(raw);
  if (!isApproval) return raw;
  return (
    `${raw}: the agent tried to call a tool but no approver is attached to ` +
    `this session. Set providerOptions.letta.session.permissionMode to ` +
    `"acceptEdits" or "unrestricted", or supply session.canUseTool, to let ` +
    `tool calls proceed.`
  );
}

function mapStopReason(
  stopReason: string | undefined,
  success: boolean,
): LanguageModelV2FinishReason {
  if (!success) return "error";
  switch (stopReason) {
    case "requires_approval":
      return "tool-calls";
    // "end_turn", "tool_rule" and undefined are all normal completions.
    default:
      return "stop";
  }
}

/** Token counts arrive as a `usage_statistics` stream event before `result`. */
function usageFromEvent(event: unknown): LanguageModelV2Usage | null {
  const e = event as Record<string, unknown> | null;
  if (!e || e.message_type !== "usage_statistics") return null;
  const n = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    inputTokens: n(e.prompt_tokens),
    outputTokens: n(e.completion_tokens),
    totalTokens: n(e.total_tokens),
    reasoningTokens: n(e.reasoning_tokens),
    cachedInputTokens: n(e.cached_input_tokens),
  };
}

/**
 * One live session per agent/conversation, reused across turns.
 *
 * Opening a session is the expensive part of a turn — for the local backend
 * it spawns an app-server subprocess and waits for it to listen; for remote
 * and cloud it is a websocket connect plus a runtime handshake — and the SDK
 * is built around one long-lived session per conversation. Turns on the same
 * key are serialised so two overlapping requests never interleave one
 * session's stream.
 */
export class SessionPool implements AsyncDisposable {
  private readonly sessions = new Map<string, LettaCodeSession>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(readonly client: LettaAgentClient) {}

  acquire(key: string, options?: LettaCodeClientSessionOptions): LettaCodeSession {
    let session = this.sessions.get(key);
    if (!session) {
      session = this.client.resumeSession(key, options);
      this.sessions.set(key, session);
    }
    return session;
  }

  /** Drop a session whose transport failed so the next turn reconnects. */
  async evict(key: string): Promise<void> {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (session) {
      await Promise.resolve(session[Symbol.asyncDispose]()).catch(() => {
        /* already gone */
      });
    }
  }

  /** Wait for any in-flight turn on `key`, then hold the lock until released. */
  async lock(key: string): Promise<() => void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      key,
      previous.then(() => mine),
    );
    await previous;
    return release;
  }

  async close(): Promise<void> {
    const open = [...this.sessions.values()];
    this.sessions.clear();
    this.locks.clear();
    await Promise.all(
      open.map((s) =>
        Promise.resolve(s[Symbol.asyncDispose]()).catch(() => {
          /* best effort */
        }),
      ),
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * The agent SDK emits one `assistant`/`reasoning` SDKMessage per streamed
 * chunk. Each chunk has its own uuid, but every chunk of one logical message
 * shares an otid, and content is per-chunk, not cumulative. So a block is
 * keyed by (kind, otid) and chunks append to it; a new otid or a different
 * kind starts a new block.
 */
type BlockKind = "text" | "reasoning";
type Block = { kind: BlockKind; id: string };

export class LettaChatModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider = "letta";
  readonly modelId = "placeholder"; // model selection lives on the Letta agent
  readonly supportedUrls = {};

  private readonly pool: SessionPool;

  /**
   * Accepts a shared `SessionPool` (what `createLetta` passes, so every model
   * from one provider reuses sessions) or a bare client for direct use.
   */
  constructor(source: SessionPool | LettaAgentClient) {
    this.pool =
      source instanceof SessionPool
        ? source
        : new SessionPool(source as LettaAgentClient);
  }

  private getArgs(options: LanguageModelV2CallOptions): TurnArgs {
    const warnings: LanguageModelV2CallWarning[] = [];

    const letta = (
      options as LanguageModelV2CallOptions & {
        providerOptions?: LettaProviderOptions;
      }
    ).providerOptions?.letta;

    const agentId = letta?.agent?.id;
    if (!agentId) {
      throw new Error(
        "Letta provider requires an agentId in providerOptions. Usage: " +
          "streamText({ model: letta(), providerOptions: { letta: { agent: { id: 'agent-...' } } }, ... })",
      );
    }

    // Options from the REST-era provider that have no session equivalent.
    const agentOpts = (letta?.agent ?? {}) as Record<string, unknown>;
    const legacy = LEGACY_AGENT_OPTIONS.filter((k) => agentOpts[k] !== undefined);
    if ((letta as Record<string, unknown> | undefined)?.timeoutInSeconds !== undefined) {
      legacy.push("timeoutInSeconds" as never);
    }
    if (legacy.length > 0) {
      warnings.push({
        type: "other",
        message:
          `providerOptions.letta.agent.{${legacy.join(", ")}} ` +
          `${legacy.length === 1 ? "is" : "are"} not supported by the ` +
          `app-server transport and will be ignored. Session behaviour is ` +
          `configured via providerOptions.letta.session (model, ` +
          `reasoningEffort, permissionMode, allowedTools, tools, mcpServers).`,
      });
    }

    // Letta agents own their system prompt (memory blocks); a system message
    // in the AI SDK prompt has nowhere to go. Say so rather than drop it.
    if (options.prompt.some((m) => m.role === "system")) {
      warnings.push({
        type: "other",
        message:
          "System messages are not forwarded: a Letta agent's instructions " +
          "live in its memory blocks. Configure them on the agent instead.",
      });
    }

    // A Letta agent owns its toolset. Tool definitions passed through the AI
    // SDK call are not sent to the agent; tool calls the agent makes are
    // reported as provider-executed, so nothing needs registering here.
    if (options.tools && options.tools.length > 0) {
      warnings.push({
        type: "unsupported-setting",
        setting: "tools",
        details:
          "Letta agents execute their own tools; AI SDK tool definitions are " +
          "not sent to the agent. Tool calls it makes are reported as " +
          "provider-executed. For tools that should run in your own process, " +
          "use providerOptions.letta.session.tools.",
      });
    }
    for (const setting of ["temperature", "topP", "topK", "seed"] as const) {
      if (options[setting] !== undefined) {
        warnings.push({
          type: "unsupported-setting",
          setting,
          details: "Sampling settings are configured on the Letta agent.",
        });
      }
    }

    return {
      agentId,
      conversationId: letta?.agent?.conversationId,
      sessionOptions: letta?.session,
      message: convertToLettaMessage(options.prompt),
      warnings,
    };
  }

  /**
   * One turn, mapped from SDKMessage events to AI SDK stream parts.
   * Shared by doStream and doGenerate so both agree on semantics.
   *
   * `abort` is the provider's own controller: the caller's abortSignal is
   * chained into it, and doStream's cancel() fires it too, so both paths stop
   * the agent server-side rather than merely stopping us reading.
   */
  private async *runTurn(
    args: TurnArgs,
    abort: AbortController,
  ): AsyncGenerator<LanguageModelV2StreamPart> {
    // resumeSession(agentId) continues the agent's default conversation;
    // resumeSession(conversationId) continues that specific one.
    const key = args.conversationId ?? args.agentId;

    let finishReason: LanguageModelV2FinishReason = "stop";
    let usage: LanguageModelV2Usage = UNKNOWN_USAGE;
    let errorEmitted = false;
    let transportFailed = false;

    let block: Block | null = null;
    const toolNames = new Map<string, string>();

    const close = (): LanguageModelV2StreamPart | null => {
      if (!block) return null;
      const part = { type: `${block.kind}-end`, id: block.id };
      block = null;
      return part as LanguageModelV2StreamPart;
    };

    /** Route a content chunk into the block keyed by (kind, id). */
    function* content(
      kind: BlockKind,
      id: string,
      text: string,
    ): Generator<LanguageModelV2StreamPart> {
      if (!text) return;
      if (block && (block.kind !== kind || block.id !== id)) {
        const end = close();
        if (end) yield end;
      }
      if (!block) {
        block = { kind, id };
        yield { type: `${kind}-start`, id } as LanguageModelV2StreamPart;
      }
      yield { type: `${kind}-delta`, id, delta: text } as LanguageModelV2StreamPart;
    }

    // Nothing to do if the caller already gave up: don't touch the session.
    if (abort.signal.aborted) {
      yield { type: "finish", finishReason: "other", usage };
      return;
    }

    const release = await this.pool.lock(key);
    const session = this.pool.acquire(key, args.sessionOptions);

    const onAbort = () => {
      void session.abort().catch(() => {
        /* the turn may already be finished */
      });
    };

    // The turn body is its own generator so an early `return` (caller gave
    // up while we waited) still falls through to the `finish` part below.
    const body = async function* (): AsyncGenerator<LanguageModelV2StreamPart> {
      // abort() is a no-op until the session has initialised, and send() is
      // what initialises it — so bring the runtime up first, then re-check.
      await session.ready();
      if (abort.signal.aborted) {
        finishReason = "other";
        return;
      }
      abort.signal.addEventListener("abort", onAbort, { once: true });

      await session.send(args.message);

      for await (const message of session.stream() as AsyncGenerator<SDKMessage>) {
        switch (message.type) {
          case "stream_event": {
            const u = usageFromEvent(message.event);
            if (u) {
              usage = u;
              break;
            }
            const delta = extractStreamTextDelta(message.event);
            if (delta?.text) {
              yield* content(
                delta.kind === "reasoning" ? "reasoning" : "text",
                message.uuid,
                delta.text,
              );
            }
            break;
          }

          // Every streamed chunk gets its own uuid, but all chunks of one
          // logical message share an otid — that is the identity to key the
          // block on. Fall back to uuid for the rare fragment without one.
          case "assistant":
            yield* content(
              "text",
              message.otid ?? message.uuid,
              message.content ?? "",
            );
            break;

          case "reasoning":
            yield* content(
              "reasoning",
              message.otid ?? message.uuid,
              message.content ?? "",
            );
            break;

          case "tool_call": {
            const end = close();
            if (end) yield end;
            toolNames.set(message.toolCallId, message.toolName);
            // The agent runs this tool itself. Marking the call as
            // provider-executed (and dynamic, since it is not in the caller's
            // toolset) tells the AI SDK not to look it up, execute it, or
            // wait for a client result.
            yield {
              type: "tool-call",
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              input:
                message.rawArguments ?? JSON.stringify(message.toolInput ?? {}),
              providerExecuted: true,
              dynamic: true,
            } as LanguageModelV2StreamPart;
            break;
          }

          case "tool_result": {
            const end = close();
            if (end) yield end;
            yield {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: toolNames.get(message.toolCallId) ?? "",
              result: message.content,
              isError: message.isError,
              providerExecuted: true,
              dynamic: true,
            } as LanguageModelV2StreamPart;
            break;
          }

          case "error": {
            const end = close();
            if (end) yield end;
            if (abort.signal.aborted) {
              // Our own abort: report a cancellation, not a failure.
              finishReason = "other";
              break;
            }
            finishReason = "error";
            errorEmitted = true;
            yield {
              type: "error",
              error: new Error(explainError(message.message, message)),
            };
            break;
          }

          case "result": {
            const end = close();
            if (end) yield end;
            if (abort.signal.aborted || message.errorCode === "interrupted") {
              finishReason = "other";
              break;
            }
            finishReason = mapStopReason(message.stopReason, message.success);
            // The SDK sends an `error` message and then a failing `result`
            // for the same failure; report it once.
            if (!message.success && message.error && !errorEmitted) {
              errorEmitted = true;
              yield {
                type: "error",
                error: new Error(explainError(message.error, message)),
              };
            }
            break;
          }

          default:
            break;
        }
      }

      const dangling = close();
      if (dangling) yield dangling;
    };

    try {
      yield* body();
    } catch (error) {
      // A throw here is the transport, not the agent: drop the session so
      // the next turn reconnects instead of reusing a dead socket.
      transportFailed = true;
      throw error;
    } finally {
      abort.signal.removeEventListener("abort", onAbort);
      if (transportFailed) await this.pool.evict(key);
      release();
    }

    yield { type: "finish", finishReason, usage };
  }

  /** Chain the caller's signal into a controller the provider owns. */
  private static controllerFor(signal?: AbortSignal): AbortController {
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else
        signal.addEventListener(
          "abort",
          () => controller.abort(signal.reason),
          { once: true },
        );
    }
    return controller;
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const args = this.getArgs(options);
    const abort = LettaChatModel.controllerFor(options.abortSignal);

    const content: LanguageModelV2Content[] = [];
    let finishReason: LanguageModelV2FinishReason = "stop";
    let usage: LanguageModelV2Usage = UNKNOWN_USAGE;
    let buffer = "";

    for await (const part of this.runTurn(args, abort)) {
      switch (part.type) {
        case "text-delta":
        case "reasoning-delta":
          buffer += part.delta;
          break;
        case "text-end":
        case "reasoning-end":
          if (buffer) {
            content.push({
              type: part.type === "text-end" ? "text" : "reasoning",
              text: buffer,
            });
          }
          buffer = "";
          break;
        case "tool-call":
          content.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            providerExecuted: true,
          });
          break;
        case "tool-result":
          content.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.result,
            isError: part.isError,
            providerExecuted: true,
          });
          break;
        case "finish":
          finishReason = part.finishReason;
          usage = part.usage;
          break;
        default:
          break;
      }
    }

    return {
      content,
      finishReason,
      usage,
      warnings: args.warnings,
      request: { body: { agentId: args.agentId, message: args.message } },
    };
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const args = this.getArgs(options);
    const abort = LettaChatModel.controllerFor(options.abortSignal);
    const turn = this.runTurn(args, abort);

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: args.warnings });
      },
      async pull(controller) {
        try {
          const { value, done } = await turn.next();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.enqueue({
            type: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
          controller.close();
        }
      },
      async cancel() {
        // Stop the agent server-side, not just our reading of it. The
        // listener in runTurn turns this into session.abort(), and the
        // pending next() then resolves so the generator can wind down.
        abort.abort();
        await turn.return(undefined);
      },
    });

    return {
      stream,
      request: { body: { agentId: args.agentId, message: args.message } },
    };
  }
}
