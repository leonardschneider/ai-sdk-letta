# @ai-sdk-letta/server

## 0.2.0

### Minor Changes

- fdfd790: File attachments. Opt-in built-in tools `list_files`, `read_file` (PDF page or text line ranges, bounded, saying when output is truncated) and `search_files` (passages with page or line), restricted to the current conversation's folder, which the runtime binds. Files (text, Markdown, CSV, JSON, code, PDF; detected by content) are stored per conversation (0700/0600, atomic writes, sanitized names, no symlinks or traversal), and the user's turn carries only an "Attached: ..." note. PDFs are read with `unpdf` 1.8.1 (pure JavaScript) in a bounded worker; pages without a text layer are returned to the model as images. Images are also saved to the folder. Typed `FileInputError`s and `FILE_LIMITS`. The tool bridge passes a runtime-bound `context` to tools and honours `toModelOutput` (text and bounded images). The server adds `POST /v1/uploads` (raw bytes, route-only 25 MB limit, CSRF), `files` on `POST /v1/runs`, and `GET /v1/threads/:id/files` and `/files/:name` (safe download headers). Agents without the file tools are unchanged.

### Patch Changes

- Updated dependencies [fdfd790]
  - ai-sdk-letta@0.2.0

## 0.1.0

### Minor Changes

- cbca4fb: First public release. A local HTTP runtime for ai-sdk-letta agents: durable threads and runs, NDJSON events, exactly-once answers and cancellation, and image input on `POST /v1/runs`; `startGuiServer` for a loopback browser app (session cookie, CSRF, Origin and Host checks, strict CSP) and `startApiServer` for a token-authenticated server-to-server API.

### Patch Changes

- Updated dependencies [cbca4fb]
  - ai-sdk-letta@0.1.0
