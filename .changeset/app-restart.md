---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Stopped MCP Apps restart easily. Dev apps keep their spec when their services container stops after its idle timeout, and across server restarts (`dev-apps.json`). Opening a view or calling a tool restarts them by themselves; failed apps show why, with Restart and Logs. New routes: `POST /v1/threads/:id/apps/:app/restart`, `GET /v1/threads/:id/apps/:app/logs`, `POST /v1/apps/:app/restart|stop`, `GET /v1/apps/:app/logs`, and a view heartbeat that keeps the container running while a view is on screen. The Apps dialog shows each app's status with Restart, Stop and Logs.
