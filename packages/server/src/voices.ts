import express from 'express';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chooseReviewerModel, counsel, lettaVoice, sweepVoices, localBackendDirectory, statePaths, validVoiceBounds, MAX_REVISIONS, VOICES, VOICE_CHOICES, VOICE_MINIMUMS, VOICE_MODES, type Counsel, type CounselRequest, type InnerVoice, type VoiceBounds, type VoiceChoice, type VoiceMinimum, type VoiceMode, type VoiceName } from 'ai-sdk-letta';
import { BODY_LIMIT_BYTES } from './http.js';
import { MODEL_HANDLE, localModels } from './models.js';
import { RuntimeFault } from './runtime.js';

/**
 * The inner voices Ambition and Prudence (see `ai-sdk-letta`'s `voices.ts`)
 * as the server offers them: per-agent settings (each voice on or off, and
 * its model: `auto` picks another family than the agent's; who decides the
 * review mode, its bounds and the most revision rounds), and the counsellor
 * a runtime asks within a turn: they review the draft reply, then the agent
 * reflects on their notes and keeps or revises it, up to `maxRevisions`
 * rounds (see `ThreadRuntime`). Both voices are off until the person turns them on.
 */

/** One voice's setting. */
export type VoiceSetting = { enabled: boolean; model: string };
/**
 * The old "speak after" setting (every reply, or only long turns). Still
 * accepted as input and migrated: `long` becomes minimum
 * `calibrated_if_tools` with default `skip`; `every` becomes default `calibrated`.
 */
export type SpeakAfter = 'every' | 'long';
export const SPEAK_AFTER: readonly SpeakAfter[] = Object.freeze(['every', 'long'] as const);
/** Who decides a turn's review mode: the agent (with the inner_voices tool, within the bounds) or nobody (`fixed`: always the default mode, clamped). */
export type VoiceDecider = 'agent' | 'fixed';
export const VOICE_DECIDERS: readonly VoiceDecider[] = Object.freeze(['agent', 'fixed'] as const);
/**
 * How a turn is reviewed: who decides, the default mode (when the agent does
 * not choose, or in `fixed`), the bounds (minimum, maximum) and how many
 * revision rounds at most (each round: two voice calls plus an agent step).
 */
export type ReviewPolicy = VoiceBounds & { decides: VoiceDecider; maxRevisions: number };
/** Both voices' settings and the review policy (see {@link ReviewPolicy}; defaults when absent). */
export type VoiceSettings = Record<VoiceName, VoiceSetting> & Partial<ReviewPolicy>;
/** The agent decides; a calibrated review by default; no minimum; up to debate; one revision. */
export const DEFAULT_POLICY: Readonly<ReviewPolicy> = Object.freeze({ decides: 'agent', defaultMode: 'calibrated', minimum: 'none', maximum: 'debate', maxRevisions: 1 });
/** Off, on the automatic model. */
export const DEFAULT_VOICES: VoiceSettings = Object.freeze({ ambition: Object.freeze({ enabled: false, model: 'auto' }), prudence: Object.freeze({ enabled: false, model: 'auto' }) }) as VoiceSettings;
/** The policy of settings (defaults filled in). */
export const reviewPolicy = (settings: VoiceSettings): ReviewPolicy => ({
  decides: settings.decides ?? DEFAULT_POLICY.decides, defaultMode: settings.defaultMode ?? DEFAULT_POLICY.defaultMode, minimum: settings.minimum ?? DEFAULT_POLICY.minimum,
  maximum: settings.maximum ?? DEFAULT_POLICY.maximum, maxRevisions: settings.maxRevisions ?? DEFAULT_POLICY.maxRevisions,
});
const POLICY_KEYS = ['decides', 'defaultMode', 'minimum', 'maximum', 'maxRevisions', 'speakAfter'];

/**
 * Validate settings (`{ ambition: { enabled, model }, prudence: { … },
 * decides?, defaultMode?, minimum?, maximum?, maxRevisions? }`; anything left
 * out keeps `fallback`'s). The minimum must not exceed the maximum and the
 * default must lie between them. An old `speakAfter` is migrated (see
 * {@link SpeakAfter}) unless the same input sets the fields it maps to.
 * @throws `RuntimeFault('invalid_input', 400)`
 */
export function checkVoiceSettings(input: unknown, fallback: VoiceSettings = DEFAULT_VOICES): VoiceSettings {
  const fail = (): never => { throw new RuntimeFault('invalid_input', 400); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some(k => !POLICY_KEYS.includes(k) && !(VOICES as readonly string[]).includes(k))) fail();
  const { speakAfter: _old, ...base } = fallback as VoiceSettings & { speakAfter?: unknown };
  const result = { ...base } as VoiceSettings;
  if (o.speakAfter !== undefined) {
    if (!SPEAK_AFTER.includes(o.speakAfter as SpeakAfter)) fail();
    if (o.speakAfter === 'long') { if (o.minimum === undefined) result.minimum = 'calibrated_if_tools'; if (o.defaultMode === undefined) result.defaultMode = 'skip'; }
    else if (o.defaultMode === undefined) result.defaultMode = 'calibrated';
  }
  if (o.decides !== undefined) { if (!VOICE_DECIDERS.includes(o.decides as VoiceDecider)) fail(); result.decides = o.decides as VoiceDecider; }
  if (o.defaultMode !== undefined) { if (!VOICE_CHOICES.includes(o.defaultMode as VoiceChoice)) fail(); result.defaultMode = o.defaultMode as VoiceChoice; }
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
/** Settings as stored (anything malformed: the defaults). */
export function storedVoices(value: unknown): VoiceSettings {
  try { return checkVoiceSettings(value); } catch { return DEFAULT_VOICES; }
}
/** Which voices are on (for the app: show "Ask Ambition & Prudence"). */
export const enabledVoices = (settings: VoiceSettings): VoiceName[] => VOICES.filter(name => settings[name].enabled);

/** What a runtime asks: the voices that are on, how turns are reviewed, and a counsel from them (in a mode). */
export interface RuntimeVoices {
  enabled(): VoiceName[];
  /** How turns are reviewed (default {@link DEFAULT_POLICY}). */
  policy?(): ReviewPolicy;
  ask(request: CounselRequest, signal?: AbortSignal): Promise<Counsel>;
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
    async ask(request, signal) {
      const settings = options.settings();
      const names = enabledVoices(settings);
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
