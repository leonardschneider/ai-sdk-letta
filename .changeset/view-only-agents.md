---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

View-only adopted agents, and live refresh of adopted agents' conversations. `AdoptionRecord.viewOnly` (set at adoption with `{ viewOnly: true }`, or with `PUT /api/adoption/agents/<id>/view-only`) lets the app show an agent that works in Letta Code: it may be adopted while Letta Code uses it, turning it off checks that again (`letta_code_active`), its API answers reads only (`403 view_only` otherwise, see `viewOnlyAllowed`), no session is opened, `adoptedDefinition` gives it no tools, sandbox or dreaming, and no containers or memory review are wired. `LiveConversations` watches the conversations being viewed in the Letta backend (`fs.watch` debounced, plus a poll) and new conversations of the agent, bumping the change channel through `ThreadRuntime.externalChange`; watchers stop when idle and on shutdown. New exports: `conversationDirectory`, `LiveConversations`, `LIVE_LIMITS`, `viewOnlyAllowed`, `VIEW_ONLY_READS`. The app gets a View only toggle in the agent menu and the Add agent picker, a banner instead of the message box, and a Live badge.
