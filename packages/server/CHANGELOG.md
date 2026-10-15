# @ai-sdk-letta/server

## 0.24.0

### Minor Changes

- 5e403b3: Activity view: see at a glance whether an agent is idle, working or waiting for you. The conversation header (always visible, also with the sidebar hidden or on a phone) shows a status pill: "Idle", "Working · 2" (pulsing) or "Needs you · 1" (amber), with a marker when another agent is busy. It opens a popover (a bottom sheet on phones) with running turns and their current step, queued messages, prompts, decisions, memory reviews and app approvals waiting for you, services (the services container with its idle countdown, the dev server, the headless browser, dev and installed apps), Jiminy reviews, dreaming and scheduled tasks — each with its elapsed time, a link to its conversation, and Stop / Restart where the app already could. The agent switcher marks busy agents, and the sidebar shows a spinner on conversations with a running turn for every agent. New routes: `GET /v1/activity` (per agent, also `/api/agents/:id/v1/activity`), `GET /api/activity?since=` (counts per agent, long poll on the change channel; no Letta call) and `POST /v1/threads/:id/preview/stop-dev-server`. `WebDevStatus` gains `idleStopsAt` and `browser`; `WebDevRegistry.conversations()` and `MemoryGuard.reviewing()` are new.
- cac8315: Agent settings page: clicking an agent in the Agents section, or its name in the breadcrumb (`agent > Settings`), opens its settings in the main area in place of the conversation (`#/agents/<id>/settings`, so a reload keeps it; "Back to conversation", Escape or picking a conversation closes it, "Open chat" opens the agent's chat). One scrollable page with a table of contents (stacked on phones): **General** (name, model and reasoning, changed inline for adopted agents or "Set in code" for the app's own agent, View only), **Tools** (tool sets, project folder, command time limit), **Instructions** (status, Preview diff, Apply, Revert), **Apps** (status, Restart, Stop, Logs, "Allow always" grants and Reset, the dev-app "without asking" toggle), **Memory** (reviewer model, review history), **Automations** (tokens), **Members** (team admins) and **Danger zone** (Remove from app); sections that don't apply to the agent are hidden. The dialogs are now thin wrappers around the same panels and stay reachable from the sidebar footer and the ⋯ menu, which gains "Settings". Single-agent setups get a Settings row in the sidebar footer.
- 086106b: Stopped MCP Apps restart easily. Dev apps keep their spec when their services container stops after its idle timeout, and across server restarts (`dev-apps.json`). Opening a view or calling a tool restarts them by themselves; failed apps show why, with Restart and Logs. New routes: `POST /v1/threads/:id/apps/:app/restart`, `GET /v1/threads/:id/apps/:app/logs`, `POST /v1/apps/:app/restart|stop`, `GET /v1/apps/:app/logs`, and a view heartbeat that keeps the container running while a view is on screen. The Apps dialog shows each app's status with Restart, Stop and Logs.
- 86cc75f: Adopted agents' app instructions update automatically. Once the person applied the app's section, the server keeps it current: at start, after a tools, project, sandbox or model change, when View only is turned off, and whenever the generated section differs from the one in Letta (compared by text). An update waits until the agent is idle (no turn running here, Letta Code not using it), one per agent (a newer one replaces it), and never interrupts a turn. A manual Apply while the agent replies now answers `{ queued: true }` instead of `runtime_busy`. Only the text between the markers changes (`instructionsUpdate` now replaces an existing section in place; new `instructionsSectionOf`). Revert turns automatic updates off (`autoUpdate: false` on the record) until the next Apply. View-only agents are never updated. Each automatic update is recorded (`instructions.auto`: time, reason, diff) and announced: `GET /api/adoption/notices?since=` (a long poll, `AdoptionRegistryOptions.onNotice`) feeds a toast such as "Updated chess's app instructions (tools changed)", and the settings page shows "Updated automatically · time · reason" with the diff.
- de6413a: The browser app reloads itself after an update. New `GET /build.json` (single-user and team apps; outside the session check) returns an opaque build ID that changes when the server restarts or the web app's `index.html` changes (`buildIdRoute`). The app polls it every 15 s and on tab focus, and reloads when it changes: at once in a hidden or idle tab, never while you type in the composer or with a dialog or menu open; an unsent message is kept across the reload. A tab opened while the server was down reloads once it answers.
- e6245d6: Background commands. `run_command` accepts `background: true` (and `notify: false`): the command starts detached in the conversation's sandbox, marked with `AI_SDK_LETTA_BACKGROUND=1` so the cleanup after other commands (`KILL_SCRIPT`) spares it, with its output in `/workspace/.jobs/<id>/{out,err}` (not versioned), a heartbeat, and a wall-clock limit (`sandbox.backgroundTimeoutMs`, 6 hours by default, at most 48). The call returns at once with `{ jobId, note }`; its live command card starts right away and keeps updating after the turn, read from the files on the host. New tools, allowed by default in `SANDBOX_TOOL_PERMISSIONS`: `command_status`, `command_output` (bounded tail) and `command_stop`. The sandbox is never idle-stopped while one runs (the idle timer resumes after), and a session that closes keeps it until they end. After a restart, commands whose sandbox is gone are marked `interrupted`; running ones are followed again and get their card back. The server sends the agent one notification turn when a command ends ("[Background command finished] `python play.py` · exit 0 · 14 min · last lines: …", with a reminder to check and report), through the normal queue like decision outcomes: never behind an uncertain turn, never twice (its run ID derives from the command), not for `notify: false` or the agent's own `command_stop`. The app shows it as a compact line; cards and the Activity view have a Stop button for running background commands (`POST /v1/threads/:id/jobs/:job/stop`). `run_command`'s description and `JOBS_NOTE` tell the agent to use `background: true` for anything longer than a few minutes and not to poll. New exports: `BackgroundCommands`, `backgroundCommandsAt`, `backgroundScript`, `backgroundNotice`, `backgroundRunId`, `BACKGROUND_LIMITS`, `BACKGROUND_MARK`, `BACKGROUND_NOTE`, and in the server `BackgroundNotifier`, `RunBackground`.
- 3ae0d82: Live output and progress of long commands. When a `run_command` or `run_command_online` call runs longer than about 3 s in a turn with jobs, it gets an automatic job card (`kind: "command"`, goal `$ <command>`): its output is read from the sandbox every second (a separate `exec` on the same container reads the command's capture files, so it works with Docker, Apple Container and any session that allows concurrent runs), the latest lines become the log, and progress is parsed from tqdm bars (`45%|████▌ | 9/20 [00:12<00:15, 1.35it/s]`, with rate and ETA), `N/M`, pip downloads and `NN%`, handling `\r` redraws. The card ends with the command: done on exit code 0, failed with the exit code, or timed out. No card is made for quick commands, or when the agent is already reporting its own job. What the model gets is unchanged. New exports: `commandJob`, `parseProgressLine`, `visibleLine`, `OutputLines`, `commandGoal`, `pollScript`, `parsePollOutput`, `pollCommandOutput`, `COMMAND_PROGRESS`; `runSandboxCommand` and `SandboxManager.run` accept `onOutput` and `polling`. `JobDesk` gains an optional `agentJobActive(conversationId)`; `job_update` requests may carry `ratePerSecond` and `etaSeconds` (the reported values win over the measured ones). The app shows the card in place of the command's line, with the command and its output one click away.
- 9e8b922: Inner voices, Ambition and Prudence (piece 1: on demand). Two optional advisory voices per agent, in the spirit of Jiminy and mirror images of each other: Ambition (confident, daring, wants success and recognition; looks for the upside, bigger goals, finishing and publishing) and Prudence (critical, wants to avoid mistakes and shame; sees weak evidence and risks, wants checks and smaller steps). Each states the other's legitimate point. They have no tools, give advice only and treat everything they read as untrusted data. `ai-sdk-letta` adds `counsel()` (both voices in parallel, 60 s each, one failing never fails the other), `lettaVoice` (a fresh hidden, tool-less, memory-less temporary agent per call, swept by `sweepVoices`), `AMBITION_PERSONA`, `PRUDENCE_PERSONA`, `VOICE_NOTE_SCHEMA` (`{ points[1..4], confidence, suggestion?, disagreeWorthDeciding? }`) and `counselReminder`. Jiminy and the voices now share `temporary-advisor.ts` (`askTemporaryAdvisor`, `chooseReviewerModel`); Jiminy behaves as before. Server: `POST /v1/threads/:id/runs/:runId/counsel` asks the voices about a finished turn (the message, the reply and a bounded tool summary), stores the notes with the run (`run.counsel`), returns them in the thread's view (`counsels`), and gives them to the agent once, as a labelled reminder in its next turn. Settings per agent (off by default; model `auto` picks another family than the agent's): `GET`/`PUT /api/adoption/agents/:id/voices` (stored in the adoption record) and `GET`/`PUT /api/voices` for the app's own agent (`<state>/server/<id>/voices.json`). Web: "Ask Ambition & Prudence" under finished replies when a voice is on; a collapsed "Ambition & Prudence weighed in ›" line opens both notes side by side (amber and blue; stacked on phones); a new "Inner voices" section in the agent settings.
- 2987f60: Jobs: visible background work. New job tools (`jobTools`, all `allow`): `job_start({ goal, total?, unit? })` returns `{ jobId }`, `job_update({ jobId, done?, total?, message?, image? })` and `job_end({ jobId, result?, status? })` answer a tiny `{ ok: true }`, so updates cost almost no tokens. The image is a PNG, JPEG, WebP or SVG file under `/workspace`, `/project` or the conversation folder (checked by content, symlinks never leave the roots, at most 5 MB, read again on each update) or a small data URL. Adopted agents get the new `jobs` tool set by default, and agents with the tools get a short `JOBS_NOTE` in their instructions. The server keeps each agent's jobs (`JobBoard`, `<dir>/jobs.json`): updates are throttled to about 4 per second (the latest wins, log lines accumulate, the last 50 are kept), jobs may outlive their turn, and running jobs become "interrupted" on a restart. Live `job` events reach the run stream (display only, never recorded). New routes: `GET /v1/threads/:id/jobs` and `GET /v1/threads/:id/jobs/:job/image` (an image only: no-store, a sandbox CSP). `/v1/activity` gains a "Jobs" group with the goal, the latest log line, the progress and the elapsed time. The app shows a live job card where `job_start` was called: the goal, a progress bar ("9/20 games · 45% · 3.1/min · ETA 4 min"), the latest log line with an expandable tail, the live image (click to enlarge) and the status (running, done, failed, interrupted); the `job_*` tool lines are hidden, and the Activity popover lists running jobs with their bar.
- ab61661: Per-tool control. Adopted agents get per-tool overrides on top of their tool sets (`AdoptionRecord.toolOverrides`: `allow`, `ask` or `off`; off leaves the tool out, also from the instructions section). `LOCKED_PERMISSIONS` holds the safety rules shared by `defineAgent` and overrides: `run_command_online`, `allow_web_origin` and `web_search` are never `allow`; `request_decision` and `ask_user` never `ask`. A set's anchor tool (`read_file`, `run_command`, `dev_server_start`, `app_dev_start`, `job_start`) cannot be turned off alone. New `GET /api/adoption/agents/<id>/tools` lists each set's tools with their default, override, lock (with the reason) and a context cost estimate (description + JSON schema characters / 4); `PUT` accepts `{ tools, overrides }` (unknown tools dropped; `tool_locked`, `invalid_input`) and, during a reply, applies after it. The app's own (code-defined) agent is **tighten only**: Settings → Tools switches its tools to Ask or Off (Allow only where the definition allows it), stored in `<state>/server/<id>/tool-overrides.json` and applied on its next session (`GET`/`PUT /api/tools`). The Tools panel shows each set with its cost, expands to Allow / Ask / Off per tool (default dot, lock and reason), resets per set and overall, and the total tool context cost.
- 6a70adb: Remote access to the single-user app from your other devices through `tailscale serve`: `startGuiServer(..., { remote: { owners, origins } })` (`--remote --owner --origin` in the example). Requests for a served origin are accepted only from loopback with the owner's `Tailscale-User-Login` (never Funnel); the session cookie is Secure and writes need that origin plus the CSRF token. Local access is unchanged. `checkRemote`, `RemoteAccess`. MCP App views and web previews are not available remotely yet.
- b2cd67f: Sidebar navigation for several agents (adopted agents, team servers): an accordion with a **Conversations** section, where every agent's conversations are grouped by time (Today, Yesterday, Previous 7 days, Older) and then by agent (a small muted sub-heading, agents ordered by their most recent conversation), and an **Agents** section (collapsed by default) listing each agent with its model and a status dot, a ⋯ menu with its settings (Model…, Tools…, Project folder…, Update instructions…, View only, Remove from app; Members… on team servers) and "Add agent…". Search covers all agents; opening another agent's conversation switches to that agent and opens it. "New chat" starts with the current agent, with a chevron to pick another. The header shows a breadcrumb, `agent > conversation` (the agent opens its menu; only the title on phones). The sidebar title is now the app's name, replacing the agent switcher. Single-agent setups keep the simple sidebar.
- 920e6bf: Tool calls per turn: the bridge's hidden limit of 100 counted calls was per session (it never reset between turns, so a long conversation was refused with `duplicate_or_limit`). It is now per turn and configurable: `toolCallLimit` in a definition (10–1000, default 100; `TOOL_CALL_LIMITS`, `toolCallLimitOf`), `OpenAgentOptions.toolCallLimit` (read at each turn's first call) and per agent in the app (Settings → Tools; `GET`/`PUT /api/tool-limit`, `/api/adoption/agents/:id/tool-limit`; `DefinitionToolLimit`). At the limit the turn asks the person "Allow N more" (repeatable) or "Stop here" (`CALL_LIMIT_PROMPT`); stopping, or an unattended turn, refuses further calls with `call_limit_reached` and tells the agent to summarize what is left.
- c409562: Ambition and Prudence now speak on their own: when at least one voice is on, they weigh in on every completed reply in the background (never on failed, stopped or listened turns; once per run). The app shows "Ambition & Prudence are thinking…", then the collapsed notes with "Ask again". The next turn waits up to 10 s for notes still being written, then proceeds without them (late notes are shown but never injected). New setting "Speak after: every reply / only long turns" (a tool call, or 30 s or more); `GET /v1/threads/:id/counsels`.
- f41a6c1: Inner voices: the agent consults them mid-turn, and skips them only when the person's minimum allows. The `inner_voices` mode tool is replaced by the always-allowed `consult_voices({ question, context?, mode?, voices? })` (`consultVoicesTool`, `CONSULT_VOICES_TOOL`): the agent chooses when, its question and the facts the voices see, the stance (clamped to the person's minimum and maximum) and which voice (both by default); the notes come back as the tool result and the turn continues (at most `CONSULT_LIMITS.perTurn` = 8 a turn). Skipping is a separate, voluntary per-turn tool, `skip_voices({ reason })` (`skipVoicesTool`, `SKIP_VOICES_TOOL`), offered only when the minimum allows it: `none` (any turn, the default) or `calibrated_if_tools` (a turn without other tools); `calibrated`/`debate` never (`skippable`, `maySkip`). The agent's note depends on the minimum (`voicesNote`). A turn that neither consulted them (no consultation brought a note; `consultedVoices`) nor validly skipped is reviewed at its end in the minimum's stance (`floorMode`). Settings are now `{ ambition, prudence, minimum, maximum, maxRevisions }`; earlier `decides` and `defaultMode` are accepted and dropped, and `speakAfter: 'long'` becomes minimum `calibrated_if_tools`. `OpenAgentOptions.innerVoices` now returns a `VoiceConsultant`; `ThreadRuntime.innerVoicesBounds()` is replaced by `voiceConsultant()`; `RuntimeVoices.ask` takes an optional voice list. Removed: `innerVoicesTool`, `clampVoiceChoice`, `parseInnerVoices`, `VOICE_CHOICES`, `minimumRank`, `INNER_VOICES_REASON_MAX` and their types. Fix: a reflection answering `KEEP.` (or `KEEP,`/`KEEP;`) followed by a rebuttal on the same line keeps the reply instead of showing that line as the revised reply; long one-line rebuttals are cut to 300 characters. The app shows each consultation as a collapsed "Asked Ambition & Prudence: <question>" line with both notes, and the settings drop "Who decides" and "Default mode" (Minimum now reads "None (agent may skip)", "If tools used", "Calibrated (never skip)", "Debate (never skip)").
- 28a528f: Inner voices: "Max consultations per turn" is now a setting (`maxConsults`, 1–100, default 30; was a hidden fixed limit of 8). Each `consult_voices` result says how many consultations are `left` of the turn's `of`; a refused call (`limit_reached`) carries the limit, and the agent's note states it (`voicesNote(minimum, maxConsults)`). `VoiceConsultant.maxConsults`, `maxConsultsOf`; `consultVoicesTool` now takes a per-turn counter (`{ count }`) instead of a `take()` callback; `CONSULT_LIMITS.perTurn` is the default (30) with `minPerTurn`/`maxPerTurn`.
- 1c7d602: Inner voices: revision rounds, a debate stance, and a per-turn mode the agent chooses within your bounds. A revision is reviewed again by both voices (independently) and the agent reflects again, up to `maxRevisions` (1–3, default 1); each round's hidden prompt has its own OTID (`<run>:reflect`, `:reflect2`, `:reflect3`) and history hides them all. `run.counsel.rounds` records each round's notes, outcome and the version it reviewed. New `debate` mode: Prudence prosecutes with specific, checkable objections only; Ambition defends (steelman, weak objections, how to strengthen); the agent may KEEP with a one-line rebuttal (`DEBATE_ADDENDA`, `voicePersona`, `rebuttalOf`). New always-allowed `inner_voices({ mode, reason })` tool (offered only with voices on and "Agent decides"): its last call sets the turn's mode, for that turn only, clamped to the person's minimum (`none`, `calibrated_if_tools`, `calibrated`, `debate`) and maximum (`calibrated`, `debate`); without a call the default mode applies (`VOICES_NOTE`, `clampVoiceChoice`, `innerVoicesTool`). Settings add `decides`, `defaultMode`, `minimum`, `maximum` and `maxRevisions` (validated: min ≤ max, default between); the old `speakAfter` migrates (`long` → minimum `calibrated_if_tools` + default `skip`; `every` → default `calibrated`). The app shows "Revised 2× after Ambition & Prudence", each round in the collapsed section, and the agent's choice ("Debate: …", "Skipped review: …").
- c1f108b: Inner voices reflect within the turn. When Ambition and Prudence are on, they now review the reply's draft before the turn ends (both in parallel, each on its own, 60 s; a failing voice is skipped), and the agent reflects on their notes in a second step of the same turn and Letta conversation: it answers `KEEP` or writes the complete revised reply (it may use tools first). The final reply is the revision or the draft; the voices never review the revision, and there is at most one reflection per turn. Stop and the turn limits apply across both steps; Stop during the review or the reflection keeps the draft. "Only long turns" still applies. The run records `counsel: { at, notes, outcome: 'kept' | 'revised' | 'skipped', draft? }`; events `reflecting` (`phase: 'review' | 'reflect'`) and `reflected`, and the reflection's events carry `phase: 'reflection'`; the activity step reads "Reflecting". The background counsel, the next-turn reminder and "Ask again" (`POST /v1/threads/:id/runs/:runId/counsel`) are removed. `ai-sdk-letta` replaces `counselReminder` with `reflectionPrompt` (a hidden `<system-reminder>`, sent with the OTID `<run id>:reflect`), and adds `keepsDraft` and `REFLECTION_PART`: history projection never shows that prompt as a user message and puts a `data-reflection` marker between the draft and the reflection (the server adds its outcome). Web: the draft streams as before, then "Ambition & Prudence are reviewing…" and "Reflecting…" under it; the final answer then replaces it in place, with a collapsed "Revised (or Kept) after Ambition & Prudence ›" line holding the draft, both notes and the reflection's tool lines. After a reload, history shows the same. Settings mention the extra reflection step.

