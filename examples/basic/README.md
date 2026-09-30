# Example: basic

A minimal agent ([src/agent.ts](src/agent.ts)) with one custom tool,
`text_stats`, plus the built-in `ask_user` question tool.

From the repository root, after `npm ci` and `npm run build`:

```sh
npm run tui                               # terminal
npm run gui                               # browser, http://127.0.0.1:4400
TEXT_STATS_PERMISSION=ask npm run tui     # require approval for every text_stats call
AGENT_ID=my-sandbox LETTA_MODEL=anthropic/claude-sonnet-4-5 npm run tui
```

Try: "Count the words in 'the quick brown fox'", or "Ask me which colour I
prefer, with three options".
