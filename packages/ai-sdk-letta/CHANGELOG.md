# ai-sdk-letta

## 0.2.0

### Minor Changes

- fdfd790: File attachments. Opt-in built-in tools `list_files`, `read_file` (PDF page or text line ranges, bounded, saying when output is truncated) and `search_files` (passages with page or line), restricted to the current conversation's folder, which the runtime binds. Files (text, Markdown, CSV, JSON, code, PDF; detected by content) are stored per conversation (0700/0600, atomic writes, sanitized names, no symlinks or traversal), and the user's turn carries only an "Attached: ..." note. PDFs are read with `unpdf` 1.8.1 (pure JavaScript) in a bounded worker; pages without a text layer are returned to the model as images. Images are also saved to the folder. Typed `FileInputError`s and `FILE_LIMITS`. The tool bridge passes a runtime-bound `context` to tools and honours `toModelOutput` (text and bounded images). The server adds `POST /v1/uploads` (raw bytes, route-only 25 MB limit, CSRF), `files` on `POST /v1/runs`, and `GET /v1/threads/:id/files` and `/files/:name` (safe download headers). Agents without the file tools are unchanged.

## 0.1.0

### Minor Changes

- cbca4fb: First public release. `LettaAgent`, a persistent, Letta-backed Vercel AI SDK `Agent`: `defineAgent` with fail-closed per-tool permissions; a durable identity mapping with locks and pending-intent files; conversations and display-only history restore; a tool bridge with schema validation, exactly-once execution, per-call approval, deadlines and a metadata-only audit; an interaction broker and the `ask_user` tool; confined MemFS access; project-scoped dreaming; image input (PNG, JPEG, GIF and WebP, validated by content and bounded); and a configurable state directory (`AI_SDK_LETTA_STATE_DIR`).
