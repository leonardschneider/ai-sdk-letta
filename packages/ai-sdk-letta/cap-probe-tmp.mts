// Does a foreground external tool survive more than 5 minutes? Requests timeout_ms 900000, then (rejected?) falls back.
import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';
import { rmSync } from 'node:fs';
const client = new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'local', requestTimeoutMs: 1_200_000 } });
const id = await client.createAgent({ name: 'ws-cap-probe-throwaway', model: 'openai-codex/gpt-5.5', memfs: false, hidden: true, baseTools: [], skillSources: [], systemPrompt: 'Call slow_wait exactly once, then report its result verbatim.', cwd: '/tmp/ws-cap' } as any);
console.log('agent', id);
const t0 = Date.now();
const tool = { name: 'slow_wait', label: 'slow_wait', description: 'Waits a long time.', parameters: { type: 'object', properties: {} }, execute: async () => { console.log('tool started', (Date.now() - t0) / 1000); await new Promise(r => setTimeout(r, 330_000)); console.log('tool returning', (Date.now() - t0) / 1000); return { content: [{ type: 'text', text: 'WAITED' }], isError: false }; } };
const s: any = client.resumeSession(id, { stateless: true, cwd: '/tmp/ws-cap', toolset: { base: 'none' }, allowedTools: ['slow_wait'], tools: [tool], permissionMode: 'strict', skillSources: [], canUseTool: async () => ({ behavior: 'allow' }) } as any);
try {
  const r = await s.ready();
  for (const timeout_ms of [900_000, 300_000]) {
    const res = await s.sendCommand({ type: 'runtime_external_tools_update', updates: [{ runtimes: [{ agent_id: r.agentId, conversation_id: r.conversationId }], external_tools: [{ tools: [{ name: 'slow_wait', label: 'slow_wait', description: 'Waits a long time.', parameters: { type: 'object', properties: {} }, auto_background: false, timeout_ms }] }] }] }, { responseType: 'runtime_external_tools_update_response', timeoutMs: 30_000 }).catch((e: any) => ({ error: String(e) }));
    console.log('timeout_ms', timeout_ms, JSON.stringify(res).slice(0, 300));
    if ((res as any).success === true) break;
  }
  await s.send('Go.');
  for await (const m of s.stream()) { if (['tool_call', 'tool_result', 'result', 'error'].includes(m.type)) console.log((Date.now() - t0) / 1000, m.type, JSON.stringify(m).slice(0, 300)); }
} finally { s.close(); await client.agents.delete(id); rmSync(`${process.env.HOME}/.letta/lc-local-backend/memfs/${id}`, { recursive: true, force: true }); console.log('deleted', id); await client.close(); }
