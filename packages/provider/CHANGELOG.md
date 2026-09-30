# Changelog

## 2.0.0

The transport moved from the Letta REST client (`@letta-ai/letta-client`) to
the Letta Agent SDK (`@letta-ai/letta-agent-sdk`), which speaks the Letta Code
app-server websocket protocol. A self-hosted app server does not serve the REST
API, so this is what lets the provider reach one. Several public behaviours
changed with it.

### Breaking

- **`createLetta({ baseUrl, token })` is rejected.** That was the REST option
  shape. Pass agent-SDK options instead:
  `createLetta({ backend: "cloud" | "local" | "remote", ... })`, or use one of
  the prebuilt providers below. The error message points here.
- **`lettaLocal` now means the local runtime.** In 1.x it pointed at a REST
  server on `localhost:8283`. That server is retired; `lettaLocal` now has the
  SDK spawn a Letta Code app-server on this machine, with agent state under
  `~/.letta/lc-local-backend`.
- **`providerOptions.letta.agent.{background, maxSteps, useAssistantMessage,
  assistantMessageToolName, assistantMessageToolKwarg,
  includeReturnMessageTypes, enableThinking, streamTokens, includePings}` and
  `providerOptions.letta.timeoutInSeconds` are no longer supported.** They
  were REST request parameters with no session equivalent. Passing them now
  produces a call warning. Session behaviour is configured through
  `providerOptions.letta.session` (`model`, `reasoningEffort`,
  `permissionMode`, `allowedTools`, `tools`, `mcpServers`, ...).
- **System messages are not forwarded.** A Letta agent's instructions live in
  its memory blocks. A `system` message in the prompt now produces a call
  warning; configure the agent instead.
- **`LettaChatModel`'s constructor takes a `SessionPool` or a client** (both
  from this package) rather than a `LettaClient`.
- **`convertToAiSdkMessage` accepts both live `SDKMessage`s and the REST
  history shape**, and `allowMessageTypes` accepts either vocabulary. It now
  emits `user` and `system` roles again. `providerMetadata` per part and
  `response.body` are no longer populated.
- **Tool calls the agent makes are reported as provider-executed.**
  Registering placeholder tools is no longer needed (and `tool()` no longer
  defaults an `execute`). A permission mode must be set for tool-using turns;
  see the README.

### Added

- `lettaRemote({ url, authToken, ... })` for a self-hosted app server, with
  every remote client option passed through.
- Per-conversation session reuse: sessions are cached per agent/conversation
  and turns on one conversation are serialised. Call `provider.close()` (or
  `await using`) on shutdown.
- `abortSignal` is honoured and stops the agent server-side; an abort reports
  `finishReason: "other"`.
- Token usage is reported from the server's `usage_statistics` event.
- `generateText` results include tool results.

### Unchanged

- `createLetta()` with no options targets Letta Cloud, and `lettaCloud` reads
  `LETTA_API_KEY` and honours `LETTA_BASE_URL`, as before.
- The model still implements `LanguageModelV2`; the peer range is
  `ai >= 5.0.89 < 8`.
