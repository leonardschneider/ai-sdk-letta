# Building your own agent

A step-by-step guide to defining, running and testing your own ai-sdk-letta
agent. It assumes you know TypeScript and the basics of the
[AI SDK](https://ai-sdk.dev) `tool()` API. Every TypeScript block below is
typechecked in CI (`npm run check:docs`).

The fastest start is the [starter template](../examples/starter): copy it,
rename the ID, edit the tools.

- [1. Concepts](#1-concepts)
- [2. Prerequisites](#2-prerequisites)
- [3. Project setup](#3-project-setup)
- [4. Write tools](#4-write-tools)
- [5. Define the agent](#5-define-the-agent)
- [6. Human in the loop](#6-human-in-the-loop)
- [7. Optional built-ins: files, shell, images](#7-optional-built-ins-files-shell-images)
- [8. Memory and dreaming](#8-memory-and-dreaming)
- [9. Run it](#9-run-it)
- [10. State, identity, starting fresh](#10-state-identity-starting-fresh)
- [11. Test it](#11-test-it)
- [12. Troubleshooting](#12-troubleshooting)

## 1. Concepts

An agent is a **definition** in your code, created with `defineAgent()`:

| Field | What it is | When it applies |
| --- | --- | --- |
| `id` | Your stable logical ID: 1–64 lowercase letters, digits or `-`. | Every start. |
| `name` | Display name, 1–120 characters. Also the Letta agent's name. | Every start: must match, or startup fails. |
| `model` | A Letta model handle, `provider/model`, for example `openai-codex/gpt-5.5`. | **At creation only.** |
| `instructions` | The system prompt. | **At creation only.** |
| `tools`, `permissions` | AI SDK tools and an `allow` / `ask` / `deny` entry for each. | Every start. |
| `toolTimeoutMs`, `sandbox`, `dreaming` | Optional; see below. | Every start. |

**Identity.** The first time a definition is opened, ai-sdk-letta creates a
persistent Letta agent on the local backend and records the mapping
`id -> Letta agent ID` in its state directory (`agents/<id>.json`). Every
later start reopens the same Letta agent, with its memory and conversations.
It never searches by name and never creates a second agent for the same
mapping.

- **Never reuse an `id` for a different agent.** The ID is the agent; a new
  purpose needs a new ID.
- **Changing `instructions` or `model` later has no effect on an existing
  agent, and nothing warns you.** They are sent only when the Letta agent is
  created. To apply new instructions, create a new agent (new `id`, or a fresh
  state directory; see [section 10](#10-state-identity-starting-fresh)) or
  change the agent in Letta yourself.
- **Changing `name` makes startup fail** with `Invalid identity mapping or
  backend mismatch; refusing to recreate agent`: the mapping and the Letta
  agent both record the name. Pick the name once.
- Tools, permissions, timeouts, the sandbox and dreaming are read from the
  definition on every start, so you can change them freely.

**Turns.** `LettaAgent` implements the AI SDK `Agent` interface (`generate`,
`stream`). Letta runs the reasoning and tool loop; each call sends exactly one
new user message. When the model calls one of your tools, it runs in your
process, behind the permission policy.

## 2. Prerequisites

Node.js 22.19+, the Letta CLI, a local Letta backend with a connected model,
and that model's handle. See [Prerequisites in the README](../README.md#prerequisites).
Check that your handle is listed:

```sh
letta --backend local model list
```

## 3. Project setup

The library (`ai-sdk-letta`) and the HTTP runtime (`@ai-sdk-letta/server`)
are on npm. The terminal UI (`@ai-sdk-letta/tui`) and the browser app
(`@ai-sdk-letta/web`) are **not on npm yet**
([why](../README.md#not-on-npm-yet)). So there are two realistic paths:

**A. In a clone, from the starter (TUI and GUI included).** Recommended to
start.

```sh
git clone https://github.com/leonardschneider/ai-sdk-letta.git
cd ai-sdk-letta
npm ci
cp -R examples/starter examples/my-agent
```

Then, in `examples/my-agent`:

1. In `package.json`, set `"name"` to `@ai-sdk-letta/example-my-agent`
   (workspace names must be unique; keep `"private": true`).
2. In `src/agent.ts`, set `id` (for example `my-agent`) and `name`, then
   edit `instructions`, `tools` and `permissions`.

Back at the repository root, run `npm install` once so npm links the new
workspace (`examples/*` are all workspaces), then:

```sh
npm run tui --workspace @ai-sdk-letta/example-my-agent
npm run gui --workspace @ai-sdk-letta/example-my-agent -- --port 4500
```

**B. Your own project, npm packages only (no bundled UI).** You write the UI,
or use the agent from code or over HTTP:

```sh
npm install ai-sdk-letta ai
npm install @ai-sdk-letta/server   # optional: HTTP runtime (startApiServer)
npm install -D typescript tsx @types/node
```

Use `"type": "module"` in `package.json` and run files with
`node --import tsx src/script.ts`. Everything in sections 4–8 and the
programmatic part of section 9 works this way. `startGuiServer` also works,
but it needs a built browser app directory; today that means building
`apps/web` in a clone.

The examples below use these files: `src/tools.ts`, `src/agent.ts`, and one
entry point per way of running it.

## 4. Write tools

A tool is an ordinary AI SDK `tool()`: a `description` the model reads, an
`inputSchema`, and an `execute` function. Any AI SDK schema works
(`jsonSchema()` as below, or a zod schema); arguments are validated against
its JSON Schema **before** anything runs, and invalid calls never reach
`execute`.

```ts
// src/tools.ts
import { appendFile } from 'node:fs/promises';
import { tool, jsonSchema } from 'ai';

/** Pure computation: safe to allow without asking. */
export const convertTemperature = tool({
  description: 'Convert a temperature between Celsius and Fahrenheit.',
  inputSchema: jsonSchema<{ value: number; from: 'C' | 'F' }>({
    type: 'object',
    properties: { value: { type: 'number' }, from: { type: 'string', enum: ['C', 'F'] } },
    required: ['value', 'from'],
    additionalProperties: false,
  }),
  execute: async ({ value, from }) => from === 'C'
    ? { celsius: value, fahrenheit: Math.round((value * 9 / 5 + 32) * 10) / 10 }
    : { celsius: Math.round(((value - 32) * 5 / 9) * 10) / 10, fahrenheit: value },
});

/** A side effect (writes a file): a good candidate for 'ask'. */
export const saveNote = tool({
  description: 'Append a one-line note to the user\'s notes file.',
  inputSchema: jsonSchema<{ text: string }>({
    type: 'object',
    properties: { text: { type: 'string', minLength: 1, maxLength: 500 } },
    required: ['text'],
    additionalProperties: false,
  }),
  execute: async ({ text }, { abortSignal }) => {
    if (/[\r\n]/.test(text)) return { saved: false, error: 'Notes must be a single line' };
    abortSignal?.throwIfAborted();
    await appendFile(process.env.NOTES_FILE ?? 'notes.md', `- ${text}\n`);
    return { saved: true };
  },
});
```

What the runtime does with your tool:

- **Results.** The return value is sent to the model as JSON, at most 16,000
  characters (`TOOL_OUTPUT_LIMIT`). Return small, structured objects. To
  control exactly what the model sees (text, or text and up to 4 images),
  add the AI SDK `toModelOutput` option.
- **Errors.** A thrown error reaches the model only as a fixed code,
  `{"error":"tool_failed"}`, never its message (so secrets in error messages
  do not leak). If the model should understand and correct a mistake,
  **return** the problem as data, as `saveNote` does. To flag a result as an
  error with your own text, use `toModelOutput`:

  ```ts
  import { tool, jsonSchema } from 'ai';

  export const lookupSku = tool({
    description: 'Look up a product by SKU in the local catalogue.',
    inputSchema: jsonSchema<{ sku: string }>({ type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false }),
    execute: async ({ sku }) => sku === 'A-1' ? { found: true as const, name: 'Anvil' } : { found: false as const, sku },
    toModelOutput: ({ output }) => output.found
      ? { type: 'json', value: output }
      : { type: 'error-text', value: `Unknown SKU ${output.sku}; ask the user to check it.` },
  });
  ```

- **Timeouts.** Each call has a deadline, `toolTimeoutMs` on the definition
  (default 5,000 ms, at most 300,000). Time spent waiting for a human
  approval does not count. On timeout or when the user stops the turn,
  `abortSignal` fires and the model gets `tool_timeout` or `tool_cancelled`.
  Pass `abortSignal` on to anything long-running.
- **Other fixed codes** the model may see: `invalid_arguments`,
  `tool_denied`, `user_denied`, `approval_cancelled`,
  `interaction_unavailable`, `duplicate_or_limit`.
- **Names.** Tool names match `[a-zA-Z0-9_-]{1,64}`. `Read`, `Write`, `Edit`
  and `Bash` are reserved for memory.
- **Context.** `execute` also receives `toolCallId` and `abortSignal`. The
  AI SDK `messages` option is always empty here: Letta keeps the transcript.

## 5. Define the agent

```ts
// src/agent.ts
import { askUserTool, defineAgent } from 'ai-sdk-letta';
import { convertTemperature, saveNote } from './tools.js';

export const agent = defineAgent({
  id: process.env.AGENT_ID ?? 'kitchen-helper',   // stable; never reuse for another agent
  name: 'Kitchen Helper',                          // checked on every start
  model: process.env.LETTA_MODEL ?? 'openai-codex/gpt-5.5',
  instructions: 'You help with cooking. Use convert_temperature for any temperature conversion. '
    + 'Save notes only when the user asks. When a choice is the user\'s to make, call ask_user with clear options.',
  tools: { convert_temperature: convertTemperature, save_note: saveNote, ask_user: askUserTool },
  // Fail-closed: every tool needs an entry.
  permissions: { convert_temperature: 'allow', save_note: 'ask', ask_user: 'allow' },
  toolTimeoutMs: 10_000,
  dreaming: { trigger: 'step-count', stepCount: 25 },
});
```

`permissions`, per tool:

- `'allow'`: runs without asking.
- `'ask'`: the human approves or denies **each call**, seeing the exact
  arguments; approval is bound to those arguments.
- `'deny'`: never exposed to the model.

`defineAgent` throws immediately if a tool has no entry
(`Missing permission for tool(s): ...`), if an entry names an unknown tool, or
if `ask_user` is set to `'ask'` (it is already interactive; it defaults to
`'allow'`). Put the definition in its own module and import it from each
entry point, so a mistake fails at startup, before any Letta call.

## 6. Human in the loop

Two things need a human during a turn:

- **Approvals** for tools with `'ask'`.
- **Questions** from `ask_user` (add `ask_user: askUserTool` to the tools).
  The model sends a question with options (`{ id, label }`, up to 12),
  optionally `allowFreeText` and `multiSelect`, and gets back
  `{ cancelled, selected, text }`.

Both go through the agent's interaction broker, `agent.interactions`. The
TUI and the GUI connect it for you. In your own code, connect **one**
handler that returns a response echoing `request.id`:

- approval: `{ id, approved: true | false }`;
- question: `{ id, selected: [optionId, ...] }` and/or `{ id, text }` (text
  only if `allowFreeText`; several options only if `multiSelect`);
- either: `{ id, cancelled: true }`.

Invalid answers are rejected, and the tool fails closed. **Without a
connected handler, `'ask'` tools and `ask_user` fail closed** with
`interaction_unavailable`. A headless script must therefore decide a policy,
for example deny every approval and pick the first option:

```ts
// src/headless.ts
import { createLettaAgent } from 'ai-sdk-letta';
import { agent } from './agent.js';

const { agent: kitchen, close } = await createLettaAgent(agent);
const disconnect = kitchen.interactions.connect(async request => {
  if (request.kind === 'approval') {
    console.error(`Denied ${request.tool} ${request.details ?? ''}`);
    return { id: request.id, approved: false };
  }
  const first = request.options?.[0];
  return first ? { id: request.id, selected: [first.id] } : { id: request.id, cancelled: true };
});
try {
  const result = await kitchen.generate({ prompt: 'Convert 180 C to Fahrenheit, then save it as a note.' });
  console.log(result.text);
} finally {
  disconnect();
  await close();
}
```

Answer promptly. Human waits are bounded (the Letta harness allows a client
tool at most five minutes; the HTTP runtime closes prompts after four), and
a prompt left unanswered fails the turn. Like any failed turn, that leaves
the conversation blocked as an uncertain delivery (see
[Troubleshooting](#12-troubleshooting)); continue in a new conversation. The
handler receives an `AbortSignal` as second argument that fires when a prompt
is withdrawn; stop showing the prompt then.

## 7. Optional built-ins: files, shell, images

All built-ins are opt-in, like every tool.

**File attachments.** `fileTools` adds `list_files`, `read_file` and
`search_files`, which read only the current conversation's attachment
folder. With them, users can attach PDFs and text files in the TUI and GUI,
and code can pass AI SDK `file` parts. **Shell commands.** `sandboxTools`
adds `run_command` (no network) and `run_command_online` (network; always
`'ask'` or `'deny'`, never `'allow'`). They run in an isolated container and
are exposed only when the definition has a `sandbox` option.

```ts
import { defineAgent, detectSandboxProvider, fileTools, FILE_TOOL_PERMISSIONS, prepareSandbox, sandboxTools, SANDBOX_TOOL_PERMISSIONS } from 'ai-sdk-letta';

// Apple Container if it runs here, else Docker, else undefined (shell tools hidden).
const provider = await detectSandboxProvider();
if (provider) await prepareSandbox({ provider }, line => console.error(line)); // builds the image once

export const analyst = defineAgent({
  id: 'data-analyst',
  name: 'Data Analyst',
  model: 'openai-codex/gpt-5.5',
  instructions: 'Answer questions about the attached files. Read only the pages or lines you need. '
    + 'Use run_command (Python, rg, jq) for calculations; run_command_online only when you need the internet.',
  tools: { ...fileTools, ...sandboxTools },
  // FILE_TOOL_PERMISSIONS: all 'allow'. SANDBOX_TOOL_PERMISSIONS: run_command 'allow', run_command_online 'ask'.
  permissions: { ...FILE_TOOL_PERMISSIONS, ...SANDBOX_TOOL_PERMISSIONS },
  ...(provider ? { sandbox: { provider, timeoutMs: 120_000 } } : {}),
});
```

The sandbox providers are optional peer dependencies, pinned exactly; install
the one you use:

```sh
npm install --save-exact @lgrammel/apple-container-sandbox@1.1.0 @ai-sdk/harness@1.0.128   # macOS 26, Apple silicon
npm install --save-exact ai-sdk-sandbox-docker@0.1.2 @ai-sdk/harness@1.0.128               # Docker
```

The README has the details: [Files](../README.md#files) (types, limits,
PDFs) and [Shell commands](../README.md#shell-commands-sandbox) (workspace,
project folders, isolation, `sandbox` options, custom providers).

**Images** need no tool: a user turn may carry up to 4 PNG, JPEG, GIF or
WebP images (5 MB each), if the model accepts images. From code, pass the
transcript plus the new turn:

```ts
import { readFileSync } from 'node:fs';
import { createLettaAgent } from 'ai-sdk-letta';
import { agent } from './agent.js';

const { agent: kitchen, close } = await createLettaAgent(agent);
try {
  const result = await kitchen.generate({ messages: [...kitchen.transcript, { role: 'user', content: [
    { type: 'text', text: 'What dish is this?' },
    { type: 'image', image: readFileSync('dish.jpg') },
  ] }] });
  console.log(result.text);
} finally {
  await close();
}
```

## 8. Memory and dreaming

Configured for you, on every agent:

- **MemFS** (Letta's git-backed memory filesystem) is enabled when the agent
  is created, and startup refuses to run without it.
- The agent may maintain its memory **only** there: it gets Letta's `Read`,
  `Write` and `Edit` on Markdown files inside its own memory directory, and
  one exact `git commit` command. No general shell or file access. A short
  memory policy is appended to your instructions at creation so the model
  knows this.
- Memory operations do not appear as tool calls in AI SDK results or the UIs.
- **Dreaming** (background memory consolidation) is set by `dreaming`:
  `{ trigger: 'step-count', stepCount: 25 }` by default; `'compaction-event'`
  or `'off'` are the other triggers. It is applied on every start, scoped to
  this agent's state directory (never your global Letta settings), and
  verified. The startup status says "configured", which is not evidence that
  a dream has run.

What the agent writes to memory is up to the model and your instructions.
If you want it to remember specific things (preferences, project facts), say
so in `instructions`.

## 9. Run it

**Terminal (from a clone).** `runTerminal` handles the conversation picker,
`/resume`, `/search`, approvals and questions:

```ts
// src/tui.ts
import { runTerminal } from '@ai-sdk-letta/tui';
import { agent } from './agent.js';

// --list, --resume, --new [title], --conversation ID, --state-dir PATH
process.exitCode = await runTerminal(agent, process.argv.slice(2));
```

**Browser (from a clone).** `startGuiServer` serves the browser app on
127.0.0.1:

```ts
// src/gui.ts
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { closeOnSignals, startGuiServer } from '@ai-sdk-letta/server';
import { agent } from './agent.js';

// Built by `npm run build --workspace @ai-sdk-letta/web` in the clone.
const assets = join(dirname(createRequire(import.meta.url).resolve('@ai-sdk-letta/web/package.json')), 'dist');
const server = await startGuiServer(agent, assets, { port: Number(process.env.PORT ?? 4400) });
closeOnSignals(server);
```

`startApiServer(agent, { port })` serves the same routes for
server-to-server use, behind a bearer token stored in the state directory.

**From code.** `createLettaAgent` opens the agent (creating it on first use)
and returns the `LettaAgent` plus `close()`. Options: `stateDirectory`,
`conversationId` (`'default'` or a Letta conversation ID), `newTitle` (create
a conversation), `traces`. Without either, it reopens the last conversation.

```ts
// src/stream.ts
import { createLettaAgent } from 'ai-sdk-letta';
import { agent } from './agent.js';

const runtime = await createLettaAgent(agent, { newTitle: 'Sunday lunch' });
console.error(runtime.agent.presentation?.status); // agent, conversation, MemFS and dreaming status
runtime.agent.interactions.connect(async request =>
  request.kind === 'approval' ? { id: request.id, approved: true } : { id: request.id, cancelled: true });
try {
  const first = await runtime.agent.generate({ prompt: 'Convert 350 F to Celsius.' });
  console.log(first.text, first.toolResults.map(result => result.toolName));

  const second = await runtime.agent.stream({ prompt: 'And 200 C to Fahrenheit?' });
  for await (const chunk of second.textStream) process.stdout.write(chunk);
} finally {
  await runtime.close();
}
```

Rules for `generate` and `stream`:

- Pass `prompt` (a string) or `messages`, plus an optional `abortSignal`.
  Other AI SDK call options are rejected.
- `messages` must extend exactly what this instance already sent; history
  edits, replays and regeneration are refused. Use `agent.transcript` as the
  base.
- One turn at a time, up to 8,000 characters of text.
- After a failed or cancelled turn, the instance refuses further turns
  (delivery is uncertain). Close it and open the agent again.
- Tool calls appear in results as `providerExecuted`: the AI SDK displays
  them but never runs them a second time.

## 10. State, identity, starting fresh

State lives in one directory: the `stateDirectory` option (`--state-dir` in
the TUI), else `AI_SDK_LETTA_STATE_DIR`, else `~/.local/state/ai-sdk-letta`
(`$XDG_STATE_HOME/ai-sdk-letta` if set; `%LOCALAPPDATA%\ai-sdk-letta\state`
on Windows). The parts you will meet:

```
<state>/agents/<id>.json      logical ID -> Letta agent ID, last conversation
<state>/agents/<id>.lock      held while a process has the agent open
<state>/agents/*.pending.json an operation whose outcome is unknown (see 12)
<state>/server/<id>/          GUI and API threads
<state>/attachments/          attached files, per Letta agent and conversation
<state>/tool-traces/          metadata-only tool audit
```

The mapping is also tied to the Letta local backend directory
(`LETTA_LOCAL_BACKEND_DIR`, default `~/.letta/lc-local-backend`). The
[README](../README.md#state-and-identity) describes the full layout.

- **Keep an agent:** keep the same `id`, `name` and state directory. To move,
  point the new setup at the directory that holds `agents/<id>.json`.
- **Start fresh, keeping the old agent:** use a new `id`, or a new state
  directory. The old Letta agent stays in Letta, unused.
- **Experiment safely:** use a throwaway ID and state directory, for example
  `AGENT_ID=kitchen-test AI_SDK_LETTA_STATE_DIR=/tmp/kitchen-test` (the
  starter reads `AGENT_ID`).
- **Delete an agent:** stop every process using it, delete the Letta agent,
  then remove its mapping and folders. Deleting only the mapping makes the
  next start create a second Letta agent with the same name; deleting only
  the Letta agent makes startup fail. ai-sdk-letta has no delete command;
  the Letta Agent SDK (`npm install @letta-ai/letta-agent-sdk@0.8.22`, the
  version ai-sdk-letta uses) can do it. Check the name before deleting:

  ```ts
  // src/delete-agent.ts
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';
  import { resolveStateDirectory, statePaths } from 'ai-sdk-letta';

  const id = process.argv[2] ?? 'kitchen-helper';
  const mapping = JSON.parse(readFileSync(join(statePaths(resolveStateDirectory()).agents, `${id}.json`), 'utf8')) as { agentId: string; name: string };
  const client = new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local' } });
  try {
    const found = await client.agents.retrieve(mapping.agentId);
    if (found.name !== mapping.name) throw new Error(`Refusing: ${mapping.agentId} is named "${found.name}"`);
    await client.agents.delete(mapping.agentId);
    console.log(`Deleted ${mapping.agentId} (${found.name}). Now remove agents/${id}.json, server/${id}/ and attachments/${mapping.agentId}/.`);
  } finally {
    await client.close();
  }
  ```

## 11. Test it

**Offline** (no backend, no model). Test tools directly, and through
`createToolBridge`, which applies the same policy as the runtime (schema
validation, permissions, approvals, timeouts, error codes). Importing the
definition also checks it.

```ts
// src/agent.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolBridge, ToolInteractions } from 'ai-sdk-letta';
import { agent } from './agent.js';

test('convert_temperature runs; invalid arguments never reach the handler', async () => {
  const bridge = createToolBridge({ tools: agent.tools, permissions: agent.permissions });
  const ok = await bridge.execute('convert_temperature', 'call-1', { value: 100, from: 'C' });
  assert.deepEqual(ok, { content: [{ type: 'text', text: '{"celsius":100,"fahrenheit":212}' }], isError: false });
  const bad = await bridge.execute('convert_temperature', 'call-2', { value: 'hot', from: 'C' });
  assert.equal(bad.isError, true);
});

test('save_note asks first, and a denial never runs it', async () => {
  const interactions = new ToolInteractions();
  interactions.connect(async request => ({ id: request.id, approved: false }));
  const bridge = createToolBridge({ tools: agent.tools, permissions: agent.permissions, interactions });
  const result = await bridge.execute('save_note', 'call-3', { text: 'Preheat to 180 C' });
  assert.deepEqual(result, { content: [{ type: 'text', text: '{"error":"user_denied"}' }], isError: true });
});
```

In your own project, run it with `node --import tsx --test src/agent.test.ts`.
In a clone, use the workspace's `npm test`, which adds the source condition
(`--conditions=ai-sdk-letta-source`) so no build is needed; the starter has
tests of this kind (`npm test --workspace @ai-sdk-letta/example-starter`).

**Live smoke** (uses the backend and your model). Use a throwaway ID and
state directory so you never touch a real agent, run one tool call and one
question, then clean up:

```sh
export AGENT_ID=starter-smoke AI_SDK_LETTA_STATE_DIR=/tmp/starter-smoke
npm run script --workspace @ai-sdk-letta/example-starter -- "How many business days from 2026-03-02 to 2026-03-16?"
npm run script --workspace @ai-sdk-letta/example-starter -- "Ask me which month to plan for, with three options, then tell me what I picked."
```

The first should report `[tool] date_diff`; the second asks on the terminal.
Then delete the Letta agent ([section 10](#10-state-identity-starting-fresh))
and `rm -rf /tmp/starter-smoke`.

## 12. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Missing permission for tool(s): x` | Every tool needs `'allow'`, `'ask'` or `'deny'` in `permissions`. |
| `Permission for unknown tool "x"` | A permission names a tool that is not in `tools` (check the key spelling). |
| `Tool name "Bash" is reserved for memory operations` | Rename the tool; `Read`, `Write`, `Edit`, `Bash` are reserved. |
| `Model "x" is not available on the local Letta backend; connect its provider first` | Raised when the agent is created. Check `letta --backend local model list` and connect the provider. |
| `Agent identity is locked: <state>/agents/<id>.lock` | Another process has the agent open (one process per agent). After a crash, check that the PID in the file is not running, then remove the `.lock`. |
| `Server already running or stale lock: .../service.lock` | Same, for the GUI or API server. |
| `Uncertain prior delivery: ...turn.pending.json` | A turn was sent but its completion was never confirmed (crash, kill, or a failed turn such as an unanswered prompt). That conversation is blocked; nothing is resent. Inspect it (for example in Letta), then remove the file; or continue in another conversation. In the GUI, start a new chat. |
| `Unresolved agent creation intent: <id>.pending.json` | Agent creation was interrupted. Check in Letta whether an agent with that name was created; reconcile by hand before removing the file. |
| `Invalid identity mapping or backend mismatch; refusing to recreate agent` | `name` changed, or `LETTA_LOCAL_BACKEND_DIR` differs from when the mapping was made. Restore them, or start fresh. |
| `Session closed or delivery uncertain; inspect backend history before reopening` | A previous turn on this instance failed or was cancelled. Close it and open the agent again. |
| `History edits, replay, and regeneration are not supported` | `messages` does not extend what was sent. Build on `agent.transcript`. |
| `Conversation has unfinished work or is offline` | The conversation still has a run or prompt in progress on the backend. Wait, or inspect it; it is never repaired automatically. |
| Tool result `{"error":"interaction_unavailable"}` | No interaction handler is connected (or it threw, or answered invalidly). Connect one; see [section 6](#6-human-in-the-loop). |
| Tool result `{"error":"tool_timeout"}` | The handler exceeded `toolTimeoutMs` (default 5 s). Raise it, or make the tool faster. |
| Tool result `{"error":"tool_failed"}` | The handler threw, or returned more than 16,000 characters. Return errors as data; keep results small. |
| Tool result `{"error":"duplicate_or_limit"}` | A call ID was repeated, or an opened agent reached 100 application tool calls. Close and reopen the agent (restart, or switch conversation). |
| The model never calls your tool | The tool is missing from `tools`, is `'deny'`, or its description and the instructions do not say when to use it. The tool traces (`<state>/tool-traces/`) record every call by tool name and status. |
| `The terminal UI requires an interactive terminal (TTY)` | Run the TUI in a real terminal; use `--list` or code otherwise. |
| `Web assets not found in ...` | Build the browser app: `npm run build --workspace @ai-sdk-letta/web`. |