### Patch Changes

- 2218484: The browser app no longer builds the hidden contents of collapsed tool lines (command, output, technical details) until you open them. A tool-heavy conversation went from ~18,000 to ~6,000 page elements; fixes Safari tabs growing to several GB and coming back blank.
- 86f7901: Claude models work with MCP App development: its tools are now named `app_dev_*` (was `mcp_app_*`), because Anthropic rejects every request with a tool whose name starts with `mcp_` ("Third-party apps now draw from your extra usage", HTTP 400). Why a turn failed is now logged (`[turn-failed] <agent> <thread> <code>: <error>`, with the HTTP status and the provider's message), kept on the run (`run.error`) and shown under the failed reply ("Details"). A turn Letta rejected before the model produced anything no longer locks the conversation: once Letta is idle, the turn is settled and the conversation stays usable.
- db2aba9: Resources no longer fail when an agent workspace holds more than 20,000 files: the files are still listed and versioning pauses (`ResourceStore.overLimit`, `overLimit` in the tree response, a note in the panel) until it is back under. Common generated folders and tool caches are never versioned (`.next`, `.nuxt`, `.svelte-kit`, `.output`, `.turbo`, `.parcel-cache`, `.vite`, `target`, `.lake`, `.tox`, `venv`, `.venv-*`).
- 9e20934: The browser app stays light in long conversations: while a reply streams it no longer redraws the whole conversation for every event (unchanged messages keep their identity; streamed text is drawn at most every 100 ms), and long conversations show their latest ~60 messages with "Show earlier messages" at the top. Fixes blank pages in Safari after a while (the tab ran out of memory).
- Updated dependencies [5e403b3]
- Updated dependencies [086106b]
- Updated dependencies [86cc75f]
- Updated dependencies [e6245d6]
- Updated dependencies [3ae0d82]
- Updated dependencies [9e8b922]
- Updated dependencies [2987f60]
- Updated dependencies [86f7901]
- Updated dependencies [4cb1bc1]
- Updated dependencies [ab61661]
- Updated dependencies [db2aba9]
- Updated dependencies [920e6bf]
- Updated dependencies [c409562]
- Updated dependencies [f41a6c1]
- Updated dependencies [cd3cc1c]
- Updated dependencies [28a528f]
- Updated dependencies [1c7d602]
- Updated dependencies [c1f108b]
  - ai-sdk-letta@0.24.0

## 0.23.0

### Minor Changes

- c10b373: MCP App state persistence. App servers get a `STATE_DIR` that survives restarts: `/workspace/.app-state/<name>` for dev apps (shown by `mcp_app_dev_start`), and for installed apps a host folder `<state>/mcp-apps/<definition>/state/<app>` mounted read-write at `/state` (kept across upgrades and removal). Views can save their own state with the `ui/state/save` host extension (`io.ai-sdk-letta/viewState`, advertised under `experimental` in the host capabilities): kept per app and call in `view-state.json` (64 KB, 10 saves/s), given back in the host context on `ui/initialize`, inherited by later calls of the same view in the conversation, and never shown to the agent. `mcp_app_guide` covers both.

### Patch Changes

- 87ddaa6: MCP Apps: a dev app's views send messages and context updates to the agent without asking (audited, like their tool calls) unless asking was turned back on for the conversation. Installed apps' message and context cards offer "Allow always" (admins), kept across restarts, listed with a Reset in the Apps dialog; "Allow all from this app" covers them too.
- 2bed40f: App views in the panel or full screen no longer stick on "No view for this call" when they follow a new call that is still streaming (they ask again until it is recorded, and again when the call finishes). Messages an app's view sends show as one compact line ("chessos: I played e2e4.") with the full text on demand; the MCP App guide asks for short, human `ui/message` text.
- d0c798a: The browser app no longer goes blank: a message that changed kind while shown (a live turn becoming its history record, as after a message from an app's view) rendered a different number of hooks and unmounted the whole page. Each message kind is now its own component. Error boundaries now keep any render error local: an app view, a side-panel tab, a message or one part of a reply shows an inline error card with Try again, and an error that reaches the top shows a small "Something went wrong" panel (Try again, Reload, details) instead of a blank page. Caught errors go to the console and, rate limited, to the server's log (`POST /api/client-errors`, same session and CSRF checks as the other routes).
- Updated dependencies [87ddaa6]
- Updated dependencies [2bed40f]
- Updated dependencies [7097c4b]
- Updated dependencies [c10b373]
  - ai-sdk-letta@0.23.0

## 0.22.0

### Minor Changes

- 12403e7: MCP Apps: fewer approval prompts. Calls from a dev app's views (the agent's own code, in its own container without network) now run without asking, audited as before; the Apps dialog has a per-conversation toggle to ask again (`McpApps.setDevViewsAsk`, `PATCH /v1/apps/:app/dev`). Approval cards of installed apps offer "Allow always" (this tool) and "Allow all from this app" (every tool that asks) to admins: `decide(…, { approved: true, always: 'tool' | 'app' })`. Grants are kept in the apps' settings file, listed in the Apps dialog with a Reset (`POST /v1/apps/:app/grants/reset`), never loosen a tool the definition denies, and never apply to the agent's own calls. `ui/message` and model-context consent still ask.

### Patch Changes

- 6411b50: MCP App views in the GUI: one live view per app view by default (earlier calls collapse to "Show this one"; a view open in the panel, full screen or picture-in-picture follows the newest call), with a per-app setting in Apps. Inline views no longer jitter: view heights are damped (±2px, oscillation hold, one update per frame), and a call finishing no longer reloads its view. `viewTools` now includes each tool's `resourceUri`.
- Updated dependencies [12403e7]
- Updated dependencies [6411b50]
  - ai-sdk-letta@0.22.0

## 0.21.1

### Patch Changes

- c61457d: Tests only: the project listing test disables git's automatic background maintenance, which made its no-write check flaky in CI.
- ai-sdk-letta@0.21.1

## 0.21.0

### Minor Changes

- 8c3b3a0: Reasoning effort in the model picker. Each model lists its reasoning efforts (`efforts`, one per catalog tier, the default marked); `GET /api/adoption/agents/<id>/model` also returns the agent's current `effort` (read from Letta's `model_settings`, else the record), and `PUT` accepts `{ model, effort? }`: the effort is validated against that model's tiers (`effort_unknown`), the settings and context window come from the chosen tier, and the record keeps it (`AdoptionRecord.effort`). The same model and effort change nothing; another effort updates Letta and restarts the runtime. New exports: `effortOf`, `EFFORT_ORDER`, `EFFORT_VALUE`, `ModelEffort`. The app's **Model…** dialog gets a Reasoning choice and the agent menu shows the effort next to the model.

