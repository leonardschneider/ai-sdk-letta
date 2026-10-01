/** Offline PTY fixture: real patched TUI + real LettaAgent whose stream reports a run_command call; no backend, model or container. */
import { runAgentTUI } from '@ai-sdk/tui';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { LettaAgent, sandboxTools } from 'ai-sdk-letta';
import { toolView } from '../../src/tool-view.js';

const command = "python3 - <<'PY'\nprint('sample_std_units', 34.6777)\nPY";
const output = `Exit code: 0 (42 ms)\nsample_std_units 34.6777\n${Array.from({ length: 12 }, (_, i) => `row_${i + 1}`).join('\n')}`;
const agent = new LettaAgent({ id: 'commands-fixture', tools: { ...sandboxTools }, open: () => ({
  send: async () => {}, abort: async () => {}, close: () => {},
  async *stream() {
    yield { type: 'tool_call', toolCallId: 'call-1', toolName: 'run_command', toolInput: { command }, uuid: 't' } as SDKMessage;
    yield { type: 'tool_result', toolCallId: 'call-1', content: output, isError: false, uuid: 'tr' } as SDKMessage;
    yield { type: 'tool_call', toolCallId: 'call-2', toolName: 'run_command', toolInput: { command: 'ls missing-folder' }, uuid: 't2' } as SDKMessage;
    yield { type: 'tool_result', toolCallId: 'call-2', content: 'Exit code: 2 (5 ms)\n[stderr]\nls: cannot access missing-folder', isError: false, uuid: 'tr2' } as SDKMessage;
    yield { type: 'assistant', content: 'DONE_REPLY', uuid: 'a' } as SDKMessage;
    yield { type: 'result', success: true, uuid: 'r', durationMs: 1, conversationId: 'conv-fixture' } as SDKMessage;
  },
}) });
await runAgentTUI({ agent, title: 'Commands fixture', tools: 'full', reasoning: 'hidden', toolView });
agent.close();
