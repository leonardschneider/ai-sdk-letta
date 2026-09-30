/** Offline: real LettaAgent stream adapter + tool bridge + patched TUI renderer. Never contacts Letta. */
import { runAgentTUI } from '@ai-sdk/tui';
import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { LettaAgent, ToolInteractions, createToolBridge } from 'ai-sdk-letta';
import { tools as registry, permissions } from './tools.js';
const interactions = new ToolInteractions();
const sent: string[] = [];
const results: unknown[] = [];
let executions = 0;
let aborts = 0;
let input = '';
let currentSignal: AbortSignal | undefined;
const bridge = createToolBridge({
  interactions, get signal() { return currentSignal; }, permissions, persist: () => {},
  tools: { ...registry, approval_demo: { ...registry.approval_demo, execute: async () => { executions++; return { acknowledged: true }; } } },
});
const agent = new LettaAgent({ id: 'interaction-fixture', tools: registry, interactions, open: signal => {
  currentSignal = signal;
  return {
    send: async message => { input = String(message); sent.push(input); }, abort: async () => { aborts++; }, close: () => {},
    async *stream() {
      if (input === 'clarify' || input === 'normal answer') {
        yield { type: 'assistant', content: input === 'clarify' ? 'Which audience should I use?' : 'CLARIFICATION_ACCEPTED', uuid: 'clarification' } as SDKMessage;
      } else if (input === 'concurrent') {
        const calls = ['FIRST_CONCURRENT', 'SECOND_CONCURRENT'].map((message, index) => ({ id: `parallel-${index}`, args: { message } }));
        for (const call of calls) yield { type: 'tool_call', toolCallId: call.id, toolName: 'approval_demo', toolInput: call.args, uuid: call.id } as SDKMessage;
        const outputs = await Promise.all(calls.map(call => bridge.execute('approval_demo', call.id, call.args, signal)));
        for (const [index, output] of outputs.entries()) {
          results.push(JSON.parse(output.content[0].text));
          yield { type: 'tool_result', toolCallId: calls[index].id, content: output.content[0].text, isError: output.isError, uuid: `return-${index}` } as SDKMessage;
        }
        yield { type: 'assistant', content: `TURNDONE${sent.length}`, uuid: 'parallel-done' } as SDKMessage;
      } else {
        const question = input.startsWith('question');
        const name = question ? 'ask_user' : 'approval_demo';
        const args = question ? { question: `QUESTION_${input}`, options: input === 'question free' ? [] : [{ id: 'one', label: 'First choice' }, { id: 'two', label: 'Second choice' }], multiSelect: input === 'question multi', allowFreeText: true } : { message: `APPROVAL_${input}` };
        const id = `call-${sent.length}`;
        yield { type: 'tool_call', toolCallId: id, toolName: name, toolInput: args, uuid: `tool-${id}` } as SDKMessage;
        const result = await bridge.execute(name, id, args, signal);
        results.push(JSON.parse(result.content[0].text));
        yield { type: 'tool_result', toolCallId: id, content: result.content[0].text, isError: result.isError, uuid: `result-${id}` } as SDKMessage;
        yield { type: 'assistant', content: `TURNDONE${sent.length}`, uuid: `text-${id}` } as SDKMessage;
      }
      yield { type: 'result', success: true, uuid: 'done', durationMs: 1, conversationId: 'default' } as SDKMessage;
    },
  };
} });
try { await runAgentTUI({ agent, title: 'Interactions fixture', interaction: interactions, tools: 'full' }); }
finally { agent.close(); }
console.log(`SENT=${JSON.stringify(sent)}`);
console.log(`RESULTS=${JSON.stringify(results)}`);
console.log(`EXECUTIONS=${executions};ABORTS=${aborts}`);
