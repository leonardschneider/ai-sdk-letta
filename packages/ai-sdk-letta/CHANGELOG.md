# ai-sdk-letta

## 0.9.0

### Minor Changes

- d56d2a2: Orchestration with n8n and Conductor OSS. The server can serve an automation API on its own loopback port (`automation: { port }`): per-trigger tokens (created and revoked by agent admins in the app's new Automations dialog, or from the command line; stored as SHA-256 hashes, shown once), each bound to one agent and the person it acts for, start turns in a named or new conversation with a required idempotency key, wait for them (long poll), and fetch the reply, tool outcomes and files created. Runs started this way are unattended: a tool that needs approval fails the run with `approval_required` and `ask_user` with `question_required`, naming the tool; the tool never runs and the conversation stays usable. A token can pre-approve specific `ask` tools; `deny` stays deny. Tokens are rate- and concurrency-limited, browsers are refused, and the API never listens on all interfaces. Such turns show a "via n8n" badge in the app. New `schedule_task` tool (opt-in, asks by default) lets the agent schedule a one-off task in the configured orchestrator (n8n through its public API, or Conductor's scheduler); the server keeps no timer of its own. Library: `LettaCallOptions.unattended`, `UnattendedPolicy`, `schedulingTools`, `resolveWhen`. Server: `AutomationService`, `automationApp`, `n8nOrchestrator`, `conductorOrchestrator`, `createAutomationToken`. Single-user runtimes now forget their oldest finished runs instead of refusing new turns after 200, and a conversation view waits briefly for another reader instead of answering `runtime_busy`. The browser app follows changes it did not make in single-user mode too (when automations are on), and hands a message back to the composer when the agent is busy.

## 0.8.0

### Minor Changes

- a237997: Atlassian (Jira and Confluence Cloud) integration with each user's own API token. `atlassianTools` adds `atlassian_fetch` (save an issue or page into the conversation's folder as Markdown plus the original document), `atlassian_update` (write an edited `.md` back by block splice: unchanged blocks are kept verbatim, edits that would lose mentions, images, statuses, macros and similar are refused naming them, and stale versions are refused) and `atlassian_request` (the user's site's Jira and Confluence REST APIs only; reads run, changes ask with a readable preview). Credentials are stored per user on the server (0600) and never returned to the browser or given to the agent; tools act as the person whose message started the turn. Also new: `adfToMarkdown`, `markdownToAdf`, `spliceMarkdown` and `validateAdf`; tools can attach a per-call preparation (`withPreparation`) that answers early or requires approval with a preview; turns accept an `actor`; and the server serves `/api/integrations/atlassian` (connect, test, disconnect) and an Atlassian media proxy for previews. The browser app gets a Connect Atlassian dialog, approval cards that show the changed blocks, and `.adf.json` previews with Atlassian's renderer.

## 0.7.0

### Minor Changes

- 4b571e0: Group conversations on team servers: the agent can listen without replying.
  
  - **Reply modes.** Agent definitions take `replyMode: 'auto' | 'always' | 'when-addressed' | 'agent-decides'` (default `'auto'`: always when the agent has one member, agent decides when it has several, from the first message of every conversation), validated by `defineAgent`. Each conversation can override it (`PATCH /v1/threads/:id { replyMode }`, `'inherit'` by default); threads are listed with `replyMode`, `replyModeInEffect` and `members`. A mention (`@Name` or the agent's name) always gets a reply.
  - **Listening turns.** `openAgentHost(definition, { listening: true })` gives the agent an application-owned `stay_silent` tool; a turn called with `replyMode` (and `addressed`) tells the agent, in a short system note, whether it must reply. In modes other than `'always'` it may end the turn without a reply: the result has no text and `providerMetadata.letta.listened` (with its private `reason`). The tool refuses when a reply is needed. `projectHistory(..., { listening: true })` marks listened turns with a `data-listened` part and keeps reasoning the backend recorded. New exports: `resolveReplyMode`, `mentionsAgent`, `turnNote`, `combinedText`, `staySilentTool`, `STAY_SILENT_TOOL`, `LISTENED_PART` and the `ai-sdk-letta/listening` subpath (browser-safe helpers). The tool name `stay_silent` is reserved.
  - **Queued messages are sent together** for agents with several members: one turn ("[Mia] … / [Otto] …", `speakers` in `LettaCallOptions`), each message keeping its own author and bubble. Withdrawal works until the turn is sent (`already_sent` afterwards); delivery stays exactly once and is never replayed.
  - **Typing presence.** `POST /v1/threads/:id/typing` (`{ typing: boolean }` only, never text); threads list who is typing; it expires about 5 seconds after the last signal and on send, lives in memory only, and never reaches the agent.
  - The browser app shows a quiet, collapsed "Listened" line (click to see the agent's note, thoughts and tool calls; no bubble, no unread badge), an ear button with the reply mode and a "Show 'Listened' lines" toggle, `@` suggestions for the agent's name, "Mia is typing…" above the composer, and "sent together" in the queue.
  - The Letta SDK's per-turn timeout (`appServer.requestTimeoutMs`, one wall-clock timer per turn that human waits do not pause) is raised from 3 to 10 minutes (`TURN_TIMEOUT_MS`), so an approval or `ask_user` question answered within the promised four minutes no longer fails the turn after 180 seconds. Setup and status requests keep explicit 60-second timeouts.
  - Avatar initials use letters and digits only ("Mia (simulated)" → "MS"), falling back to the login's first letter, then "?".

## 0.6.0

### Minor Changes

- a2b6534: Share agents with a team over Tailscale. `startTeamServer` serves several agents behind `tailscale serve`: people are identified by Tailscale (headers trusted on loopback only), each agent has members and admins (`TeamDirectory`), everything inside an agent is shared by its members, conversations run turns in parallel and a busy conversation queues messages visibly, every user turn shows its author and the agent is told who is speaking, and only a turn's author or an admin can answer its approvals and questions. The browser app gains an agent switcher, a members dialog, authors, a queue and a "no access" page. In `ai-sdk-letta`, `openAgentHost` opens several conversations of one agent at once, and `LettaAgent` calls accept `otid` and `speaker`; display history carries each user turn's `otid`. Single-user mode is unchanged.

## 0.5.2

### Patch Changes

- 4842fe2: Renaming a conversation's folder in the Resources panel now renames the conversation too (it already worked the other way round). The title becomes the name as typed (also when the folder gets a file-system-safe spelling of it), unless the title already shows that text, in which case its Markdown is kept. Moves that keep the name, renames of other folders and folder renames by the agent in the sandbox leave the title unchanged. The title change is metadata only: it never renames the folder back, and a uniqueness suffix ("Trip (2)") never enters the title. `POST /v1/resources/move` returns the renamed `thread` (as listed) in that case, so the sidebar and header update at once. `titleFromFolderName()` is exported.

## 0.5.1

### Patch Changes

- fddde18: The browser app shows the installed versions under "About this space" ("ai-sdk-letta 0.5.1 · server 0.5.1 · Letta SDK 0.8.22"), as selectable text with a copy button for bug reports. The server reads them once at startup from the `package.json` of the packages it actually resolves (npm install or source checkout) and returns them in `GET /api/session` as `versions: { aiSdkLetta, server, lettaSdk }` (`null` when one cannot be read); `runtimeVersions()` is exported.

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
