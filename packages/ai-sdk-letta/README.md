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
- `ToolInteractions`: the broker for approvals and `ask_user` questions.
- `createToolBridge`, `askUserTool`, `fileTraceWriter`: the tool policy layer.
- `resolveStateDirectory`, `acquireIdentity`, history and navigation helpers.

See the [repository README](https://github.com/leonardschneider/ai-sdk-letta#readme) for prerequisites, the security
model, state and identity, and limitations. License: Apache-2.0.
