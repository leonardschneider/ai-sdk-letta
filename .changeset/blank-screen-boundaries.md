---
"@ai-sdk-letta/server": patch
---

The browser app no longer goes blank: a message that changed kind while shown (a live turn becoming its history record, as after a message from an app's view) rendered a different number of hooks and unmounted the whole page. Each message kind is now its own component. Error boundaries now keep any render error local: an app view, a side-panel tab, a message or one part of a reply shows an inline error card with Try again, and an error that reaches the top shows a small "Something went wrong" panel (Try again, Reload, details) instead of a blank page. Caught errors go to the console and, rate limited, to the server's log (`POST /api/client-errors`, same session and CSRF checks as the other routes).
