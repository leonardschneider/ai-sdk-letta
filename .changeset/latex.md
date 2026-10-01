---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

LaTeX maths in the browser app. Replies render `\(...\)` (inline) and `\[...\]` (display) with KaTeX; `$` is never a delimiter, code is never touched, and invalid LaTeX shows its source as an error. Agent definitions take `ui: { latex: boolean }` (default `true`, validated by `defineAgent`; `DEFAULT_UI` and `AgentUiSettings` are exported). The server exposes it in `GET /api/session` and stores a per-conversation override: `PATCH /v1/threads/:id` accepts `latex: 'inherit' | 'on' | 'off'` and threads are listed with `latex` (older threads read as `'inherit'`). The GUI's CSP now states `font-src 'self'`: KaTeX's fonts are bundled with the app, never loaded from a CDN or as data: URLs.
