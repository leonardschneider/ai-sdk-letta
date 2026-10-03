---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Web search reviews get their own per-agent time limit (`webSearch.reviewTimeoutMs` on the definition, 10–280 s, default 280 s: the Letta harness ends a tool call after 5 minutes) instead of the shared approval budget. An unanswered review expires cleanly ("Web research expired"): the agent gets none of the result and the conversation stays usable. Generic support: `PreparedCall.expires`, `InteractionRequest.expiresAt`, and the HTTP runtime waits for such prompts until they expire.
