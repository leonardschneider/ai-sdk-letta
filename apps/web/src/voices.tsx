import React, { createContext, useContext, useEffect, useState } from 'react';
import { ChevronRight, LoaderCircle, RotateCw, Sparkles } from 'lucide-react';
import { api, ApiError, serverApi, type AgentInfo } from './api.js';
import { useToast } from './toasts.js';

/**
 * The inner voices Ambition and Prudence in the app: they weigh in on their own
 * after a finished reply (when they are on). Under it: a muted "thinking" line
 * while they write, then the collapsed "weighed in" line with both notes side
 * by side and "Ask again"; and the settings' "Inner voices" section.
 */

export type VoiceName = 'ambition' | 'prudence';
export type VoiceNote = { points: string[]; confidence: 'low' | 'medium' | 'high'; suggestion?: string; model?: string; costUsd?: number } | { error: string };
export type RunCounsel = { at: string; notes: Partial<Record<VoiceName, VoiceNote>>; delivered?: string; auto?: boolean; late?: boolean };

/** The conversation's voices: which are on, the stored counsels by run, the runs they are weighing on their own (`thinking`) or on request (`asking`), and asking again. */
export type VoicesState = { enabled: boolean; counsels: Record<string, RunCounsel>; asking: Set<string>; thinking?: Set<string>; ask(runId: string): void };
export const VoicesContext = createContext<VoicesState>({ enabled: false, counsels: {}, asking: new Set(), thinking: new Set(), ask() {} });

const LABEL: Record<VoiceName, string> = { ambition: 'Ambition', prudence: 'Prudence' };
const FAILED: Record<string, string> = { voice_timeout: 'took too long', voice_invalid: 'answered in a form the app could not read', voice_unsafe: 'was stopped (unexpected tool use)' };

/** Ask the voices about a run of the thread (`POST /v1/threads/:id/runs/:runId/counsel`). */
export async function askCounsel(threadId: string, runId: string) {
  return api<{ runId: string; counsel: RunCounsel }>(`/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/counsel`, {});
}
/** The thread's notes and the runs being weighed now (`GET /v1/threads/:id/counsels`). */
export async function fetchCounsels(threadId: string) {
  return api<{ counsels: Record<string, RunCounsel>; pending: string[] }>(`/v1/threads/${encodeURIComponent(threadId)}/counsels`);
}
/** What the line under a reply shows: the notes, "thinking", or nothing (no notes and none coming). */
export function voicesLine(state: Pick<VoicesState, 'counsels' | 'asking' | 'thinking'>, runId: string | undefined): 'notes' | 'thinking' | 'none' {
  if (!runId) return 'none';
  if (state.asking.has(runId) || state.thinking?.has(runId)) return 'thinking';
  return state.counsels[runId] ? 'notes' : 'none';
}
export function counselError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : '';
  return code === 'voices_off' ? 'Ambition and Prudence are off for this agent (Settings → Inner voices).'
    : code === 'run_not_finished' ? 'The voices weigh in on finished replies only.'
      : code === 'counsel_running' ? 'They are already weighing in on this reply.' : 'Couldn’t ask Ambition & Prudence. Nothing was changed.';
}

/** Under a finished assistant reply: "thinking" while the voices write, then the collapsed notes with "Ask again". */
export function ReplyVoices({ runId }: { runId: string | undefined }) {
  const state = useContext(VoicesContext);
  const [open, setOpen] = useState(false);
  const shown = voicesLine(state, runId);
  if (shown === 'thinking') return <div className="voices"><span className="voices-thinking"><LoaderCircle size={13} className="spin" aria-hidden="true"/>Ambition &amp; Prudence are thinking…</span></div>;
  if (shown === 'none') return null;
  const counsel = state.counsels[runId!]!;
  return <div className="voices" data-open={open || undefined}>
    <button type="button" className="voices-line" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <Sparkles size={13} aria-hidden="true"/><span>Ambition &amp; Prudence weighed in</span><ChevronRight size={13} className="voices-chevron" aria-hidden="true"/>
    </button>
    {open && <div className="voices-notes">
      {(['ambition', 'prudence'] as const).filter(name => counsel.notes[name]).map(name => <VoiceCard key={name} name={name} note={counsel.notes[name]!}/>)}
      <p className="voices-foot">Advisory notes{counsel.delivered ? '; the agent saw them in its next turn' : counsel.late ? '; they came after the next turn had started, so the agent did not see them' : '; the agent sees them with your next message'}.
        {state.enabled && <button type="button" className="voices-ask" onClick={() => state.ask(runId!)}><RotateCw size={12} aria-hidden="true"/><span>Ask again</span></button>}</p>
    </div>}
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
type SpeakAfter = 'every' | 'long';
type Loaded = Record<VoiceName, Setting> & { speakAfter?: SpeakAfter; models: ModelChoice[] };

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
  const put = async (body: Record<string, unknown>, done: string) => {
    if (!data) return;
    setSaving(true); setProblem('');
    try {
      const saved = await serverApi<Record<VoiceName, Setting> & { speakAfter?: SpeakAfter }>(path, body, 'PUT');
      setData({ ...data, ...saved });
      toast(done);
      onSaved();
    } catch { setProblem('Couldn’t save. Nothing was changed.'); }
    finally { setSaving(false); }
  };
  const save = (name: VoiceName, setting: Setting) => put({ [name]: setting }, `${LABEL[name]} ${setting.enabled ? 'on' : 'off'}${setting.enabled ? `, model ${setting.model === 'auto' ? 'automatic' : setting.model}` : ''}.`);
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
    <label className="voice-speak-after"><span>Speak after</span>
      <select className="member-role" value={data.speakAfter ?? 'every'} disabled={saving || !!agent.viewOnly} onChange={event => void put({ speakAfter: event.target.value }, event.target.value === 'long' ? 'They speak only after long turns.' : 'They speak after every reply.')}>
        <option value="every">Every reply</option>
        <option value="long">Only long turns (a tool call, or 30 s or more)</option>
      </select>
      <span className="adopt-meta">Each voice that is on runs once per reply it weighs in on, on its own model: it costs tokens every time. “Only long turns” skips quick chat replies.</span>
    </label>
    {problem && <p className="form-error">{problem}</p>}
  </div>;
}
