---
"ai-sdk-letta": patch
"@ai-sdk-letta/server": patch
---

The browser app shows the installed versions under "About this space" ("ai-sdk-letta 0.5.1 · server 0.5.1 · Letta SDK 0.8.22"), as selectable text with a copy button for bug reports. The server reads them once at startup from the `package.json` of the packages it actually resolves (npm install or source checkout) and returns them in `GET /api/session` as `versions: { aiSdkLetta, server, lettaSdk }` (`null` when one cannot be read); `runtimeVersions()` is exported.