### Patch Changes

- Updated dependencies [8c3b3a0]
  - ai-sdk-letta@0.21.0

## 0.20.0

### Minor Changes

- 60d1926: Adopted agents can get web development and MCP App development. Two new tool sets, `web_dev` (`webDevTools`; needs `sandbox`) and `mcp_app_dev` (`mcpAppDevTools`; needs `web_dev`), are offered when the host sandbox is `docker` or `apple-container`, never by default. With `web_dev` the adopted sandbox uses `WEBDEV_IMAGE` unless the host names another image. New exports: `adoptedToolsRefusal`, `orderedAdoptedTools`, `webDevSandbox`. The instructions section names `web_dev_guide` / `mcp_app_guide` when those tools are on. `startGuiServer` gives each adopted agent its own `WebDevRegistry` and `McpApps` + `AppGate` (closed when it is removed or its tools change), resolves preview and view tokens across all runtimes on the shared preview listener, and starts that listener whenever adopted agents may get web development. `HostFactory` may return `close`, `webDev` and `apps`; the session reports `webDev` / `apps` for such adopted agents, and `adopted.available` lists the tool sets the host offers. The app gets a **Tools…** dialog for adopted agents (with dependent checkboxes) and labels for the new sets.
- c9cfa1c: Model picker for adopted agents. `GET /api/adoption/agents/<id>/model` lists the local Letta backend's models (provider labels: ChatGPT subscription, Claude subscription or Anthropic, OpenAI API, Google; cached for 5 minutes) and `PUT /api/adoption/agents/<id>/model` `{ model }` changes the agent's model in Letta with matching `model_settings` and context window, so Letta Code uses it too; refused with `runtime_busy`, `letta_code_active`, `view_only` or `model_unknown`. The runtime restarts so the next turn uses it. `AdoptionBackend` gains `setModel` and `models`; the agent info carries `model` (the definition's for the app's own agent). New exports: `localModels`, `modelOptions`, `modelSettings`, `providerLabel`, `anthropicOAuth`, `publicModel`, `MODEL_HANDLE`, `MODEL_CACHE_MS`. The app shows the model in the agent menu and adds **Model…**.
- c10a33a: View-only adopted agents, and live refresh of adopted agents' conversations. `AdoptionRecord.viewOnly` (set at adoption with `{ viewOnly: true }`, or with `PUT /api/adoption/agents/<id>/view-only`) lets the app show an agent that works in Letta Code: it may be adopted while Letta Code uses it, turning it off checks that again (`letta_code_active`), its API answers reads only (`403 view_only` otherwise, see `viewOnlyAllowed`), no session is opened, `adoptedDefinition` gives it no tools, sandbox or dreaming, and no containers or memory review are wired. `LiveConversations` watches the conversations being viewed in the Letta backend (`fs.watch` debounced, plus a poll) and new conversations of the agent, bumping the change channel through `ThreadRuntime.externalChange`; watchers stop when idle and on shutdown. New exports: `conversationDirectory`, `LiveConversations`, `LIVE_LIMITS`, `viewOnlyAllowed`, `VIEW_ONLY_READS`. The app gets a View only toggle in the agent menu and the Add agent picker, a banner instead of the message box, and a Live badge.

