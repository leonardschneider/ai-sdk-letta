# ai-sdk-letta

## 0.1.0

### Minor Changes

- cbca4fb: First public release. `LettaAgent`, a persistent, Letta-backed Vercel AI SDK `Agent`: `defineAgent` with fail-closed per-tool permissions; a durable identity mapping with locks and pending-intent files; conversations and display-only history restore; a tool bridge with schema validation, exactly-once execution, per-call approval, deadlines and a metadata-only audit; an interaction broker and the `ask_user` tool; confined MemFS access; project-scoped dreaming; image input (PNG, JPEG, GIF and WebP, validated by content and bounded); and a configurable state directory (`AI_SDK_LETTA_STATE_DIR`).
