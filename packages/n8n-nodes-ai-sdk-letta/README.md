# n8n-nodes-ai-sdk-letta

An [n8n](https://n8n.io) community node for [ai-sdk-letta](https://github.com/leonardschneider/ai-sdk-letta)
agents: send a message to an agent from a workflow, wait for its reply, and
branch when the run needed a person's approval.

> **Not on npm yet.** Install it from a build of this repository (below).
> Unofficial: not affiliated with Letta, Vercel or n8n.

## What it does

- **Run Turn and Wait**: send a message (in a conversation by title, a new
  one, or one by ID) and wait for the reply. Output: the run, with `text`
  (the reply), `tools`, `files` and `conversation`.
- **Start Turn**: send it without waiting (returns the run ID).
- **Get Run**: a run by ID, optionally waiting until it ended.
- **Cancel Run**: stop it, or withdraw it while it waits.

Runs from n8n are **unattended**. When the agent needs approval for a tool
(or wants to ask a question), the run fails with `approval_required` (or
`question_required`) instead of waiting, and the tool never runs. Set the
node's **Settings → On Error → Continue (using error output)** to branch on
it: the error output carries `error.code`, `error.tool`, `error.runId` and
`error.conversationId`. Or pre-approve the tool on the token.

The idempotency key defaults to the execution, node run and item, so n8n's
retries never start a second turn.

## Credentials

**ai-sdk-letta API**:

- **Server URL**: the server's automation API. From n8n in Docker on the same
  machine: `http://host.docker.internal:4402` (the port you started the
  server with, `--automation-port 4402`).
- **Token**: in the ai-sdk-letta app, **Automations → New token**, used by
  n8n. It is shown once. The credential test calls `/v1/automation/whoami`.

## Install (self-hosted n8n, from this repository)

```sh
npm ci && npm run build --workspace n8n-nodes-ai-sdk-letta
cd packages/n8n-nodes-ai-sdk-letta && npm pack           # n8n-nodes-ai-sdk-letta-0.1.0.tgz
docker cp n8n-nodes-ai-sdk-letta-0.1.0.tgz <n8n container>:/tmp/
docker exec -u node <n8n container> sh -c 'mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes && npm install /tmp/n8n-nodes-ai-sdk-letta-0.1.0.tgz --omit=dev --omit=peer'
docker restart <n8n container>
```

Tested with `n8nio/n8n:2.41.6`. The node has no runtime dependencies; it uses
n8n's own `n8n-workflow` (a peer dependency).

## Example

[`examples/nightly-report.workflow.json`](examples/nightly-report.workflow.json):
every weekday at 7:00 → ask the agent for the daily report → the reply; or,
when the run needed approval, a notice with the conversation to open, and any
other failure fails the workflow. Import it (Workflows → Import from File) and
pick your credential in the *Ask the agent* node.

## Development

```sh
npm run build --workspace n8n-nodes-ai-sdk-letta
npm test --workspace n8n-nodes-ai-sdk-letta
```

The package follows n8n's community-node conventions (name `n8n-nodes-*`,
keyword `n8n-community-node-package`, the `n8n` section of `package.json`,
MIT license, no runtime dependencies, programmatic style because Run Turn and
Wait polls). Before publishing it, run n8n's checks
(`npx @n8n/scan-community-package n8n-nodes-ai-sdk-letta`) and publish from
GitHub Actions with provenance, as n8n requires for verified nodes.
