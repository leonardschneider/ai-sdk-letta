---
"@ai-sdk-letta/server": patch
---

Document browser support for the GUI. The browser app, including the web development Preview pane and MCP App views, is verified in Safari 26.5 and Chrome 154, and in Firefox 142 for the main paths. Covered: HMR through the preview listener, the sandbox proxy handshake, inline, panel, full screen and picture-in-picture views, tool calls through the gate, and isolation that matches across browsers. The README gains a "Browser support" section. It covers the `*.localhost` origins and the known differences: Safari compiles WebAssembly in MCP App views where Chrome refuses, and storage in frames is partitioned. The agent's `browser_*` tools always use the container's headless Chromium. Nothing in the code changes.
