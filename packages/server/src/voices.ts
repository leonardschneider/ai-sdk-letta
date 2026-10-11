import express from 'express';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chooseReviewerModel, counsel, lettaVoice, sweepVoices, localBackendDirectory, statePaths, validVoiceBounds, MAX_REVISIONS, VOICES, VOICE_MODES, VOICE_MINIMUMS, type Counsel, type CounselRequest, type InnerVoice, type VoiceBounds, type VoiceMinimum, type VoiceMode, type VoiceName } from 'ai-sdk-letta';
import { BODY_LIMIT_BYTES } from './http.js';
import { MODEL_HANDLE, localModels } from './models.js';
import { RuntimeFault } from './runtime.js';

/**
 * The inner voices Ambition and Prudence (see `ai-sdk-letta`'s `voices.ts`)
 * as the server offers them: per-agent settings (each voice on or off, and
 * its model: `auto` picks another family than the agent's; the minimum (which
 * says whether the agent may skip), the highest stance and the most revision
 * rounds), and the counsellor a runtime asks. The agent consults them mid-turn
 * with `consult_voices` (when, what, the stance and which voice are its call),
 * or skips a turn with `skip_voices` when the minimum allows it; a turn that
 * does neither is reviewed at its end: they review the final reply, then the agent
 * reflects and keeps or revises it, up to `maxRevisions` rounds (see
 * `ThreadRuntime`). Both voices are off until the person turns them on.
 */

/** One voice's setting. */
export type VoiceSetting = { enabled: boolean; model: string };
/**
 * The person's policy: the minimum (`none`: the agent may skip any turn;
 * `calibrated_if_tools`: a turn without other tools; `calibrated`/`debate`:
 * never, and the stance is at least that), the highest stance, and how many
 * revision rounds an end-of-turn review may take.
 */
export type ReviewPolicy = VoiceBounds & { maxRevisions: number };
/** Both voices' settings and the review policy (see {@link ReviewPolicy}; defaults when absent). */
export type VoiceSettings = Record<VoiceName, VoiceSetting> & Partial<ReviewPolicy>;
/** The agent may skip; up to debate; one revision. */
export const DEFAULT_POLICY: Readonly<ReviewPolicy> = Object.freeze({ minimum: 'none', maximum: 'debate', maxRevisions: 1 });
/** Off, on the automatic model. */
export const DEFAULT_VOICES: VoiceSettings = Object.freeze({ ambition: Object.freeze({ enabled: false, model: 'auto' }), prudence: Object.freeze({ enabled: false, model: 'auto' }) }) as VoiceSettings;
/** The policy of settings (defaults filled in). */
export const reviewPolicy = (settings: VoiceSettings): ReviewPolicy => ({
  minimum: settings.minimum ?? DEFAULT_POLICY.minimum, maximum: settings.maximum ?? DEFAULT_POLICY.maximum, maxRevisions: settings.maxRevisions ?? DEFAULT_POLICY.maxRevisions,
});
/** Settings of earlier versions: still accepted as input, and migrated (or dropped). */
const OLD_KEYS = ['decides', 'defaultMode', 'speakAfter'];
const POLICY_KEYS = ['minimum', 'maximum', 'maxRevisions', ...OLD_KEYS];

/**
 * Validate settings (`{ ambition: { enabled, model }, prudence: { … },
 * minimum?, maximum?, maxRevisions? }`; anything left out keeps
 * `fallback`'s). The minimum's stance must not exceed the maximum. Earlier
 * settings are migrated: `decides` and `defaultMode` are accepted and dropped
 * (the agent decides within the minimum now); `speakAfter: 'long'` becomes
 * minimum `calibrated_if_tools` unless the input sets one.
 * @throws `RuntimeFault('invalid_input', 400)`
 */
export function checkVoiceSettings(input: unknown, fallback: VoiceSettings = DEFAULT_VOICES): VoiceSettings {
  const fail = (): never => { throw new RuntimeFault('invalid_input', 400); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some(k => !POLICY_KEYS.includes(k) && !(VOICES as readonly string[]).includes(k))) fail();
  const base = Object.fromEntries(Object.entries(fallback).filter(([key]) => !OLD_KEYS.includes(key))) as VoiceSettings;
  const result = { ...base } as VoiceSettings;
  if (o.decides !== undefined && o.decides !== 'agent' && o.decides !== 'fixed') fail();
  if (o.defaultMode !== undefined && !['skip', ...VOICE_MODES].includes(o.defaultMode as string)) fail();
  if (o.speakAfter !== undefined && o.speakAfter !== 'every' && o.speakAfter !== 'long') fail();
  if (o.speakAfter === 'long' && o.minimum === undefined) result.minimum = 'calibrated_if_tools';
  if (o.minimum !== undefined) { if (!VOICE_MINIMUMS.includes(o.minimum as VoiceMinimum)) fail(); result.minimum = o.minimum as VoiceMinimum; }
  if (o.maximum !== undefined) { if (!VOICE_MODES.includes(o.maximum as VoiceMode)) fail(); result.maximum = o.maximum as VoiceMode; }
  if (o.maxRevisions !== undefined) { if (!Number.isInteger(o.maxRevisions) || (o.maxRevisions as number) < 1 || (o.maxRevisions as number) > MAX_REVISIONS) fail(); result.maxRevisions = o.maxRevisions as number; }
  for (const name of VOICES) {
    const value = o[name];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(k => k !== 'enabled' && k !== 'model')) fail();
    if (typeof v.enabled !== 'boolean') fail();
    const model = v.model === undefined ? 'auto' : v.model;
    if (typeof model !== 'string' || (model !== 'auto' && !MODEL_HANDLE.test(model))) fail();
    result[name] = { enabled: v.enabled as boolean, model: model as string };
  }
  if (!validVoiceBounds(reviewPolicy(result))) fail();
  return result;
}
/** Settings as stored (migrated; anything malformed: the defaults). */
export function storedVoices(value: unknown): VoiceSettings {
  try { return checkVoiceSettings(value); } catch { return DEFAULT_VOICES; }
}
/** Which voices are on (for the app: show "Ask Ambition & Prudence"). */
export const enabledVoices = (settings: VoiceSettings): VoiceName[] => VOICES.filter(name => settings[name].enabled);

