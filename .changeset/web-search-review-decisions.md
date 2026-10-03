---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

A web search review nobody answers in time becomes a decision instead of expiring: the result is kept on the server, the agent ends its turn, and the card (and the bell) keep it with Approve, Reject and Reject with note, without a time limit. Only the person whose turn searched, or an admin, may review it. The outcome reaches the agent once as a new turn: the result labelled as untrusted with its age, or that it was dismissed with the note. After `webSearch.staleAfterMs` (default 7 days) "Search again" asks the agent to search anew. Without a decision store (terminal UI, plain scripts) reviews still expire.
