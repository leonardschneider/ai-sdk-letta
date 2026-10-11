import express from 'express';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chooseReviewerModel, counsel, lettaVoice, sweepVoices, localBackendDirectory, statePaths, VOICES, type Counsel, type CounselRequest, type InnerVoice, type VoiceName } from 'ai-sdk-letta';
import { BODY_LIMIT_BYTES } from './http.js';
import { MODEL_HANDLE, localModels } from './models.js';
import { RuntimeFault } from './runtime.js';

/**
 * The inner voices Ambition and Prudence (see `ai-sdk-letta`'s `voices.ts`)
 * as the server offers them: per-agent settings (each voice on or off, and
 * its model: `auto` picks another family than the agent's), and the
 * counsellor a runtime asks on demand (`POST /v1/threads/:id/runs/:runId/counsel`).
 * Both voices are off until the person turns them on.
 */

/** One voice's setting. */
export type VoiceSetting = { enabled: boolean; model: string };
/** Both voices' settings. */
export type VoiceSettings = Record<VoiceName, VoiceSetting>;
/** Off, on the automatic model. */
export const DEFAULT_VOICES: VoiceSettings = Object.freeze({ ambition: Object.freeze({ enabled: false, model: 'auto' }), prudence: Object.freeze({ enabled: false, model: 'auto' }) }) as VoiceSettings;

/** Validate settings (`{ ambition: { enabled, model }, prudence: { … } }`; a voice left out keeps `fallback`'s). @throws `RuntimeFault('invalid_input', 400)` */
export function checkVoiceSettings(input: unknown, fallback: VoiceSettings = DEFAULT_VOICES): VoiceSettings {
  const fail = (): never => { throw new RuntimeFault('invalid_input', 400); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some(k => !(VOICES as readonly string[]).includes(k))) fail();
  const result = { ...fallback } as VoiceSettings;
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
  return result;
}
/** Settings as stored (anything malformed: the defaults). */
export function storedVoices(value: unknown): VoiceSettings {
  try { return checkVoiceSettings(value); } catch { return DEFAULT_VOICES; }
}
/** Which voices are on (for the app: show "Ask Ambition & Prudence"). */
export const enabledVoices = (settings: VoiceSettings): VoiceName[] => VOICES.filter(name => settings[name].enabled);

/** What a runtime asks: the voices that are on, and a counsel from them. */
export interface RuntimeVoices {
  enabled(): VoiceName[];
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
