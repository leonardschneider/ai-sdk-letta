# @ai-sdk-letta/web

The [assistant-ui](https://www.assistant-ui.com) browser app for
ai-sdk-letta agents. `npm run build` writes static assets to `dist/`, which
`startGuiServer` from `@ai-sdk-letta/server` serves on 127.0.0.1.

It renders streaming replies, tool activity (technical details collapsed),
docked approval and question cards (each answer is sent exactly once),
safe Markdown (no raw HTML, no remote images, lazy syntax highlighting), and
image attachments: paste, drop or pick PNG, JPEG, GIF or WebP images
(downscaled in the browser when large), with removable thumbnails and
click-to-enlarge in messages.

**Not on npm yet.** This package is `"private": true`: build it in this
repository and pass its `dist/` directory to `startGuiServer`. Shipping the
built assets with `@ai-sdk-letta/server`, or publishing them as their own
package, is a follow-up.

License: Apache-2.0.
