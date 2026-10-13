---
"@ai-sdk-letta/server": minor
---

The browser app reloads itself after an update. New `GET /build.json` (single-user and team apps; outside the session check) returns an opaque build ID that changes when the server restarts or the web app's `index.html` changes (`buildIdRoute`). The app polls it every 15 s and on tab focus, and reloads when it changes: at once in a hidden or idle tab, never while you type in the composer or with a dialog or menu open; an unsent message is kept across the reload. A tab opened while the server was down reloads once it answers.
