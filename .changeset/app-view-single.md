---
"ai-sdk-letta": patch
"@ai-sdk-letta/server": patch
---

MCP App views in the GUI: one live view per app view by default (earlier calls collapse to "Show this one"; a view open in the panel, full screen or picture-in-picture follows the newest call), with a per-app setting in Apps. Inline views no longer jitter: view heights are damped (±2px, oscillation hold, one update per frame), and a call finishing no longer reloads its view. `viewTools` now includes each tool's `resourceUri`.
