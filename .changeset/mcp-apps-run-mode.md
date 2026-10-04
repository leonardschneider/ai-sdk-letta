---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

MCP Apps (run mode): install MCP servers with interactive views from local packages or folders (`mcpApps` in a definition, `MCP_APPS` in the example). Each app's server runs in its own no-network container (`MCP_APPS_IMAGE`: Node and Python); its model-visible tools join the agent as `<app>__<tool>` (with this package's own visibility predicate: a missing visibility means model and app), the model sees `content` only, and calls with a view are recorded so views render again after a reload. In the single-user GUI, views render inline in the tool line, in a right panel, full screen or picture-in-picture, each on its own single-use `s-<token>.localhost` origin with a server-computed CSP; everything a view asks for goes through the server's gate (visibility, per-tool allow / ask / deny, out-of-turn approval cards, audit). `ui/message` asks and then arrives as a user message marked with an App badge; `ui/update-model-context` asks once per view and reaches the next turn as untrusted context. App content is a new `app` provenance source. Team servers refuse `mcpApps` for now.
