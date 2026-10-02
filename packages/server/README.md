# @ai-sdk-letta/server

Local HTTP runtime for [ai-sdk-letta](https://github.com/leonardschneider/ai-sdk-letta/tree/main/packages/ai-sdk-letta) agents. Unofficial; not
affiliated with Letta or Vercel.

```sh
npm install @ai-sdk-letta/server ai-sdk-letta ai
```

- `ThreadRuntime`: durable threads and runs over one agent, NDJSON events,
  exactly-once answers, cancellation, rename and archive. A run interrupted by
  a restart blocks its thread instead of being replayed.
- `startGuiServer(definition, assetsDir, options)`: the loopback browser app
  (session cookie, CSRF, Origin and Host checks, strict CSP).
- `startApiServer(definition, options)`: the same routes behind a 256-bit
  bearer token and owner header, for server-to-server use.
- `startTeamServer(definitions, assetsDir, { owners, origins, port })`:
  several agents for a team behind `tailscale serve`. Identity from
  Tailscale's headers (trusted on loopback only), per-agent members and
  admins (`TeamDirectory`, `<state>/team/team.json`), conversations in
  parallel, a visible queue per conversation, and authors on every turn.
  Agent routes live under `/api/agents/<id>/...` and answer 404 to
  non-members; members are managed at `/api/agents/<id>/members` (admins
  only for changes); answering or stopping a turn needs its author or an
  admin (`not_your_turn`, 403). `GET /v1/changes?since=N` long-polls for
  changes made by others. `ThreadRuntime` takes `{ queue, parallel }` for this.
- Group conversations (team servers; `ThreadRuntime` option `replyMode`, the
  agent's setting, `agentName`, and `members`, how many people share the
  agent): each turn is sent with the reply mode in effect (`'always'`,
  `'when-addressed'`, `'agent-decides'`; the agent's `'auto'` is always with
  one member, agent decides with several) and whether it
  mentions the agent. The agent may listen without replying (the
  `stay_silent` tool): the run then has a `listened` event (`{ reason? }`)
  and `reasoning` events when the model shares them, and no text. Threads are
  listed with `replyMode` (the override, `'inherit'` by default),
  `replyModeInEffect`, `members` and `typing` (`[{ id, name }]`), and
  `PATCH /v1/threads/:id` accepts `replyMode`. Queued text messages of an
  agent with several members are sent together as one turn (the first
  run has `batch`, the others `batchOf`; each keeps its author in history);
  a queued message being sent can no longer be withdrawn (`already_sent`).
  `POST /v1/threads/:id/typing` takes exactly `{ typing: boolean }` (a
  heartbeat while typing; it expires after 5 s and on send); it is kept in
  memory only and never reaches the agent.

Routes (under `/api` for the GUI): `GET /v1/capabilities`, `GET|POST /v1/threads`,
`PATCH /v1/threads/:id`, `GET /v1/threads/:id/history`, `GET /v1/threads/:id/view`,
`POST /v1/runs`, `GET /v1/runs/:id/events?after=N` (NDJSON), `POST /v1/runs/:id/answer`,
`POST /v1/runs/:id/cancel`, and with the file tools `POST /v1/uploads`,
`GET /v1/threads/:id/files`, `GET /v1/threads/:id/files/:name`.

`PATCH /v1/threads/:id` takes any of `{ title, archived, latex }`: `title`
(1–120 characters), `archived` (boolean), and `latex`, the conversation's
override of the agent's `ui.latex` for the browser app: `'inherit'` (the
default, also for threads saved by earlier versions), `'on'` or `'off'`.
Threads are listed with `latex`; `GET /api/session` (GUI) returns the
agent's `ui: { latex }`. It returns the thread as listed.

`POST /v1/resources/move` takes `{ from, to }` (paths from the root) and
returns `{ path, from, commit? }`. Renaming a conversation's own folder
renames the conversation too (`titleFromFolderName`: the name as typed,
also when the folder got a file-system-safe spelling of it, or the title
unchanged when it already shows that text), and the
answer then also has `thread`, as listed. A move that keeps the name does
not; neither does a folder renamed by the agent in the sandbox.

`GET /api/session` also returns `versions: { aiSdkLetta, server, lettaSdk }`,
read once at startup from the `package.json` of the packages this server
actually resolves (an npm install or a source checkout alike; `null` when one
cannot be read), and shown under "About this space" in the browser app.
`runtimeVersions()` returns the same object.

`POST /v1/runs` takes `{ id, threadId, text, parentRunId, images? }`, where
`images` is a list of `{ mediaType, data }` (base64, no `data:` prefix).
Text may be empty when images are present. Images are validated against
`IMAGE_LIMITS` and rejected with a fixed code (`image_unsupported_type`,
`image_invalid`, `image_remote_url`: 400; `image_too_large`,
`images_too_many` (400), `images_too_large`: 413). Only this route accepts a
larger body (`RUN_BODY_LIMIT_BYTES`); others keep `BODY_LIMIT_BYTES` (24 KB)
and answer `payload_too_large` (413) beyond it. Runtime state stores each
image's type, size and SHA-256, never its bytes. An image may carry a
`name`; with the file tools it is also saved to the conversation's folder
under that name.

**Files** (when the definition includes `fileTools`). `POST /v1/uploads`
takes one file's raw bytes (`Content-Type: application/octet-stream`, the
URL-encoded name in `X-File-Name`), validates it (type by content, size,
PDF text) and stages it; it returns `{ id, name, kind, mediaType, label,
bytes, pages?, lines? }`. Only this route accepts raw bodies, up to
`UPLOAD_BODY_LIMIT_BYTES` (25 MB); at most three uploads are validated at
once (`uploads_busy`, 429). `POST /v1/runs` then takes `files: [id, ...]`
(up to 8): the staged files move into the conversation's folder and the
turn carries the "Attached: ..." note. Staged uploads expire after 24 hours.
`GET /v1/threads/:id/files` lists a conversation's files (archived threads
keep them); `GET /v1/threads/:id/files/:name` downloads one with
`Content-Disposition: attachment`, `nosniff`, `Cross-Origin-Resource-Policy:
same-origin` and a sandboxing CSP (text is served as `text/plain`). Errors
use fixed codes: `file_unsupported_type`, `file_invalid`, `file_name_invalid`
(400), `file_not_found`, `files_unavailable` (404), `files_too_many`,
`conversation_files_full` (409), `file_too_large`, `payload_too_large` (413).

`startGuiServer` serves a built browser app from the directory you pass. The
assistant-ui app in this repository (`apps/web`) is not on npm yet; build it
from a checkout.

License: Apache-2.0.
