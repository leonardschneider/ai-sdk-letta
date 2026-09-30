# Agent-SDK transport port

Fork of `@letta-ai/vercel-ai-sdk-provider` v1.4.0 that replaces the REST
transport with the Letta Code app-server protocol, so the provider can reach a
**self-hosted app server** instead of only Letta Cloud.

## Why

Upstream depends on `@letta-ai/letta-client` (the Letta REST API client). A
self-hosted app server does not serve that API — probing one directly:

```
/v1/models            -> 200    (only with --openai-api)
/v1/agents            -> 404
/v1/blocks            -> 404
/v1/health            -> 404
```

So upstream can only talk to Letta Cloud. `@letta-ai/letta-agent-sdk` speaks
the websocket protocol the app server actually serves, and has a `remote`
backend for exactly this.

## What changed

| File | Change |
|---|---|
| `letta-provider.ts` | `LettaClient` → `LettaAgentClient`, created lazily on first use; `createLetta()` still defaults to Cloud and rejects the retired `{baseUrl, token}` shape; `lettaCloud` honours `LETTA_BASE_URL`; added `lettaRemote(...)` and `close()`; `lettaLocal` now means `backend: "local"` (was the dead `localhost:8283`) — see CHANGELOG.md |
| `letta-chat.ts` | `agents.messages.create/createStream` → `resumeSession()` + `send()` + `stream()`; maps `SDKMessage` variants to AI SDK stream parts (tool parts provider-executed, blocks keyed by otid); shared `runTurn` so generate and stream agree; abort/cancel reach the agent |
| `convert-to-letta-message.ts` | `MessageCreate[]` → `SendMessage` (sends only the newest user message; the transcript lives server-side) |
| `convert-to-ai-sdk-message.ts` | `LettaMessageUnion` → `SDKMessage`; tool results now upgrade their matching call part by `toolCallId` |
| `package.json` | dep `@letta-ai/letta-client` → `@letta-ai/letta-agent-sdk`; peer `ai` widened to `>=5.0.89 <8` |
| `letta-tools.test.ts` | `ToolExecutionOptions` now requires `context` in ai@7 |

No spec migration was needed: the model still implements `LanguageModelV2`, and
`ai@7` accepts it —
`type LanguageModel = GlobalProviderModelId | LanguageModelV4 | LanguageModelV3 | LanguageModelV2`.
The SDK logs "v2 specification compatibility mode" at runtime.

## Usage

```ts
import { streamText } from "ai";
import { lettaRemote } from "@letta-ai/vercel-ai-sdk-provider";

const letta = lettaRemote({
  url: "ws://your-host:4500",
  authToken: process.env.APP_SERVER_TOKEN, // capability token
});

const res = streamText({
  model: letta(),
  providerOptions: {
    letta: {
      agent: {
        id: "agent-...",
        // Give each end user their own conversation on ONE agent:
        // isolated transcripts, shared memory.
        conversationId: "local-conv-7",
      },
    },
  },
  prompt: "Say hello.",
});
```

Server side:

```sh
letta server --listen ws://0.0.0.0:4500 \
  --ws-auth capability-token --ws-token-file /path/to/token
```

## Tool calls require a permission mode

Letta's default permission mode (`standard`) asks a human to approve tool
calls. A provider driven by `generateText`/`streamText` has no approver
attached, so **any tool-using turn fails with `approval_conflict`**. Set one of:

```ts
providerOptions: {
  letta: {
    agent: { id: "agent-..." },
    session: { permissionMode: "unrestricted" }, // or "acceptEdits", or canUseTool
  },
}
```

The provider rewrites that error to say so rather than surfacing the bare code.
Note `unrestricted` means server-side tools (including `Bash`) run without
prompting — scope the agent's toolset accordingly.

## Tool calls are provider-executed

Tool calls the agent makes are emitted with `providerExecuted: true` and
`dynamic: true`. That is what tells the AI SDK not to look the tool up in the
caller's toolset (no `AI_NoSuchToolError`), not to execute it locally, and not
to start a second step waiting for a client result. Nothing needs registering;
`tool()` is kept only as a typing convenience.

## Streaming model

The SDK emits one `assistant`/`reasoning` SDKMessage per streamed chunk. A wire
probe showed each chunk has its own `uuid` but all chunks of a logical message
share an `otid`, with per-chunk (not cumulative) content. Blocks are therefore
keyed by `(kind, otid)` and chunks append; a different otid or kind starts a
new block. There is no delta-vs-completed-message dedup: this SDK sends one or
the other, never both for the same content.

