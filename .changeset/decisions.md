---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Decisions: the agent can ask the people of a conversation to decide something, without holding the turn open. `request_decision` (with `cancel_decision`, opt-in through `decisionTools`) records a pending decision and pauses the work; every member of the agent sees it in the app (a notification bell and a card in the conversation) and any of them can decide once, or stop the work. The outcome resumes the work as a new turn of the conversation. Decisions survive restarts and are delivered exactly once. Automation runs that ask for a decision end as `decision_pending`, and `GET /v1/automation/decisions/<id>?wait=` waits for the outcome; the n8n node and the Conductor examples can wait through decisions.
