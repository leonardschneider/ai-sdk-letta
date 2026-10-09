---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Adopted agents can get web development and MCP App development. Two new tool sets, `web_dev` (`webDevTools`; needs `sandbox`) and `mcp_app_dev` (`mcpAppDevTools`; needs `web_dev`), are offered when the host sandbox is `docker` or `apple-container`, never by default. With `web_dev` the adopted sandbox uses `WEBDEV_IMAGE` unless the host names another image. New exports: `adoptedToolsRefusal`, `orderedAdoptedTools`, `webDevSandbox`. The instructions section names `web_dev_guide` / `mcp_app_guide` when those tools are on. `startGuiServer` gives each adopted agent its own `WebDevRegistry` and `McpApps` + `AppGate` (closed when it is removed or its tools change), resolves preview and view tokens across all runtimes on the shared preview listener, and starts that listener whenever adopted agents may get web development. `HostFactory` may return `close`, `webDev` and `apps`; the session reports `webDev` / `apps` for such adopted agents, and `adopted.available` lists the tool sets the host offers. The app gets a **Tools…** dialog for adopted agents (with dependent checkboxes) and labels for the new sets.
