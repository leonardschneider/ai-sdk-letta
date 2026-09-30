import { ProviderV2, LanguageModelV2 } from "@ai-sdk/provider";
import {
  LettaAgentClient,
  type LettaCodeClientOptions,
  type LettaCodeRemoteClientOptions,
} from "@letta-ai/letta-agent-sdk";
import { LettaChatModel, SessionPool } from "./letta-chat";
import { tool } from "./letta-tools";

export interface LettaProvider extends ProviderV2, AsyncDisposable {
  /**
   * Creates a language model bound to the configured Letta backend.
   */
  (): LanguageModelV2;

  /**
   * The underlying Letta Agent SDK client for direct access.
   */
  readonly client: LettaAgentClient;

  /**
   * Creates a typed tool placeholder. Tool calls the agent makes are already
   * reported as provider-executed, so registering one is optional — it only
   * gives consumers of the stream typed tool parts. To run tools in *your*
   * process, pass `AgentTool`s through `providerOptions.letta.session.tools`.
   */
  tool: typeof tool;

  /**
   * Close every session this provider has opened. Sessions are cached per
   * agent/conversation and reused across turns, so call this on shutdown.
   */
  close(): Promise<void>;
}

/** Fields of the retired REST-client option shape, rejected with guidance. */
const LEGACY_CLIENT_OPTIONS = ["baseUrl", "token"] as const;

function assertNotLegacyOptions(options: object): void {
  const present = LEGACY_CLIENT_OPTIONS.filter((k) => k in options);
  if (present.length === 0) return;
  throw new Error(
    `createLetta({ ${present.join(", ")} }) is the option shape of the retired ` +
      `REST transport and is no longer accepted. Use lettaCloud (reads ` +
      `LETTA_API_KEY / LETTA_BASE_URL), lettaLocal, or ` +
      `lettaRemote({ url: "ws://host:4500", authToken }). See CHANGELOG.md.`,
  );
}

/**
 * Create a Letta AI provider instance.
 *
 * The transport is the Letta Code app-server websocket protocol, so
 * `backend: "remote"` can reach a self-hosted app server
 * (`letta server --listen ...`). With no options this targets Letta Cloud,
 * matching the previous provider's default.
 *
 * The client is created on first use, not at import time, so importing the
 * package never spawns a local app server or reads credentials.
 */
export function createLetta(
  options: LettaCodeClientOptions = { backend: "cloud" },
): LettaProvider {
  assertNotLegacyOptions(options);

  let pool: SessionPool | undefined;
  const getPool = () => {
    if (!pool) pool = new SessionPool(new LettaAgentClient(options));
    return pool;
  };

  const provider = function (): LanguageModelV2 {
    if (new.target) {
      throw new Error(
        "The Letta model function cannot be called with the new keyword.",
      );
    }

    if (arguments.length > 0) {
      throw new Error(
        "The Letta provider does not accept model parameters. Model configuration is managed through your Letta agents.",
      );
    }

    return new LettaChatModel(getPool());
  } as LettaProvider;

  Object.defineProperty(provider, "client", {
    get: () => getPool().client,
    enumerable: true,
  });
  provider.tool = tool;
  provider.close = async () => {
    if (pool) await pool.close();
  };
  provider[Symbol.asyncDispose] = provider.close;

  return provider;
}

/**
 * Letta Cloud. Reads LETTA_API_KEY from the environment (the SDK does this
 * itself when `apiKey` is omitted) and honours LETTA_BASE_URL as the API base
 * URL, as the previous provider did.
 */
export const lettaCloud = createLetta({
  backend: "cloud",
  ...(process.env.LETTA_BASE_URL
    ? { apiBaseUrl: process.env.LETTA_BASE_URL }
    : {}),
});

/**
 * Local runtime: the SDK spawns its own Letta Code app-server on this machine
 * and keeps agent state under the local backend directory.
 *
 * Note: in 1.x this pointed at a REST server on localhost:8283. That server
 * is retired; see CHANGELOG.md.
 */
export const lettaLocal = createLetta({ backend: "local" });

/**
 * Self-hosted app server you run yourself, e.g.
 *
 *   letta server --listen ws://0.0.0.0:4500 \
 *     --ws-auth capability-token --ws-token-file /path/to/token
 *
 * Accepts every remote client option; `authToken` is sent as
 * `Authorization: Bearer <token>` on the websocket upgrade.
 */
export function lettaRemote(
  config: Omit<LettaCodeRemoteClientOptions, "backend">,
): LettaProvider {
  return createLetta({ backend: "remote", ...config });
}
