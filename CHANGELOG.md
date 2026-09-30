# Changelog

## 0.1.0

First public version, extracted from a working prototype.

- `ai-sdk-letta`: `LettaAgent`, a persistent Letta-backed AI SDK `Agent`;
  `defineAgent` with fail-closed per-tool permissions; durable identity
  mapping with locks and pending-intent files; conversations and display-only
  history restore; the tool bridge (validation, exactly-once execution,
  per-call approval, deadlines, audit); the interaction broker and the
  `ask_user` tool; confined MemFS access; project-scoped dreaming; a
  configurable state directory (`AI_SDK_LETTA_STATE_DIR`).
- `@ai-sdk-letta/server`: durable threads and runs with NDJSON events,
  answers and cancellation; loopback browser app; token API.
- `@ai-sdk-letta/tui`: terminal UI with `/resume`, `/search`, approvals and
  questions, on `@ai-sdk/tui` 1.0.119 plus a patch.
- `@ai-sdk-letta/web`: assistant-ui browser app.
- `@ai-sdk-letta/provider`: absorbed the Agent SDK port of Letta's AI SDK
  provider (2.0.0) with its history and MIT license.
- `examples/basic`: one custom tool in the terminal and the browser.
