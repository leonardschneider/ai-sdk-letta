# ai-sdk-letta

A persistent, Letta-backed Vercel AI SDK `Agent` with memory, dreaming,
application-owned tools and human-in-the-loop. Unofficial; not affiliated with
Letta or Vercel.

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
- `LettaAgent`: the AI SDK `Agent` (`generate`, `stream`, `interactions`, `presentation`, `close`).
- `ToolInteractions`: the broker for approvals and `ask_user` questions.
- `createToolBridge`, `askUserTool`, `fileTraceWriter`: the tool policy layer.
- `resolveStateDirectory`, `acquireIdentity`, history and navigation helpers.

See the [repository README](../../README.md) for prerequisites, the security
model, state and identity, and limitations. License: Apache-2.0.