## Sessions are cached per conversation

Opening a session is the expensive part of a turn — a subprocess spawn for the
local backend, a websocket connect plus runtime handshake for remote/cloud —
and the SDK is built around one long-lived session per conversation. The
provider keeps a `SessionPool`: one session per agent/conversation key, shared
by every model created from the same provider, with turns on one key
serialised. A session whose transport throws is evicted so the next turn
reconnects. `provider.close()` (or `await using`) disposes them all.

Token usage is read from the server's `usage_statistics` stream event, which
arrives before `result`.

## Abort and cancel

The caller's `abortSignal` is chained into a provider-owned `AbortController`
that `doStream`'s `cancel()` also fires, so both paths stop the agent
server-side. Because `session.abort()` is a no-op until the session has
initialised, the provider calls `session.ready()` before registering the
listener; an already-aborted signal starts no turn at all. An abort that lands
is reported as `finishReason: "other"` with no error part.

## Verified

`npm test` runs unit tests plus an e2e suite that **skips** unless
`LETTA_E2E_URL` and `LETTA_E2E_AGENT_ID` are set, so CI stays green without
credentials. Against a live server all five e2e cases pass.


Against a self-hosted app server over a non-loopback address with
capability-token auth, using a stub OpenAI-compatible model provider (no
credentials, nothing left the machine):

- 71 unit tests (`npm run test:node`) covering the stream mapping against
  scripted `SDKMessage` sequences: delta/completed-message dedup, reasoning vs
  text block separation, tool call and result mapping, finish-reason table,
  error paths, session disposal, and both converters
- `streamText` streams assistant text; `finishReason: "stop"`
- `generateText` returns the same through the non-streaming path
- AI SDK `tools` produce an explicit `unsupported-setting` warning rather than
  being silently dropped
- **A real two-step tool loop** (`e2e-tools.mjs`), stub model emits a
  `TaskList` call, the agent executes it server-side and replies:

  ```
  stream-start
  tool-call    name=TaskList id=call_tasklist_1 input={}
  tool-result  id=call_tasklist_1 isError=false result={"tasks":[]}
  text-start / text-delta "Tool run complete." / text-end
  finish       finishReason=stop
  ```
- **Conversation isolation**, observed at the model layer:

  | turn | conversation | messages the model received | contains |
  |---|---|---|---|
  | 1 | alice | 1 | `ALICE-SECRET-42` |
  | 2 | alice | 3 | `ALICE-SECRET-42`, `alice second` |
  | 3 | bob | 1 | `BOB-MESSAGE-99` only |

  Turn 2 proves server-side transcript accumulation (the client sent only the
  newest message). Turn 3 proves bob never sees alice's content.
- **Two different tools in one turn**, each call correlated to exactly one
  result, no `tool-error`, and the file contents echoed back by the model.
- **Caller-side tool execution**: a tool supplied via `session.tools` ran in
  the test process (proven by echoing a per-process nonce back through the
  model) while the agent ran on the app server.
- **Three concurrent turns** on one provider instance: each returns its own
  sentinel and none contains another's.
- **Streamed reasoning stays out of assistant text**, confirmed against a real
  reasoning model: 10 reasoning blocks and 14 text blocks in one turn, block
  starts equal to ends, and no reasoning prefix present in the text. This is
  the path the reasoning-leak bug lived on.

## Known limitations

- **AI SDK `tools` are not translated into Letta tools.** Definitions passed
  to `generateText`/`streamText` are warned about, not executed; nothing needs
  registering, since the agent's calls are provider-executed. Caller-side
  execution itself *does* work: pass Letta `AgentTool`s through
  `providerOptions.letta.session.tools` and they run in your process. What is
  missing is only the automatic AI-SDK-shape → `AgentTool` conversion.
- Upstream's REST-era e2e tests were removed rather than ported.
- `loop_status` and `queue_update` messages are ignored rather than surfaced.
- Session options (`providerOptions.letta.session`) take effect when a
  conversation's session is first opened; later turns on the same
  conversation reuse that session as-is.
- `lint` and `prettier-check` remain broken upstream — neither eslint nor
  prettier is a devDependency. Left alone as out of scope.
