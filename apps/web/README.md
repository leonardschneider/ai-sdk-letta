# @ai-sdk-letta/web

The [assistant-ui](https://www.assistant-ui.com) browser app for
ai-sdk-letta agents. `npm run build` writes static assets to `dist/`, which
`startGuiServer` from `@ai-sdk-letta/server` serves on 127.0.0.1.

It renders streaming replies, tool activity (technical details collapsed),
docked approval and question cards (each answer is sent exactly once), and
safe Markdown (no raw HTML, no remote images, lazy syntax highlighting).

License: Apache-2.0.
