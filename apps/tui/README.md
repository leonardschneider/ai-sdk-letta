# @ai-sdk-letta/tui

Terminal UI for [ai-sdk-letta](../../packages/ai-sdk-letta) agents, built on
`@ai-sdk/tui`. Unofficial; not affiliated with Letta or Vercel.

```ts
import { runTerminal } from '@ai-sdk-letta/tui';
process.exitCode = await runTerminal(definition, process.argv.slice(2));
```

Options: `--list`, `--resume`, `--new [title]`, `--conversation ID`,
`--state-dir PATH`. In the UI: `/resume`, `/search`, `/help`, PgUp/PgDn, Esc,
and **Ctrl+V** or a dropped image path to attach images (shown as
`[Image 1]`; Backspace removes). With the file tools, a dropped or pasted
PDF, text, Markdown, CSV, JSON or code file path attaches it as
`[File 1: report.pdf]`; sent and restored messages show `[File: report.pdf]`.
Clipboard images need `osascript` (macOS) or `wl-paste`/`xclip` (Linux);
dropping a file works everywhere.

**Not on npm yet.** This package is `"private": true`. Its `@ai-sdk/tui`
dependency is patched by the repository's `postinstall` (below), and a patch
in a published package's own tree is not applied when a consumer installs
it from npm: they would get the unpatched `@ai-sdk/tui`, which lacks the
options this TUI needs. Use it from a checkout of this repository
(`npm run tui`). The way forward is still open: depend on a published fork of
`@ai-sdk/tui`, or wait for the changes to land upstream.

**Patched dependency.** `@ai-sdk/tui` is pinned at 1.0.119 and patched on
install by `patch-package` ([patches/](patches)): display-only restored
history (`initialMessages`), idle-only local slash commands (`localCommand`),
an interaction renderer for approvals and questions (`interaction`), and
generic prompt attachments (`attachments`: `fromClipboard` for Ctrl+V and
`fromText` for pasted or dropped text; files are sent as `file` parts and
named in their markers), and custom tool cards (`toolView`: title, right
title and verbatim content, used for "Ran `command`" cards). To change the patch, edit
`node_modules/@ai-sdk/tui/src`, rebuild `dist/index.js` with
`npx esbuild node_modules/@ai-sdk/tui/src/index.ts --bundle --platform=node --format=esm --external:ai --outfile=node_modules/@ai-sdk/tui/dist/index.js`
(it reproduces the patched `dist` exactly), mirror any type changes in
`dist/index.d.ts`, then run `npx patch-package @ai-sdk/tui --patch-dir apps/tui/patches`. These
changes are being upstreamed through a fork of `vercel/ai`. The PTY tests in
`test/` exercise the patched renderer offline.

License: Apache-2.0. `@ai-sdk/tui` is Apache-2.0, Copyright Vercel, Inc.
