---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

MCP Apps dev mode: the agent writes MCP Apps and tries them in the conversation. `mcpAppDevTools` (`mcp_app_guide`, `mcp_app_dev_start`, `_reload`, `_stop`, `_status`, `_logs`, `_call`, `_check`) run an MCP server the agent is writing as a dev app of its conversation, over stdio in the web development services container, with a contract linter. Its model-visible tools join the agent as `dev_<name>__<tool>` from the next turn (the session reopens when they change), its views render inline and in side panel tabs with a Dev badge, every call a view makes asks, and `mcp_app_dev_reload` re-renders open views live (`GET /v1/apps` carries `devGenerations`). `mcp_app_guide` is a short guide adapted from the ext-apps `create-mcp-app` skill (v2.0.3; Apache-2.0 code, CC-BY-4.0 docs). The browser app's side panel is now tabbed (Resources, Preview, one tab per app view). `examples/basic` enables it with `MCP_APP_DEV=1`.
