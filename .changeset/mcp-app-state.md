---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

MCP App state persistence. App servers get a `STATE_DIR` that survives restarts: `/workspace/.app-state/<name>` for dev apps (shown by `mcp_app_dev_start`), and for installed apps a host folder `<state>/mcp-apps/<definition>/state/<app>` mounted read-write at `/state` (kept across upgrades and removal). Views can save their own state with the `ui/state/save` host extension (`io.ai-sdk-letta/viewState`, advertised under `experimental` in the host capabilities): kept per app and call in `view-state.json` (64 KB, 10 saves/s), given back in the host context on `ui/initialize`, inherited by later calls of the same view in the conversation, and never shown to the agent. `mcp_app_guide` covers both.
