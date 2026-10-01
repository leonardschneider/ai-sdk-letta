---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Conversation names are inline Markdown: links, bold, italic and code. The browser app renders them in the sidebar and the header; links open in a new tab, only `http`, `https` and `mailto` links are active, bare URLs become links and long URLs are shortened in the sidebar, while clicking elsewhere on a row still opens the conversation. Rename edits the Markdown as written, search matches the text a name shows, and titles derived from the first message keep inline Markdown (a pasted URL stays a link). Resource folders are named after the text a title shows, never its syntax (`[Spec](https://x)` → "Spec"), and the TUI shows plain text. New: `parseTitle`, `titleText`, `safeLinkHref` and `shortUrl`, also importable without Node dependencies from `ai-sdk-letta/title`.
