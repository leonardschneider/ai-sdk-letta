# Changelog

From 0.1.0 on, each published package keeps its own changelog, written by
Changesets: [`ai-sdk-letta`](packages/ai-sdk-letta/CHANGELOG.md),
[`@ai-sdk-letta/server`](packages/server/CHANGELOG.md) and
[`@ai-sdk-letta/provider`](packages/provider/CHANGELOG.md). This file is the
repository's history up to the first release.

## Unreleased

- File attachments. Opt-in built-in tools `list_files`, `read_file` (PDF
  page or text line ranges, bounded, with truncation notices) and
  `search_files` (passages with page or line), restricted to the current
  conversation's folder, which the runtime binds. Files (text, Markdown,
  CSV, JSON, code, PDF; detected by content) are stored per conversation
  (0700/0600, atomic, sanitized names, no symlinks or traversal); the user's
  turn carries only an "Attached: ..." note. PDFs are read with `unpdf`
  1.8.1 (pure JavaScript) in a bounded worker; scanned pages are returned to
  the model as images. Images are also saved to the folder. Typed
  `FileInputError`s and `FILE_LIMITS`. The tool bridge passes a
  runtime-bound `context` to tools and supports `toModelOutput` (text and
  images, bounded).
- `@ai-sdk-letta/server`: `POST /v1/uploads` (raw bytes, route-only 25 MB
  limit, CSRF), `files` on `POST /v1/runs`, and `GET /v1/threads/:id/files`
  and `/files/:name` (safe download headers).
- `@ai-sdk-letta/web`: attach PDFs and text files by picker, drop or paste;
  file chips in the composer and in messages (download on click); natural
  file tool lines; error toasts.
- `@ai-sdk-letta/tui`: dropped or pasted document paths attach as
  `[File 1: name]`; restored turns show `[File: name]`. The `@ai-sdk/tui`
  patch names files in markers and labels.
- The example agent includes the file tools.

- Image input. `LettaAgent` accepts images (AI SDK `image`/`file` parts) in a
  new user turn and sends them as Letta `ImageContent`; PNG, JPEG, GIF and
  WebP, validated by content, with per-image, count and total limits and
  typed `ImageInputError`s. The no-replay guard compares images by SHA-256
  and keeps only the hash. Restored history shows user images.
- `@ai-sdk-letta/server`: `POST /v1/runs` accepts `images` under a raised,
  still bounded, route-only body limit; state records image metadata only.
  CSP allows local `blob:` images.
- `@ai-sdk-letta/web`: paste, drag and drop, and a paperclip picker, with
  removable thumbnails, client-side downscaling, error toasts, and images in
  messages with click-to-enlarge.
- `@ai-sdk-letta/tui`: Ctrl+V reads a clipboard image (macOS `osascript`,
  Linux `wl-paste`/`xclip`); dropped or pasted image paths attach files;
  `[Image N]` markers in the prompt. The `@ai-sdk/tui` patch gains a generic
  `attachments` option.

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
