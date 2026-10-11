import React, { createContext, useContext, useEffect, useState } from 'react';
import { ChevronRight, LoaderCircle, Sparkles } from 'lucide-react';
import { serverApi, type AgentInfo } from './api.js';
import type { Reflection, ReflectionOutcome } from './messages.js';
import { useToast } from './toasts.js';

/**
 * The inner voices Ambition and Prudence in the app. When they are on, they
 * review a reply's draft within the turn and the agent reflects on their
 * notes: under the draft, a muted "reviewing" then "Reflecting…" line; then
 * the reply shows only the final answer, with a collapsed "Revised 2× (or
 * Kept) after Ambition & Prudence" line holding each round (the version it
 * reviewed, both notes side by side, the outcome) and the reflections' tool
 * calls. The agent's choice shows too ("Debate: <reason>"), and a review it
 * skipped is a muted "Review skipped — <reason>" line. Also the settings'
 * "Inner voices" section.
 */

export type VoiceName = 'ambition' | 'prudence';
export type VoiceNote = { points: string[]; confidence: 'low' | 'medium' | 'high'; suggestion?: string; model?: string; costUsd?: number } | { error: string };
type Notes = Partial<Record<VoiceName, VoiceNote>>;
export type VoiceChoice = 'skip' | 'calibrated' | 'debate';
/** One review round: the notes on `text` (the draft, then each revision), and what the reflection did (`rebuttal`: a debate KEEP's one line). */
export type CounselRound = { notes: Notes; outcome: ReflectionOutcome; text: string; rebuttal?: string; reason?: 'no_notes' | 'stopped' };
export type RunCounsel = { at: string; notes: Notes; outcome: ReflectionOutcome; draft?: string; reason?: 'no_notes' | 'stopped' | 'agent_skipped';
  mode?: VoiceChoice; choice?: { mode: VoiceChoice; reason: string }; rounds?: CounselRound[]; revisions?: number };

/** The conversation's voices: whether any is on, and the stored reviews by run. */
export type VoicesState = { enabled: boolean; counsels: Record<string, RunCounsel> };
export const VoicesContext = createContext<VoicesState>({ enabled: false, counsels: {} });

const LABEL: Record<VoiceName, string> = { ambition: 'Ambition', prudence: 'Prudence' };
const FAILED: Record<string, string> = { voice_timeout: 'took too long', voice_invalid: 'answered in a form the app could not read', voice_unsafe: 'was stopped (unexpected tool use)', voice_cancelled: 'was stopped' };

/**
 * What the line under a reply shows: `reviewing` / `reflecting` while the
 * turn runs, then `kept` / `revised` (or `notes`: the reflection was skipped
 * but notes exist; `skipped`: the agent skipped the review this turn), else `none`.
 */
export function voicesLine(reflection: Reflection | undefined, counsel: RunCounsel | undefined): 'reviewing' | 'reflecting' | 'kept' | 'revised' | 'notes' | 'skipped' | 'none' {
  if (reflection?.state === 'reviewing') return 'reviewing';
  if (reflection?.state === 'reflecting') return 'reflecting';
  if (counsel?.reason === 'agent_skipped') return 'skipped';
  const outcome = reflection?.outcome ?? counsel?.outcome;
  if (outcome === 'kept' || outcome === 'revised') return outcome;
  return counsel && Object.values(counsel.notes).some(note => note && !('error' in note)) ? 'notes' : 'none';
}

/** The collapsed line's label: "Revised 2× after Ambition & Prudence", "Kept after…", then the agent's choice ("Debate: <reason>"). */
export function voicesLabel(shown: ReturnType<typeof voicesLine>, counsel: RunCounsel | undefined, reflection?: Reflection): string {
  if (shown === 'skipped') return `Skipped review: ${counsel?.choice?.reason ?? 'the agent skipped it'}`;
  const revisions = counsel?.revisions ?? reflection?.revisions ?? 1;
  const head = shown === 'revised' ? `Revised${revisions > 1 ? ` ${revisions}×` : ''} after Ambition & Prudence` : shown === 'kept' ? 'Kept after Ambition & Prudence' : 'Ambition & Prudence weighed in';
  const choice = counsel?.choice;
  if (choice?.mode === 'debate' && counsel?.mode === 'debate') return `${head} · Debate: ${choice.reason}`;
  if (choice?.mode === 'skip') return `${head} · Skip raised by your minimum (${choice.reason})`;
  if (choice) return `${head} · ${choice.mode === counsel?.mode ? 'Calibrated' : 'Chose ' + choice.mode}: ${choice.reason}`;
  return counsel?.mode === 'debate' ? `${head} · Debate` : head;
}

const OUTCOME: Record<ReflectionOutcome, string> = { kept: 'Kept', revised: 'Revised', skipped: 'Not reflected on' };

