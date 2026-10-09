---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

MCP Apps: fewer approval prompts. Calls from a dev app's views (the agent's own code, in its own container without network) now run without asking, audited as before; the Apps dialog has a per-conversation toggle to ask again (`McpApps.setDevViewsAsk`, `PATCH /v1/apps/:app/dev`). Approval cards of installed apps offer "Allow always" (this tool) and "Allow all from this app" (every tool that asks) to admins: `decide(…, { approved: true, always: 'tool' | 'app' })`. Grants are kept in the apps' settings file, listed in the Apps dialog with a Reset (`POST /v1/apps/:app/grants/reset`), never loosen a tool the definition denies, and never apply to the agent's own calls. `ui/message` and model-context consent still ask.
