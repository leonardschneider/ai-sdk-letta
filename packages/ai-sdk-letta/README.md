# ai-sdk-letta

A persistent, Letta-backed Vercel AI SDK `Agent` with memory, dreaming,
application-owned tools and human-in-the-loop. Unofficial; not affiliated with
Letta or Vercel.

```sh
npm install ai-sdk-letta ai
```

Needs Node.js 22.19+, the Letta CLI and a local Letta backend with a connected
model ([prerequisites](https://github.com/leonardschneider/ai-sdk-letta#prerequisites)).

```ts
import { askUserTool, createLettaAgent, defineAgent } from 'ai-sdk-letta';

const definition = defineAgent({ id: 'my-agent', name: 'My Agent', model: 'openai-codex/gpt-5.5',
  instructions: 'Be helpful.', tools: { ask_user: askUserTool }, permissions: { ask_user: 'allow' } });
const { agent, close } = await createLettaAgent(definition);
```

Main exports:

- `defineAgent(input)`: validate a definition (fail-closed permissions).
- `openLettaAgent(definition, options)` / `createLettaAgent(...)`: open or
  create the agent on the local Letta backend; returns `{ agent, identity, navigation, close }`.
- `LettaAgent`: the AI SDK `Agent` (`generate`, `stream`, `interactions`, `presentation`, `transcript`, `close`).
  User turns may include images (`image`/`file` parts), sent as Letta `ImageContent`.
- `IMAGE_LIMITS`, `ImageInputError`, `validateImages`, `decodeImagePart`: image validation (PNG, JPEG, GIF, WebP).
- `fileTools`, `FILE_TOOL_PERMISSIONS`: opt-in `list_files`, `read_file`, `search_files`, bound to the
  current conversation's attachment folder. With them, user turns may carry `file` parts (PDF, text,
  Markdown, CSV, JSON, code), stored per conversation and announced by a short "Attached: ..." note.
- `AttachmentStore`, `UploadStaging`, `FILE_LIMITS`, `FileInputError`, `detectFileType`, `extractPdfText`:
  the storage, validation and PDF layer (unpdf, pure JavaScript).
- `sandboxTools`, `SANDBOX_TOOL_PERMISSIONS` and the definition's `sandbox` option: opt-in
  `run_command` (no network) and `run_command_online` (always asks) in an isolated sandbox per
  conversation, through the AI SDK `Experimental_SandboxSession`. Providers are optional peers:
  `@lgrammel/apple-container-sandbox` or `ai-sdk-sandbox-docker`, or your own factory.
- `SandboxManager`, `checkProjectFolder`, `gitConfigCredentials`, `detectSandboxProvider`, `prepareSandbox`:
  the sandbox lifecycle and safety checks.
- `ToolInteractions`: the broker for approvals and `ask_user` questions.
- `createToolBridge`, `askUserTool`, `fileTraceWriter`: the tool policy layer (it passes the bound
  sandbox to tools as `experimental_sandbox`).
- `resolveStateDirectory`, `acquireIdentity`, history and navigation helpers.

See the [repository README](https://github.com/leonardschneider/ai-sdk-letta#readme) for prerequisites, the security
model, state and identity, and limitations. License: Apache-2.0.