/** What a runtime asks: the voices that are on, the person's policy, and a counsel from them (in a mode). */
export interface RuntimeVoices {
  enabled(): VoiceName[];
  /** How turns are reviewed (default {@link DEFAULT_POLICY}). */
  policy?(): ReviewPolicy;
  /** Ask the voices that are on (or only `only`, those of them that are on). */
  ask(request: CounselRequest, signal?: AbortSignal, only?: readonly VoiceName[]): Promise<Counsel>;
}
/** Builds one voice on a model (tests replace it; the default is a temporary hidden Letta agent per call). */
export type VoiceFactory = (name: VoiceName, model: string, directory: string) => InnerVoice;
const lettaVoiceFactory: VoiceFactory = (voice, model, directory) => lettaVoice({ voice, model, directory, backendDirectory: localBackendDirectory() });

/**
 * The counsellor of one agent: reads its settings on every call, picks each
 * voice's model (`auto`: another family than `agentModel`'s, from the
 * backend's models), and asks the voices that are on in parallel.
 */
export function voiceCounsellor(options: { settings(): VoiceSettings; agentModel(): string; directory: string; available?: () => Promise<string[]>; voice?: VoiceFactory; timeoutMs?: number }): RuntimeVoices {
  const available = options.available ?? (() => localModels().then(models => models.map(m => m.handle), () => []));
  const make = options.voice ?? lettaVoiceFactory;
  // Temporary voice agents a crash left behind are removed before the first counsel (default voices only).
  let swept: Promise<unknown> | undefined;
  const sweep = () => options.voice ? Promise.resolve() : swept ??= sweepVoices({ directory: options.directory, backendDirectory: localBackendDirectory() }).catch(() => 0);
  return {
    enabled: () => enabledVoices(options.settings()),
    policy: () => reviewPolicy(options.settings()),
    async ask(request, signal, only) {
      const settings = options.settings();
      const names = enabledVoices(settings).filter(name => !only || only.includes(name));
      if (!names.length) throw new RuntimeFault('voices_off');
      await sweep();
      const handles = names.some(name => settings[name].model === 'auto') ? await available().catch(() => []) : [];
      const voices: Partial<Record<VoiceName, InnerVoice>> = {};
      for (const name of names) voices[name] = make(name, chooseReviewerModel(options.agentModel(), handles, settings[name].model).model, join(options.directory, name));
      return counsel(request, voices, { ...(signal ? { signal } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
    },
  };
}

/**
 * Voice settings of a code-defined agent (the app's own agent), kept in
 * `<state>/server/<definition id>/voices.json` (0600). Routes: `GET`/`PUT /voices`.
 */
export class DefinitionVoices {
  readonly file: string;
  private settings: VoiceSettings;
  constructor(definitionId: string, stateDirectory: string, private readonly onChange?: (settings: VoiceSettings) => void) {
    this.file = join(statePaths(stateDirectory).server(definitionId), 'voices.json');
    this.settings = this.read();
  }
  get(): VoiceSettings { return this.settings; }
  set(input: unknown): VoiceSettings {
    const next = checkVoiceSettings(input, this.settings);
    this.write(next); this.settings = next; this.onChange?.(next);
    return next;
  }
  routes(): express.Router {
    const router = express.Router();
    // With the models a voice may use (the settings' pick list).
    router.get('/voices', async (_req, res) => { const models = await localModels().catch(() => []); res.json({ ...this.get(), models: models.map(m => ({ handle: m.handle, label: m.label, providerLabel: m.providerLabel })) }); });
    router.put('/voices', express.json({ limit: BODY_LIMIT_BYTES }), (req, res) => {
      try { res.json(this.set(req.body)); }
      catch (error) { if (error instanceof RuntimeFault) return void res.status(error.status).json({ error: error.code }); res.status(500).json({ error: 'voices_unavailable' }); }
    });
    return router;
  }
  private read(): VoiceSettings {
    try {
      if (lstatSync(this.file).isSymbolicLink()) return DEFAULT_VOICES;
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; voices?: unknown };
      return value.version === 1 ? storedVoices(value.voices) : DEFAULT_VOICES;
    } catch { return DEFAULT_VOICES; }
  }
  private write(voices: VoiceSettings) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp-${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, voices }, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file);
  }
}