### Patch Changes

- Updated dependencies [60d1926]
- Updated dependencies [ede948e]
- Updated dependencies [c10a33a]
  - ai-sdk-letta@0.20.0

## 0.19.0

### Minor Changes

- 1219862: MCP Apps dev mode: the agent writes MCP Apps and tries them in the conversation. `mcpAppDevTools` (`mcp_app_guide`, `mcp_app_dev_start`, `_reload`, `_stop`, `_status`, `_logs`, `_call`, `_check`) run an MCP server the agent is writing as a dev app of its conversation, over stdio in the web development services container, with a contract linter. Its model-visible tools join the agent as `dev_<name>__<tool>` from the next turn (the session reopens when they change), its views render inline and in side panel tabs with a Dev badge, every call a view makes asks, and `mcp_app_dev_reload` re-renders open views live (`GET /v1/apps` carries `devGenerations`). `mcp_app_guide` is a short guide adapted from the ext-apps `create-mcp-app` skill (v2.0.3; Apache-2.0 code, CC-BY-4.0 docs). The browser app's side panel is now tabbed (Resources, Preview, one tab per app view). `examples/basic` enables it with `MCP_APP_DEV=1`.

### Patch Changes

- d500f85: Document browser support for the GUI. The browser app, including the web development Preview pane and MCP App views, is verified in Safari 26.5 and Chrome 154, and in Firefox 142 for the main paths. Covered: HMR through the preview listener, the sandbox proxy handshake, inline, panel, full screen and picture-in-picture views, tool calls through the gate, and isolation that matches across browsers. The README gains a "Browser support" section. It covers the `*.localhost` origins and the known differences: Safari compiles WebAssembly in MCP App views where Chrome refuses, and storage in frames is partitioned. The agent's `browser_*` tools always use the container's headless Chromium. Nothing in the code changes.
- Updated dependencies [1219862]
  - ai-sdk-letta@0.19.0

