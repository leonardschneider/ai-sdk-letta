---
"@ai-sdk-letta/server": patch
---

The browser app stays light in long conversations: while a reply streams it no longer redraws the whole conversation for every event (unchanged messages keep their identity; streamed text is drawn at most every 100 ms), and long conversations show their latest ~60 messages with "Show earlier messages" at the top. Fixes blank pages in Safari after a while (the tab ran out of memory).
