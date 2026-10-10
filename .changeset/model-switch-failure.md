---
"ai-sdk-letta": patch
"@ai-sdk-letta/server": patch
---

Claude models work with MCP App development: its tools are now named `app_dev_*` (was `mcp_app_*`), because Anthropic rejects every request with a tool whose name starts with `mcp_` ("Third-party apps now draw from your extra usage", HTTP 400). Why a turn failed is now logged (`[turn-failed] <agent> <thread> <code>: <error>`, with the HTTP status and the provider's message), kept on the run (`run.error`) and shown under the failed reply ("Details"). A turn Letta rejected before the model produced anything no longer locks the conversation: once Letta is idle, the turn is settled and the conversation stays usable.
