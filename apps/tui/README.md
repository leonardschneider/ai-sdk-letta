# @ai-sdk-letta/tui

Terminal UI for [ai-sdk-letta](../../packages/ai-sdk-letta) agents, built on
`@ai-sdk/tui`. Unofficial; not affiliated with Letta or Vercel.

```ts
import { runTerminal } from '@ai-sdk-letta/tui';
process.exitCode = await runTerminal(definition, process.argv.slice(2));
```

Options: `--list`, `--resume`, `--new [title]`, `--conversation ID`,
`--state-dir PATH`. In the UI: `/resume`, `/search`, `/help`, PgUp/PgDn, Esc.

**Patched dependency.** `@ai-sdk/tui` is pinned at 1.0.119 and patched on
install by `patch-package` ([patches/](patches)): display-only restored
history (`initialMessages`), idle-only local slash commands (`localCommand`),
and an interaction renderer for approvals and questions (`interaction`). These
changes are being upstreamed through a fork of `vercel/ai`. The PTY tests in
`test/` exercise the patched renderer offline.

License: Apache-2.0. `@ai-sdk/tui` is Apache-2.0, Copyright Vercel, Inc.
