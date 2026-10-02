---
"ai-sdk-letta": patch
"@ai-sdk-letta/server": patch
---

Renaming a conversation's folder in the Resources panel now renames the conversation too (it already worked the other way round). The title becomes the name as typed (also when the folder gets a file-system-safe spelling of it), unless the title already shows that text, in which case its Markdown is kept. Moves that keep the name, renames of other folders and folder renames by the agent in the sandbox leave the title unchanged. The title change is metadata only: it never renames the folder back, and a uniqueness suffix ("Trip (2)") never enters the title. `POST /v1/resources/move` returns the renamed `thread` (as listed) in that case, so the sidebar and header update at once. `titleFromFolderName()` is exported.
