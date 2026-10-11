import React, { createContext, useContext, useEffect, useState } from 'react';
import { ChevronRight, LoaderCircle, Sparkles } from 'lucide-react';
import { api, ApiError, serverApi, type AgentInfo } from './api.js';
import { useToast } from './toasts.js';

/**
 * The inner voices Ambition and Prudence in the app: "Ask Ambition & Prudence"
 * under a finished reply (when they are on), the collapsed "weighed in" line
 * with both notes side by side, and the settings' "Inner voices" section.
 */

export type VoiceName = 'ambition' | 'prudence';
export type VoiceNote = { points: string[]; confidence: 'low' | 'medium' | 'high'; suggestion?: string; model?: string; costUsd?: number } | { error: string };
export type RunCounsel = { at: string; notes: Partial<Record<VoiceName, VoiceNote>>; delivered?: string };

/** The conversation's voices: which are on, the stored counsels by run, and asking for one. */
export type VoicesState = { enabled: boolean; counsels: Record<string, RunCounsel>; asking: Set<string>; ask(runId: string): void };
export const VoicesContext = createContext<VoicesState>({ enabled: false, counsels: {}, asking: new Set(), ask() {} });

const LABEL: Record<VoiceName, string> = { ambition: 'Ambition', prudence: 'Prudence' };
const FAILED: Record<string, string> = { voice_timeout: 'took too long', voice_invalid: 'answered in a form the app could not read', voice_unsafe: 'was stopped (unexpected tool use)' };

/** Ask the voices about a run of the thread (`POST /v1/threads/:id/runs/:runId/counsel`). */
export async function askCounsel(threadId: string, runId: string) {
  return api<{ runId: string; counsel: RunCounsel }>(`/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/counsel`, {});
}
export function counselError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : '';
  return code === 'voices_off' ? 'Ambition and Prudence are off for this agent (Settings → Inner voices).'
    : code === 'run_not_finished' ? 'The voices weigh in on finished replies only.'
      : code === 'counsel_running' ? 'They are already weighing in on this reply.' : 'Couldn’t ask Ambition & Prudence. Nothing was changed.';
}

/** Under a finished assistant reply: the action, or the collapsed notes. */
export function ReplyVoices({ runId }: { runId: string | undefined }) {
  const { enabled, counsels, asking, ask } = useContext(VoicesContext);
  const [open, setOpen] = useState(false);
  if (!runId) return null;
  const counsel = counsels[runId];
  if (counsel) return <div className="voices" data-open={open || undefined}>
    <button type="button" className="voices-line" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <Sparkles size={13} aria-hidden="true"/><span>Ambition &amp; Prudence weighed in</span><ChevronRight size={13} className="voices-chevron" aria-hidden="true"/>
    </button>
    {open && <div className="voices-notes">
      {(['ambition', 'prudence'] as const).filter(name => counsel.notes[name]).map(name => <VoiceCard key={name} name={name} note={counsel.notes[name]!}/>)}
      <p className="voices-foot">Advisory notes{counsel.delivered ? '; the agent saw them in its next turn' : '; the agent sees them with your next message'}.</p>
    </div>}
  </div>;
  if (!enabled) return null;
  const busy = asking.has(runId);
  return <div className="voices">
    <button type="button" className="voices-ask" disabled={busy} onClick={() => ask(runId)}>
      {busy ? <LoaderCircle size={13} className="spin" aria-hidden="true"/> : <Sparkles size={13} aria-hidden="true"/>}
      <span>{busy ? 'Ambition & Prudence are weighing in…' : 'Ask Ambition & Prudence'}</span>
    </button>
  </div>;
}

function VoiceCard({ name, note }: { name: VoiceName; note: VoiceNote }) {
  return <section className="voice-card" data-voice={name} aria-label={LABEL[name]}>
    <header><strong>{LABEL[name]}</strong>{'error' in note ? null : <span className="voice-confidence">{note.confidence} confidence</span>}</header>
    {'error' in note ? <p className="voice-failed">{LABEL[name]} {FAILED[note.error] ?? 'couldn’t answer'}.</p> : <>
      <ul>{note.points.map((point, i) => <li key={i}>{point}</li>)}</ul>
      {note.suggestion && <p className="voice-suggestion"><span>Suggestion</span>{note.suggestion}</p>}
      {note.model && <p className="voice-model">{note.model}</p>}
    </>}
  </section>;
}

/* ------------------------------------------------------------------ */
/* Settings: Inner voices                                              */
/* ------------------------------------------------------------------ */

type Setting = { enabled: boolean; model: string };
type ModelChoice = { handle: string; label: string; providerLabel: string };
type Loaded = Record<VoiceName, Setting> & { models: ModelChoice[] };

const BLURB: Record<VoiceName, string> = {
  ambition: 'Confident and daring: wants success, recognition and achievement. Looks for the upside, bigger goals, finishing and publishing.',
  prudence: 'Critical and careful: wants to avoid mistakes and shame. Sees what could go wrong, weak evidence and risks; wants checks and smaller steps.',
};

/** The "Inner voices" section: each voice on or off, and its model (auto: another family than the agent's). */
export function VoicesPanel({ agent, onSaved }: { agent: AgentInfo; onSaved(): void }) {
  const toast = useToast();
  const path = agent.adopted ? `/adoption/agents/${encodeURIComponent(agent.id)}/voices` : '/voices';
  const [data, setData] = useState<Loaded>();
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { void serverApi<Loaded>(path).then(setData, () => setProblem('Couldn’t load the inner voices.')); }, [path]);
  const save = async (name: VoiceName, setting: Setting) => {
    if (!data) return;
    setSaving(true); setProblem('');
    try {
      const saved = await serverApi<Record<VoiceName, Setting>>(path, { [name]: setting }, 'PUT');
      setData({ ...data, ...saved });
      toast(`${LABEL[name]} ${setting.enabled ? 'on' : 'off'}${setting.enabled ? `, model ${setting.model === 'auto' ? 'automatic' : setting.model}` : ''}.`);
      onSaved();
    } catch { setProblem('Couldn’t save. Nothing was changed.'); }
    finally { setSaving(false); }
  };
  if (!data) return problem ? <p className="form-error">{problem}</p> : <p className="adopt-meta">Loading…</p>;
  const groups = new Map<string, ModelChoice[]>();
  for (const model of data.models) groups.set(model.providerLabel, [...(groups.get(model.providerLabel) ?? []), model]);
  return <div className="voices-settings">
    {(['ambition', 'prudence'] as const).map(name => <div key={name} className="voice-setting" data-voice={name}>
      <label className="settings-switch">
        <input type="checkbox" role="switch" checked={data[name].enabled} disabled={saving || !!agent.viewOnly} onChange={event => void save(name, { ...data[name], enabled: event.target.checked })}/>
        <span><strong>{LABEL[name]}</strong><span className="adopt-meta">{BLURB[name]}</span></span>
      </label>
      <label className="voice-model-pick"><span>Model</span>
        <select className="member-role" value={data[name].model} disabled={saving || !!agent.viewOnly} onChange={event => void save(name, { ...data[name], model: event.target.value })}>
          <option value="auto">Auto (another model family)</option>
          {[...groups].map(([provider, models]) => <optgroup key={provider} label={provider}>{models.map(m => <option key={m.handle} value={m.handle}>{m.label}</option>)}</optgroup>)}
          {data[name].model !== 'auto' && !data.models.some(m => m.handle === data[name].model) && <option value={data[name].model}>{data[name].model}</option>}
        </select>
      </label>
    </div>)}
    {problem && <p className="form-error">{problem}</p>}
  </div>;
}
