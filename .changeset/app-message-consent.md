---
"ai-sdk-letta": patch
"@ai-sdk-letta/server": patch
---

MCP Apps: a dev app's views send messages and context updates to the agent without asking (audited, like their tool calls) unless asking was turned back on for the conversation. Installed apps' message and context cards offer "Allow always" (admins), kept across restarts, listed with a Reset in the Apps dialog; "Allow all from this app" covers them too.
