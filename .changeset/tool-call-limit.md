---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Tool calls per turn: the bridge's hidden limit of 100 counted calls was per session (it never reset between turns, so a long conversation was refused with `duplicate_or_limit`). It is now per turn and configurable: `toolCallLimit` in a definition (10–1000, default 100; `TOOL_CALL_LIMITS`, `toolCallLimitOf`), `OpenAgentOptions.toolCallLimit` (read at each turn's first call) and per agent in the app (Settings → Tools; `GET`/`PUT /api/tool-limit`, `/api/adoption/agents/:id/tool-limit`; `DefinitionToolLimit`). At the limit the turn asks the person "Allow N more" (repeatable) or "Stop here" (`CALL_LIMIT_PROMPT`); stopping, or an unattended turn, refuses further calls with `call_limit_reached` and tells the agent to summarize what is left.