## 0.18.0

### Minor Changes

- 4e0dce7: MCP Apps (run mode): install MCP servers with interactive views from local packages or folders (`mcpApps` in a definition, `MCP_APPS` in the example). Each app's server runs in its own no-network container (`MCP_APPS_IMAGE`: Node and Python); its model-visible tools join the agent as `<app>__<tool>` (with this package's own visibility predicate: a missing visibility means model and app), the model sees `content` only, and calls with a view are recorded so views render again after a reload. In the single-user GUI, views render inline in the tool line, in a right panel, full screen or picture-in-picture, each on its own single-use `s-<token>.localhost` origin with a server-computed CSP; everything a view asks for goes through the server's gate (visibility, per-tool allow / ask / deny, out-of-turn approval cards, audit). `ui/message` asks and then arrives as a user message marked with an App badge; `ui/update-model-context` asks once per view and reaches the next turn as untrusted context. App content is a new `app` provenance source. Team servers refuse `mcpApps` for now.
- 836d3cc: The Resources panel shows the agent's project folder (the one mounted at `/project` in its sandbox) as a second section, **Project · <name>**, below the resources. It is read-only: folders are listed one at a time when opened (a page of 200 entries with "Show more"), `.git`, `node_modules` and what the project's `.gitignore` ignores are hidden (asked of git; outside a repository a default list applies), files preview and download like resources (same size limits and sandboxed previews), and a dot marks files git sees as changed. It refreshes when a turn ends. Nothing writes to the folder: git runs only read-only commands without optional locks, and there is no rename, move, delete or upload there. New routes `GET /v1/project/list`, `/v1/project/file` and `/v1/project/preview` sit behind the same session, CSRF and team membership checks; every path is resolved inside the project's real path and anything that resolves outside it (a `..`, a symlink pointing elsewhere) is refused. The session's agent info gains `project` (the folder's name).
- 8fe813f: Long turns work, and a stop or timeout no longer locks the conversation.
  
  - **Turn limits.** A turn is stopped after 10 minutes without progress (anything Letta streams; a running tool call counts as progress) or after 6 hours of work, and time waiting for a person (approvals, questions) counts toward neither. Set them per agent (`defineAgent({ turnLimits: { idleMs, maxMs } })`, `maxMs: 0` for no cap) or with `AI_SDK_LETTA_TURN_IDLE_MS` and `AI_SDK_LETTA_TURN_MAX_MS` (`AI_SDK_LETTA_TURN_DEADLINE_MS` still works, as the hard cap). The server's fixed 180-second work deadline is gone, and the Letta SDK's per-turn timer (`appServer.requestTimeoutMs`, one wall-clock timer per turn that nothing extends; it ended a 10-minute turn with `runtime_failed`) is set beyond any turn (`TURN_TIMEOUT_MS`); setup and status requests keep explicit 60-second timeouts.
  - **Stops are settled.** Stop, an abort signal, an unanswered prompt and a turn limit all cancel the backend run, wait until Letta reports no active run, and record the turn as settled (`<id>.<conversation>.turn.settled.json`, replacing the pending marker); reopening accepts a history that ends with that turn's unanswered message or interrupted tool. The server records such a turn with the new run status `stopped` (event `stopped`, `code` `cancelled`, `timed_out`, `idle_timeout` or `max_duration`) and treats it as usable everywhere (new turns, the queue, rewind, decision outcomes, automations). The app shows the partial reply as stopped and keeps the composer open. `LettaAgent.lastTurn()` reports `{ end: 'completed' | 'stopped' | 'failed', reason, delivered }`; `generate` rejects with `TurnLimitError` when a limit stopped it.
  - **Check and unlock.** Turns whose outcome is genuinely uncertain (a crash mid-turn, a connection failure, a stop Letta never confirmed) still lock the conversation, now with a **Check and unlock** action (`POST /v1/threads/<id>/check`, `AgentHost.check()`, `checkConversation()`): it asks Letta, read-only, whether a run is still active and whether the turn's message (its OTID) arrived, unlocks the conversation when nothing runs, and shows what Letta has. Nothing is ever replayed.
  - **Sandbox command timeout per agent.** `sandbox.timeoutMs` (default 120 s, at most 240 s) is documented for long builds, and added agents get their own (`PUT /api/adoption/agents/<id>/sandbox` `{ commandTimeoutMs }`, and a field in the Project folder dialog).

### Patch Changes

- bae8c04: Markdown file previews in the Resources panel render LaTeX maths, always on, as written for static sites and editors: `$$...$$` display (on one line or several), `$...$` inline (with Pandoc's guards, so "$5 and $10" stay prices), `\(...\)`, `\[...\]` and the Markdown-escaped `\\(...\\)` and `\\[...\\]` used by Hugo; in files that use the escaped form, `\\\\`, `\\,` and `\*` inside maths read as `\\`, `\,` and `*`, as the site's Markdown would have made them. Code is never touched and invalid TeX shows as an inline error. YAML (`---`) or TOML (`+++`) front matter at the top of a file shows as a muted metadata block instead of a rule and a paragraph. Replies keep their rules: only `\(...\)` and `\[...\]`, never `$`.
- Updated dependencies [4e0dce7]
- Updated dependencies [8fe813f]
  - ai-sdk-letta@0.18.0

## 0.17.0

### Minor Changes

- d61e973: Each adopted agent can have its own project folder, mounted read-write at `/project` in its sandbox: set it in the GUI (agent menu, **Project folder…**) or with `PUT /api/adoption/agents/<id>/project` `{ path | null }`. It is recorded in `adopted.json`, checked by the new `checkAdoptedProject` (absolute existing folder, not the home folder, `/` or `~/.letta`, no credentials in `.git/config`), and merged into the agent's sandbox by `adoptedDefinition`. The shell tools' descriptions and the "Update instructions" section tell the agent where the project is. Changing it restarts only that agent's runtime.

### Patch Changes

- Updated dependencies [d61e973]
  - ai-sdk-letta@0.17.0

## 0.16.1

### Patch Changes

- 661e49e: The Resources panel hides the folders of archived conversations by default; "Show archived (N)" at the bottom of the tree reveals them in a muted group (the choice is remembered), and restoring a conversation brings its folder back. Nothing moves on disk: git history, old file chips and the agent's access are unchanged. `GET /v1/resources` now also returns `archived`, the paths of those folders, and its `version` changes when a conversation is archived or restored.
- ai-sdk-letta@0.16.1

## 0.16.0

### Minor Changes

- e86206a: Open your existing local Letta agents in place. **Add agent…** in the single-user GUI (the agent name at the top of the sidebar) lists your local Letta agents (name, model, last activity, conversations; hidden, subagent, reflection and temporary agents excluded) and adds one by ID: the same agent, memory and conversations, nothing copied, never a new agent. Added agents are recorded in `<state>/adopted.json`, come back after a restart, and are switched with the same menu; **Remove from app…** forgets one without touching the Letta agent. Each gets the app's tools (files, decisions and questions by default; sandbox and web search when the server has them) with fail-closed permissions. Its conversations, `default` included, are listed with their summary or first message as title and read without opening a session; Letta Code's tool calls render as collapsed "Used <tool>" lines (`projectHistory` option `foreignTools`). Adding or sending is refused while a Letta Code session of the agent runs (`letta_code_active`, with a retry). Its system prompt, model and tags are not changed; **Update instructions…** shows a diff of the section it would append (tools here and the memory policy), applies it only on approval, and can revert it. Memory governance from adoption on: the older layout is protected (`system/**`), earlier history shows as "Before adoption", and commits of the agent's own Letta Code sessions show as "From Letta Code" and are never reverted (Jiminy only flags). The end-of-turn memory commit now commits only the files the turn changed, never edits that were already uncommitted (all agents). Core: `defineAgent({ adopt: { agentId } })`, `AdoptionStore`, `listAdoptableAgents`, `lettaCodeActivity`, `adoptedDefinition`, `peekConversation`, `forgetIdentity`. TUI: `--agent <id>` opens an agent added in the GUI.

### Patch Changes

- Updated dependencies [e86206a]
  - ai-sdk-letta@0.16.0

## 0.15.0

### Minor Changes

- f632dd9: Web app development with a live preview: `webDevTools` lets an agent run a dev server in its sandbox (`dev_server_start`/`stop`/`logs`, which name the folder they resolved), test the app with 23 `browser_*` tools from chrome-devtools-mcp 1.10.1 (including WebMCP; no file paths, uploads or heap snapshots), and read `web_dev_guide`. Each conversation gets a services container next to its sandbox (the new `WEBDEV_IMAGE`: Node 22, Chromium, chrome-devtools-mcp; no network, `--init`, idle timeout), reached only over `exec -i` stdio. The browser app shows the dev server in a Preview pane served from its own origin (`p-<token>.localhost`, a second loopback listener of the server, with credentials stripped and a strict preview CSP), with an address bar, reload, open in a new tab and a 390 px toggle. Outside origins are approved per conversation (`allow_web_origin`, always asks), pass a host-side proxy with web search's SSRF checks, and can be revoked from the pane. Browser and dev server output counts as untrusted (`browser` provenance source with the page URL) and can never be a trusted tool. Team servers do not serve previews yet.

### Patch Changes

- Updated dependencies [f632dd9]
  - ai-sdk-letta@0.15.0

## 0.14.0

### Minor Changes

- d1b8bd4: Claim confirmation. When a memory change relies on a statement it attributes to a person ("Bob from ops said …"), Jiminy lists it (`claims`) and the change is held until that person confirms it: they get a claim confirmation decision in their bell (Yes re-applies the change with `X-Confirmed-By`; No keeps it removed and notifies the requester and admins of an unconfirmed claim; Partly keeps it removed and sends their comment to the agent). Only the named member can confirm; admins may reject but never confirm for them. People are matched by display name, first name or Tailscale login and never guessed: outsiders and ambiguous names get an admin memory review ("cannot be verified"); claims about the requester need nothing. `matchClaimPerson`, `MemoryGuard.decideClaim` and the guard events `members`/`confirmClaims` are exported. Members may now switch their own conversation to Strict (trust mode); loosening it stays admin-only.
- 451dec0: Memory review settings and line drops. **Trust mode** (`memory.trustJiminy`, off by default; each conversation can override it from a shield button in its header, admins only on a team server): protected-file changes from a person's own attended turn are no longer refused up front when the person is not an admin or the turn read untrusted content; Jiminy reviews them and may keep them. Automations, scheduled tasks, anonymous turns, letter-case aliases of protected files, new root files from untrusted or unattended turns, dreams touching protected files and failed reviews stay deterministic. Provenance records it (`X-Trust-Mode`). **Automation memory floor**: each automation token sets where its runs' memory changes start after reading untrusted content (`accept`, `flag` (default) or `ask_human`), in the Automations dialog (create and edit) or `PATCH /tokens/:id`; Jiminy can only make it stricter. **Line drops**: Jiminy can keep a change and drop specific lines it added (`drop`, line ranges with their exact text), for dreams and for turns: a partial-revert commit after the merge, or the Letta harness's `approve_edits` before it (when the harness supports `merge: "client"`). Drops that do not apply exactly revert the whole change. The Memory view and the review card show the dropped lines. The reviewer model is documented as a per-agent setting (`memory.reviewer`). Merges with no net change are no longer reviewed.

### Patch Changes

- Updated dependencies [d1b8bd4]
- Updated dependencies [451dec0]
  - ai-sdk-letta@0.14.0

## 0.13.0

### Minor Changes

- d8442a1: Memory provenance and review (Jiminy). Every memory change is recorded with where it came from (who acted and their role, automation token or scheduled task, whether it ran unattended, and the untrusted content the turn read: web research, attachments, Jira or Confluence, tool output) in the memory ledger and git metadata (commit trailers, or a `refs/notes/provenance` note), never in memory files; the agent can read it with the new `memory_provenance` tool. Protected files (`persona.md`, `rules.md`, `goals.md`, `MEMORY.md`, `system/**` by default; `memory.protected` in the definition) change only in an admin's own turn with no untrusted content, under any letter case; a new root memory file is refused from untrusted or unattended turns; changes no turn made (dreams) are reverted from protected files at once. Jiminy, a temporary hidden tool-less reviewer agent (another model family than the agent's when one is connected; `memory.reviewer`), reviews every memory-changing turn and dream in the background and can only tighten the harness's decision: `reject` reverts the change, `ask_human` removes it until a person approves it in a new "Memory review" decision. Dreams keep merge mode `auto`; a Letta harness that can ask before merging a dream (merge mode `client`) is detected and used. `TurnActor` gets a `role`; team servers pass each author's role. The browser app gets a Memory view (reviews with provenance chips, diffs, the dream exposure window, refused writes, who wrote each part of a file, the reviewer model), memory review cards in the bell, toasts when a change is reverted, and provenance chips in the rewind confirmation. The web search summarizer (and the reviewer) now also delete the transcripts the Letta harness keeps for each temporary agent, and the crash sweep finds orphans by name and tag.

### Patch Changes

- Updated dependencies [d8442a1]
  - ai-sdk-letta@0.13.0

## 0.12.0

### Minor Changes

- 960c030: Rewind: edit one of your earlier messages in the browser app. The conversation continues from the edited message (the Letta conversation is forked just before it; the old one is archived for audit), and what the later turns changed in the agent's resources and memory is reverted as new git commits (history is never rewritten). A confirmation lists the turns removed, the files and memory reverted, files that can't be reverted cleanly because something else changed them later (kept as they are), changes that are kept (yours in the Resources panel, other conversations', dreaming), effects outside the app that can't be undone, and the decisions, web research reviews and scheduled tasks that are withdrawn. Solo conversations only (on a team server: ones only you wrote in). Crash-safe and idempotent; refused while a turn runs or waits.
  
  To make this precise, every turn is now sent with its run ID as the message's OTID, end-of-turn resources commits carry `X-Turn` and `X-Conversation` trailers (`X-Shared-Turns` when conversations ran at the same time), and the agent's uncommitted memory changes are committed at the end of each turn with the same trailers (`MemoryJournal`). New: `ThreadRuntime.rewindPreview()`, `rewind()` and `resumeRewinds()`; routes `GET /v1/threads/:id/rewind`, `POST /v1/threads/:id/rewind/preview` and `POST /v1/threads/:id/rewind`; the `rewindInternalTools` server option; `ResourceStore.planRewind()`, `applyRewind()` and `rebind()`; `ConversationSession.rewind` (fork, history records, memory journal). `beforeTurn`/`afterTurn` hooks of `LettaAgent` now receive the turn's OTID.
  
  New conversations are always named Letta conversations, never the agent's `default` one: a new agent's identity mapping records no conversation until the first is created (`namedOnly`), and opening it without a conversation creates a named one ("Conversation <date>"); the TUI's picker creates one on Enter and lists `default` only for agents of earlier versions. Existing mappings and threads that use `default` keep working unchanged, but cannot be rewound (`rewind_legacy_conversation`; Edit says "This older conversation can't be rewound"). Rewind forks with the SDK's `conversations.fork()` (named conversations only).

### Patch Changes

- Updated dependencies [960c030]
  - ai-sdk-letta@0.12.0

## 0.11.0

### Minor Changes

- ad1f04c: A web search review nobody answers in time becomes a decision instead of expiring: the result is kept on the server, the agent ends its turn, and the card (and the bell) keep it with Approve, Reject and Reject with note, without a time limit. Only the person whose turn searched, or an admin, may review it. The outcome reaches the agent once as a new turn: the result labelled as untrusted with its age, or that it was dismissed with the note. After `webSearch.staleAfterMs` (default 7 days) "Search again" asks the agent to search anew. Without a decision store (terminal UI, plain scripts) reviews still expire.
- 3415ba6: Web search reviews get their own per-agent time limit (`webSearch.reviewTimeoutMs` on the definition, 10–280 s, default 280 s: the Letta harness ends a tool call after 5 minutes) instead of the shared approval budget. An unanswered review expires cleanly ("Web research expired"): the agent gets none of the result and the conversation stays usable. Generic support: `PreparedCall.expires`, `InteractionRequest.expiresAt`, and the HTTP runtime waits for such prompts until they expire.
- cd9305c: Add web search with human review: `webSearchTools` (`web_search`) searches your own SearXNG (`SEARXNG_URL`), reads the best pages on the server with SSRF protection and Mozilla Readability, and has a tool-less, memory-less Letta sub-agent summarize them into validated, capped JSON (summary, claims with sources, relevance-filtered sources). A person reviews each result in the app (Approve, Reject, Reject with a note) before the agent sees it, labelled as untrusted web research; unattended runs fail with `approval_required` unless their token pre-approves `web_search`.

### Patch Changes

- Updated dependencies [ad1f04c]
- Updated dependencies [3415ba6]
- Updated dependencies [cd9305c]
  - ai-sdk-letta@0.11.0

## 0.10.0

### Minor Changes

- 3543033: Decisions: the agent can ask the people of a conversation to decide something, without holding the turn open. `request_decision` (with `cancel_decision`, opt-in through `decisionTools`) records a pending decision and pauses the work; every member of the agent sees it in the app (a notification bell and a card in the conversation) and any of them can decide once, or stop the work. The outcome resumes the work as a new turn of the conversation. Decisions survive restarts and are delivered exactly once. Automation runs that ask for a decision end as `decision_pending`, and `GET /v1/automation/decisions/<id>?wait=` waits for the outcome; the n8n node and the Conductor examples can wait through decisions.

### Patch Changes

- Updated dependencies [3543033]
  - ai-sdk-letta@0.10.0

## 0.9.0

### Minor Changes

- d56d2a2: Orchestration with n8n and Conductor OSS. The server can serve an automation API on its own loopback port (`automation: { port }`): per-trigger tokens (created and revoked by agent admins in the app's new Automations dialog, or from the command line; stored as SHA-256 hashes, shown once), each bound to one agent and the person it acts for, start turns in a named or new conversation with a required idempotency key, wait for them (long poll), and fetch the reply, tool outcomes and files created. Runs started this way are unattended: a tool that needs approval fails the run with `approval_required` and `ask_user` with `question_required`, naming the tool; the tool never runs and the conversation stays usable. A token can pre-approve specific `ask` tools; `deny` stays deny. Tokens are rate- and concurrency-limited, browsers are refused, and the API never listens on all interfaces. Such turns show a "via n8n" badge in the app. New `schedule_task` tool (opt-in, asks by default) lets the agent schedule a one-off task in the configured orchestrator (n8n through its public API, or Conductor's scheduler); the server keeps no timer of its own. Library: `LettaCallOptions.unattended`, `UnattendedPolicy`, `schedulingTools`, `resolveWhen`. Server: `AutomationService`, `automationApp`, `n8nOrchestrator`, `conductorOrchestrator`, `createAutomationToken`. Single-user runtimes now forget their oldest finished runs instead of refusing new turns after 200, and a conversation view waits briefly for another reader instead of answering `runtime_busy`. The browser app follows changes it did not make in single-user mode too (when automations are on), and hands a message back to the composer when the agent is busy.

### Patch Changes

- Updated dependencies [d56d2a2]
  - ai-sdk-letta@0.9.0

## 0.8.0

### Minor Changes

- a237997: Atlassian (Jira and Confluence Cloud) integration with each user's own API token. `atlassianTools` adds `atlassian_fetch` (save an issue or page into the conversation's folder as Markdown plus the original document), `atlassian_update` (write an edited `.md` back by block splice: unchanged blocks are kept verbatim, edits that would lose mentions, images, statuses, macros and similar are refused naming them, and stale versions are refused) and `atlassian_request` (the user's site's Jira and Confluence REST APIs only; reads run, changes ask with a readable preview). Credentials are stored per user on the server (0600) and never returned to the browser or given to the agent; tools act as the person whose message started the turn. Also new: `adfToMarkdown`, `markdownToAdf`, `spliceMarkdown` and `validateAdf`; tools can attach a per-call preparation (`withPreparation`) that answers early or requires approval with a preview; turns accept an `actor`; and the server serves `/api/integrations/atlassian` (connect, test, disconnect) and an Atlassian media proxy for previews. The browser app gets a Connect Atlassian dialog, approval cards that show the changed blocks, and `.adf.json` previews with Atlassian's renderer.

### Patch Changes

- Updated dependencies [a237997]
  - ai-sdk-letta@0.8.0

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

### Patch Changes

- Updated dependencies [4b571e0]
  - ai-sdk-letta@0.7.0

## 0.6.0

### Minor Changes

- a2b6534: Share agents with a team over Tailscale. `startTeamServer` serves several agents behind `tailscale serve`: people are identified by Tailscale (headers trusted on loopback only), each agent has members and admins (`TeamDirectory`), everything inside an agent is shared by its members, conversations run turns in parallel and a busy conversation queues messages visibly, every user turn shows its author and the agent is told who is speaking, and only a turn's author or an admin can answer its approvals and questions. The browser app gains an agent switcher, a members dialog, authors, a queue and a "no access" page. In `ai-sdk-letta`, `openAgentHost` opens several conversations of one agent at once, and `LettaAgent` calls accept `otid` and `speaker`; display history carries each user turn's `otid`. Single-user mode is unchanged.

### Patch Changes

- Updated dependencies [a2b6534]
  - ai-sdk-letta@0.6.0

## 0.5.2

### Patch Changes

- 4842fe2: Renaming a conversation's folder in the Resources panel now renames the conversation too (it already worked the other way round). The title becomes the name as typed (also when the folder gets a file-system-safe spelling of it), unless the title already shows that text, in which case its Markdown is kept. Moves that keep the name, renames of other folders and folder renames by the agent in the sandbox leave the title unchanged. The title change is metadata only: it never renames the folder back, and a uniqueness suffix ("Trip (2)") never enters the title. `POST /v1/resources/move` returns the renamed `thread` (as listed) in that case, so the sidebar and header update at once. `titleFromFolderName()` is exported.
- Updated dependencies [4842fe2]
  - ai-sdk-letta@0.5.2

## 0.5.1

### Patch Changes

- fddde18: The browser app shows the installed versions under "About this space" ("ai-sdk-letta 0.5.1 · server 0.5.1 · Letta SDK 0.8.22"), as selectable text with a copy button for bug reports. The server reads them once at startup from the `package.json` of the packages it actually resolves (npm install or source checkout) and returns them in `GET /api/session` as `versions: { aiSdkLetta, server, lettaSdk }` (`null` when one cannot be read); `runtimeVersions()` is exported.
- Updated dependencies [fddde18]
  - ai-sdk-letta@0.5.1

## 0.5.0

### Minor Changes

- a592457: LaTeX maths in the browser app. Replies render `\(...\)` (inline) and `\[...\]` (display) with KaTeX; `$` is never a delimiter, code is never touched, and invalid LaTeX shows its source as an error. Agent definitions take `ui: { latex: boolean }` (default `true`, validated by `defineAgent`; `DEFAULT_UI` and `AgentUiSettings` are exported). The server exposes it in `GET /api/session` and stores a per-conversation override: `PATCH /v1/threads/:id` accepts `latex: 'inherit' | 'on' | 'off'` and threads are listed with `latex` (older threads read as `'inherit'`). The GUI's CSP now states `font-src 'self'`: KaTeX's fonts are bundled with the app, never loaded from a CDN or as data: URLs.
- 6976703: Conversation names are inline Markdown: links, bold, italic and code. The browser app renders them in the sidebar and the header; links open in a new tab, only `http`, `https` and `mailto` links are active, bare URLs become links and long URLs are shortened in the sidebar, while clicking elsewhere on a row still opens the conversation. Rename edits the Markdown as written, search matches the text a name shows, and titles derived from the first message keep inline Markdown (a pasted URL stays a link). Resource folders are named after the text a title shows, never its syntax (`[Spec](https://x)` → "Spec"), and the TUI shows plain text. New: `parseTitle`, `titleText`, `safeLinkHref` and `shortUrl`, also importable without Node dependencies from `ai-sdk-letta/title`.

### Patch Changes

- Updated dependencies [a592457]
- Updated dependencies [6976703]
  - ai-sdk-letta@0.5.0

## 0.4.0

### Minor Changes

- bd25a23: Add resources: all of an agent's files in one git-backed folder (`<state>/resources/<agent ID>/`), one folder per conversation named after its title (renamed with the conversation, after the running turn if any), plus folders the user makes. Every user operation (upload, new folder, move, rename, delete, restore) is one commit, and what the agent changed during a turn is committed at the end of the turn; git runs with a fixed identity, without global or system config, under a lock. The file tools now default to the conversation's folder and reach every conversation's files with paths from the root (`/Other chat/data.csv`; `list_files` and `search_files` take a `folder`). The sandbox mounts the whole work tree at `/workspace` (never the git history) and starts commands in the conversation's folder; `.venv` is shared and not versioned. Files attached with 0.3 are moved into the resources automatically, once, and links in older messages keep resolving after moves. `ResourceStore` and `LettaRuntime.resources` expose the tree and its operations. The server adds `/v1/resources` routes (tree, upload, folders, move, delete, restore, history, download, and a sandboxed preview with a strict CSP), and file downloads follow files the user moved or renamed. `AttachmentStore` is now a view of a conversation's folder in the resources, and `store()` is async.

### Patch Changes

- Updated dependencies [bd25a23]
  - ai-sdk-letta@0.4.0

## 0.3.0

### Minor Changes

- 4403ef3: Add sandboxed shell commands. `sandboxTools` adds `run_command` (no network, allowed by default) and `run_command_online` (internet access, always asks), run through the AI SDK `Experimental_SandboxSession` in one isolated sandbox per conversation with the conversation's files at `/workspace`. Configure it with the definition's new `sandbox` option: `'apple-container'` (`@lgrammel/apple-container-sandbox` 1.1.0), `'docker'` (`ai-sdk-sandbox-docker` 0.1.2), both optional peer dependencies, or a custom factory. Commands get an empty environment, git without global config and a fixed identity, a timeout, abort on Stop, and capped output; pip packages persist in `/workspace/.venv`. Project folders whose git config holds credentials are refused. The tool bridge now passes the bound sandbox to tools as `experimental_sandbox` and supports per-tool timeouts.

### Patch Changes

- Updated dependencies [4403ef3]
  - ai-sdk-letta@0.3.0

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
