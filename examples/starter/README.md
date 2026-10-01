# Starter: build your own agent

The smallest complete ai-sdk-letta agent, to copy. It has one custom tool,
`date_diff` (pure date arithmetic: days, weeks, business days and weekdays
between two dates; no network, no files), its permission, and the built-in
`ask_user` question tool. It runs in the terminal, in the browser and from a
script.

```
src/tools.ts    the date_diff tool
src/agent.ts    the definition: id, name, model, instructions, tools, permissions
src/tui.ts      terminal UI
src/gui.ts      browser UI
src/script.ts   one turn from code; approvals and questions on stdin
test/           offline tests (no backend, no model)
```

## Use it

Copy this folder, rename the ID, edit the tools. From the repository root,
after `npm ci`:

```sh
cp -R examples/starter examples/my-agent
```

1. In `examples/my-agent/package.json`, set `"name"` to
   `@ai-sdk-letta/example-my-agent` (keep `"private": true`).
2. In `examples/my-agent/src/agent.ts`, set `id` and `name`. The first run
   creates a persistent Letta agent for that ID; later runs reopen it. Never
   reuse an ID for a different agent. `model` and `instructions` are applied
   only when the agent is created.
3. Edit `src/tools.ts`, and list every tool in `tools` and `permissions`
   (`'allow'`, `'ask'` or `'deny'`).
4. Run `npm install` at the root once, to link the new workspace.

```sh
npm test --workspace @ai-sdk-letta/example-my-agent                     # offline
npm run tui --workspace @ai-sdk-letta/example-my-agent                  # terminal
npm run gui --workspace @ai-sdk-letta/example-my-agent -- --port 4500   # browser
npm run script --workspace @ai-sdk-letta/example-my-agent -- "How many business days until 2026-12-24?"
```

Environment variables: `LETTA_MODEL` (model handle, default
`openai-codex/gpt-5.5`), `STARTER_AGENT_ID` (a throwaway logical ID),
`AI_SDK_LETTA_STATE_DIR` (state directory), `DATE_DIFF_PERMISSION=ask`
(approve each `date_diff` call). When you rename the agent, rename
`STARTER_AGENT_ID` too, or remove it.

Try: "How many business days between 2026-03-02 and 2026-04-03?", or "Ask
me which month to plan for, with three options".

The full guide: [Building your own agent](../../docs/building-your-own-agent.md).
