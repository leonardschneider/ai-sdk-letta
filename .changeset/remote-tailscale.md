---
"@ai-sdk-letta/server": minor
---

Remote access to the single-user app from your other devices through `tailscale serve`: `startGuiServer(..., { remote: { owners, origins } })` (`--remote --owner --origin` in the example). Requests for a served origin are accepted only from loopback with the owner's `Tailscale-User-Login` (never Funnel); the session cookie is Secure and writes need that origin plus the CSRF token. Local access is unchanged. `checkRemote`, `RemoteAccess`. MCP App views and web previews are not available remotely yet.
