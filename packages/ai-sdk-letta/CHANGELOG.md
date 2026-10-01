# ai-sdk-letta

## 0.5.0

### Minor Changes

- a592457: LaTeX maths in the browser app. Replies render `\(...\)` (inline) and `\[...\]` (display) with KaTeX; `$` is never a delimiter, code is never touched, and invalid LaTeX shows its source as an error. Agent definitions take `ui: { latex: boolean }` (default `true`, validated by `defineAgent`; `DEFAULT_UI` and `AgentUiSettings` are exported). The server exposes it in `GET /api/session` and stores a per-conversation override: `PATCH /v1/threads/:id` accepts `latex: 'inherit' | 'on' | 'off'` and threads are listed with `latex` (older threads read as `'inherit'`). The GUI's CSP now states `font-src 'self'`: KaTeX's fonts are bundled with the app, never loaded from a CDN or as data: URLs.
- 6976703: Conversation names are inline Markdown: links, bold, italic and code. The browser app renders them in the sidebar and the header; links open in a new tab, only `http`, `https` and `mailto` links are active, bare URLs become links and long URLs are shortened in the sidebar, while clicking elsewhere on a row still opens the conversation. Rename edits the Markdown as written, search matches the text a name shows, and titles derived from the first message keep inline Markdown (a pasted URL stays a link). Resource folders are named after the text a title shows, never its syntax (`[Spec](https://x)` → "Spec"), and the TUI shows plain text. New: `parseTitle`, `titleText`, `safeLinkHref` and `shortUrl`, also importable without Node dependencies from `ai-sdk-letta/title`.

## 0.4.0

### Minor Changes

- bd25a23: Add resources: all of an agent's files in one git-backed folder (`<state>/resources/<agent ID>/`), one folder per conversation named after its title (renamed with the conversation, after the running turn if any), plus folders the user makes. Every user operation (upload, new folder, move, rename, delete, restore) is one commit, and what the agent changed during a turn is committed at the end of the turn; git runs with a fixed identity, without global or system config, under a lock. The file tools now default to the conversation's folder and reach every conversation's files with paths from the root (`/Other chat/data.csv`; `list_files` and `search_files` take a `folder`). The sandbox mounts the whole work tree at `/workspace` (never the git history) and starts commands in the conversation's folder; `.venv` is shared and not versioned. Files attached with 0.3 are moved into the resources automatically, once, and links in older messages keep resolving after moves. `ResourceStore` and `LettaRuntime.resources` expose the tree and its operations. The server adds `/v1/resources` routes (tree, upload, folders, move, delete, restore, history, download, and a sandboxed preview with a strict CSP), and file downloads follow files the user moved or renamed. `AttachmentStore` is now a view of a conversation's folder in the resources, and `store()` is async.

## 0.3.0

### Minor Changes

- 4403ef3: Add sandboxed shell commands. `sandboxTools` adds `run_command` (no network, allowed by default) and `run_command_online` (internet access, always asks), run through the AI SDK `Experimental_SandboxSession` in one isolated sandbox per conversation with the conversation's files at `/workspace`. Configure it with the definition's new `sandbox` option: `'apple-container'` (`@lgrammel/apple-container-sandbox` 1.1.0), `'docker'` (`ai-sdk-sandbox-docker` 0.1.2), both optional peer dependencies, or a custom factory. Commands get an empty environment, git without global config and a fixed identity, a timeout, abort on Stop, and capped output; pip packages persist in `/workspace/.venv`. Project folders whose git config holds credentials are refused. The tool bridge now passes the bound sandbox to tools as `experimental_sandbox` and supports per-tool timeouts.

## 0.2.0

### Minor Changes

- fdfd790: File attachments. Opt-in built-in tools `list_files`, `read_file` (PDF page or text line ranges, bounded, saying when output is truncated) and `search_files` (passages with page or line), restricted to the current conversation's folder, which the runtime binds. Files (text, Markdown, CSV, JSON, code, PDF; detected by content) are stored per conversation (0700/0600, atomic writes, sanitized names, no symlinks or traversal), and the user's turn carries only an "Attached: ..." note. PDFs are read with `unpdf` 1.8.1 (pure JavaScript) in a bounded worker; pages without a text layer are returned to the model as images. Images are also saved to the folder. Typed `FileInputError`s and `FILE_LIMITS`. The tool bridge passes a runtime-bound `context` to tools and honours `toModelOutput` (text and bounded images). The server adds `POST /v1/uploads` (raw bytes, route-only 25 MB limit, CSRF), `files` on `POST /v1/runs`, and `GET /v1/threads/:id/files` and `/files/:name` (safe download headers). Agents without the file tools are unchanged.

## 0.1.0

### Minor Changes

- cbca4fb: First public release. `LettaAgent`, a persistent, Letta-backed Vercel AI SDK `Agent`: `defineAgent` with fail-closed per-tool permissions; a durable identity mapping with locks and pending-intent files; conversations and display-only history restore; a tool bridge with schema validation, exactly-once execution, per-call approval, deadlines and a metadata-only audit; an interaction broker and the `ask_user` tool; confined MemFS access; project-scoped dreaming; image input (PNG, JPEG, GIF and WebP, validated by content and bounded); and a configurable state directory (`AI_SDK_LETTA_STATE_DIR`).