/** Under an assistant reply: the review's progress, then the collapsed section (each round: version, notes, outcome; the reflections' tool lines). */
export function ReplyVoices({ runId, reflection, tools }: { runId: string | undefined; reflection: Reflection | undefined; tools?: React.ReactNode }) {
  const state = useContext(VoicesContext);
  const [open, setOpen] = useState(false);
  const counsel = runId ? state.counsels[runId] : undefined;
  const shown = voicesLine(reflection, counsel);
  if (shown === 'none') return null;
  if (shown === 'reviewing' || shown === 'reflecting') return <div className="voices" aria-live="polite"><span className="voices-thinking"><LoaderCircle size={13} className="spin" aria-hidden="true"/>{shown === 'reviewing' ? <>Ambition &amp; Prudence are reviewing…</> : 'Reflecting…'}</span></div>;
  const label = voicesLabel(shown, counsel, reflection);
  // A review the agent skipped: one muted line, collapsed (its reason) like the rest.
  if (shown === 'skipped') return <div className="voices voices-skipped" data-open={open || undefined}>
    <button type="button" className="voices-line" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <Sparkles size={13} aria-hidden="true"/><span>{label}</span><ChevronRight size={13} className="voices-chevron" aria-hidden="true"/>
    </button>
    {open && <div className="voices-open"><p className="voices-foot">Review skipped — {counsel?.choice?.reason ?? 'the agent skipped it'}. The agent chose this for this turn only, within your bounds.</p></div>}
  </div>;
  const draft = reflection?.draft ?? counsel?.draft;
  const rounds = counsel?.rounds?.length ? counsel.rounds : undefined;
  return <div className="voices" data-open={open || undefined}>
    <button type="button" className="voices-line" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <Sparkles size={13} aria-hidden="true"/><span>{label}</span><ChevronRight size={13} className="voices-chevron" aria-hidden="true"/>
    </button>
    {open && <div className="voices-open">
      {rounds ? rounds.map((round, i) => <section key={i} className="voices-round" aria-label={`Round ${i + 1}`}>
        {(rounds.length > 1 || round.outcome === 'revised') && <div className="voices-draft"><span className="voices-draft-label">{i === 0 ? 'First draft' : `Revision ${i}`}</span><p>{round.text}</p></div>}
        <div className="voices-notes">{(['ambition', 'prudence'] as const).filter(name => round.notes[name]).map(name => <VoiceCard key={name} name={name} note={round.notes[name]!}/>)}</div>
        <p className="voices-outcome"><strong>{rounds.length > 1 ? `Round ${i + 1}: ` : ''}{OUTCOME[round.outcome]}</strong>{round.rebuttal ? <> — rebuttal: {round.rebuttal}</> : null}{round.reason === 'stopped' ? ' (stopped)' : round.reason === 'no_notes' ? ' (no voice answered)' : ''}</p>
      </section>) : <>
        {shown === 'revised' && draft && <div className="voices-draft"><span className="voices-draft-label">First draft</span><p>{draft}</p></div>}
        {counsel && <div className="voices-notes">
          {(['ambition', 'prudence'] as const).filter(name => counsel.notes[name]).map(name => <VoiceCard key={name} name={name} note={counsel.notes[name]!}/>)}
        </div>}
      </>}
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
type Minimum = 'none' | 'calibrated_if_tools' | 'calibrated' | 'debate';
type Policy = { decides?: 'agent' | 'fixed'; defaultMode?: VoiceChoice; minimum?: Minimum; maximum?: 'calibrated' | 'debate'; maxRevisions?: number };
type Loaded = Record<VoiceName, Setting> & Policy & { models: ModelChoice[] };

const BLURB: Record<VoiceName, string> = {
  ambition: 'Confident and daring: wants success, recognition and achievement. Looks for the upside, bigger goals, finishing and publishing. In debate, it defends the reply.',
  prudence: 'Critical and careful: wants to avoid mistakes and shame. Sees what could go wrong, weak evidence and risks; wants checks and smaller steps. In debate, it prosecutes with checkable objections.',
};
const RANK = { skip: 0, none: 0, calibrated_if_tools: 0, calibrated: 1, debate: 2 } as const;
/** Mirrors the server's check: minimum ≤ maximum, and the default between them. */
export function validPolicy(p: Required<Policy>): boolean {
  const low = p.minimum === 'calibrated_if_tools' ? 0 : RANK[p.minimum];
  return RANK[p.minimum] <= RANK[p.maximum] && RANK[p.defaultMode] >= low && RANK[p.defaultMode] <= RANK[p.maximum];
}
const policyOf = (data: Policy): Required<Policy> => ({ decides: data.decides ?? 'agent', defaultMode: data.defaultMode ?? 'calibrated', minimum: data.minimum ?? 'none', maximum: data.maximum ?? 'debate', maxRevisions: data.maxRevisions ?? 1 });

/** The "Inner voices" section: each voice on or off and its model (auto: another family than the agent's), and how turns are reviewed. */
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
      const saved = await serverApi<Record<VoiceName, Setting> & Policy>(path, body, 'PUT');
      setData({ ...data, ...saved });
      toast(done);
      onSaved();
    } catch { setProblem('Couldn’t save. Nothing was changed.'); }
    finally { setSaving(false); }
  };
  const save = (name: VoiceName, setting: Setting) => put({ [name]: setting }, `${LABEL[name]} ${setting.enabled ? 'on' : 'off'}${setting.enabled ? `, model ${setting.model === 'auto' ? 'automatic' : setting.model}` : ''}.`);
  if (!data) return problem ? <p className="form-error">{problem}</p> : <p className="adopt-meta">Loading…</p>;
  const policy = policyOf(data);
  // A change that would break the bounds moves the default (or the other bound) along, so the saved policy stays valid.
  const savePolicy = (change: Partial<Required<Policy>>, done: string) => {
    const next = { ...policy, ...change };
    if (RANK[next.minimum] > RANK[next.maximum]) { if (change.maximum) next.minimum = next.maximum; else next.maximum = next.minimum === 'debate' ? 'debate' : 'calibrated'; }
    const low = next.minimum === 'calibrated_if_tools' ? 0 : RANK[next.minimum];
    if (RANK[next.defaultMode] < low) next.defaultMode = next.minimum === 'debate' ? 'debate' : 'calibrated';
    if (RANK[next.defaultMode] > RANK[next.maximum]) next.defaultMode = next.maximum;
    if (!validPolicy(next)) { setProblem('Those bounds don’t fit together.'); return; }
    void put(next, done);
  };
  const disabled = saving || !!agent.viewOnly;
  const groups = new Map<string, ModelChoice[]>();
  for (const model of data.models) groups.set(model.providerLabel, [...(groups.get(model.providerLabel) ?? []), model]);
  return <div className="voices-settings">
    {(['ambition', 'prudence'] as const).map(name => <div key={name} className="voice-setting" data-voice={name}>
      <label className="settings-switch">
        <input type="checkbox" role="switch" checked={data[name].enabled} disabled={disabled} onChange={event => void save(name, { ...data[name], enabled: event.target.checked })}/>
        <span><strong>{LABEL[name]}</strong><span className="adopt-meta">{BLURB[name]}</span></span>
      </label>
      <label className="voice-model-pick"><span>Model</span>
        <select className="member-role" value={data[name].model} disabled={disabled} onChange={event => void save(name, { ...data[name], model: event.target.value })}>
          <option value="auto">Auto (another model family)</option>
          {[...groups].map(([provider, models]) => <optgroup key={provider} label={provider}>{models.map(m => <option key={m.handle} value={m.handle}>{m.label}</option>)}</optgroup>)}
          {data[name].model !== 'auto' && !data.models.some(m => m.handle === data[name].model) && <option value={data[name].model}>{data[name].model}</option>}
        </select>
      </label>
    </div>)}
    <div className="voice-policy">
      <label className="voice-model-pick"><span>Who decides</span>
        <select className="member-role" value={policy.decides} disabled={disabled} onChange={event => savePolicy({ decides: event.target.value as 'agent' | 'fixed' }, event.target.value === 'agent' ? 'The agent chooses the review per turn, within your bounds.' : 'Every turn uses the default mode.')}>
          <option value="agent" title="Agent decides (within bounds)">Agent decides</option>
          <option value="fixed">Fixed</option>
        </select>
      </label>
      <label className="voice-model-pick"><span>Default mode</span>
        <select className="member-role" value={policy.defaultMode} disabled={disabled} onChange={event => savePolicy({ defaultMode: event.target.value as VoiceChoice }, `Default: ${event.target.value}.`)}>
          <option value="skip">Skip</option>
          <option value="calibrated">Calibrated</option>
          <option value="debate">Debate</option>
        </select>
      </label>
      <label className="voice-model-pick"><span>Minimum</span>
        <select className="member-role" value={policy.minimum} disabled={disabled} onChange={event => savePolicy({ minimum: event.target.value as Minimum }, `Minimum: ${event.target.value.replace(/_/g, ' ')}.`)}>
          <option value="none">None</option>
          <option value="calibrated_if_tools" title="Calibrated if the turn used tools">If tools used</option>
          <option value="calibrated">Calibrated</option>
          <option value="debate">Debate</option>
        </select>
      </label>
      <label className="voice-model-pick"><span>Maximum</span>
        <select className="member-role" value={policy.maximum} disabled={disabled} onChange={event => savePolicy({ maximum: event.target.value as 'calibrated' | 'debate' }, `Maximum: ${event.target.value}.`)}>
          <option value="calibrated">Calibrated</option>
          <option value="debate">Debate</option>
        </select>
      </label>
      <label className="voice-model-pick"><span>Max revisions</span>
        <select className="member-role" value={policy.maxRevisions} disabled={disabled} onChange={event => savePolicy({ maxRevisions: Number(event.target.value) }, `Up to ${event.target.value} revision${event.target.value === '1' ? '' : 's'}.`)}>
          {[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <span className="adopt-meta">Calibrated: each voice reviews the draft on its own terms. Debate: Prudence argues against it with checkable objections and Ambition defends it; neither sees the other. With “Agent decides” (within these bounds), the agent picks skip, calibrated or debate per turn (it may only skip for that turn); the minimum raises its choice (“If tools used”: calibrated when the turn used a tool) and the maximum caps it. Cost: each round costs two voice calls plus an agent step; a revision is reviewed again, up to “Max revisions”.</span>
    </div>
    {problem && <p className="form-error">{problem}</p>}
  </div>;
}
