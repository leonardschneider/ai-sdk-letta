---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Share agents with a team over Tailscale. `startTeamServer` serves several agents behind `tailscale serve`: people are identified by Tailscale (headers trusted on loopback only), each agent has members and admins (`TeamDirectory`), everything inside an agent is shared by its members, conversations run turns in parallel and a busy conversation queues messages visibly, every user turn shows its author and the agent is told who is speaking, and only a turn's author or an admin can answer its approvals and questions. The browser app gains an agent switcher, a members dialog, authors, a queue and a "no access" page. In `ai-sdk-letta`, `openAgentHost` opens several conversations of one agent at once, and `LettaAgent` calls accept `otid` and `speaker`; display history carries each user turn's `otid`. Single-user mode is unchanged.
