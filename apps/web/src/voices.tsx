import React, { createContext, useContext, useEffect, useState } from 'react';
import { ChevronRight, LoaderCircle, Sparkles } from 'lucide-react';
import { serverApi, type AgentInfo } from './api.js';
import type { Reflection, ReflectionOutcome } from './messages.js';
import { useToast } from './toasts.js';

/**
 * The inner voices Ambition and Prudence in the app. When they are on, they
 * review a reply's draft within the turn and the agent reflects on their
 * notes: under the draft, a muted "reviewing" then "Reflecting…" line; then
 * the reply shows only the final answer, with a collapsed "Revised (or Kept)
 * after Ambition & Prudence" line holding the draft, both notes side by side
 * and the reflection's tool calls. Also the settings' "Inner voices" section.
 */

export type VoiceName = 'ambition' | 'prudence';
export type VoiceNote = { points: string[]; confidence: 'low' | 'medium' | 'high'; suggestion?: string; model?: string; costUsd?: number } | { error: string };
export type RunCounsel = { at: string; notes: Partial<Record<VoiceName, VoiceNote>>; outcome: ReflectionOutcome; draft?: string; reason?: 'no_notes' | 'stopped' };

/** The conversation's voices: whether any is on, and the stored reviews by run. */
export type VoicesState = { enabled: boolean; counsels: Record<string, RunCounsel> };
export const VoicesContext = createContext<VoicesState>({ enabled: false, counsels: {} });

const LABEL: Record<VoiceName, string> = { ambition: 'Ambition', prudence: 'Prudence' };
const FAILED: Record<string, string> = { voice_timeout: 'took too long', voice_invalid: 'answered in a form the app could not read', voice_unsafe: 'was stopped (unexpected tool use)', voice_cancelled: 'was stopped' };

/**
 * What the line under a reply shows: `reviewing` / `reflecting` while the
 * turn runs, then `kept` / `revised` (or `notes`: the reflection was skipped
 * but notes exist), else `none`.
 */
export function voicesLine(reflection: Reflection | undefined, counsel: RunCounsel | undefined): 'reviewing' | 'reflecting' | 'kept' | 'revised' | 'notes' | 'none' {
  if (reflection?.state === 'reviewing') return 'reviewing';
  if (reflection?.state === 'reflecting') return 'reflecting';
  const outcome = reflection?.outcome ?? counsel?.outcome;
  if (outcome === 'kept' || outcome === 'revised') return outcome;
  return counsel && Object.values(counsel.notes).some(note => note && !('error' in note)) ? 'notes' : 'none';
}

/** Under an assistant reply: the review's progress, then the collapsed section (draft, notes, the reflection's tool lines). */
export function ReplyVoices({ runId, reflection, tools }: { runId: string | undefined; reflection: Reflection | undefined; tools?: React.ReactNode }) {
  const state = useContext(VoicesContext);
  const [open, setOpen] = useState(false);
  const counsel = runId ? state.counsels[runId] : undefined;
  const shown = voicesLine(reflection, counsel);
  if (shown === 'none') return null;
  if (shown === 'reviewing' || shown === 'reflecting') return <div className="voices" aria-live="polite"><span className="voices-thinking"><LoaderCircle size={13} className="spin" aria-hidden="true"/>{shown === 'reviewing' ? <>Ambition &amp; Prudence are reviewing…</> : 'Reflecting…'}</span></div>;
  const draft = reflection?.draft ?? counsel?.draft;
  const label = shown === 'revised' ? 'Revised after Ambition & Prudence' : shown === 'kept' ? 'Kept after Ambition & Prudence' : 'Ambition & Prudence weighed in';
  return <div className="voices" data-open={open || undefined}>
    <button type="button" className="voices-line" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <Sparkles size={13} aria-hidden="true"/><span>{label}</span><ChevronRight size={13} className="voices-chevron" aria-hidden="true"/>
    </button>
    {open && <div className="voices-open">
      {shown === 'revised' && draft && <div className="voices-draft"><span className="voices-draft-label">First draft</span><p>{draft}</p></div>}
      {counsel && <div className="voices-notes">
        {(['ambition', 'prudence'] as const).filter(name => counsel.notes[name]).map(name => <VoiceCard key={name} name={name} note={counsel.notes[name]!}/>)}
      </div>}
      {tools && <div className="voices-tools">{tools}</div>}
      <p className="voices-foot">{shown === 'revised' ? 'The agent reflected on these advisory notes and revised its reply.' : shown === 'kept' ? 'The agent reflected on these advisory notes and kept its reply.' : counsel?.reason === 'stopped' ? 'The reply was stopped before the agent reflected on these notes.' : 'Advisory notes.'}</p>
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
    <label className="voice-speak-after"><span>Review</span>
      <select className="member-role" value={data.speakAfter ?? 'every'} disabled={saving || !!agent.viewOnly} onChange={event => void put({ speakAfter: event.target.value }, event.target.value === 'long' ? 'They review only long turns.' : 'They review every reply.')}>
        <option value="every">Every reply</option>
        <option value="long">Only long turns (a tool call, or 30 s or more)</option>
      </select>
      <span className="adopt-meta">Each voice that is on reviews the reply’s draft on its own model; then the agent takes one more step to reflect on their notes (keep or revise). Both cost tokens and time on every reply they review. “Only long turns” skips quick chat replies.</span>
    </label>
    {problem && <p className="form-error">{problem}</p>}
  </div>;
}
