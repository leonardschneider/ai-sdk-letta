import React, { useEffect, useState } from 'react';
import { serverApi, type AgentInfo } from './api.js';
import { useToast } from './toasts.js';

/** What `GET …/tool-limit` returns. */
type ToolLimit = { toolCallLimit: number | null; default: number; min: number; max: number };
/** The choices offered (plus the current value, when it is another one). */
export const TOOL_LIMIT_CHOICES = [25, 50, 100, 200, 500, 1000];

/** The settings' "Tool calls per turn": how many before the agent asks you for as many more. */
export function ToolLimitPanel({ agent }: { agent: AgentInfo }) {
  const toast = useToast();
  const path = agent.adopted ? `/adoption/agents/${encodeURIComponent(agent.id)}/tool-limit` : '/tool-limit';
  const [data, setData] = useState<ToolLimit>();
  const [problem, setProblem] = useState('');
  useEffect(() => { void serverApi<ToolLimit>(path, undefined, 'GET').then(setData, () => setProblem('Couldn’t load the tool call limit.')); }, [path]);
  if (!data) return problem ? <p className="form-error">{problem}</p> : null;
  const current = data.toolCallLimit ?? data.default;
  const choices = [...new Set([...TOOL_LIMIT_CHOICES, current])].filter(n => n >= data.min && n <= data.max).sort((a, b) => a - b);
  const save = async (value: number) => {
    setProblem('');
    try {
      setData(await serverApi<ToolLimit>(path, { toolCallLimit: value === data.default ? null : value }, 'PUT'));
      toast(`Up to ${value} tool calls per turn before ${agent.name} asks you for more.`);
    } catch { setProblem('Couldn’t save. Nothing was changed.'); }
  };
  return <div className="voice-policy">
    <label className="voice-model-pick"><span>Tool calls per turn</span>
      <select className="member-role" value={current} disabled={!!agent.viewOnly} onChange={event => void save(Number(event.target.value))}>
        {choices.map(n => <option key={n} value={n}>{n}{n === data.default ? ' (default)' : ''}</option>)}
      </select>
    </label>
    <span className="adopt-meta">When a turn reaches this many tool calls, {agent.name} pauses and asks you whether to allow as many more (you can allow more again later in the same turn) or stop there. Automations stop at the limit. Inner voices don’t count. Applies from the next turn.</span>
    {problem && <p className="form-error">{problem}</p>}
  </div>;
}
