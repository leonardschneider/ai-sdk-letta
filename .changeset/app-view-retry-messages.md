---
"@ai-sdk-letta/server": patch
"ai-sdk-letta": patch
---

App views in the panel or full screen no longer stick on "No view for this call" when they follow a new call that is still streaming (they ask again until it is recorded, and again when the call finishes). Messages an app's view sends show as one compact line ("chessos: I played e2e4.") with the full text on demand; the MCP App guide asks for short, human `ui/message` text.
