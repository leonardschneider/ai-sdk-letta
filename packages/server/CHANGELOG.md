# @ai-sdk-letta/server

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
