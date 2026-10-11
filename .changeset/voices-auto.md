---
"@ai-sdk-letta/server": minor
"ai-sdk-letta": minor
---

Ambition and Prudence now speak on their own: when at least one voice is on, they weigh in on every completed reply in the background (never on failed, stopped or listened turns; once per run). The app shows "Ambition & Prudence are thinking…", then the collapsed notes with "Ask again". The next turn waits up to 10 s for notes still being written, then proceeds without them (late notes are shown but never injected). New setting "Speak after: every reply / only long turns" (a tool call, or 30 s or more); `GET /v1/threads/:id/counsels`.
