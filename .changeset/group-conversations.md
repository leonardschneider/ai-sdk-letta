---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Group conversations on team servers: the agent can listen without replying.

- **Reply modes.** Agent definitions take `replyMode: 'auto' | 'always' | 'when-addressed' | 'agent-decides'` (default `'auto'`: always while one person writes in a conversation, agent decides once several do), validated by `defineAgent`. Each conversation can override it (`PATCH /v1/threads/:id { replyMode }`, `'inherit'` by default); threads are listed with `replyMode`, `replyModeInEffect` and `participants`. A mention (`@Name` or the agent's name) always gets a reply.
- **Listening turns.** `openAgentHost(definition, { listening: true })` gives the agent an application-owned `stay_silent` tool; a turn called with `replyMode` (and `addressed`) tells the agent, in a short system note, whether it must reply. In modes other than `'always'` it may end the turn without a reply: the result has no text and `providerMetadata.letta.listened` (with its private `reason`). The tool refuses when a reply is needed. `projectHistory(..., { listening: true })` marks listened turns with a `data-listened` part and keeps reasoning the backend recorded. New exports: `resolveReplyMode`, `mentionsAgent`, `turnNote`, `combinedText`, `staySilentTool`, `STAY_SILENT_TOOL`, `LISTENED_PART` and the `ai-sdk-letta/listening` subpath (browser-safe helpers). The tool name `stay_silent` is reserved.
- **Queued messages are sent together** in conversations with several people: one turn ("[Mia] … / [Otto] …", `speakers` in `LettaCallOptions`), each message keeping its own author and bubble. Withdrawal works until the turn is sent (`already_sent` afterwards); delivery stays exactly once and is never replayed.
- **Typing presence.** `POST /v1/threads/:id/typing` (`{ typing: boolean }` only, never text); threads list who is typing; it expires about 5 seconds after the last signal and on send, lives in memory only, and never reaches the agent.
- The browser app shows a quiet, collapsed "Listened" line (click to see the agent's note, thoughts and tool calls; no bubble, no unread badge), an ear button with the reply mode and a "Show 'Listened' lines" toggle, `@` suggestions for the agent's name, "Mia is typing…" above the composer, and "sent together" in the queue.
