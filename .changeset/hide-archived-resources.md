---
"@ai-sdk-letta/server": patch
---

The Resources panel hides the folders of archived conversations by default; "Show archived (N)" at the bottom of the tree reveals them in a muted group (the choice is remembered), and restoring a conversation brings its folder back. Nothing moves on disk: git history, old file chips and the agent's access are unchanged. `GET /v1/resources` now also returns `archived`, the paths of those folders, and its `version` changes when a conversation is archived or restored.
