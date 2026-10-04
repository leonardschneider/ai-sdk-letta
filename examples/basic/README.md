# Example: basic

A minimal agent ([src/agent.ts](src/agent.ts)) with one custom tool,
`text_stats`, plus the built-in `ask_user` question tool, the file tools
(`list_files`, `read_file`, `search_files`) for attached files, and the
sandbox tools (`run_command`, `run_command_online`).

The sandbox uses Apple Container if it runs (`brew install container &&
container system start`), otherwise Docker, otherwise it is off and the
startup message says so. The first run builds the sandbox image (about a
minute). `SANDBOX_PROVIDER=apple-container|docker|off` forces a choice,
`SANDBOX_PROJECT=/path` mounts a project folder at `/project`, and
`SANDBOX_TIMEOUT_MS` sets the per-command timeout.

From the repository root, after `npm ci` and `npm run build`:

```sh
npm run tui                               # terminal
npm run gui                               # browser, http://127.0.0.1:4400
TEXT_STATS_PERMISSION=ask npm run tui     # require approval for every text_stats call
WEB_SEARCH=1 SEARXNG_URL=http://127.0.0.1:8888 npm run gui   # web search (see "Web search" in the main README); WEB_SEARCH_REVIEW_MS=60000 for a 1-minute review in the turn (then it waits as a decision)
MCP_APPS="basic=./server-basic-vanillajs-2.0.3.tgz --stdio" npm run gui   # an MCP App from a local npm tarball (see "MCP Apps" in the main README)
AGENT_ID=my-sandbox LETTA_MODEL=anthropic/claude-sonnet-4-5 npm run tui
```

Try: "Count the words in 'the quick brown fox'", or "Ask me which colour I
prefer, with three options", or attach a PDF and ask about one of its pages,
or attach a CSV and ask for statistics computed with Python ("pip install
tabulate and print it as a table" asks for approval first).
