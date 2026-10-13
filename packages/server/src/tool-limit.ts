import express from 'express';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { statePaths, toolCallLimitOf, TOOL_CALL_LIMITS } from 'ai-sdk-letta';
import { BODY_LIMIT_BYTES } from './http.js';

/**
 * The per-turn tool call limit of a code-defined agent (the app's own agent),
 * kept in `<state>/server/<definition id>/tool-limit.json` (0600). Unset: the
 * definition's `toolCallLimit`. Routes: `GET`/`PUT /tool-limit` with
 * `{ toolCallLimit | null }`. Applies from the next turn; nothing restarts.
 */
export class DefinitionToolLimit {
  readonly file: string;
  private value: number | undefined;
  constructor(definitionId: string, stateDirectory: string, private readonly fallback: number = TOOL_CALL_LIMITS.default) {
    this.file = join(statePaths(stateDirectory).server(definitionId), 'tool-limit.json');
    this.value = this.read();
  }
  /** The limit in effect. */
  get(): number { return this.value ?? this.fallback; }
  /** What the settings show. */
  view() { return { toolCallLimit: this.value ?? null, default: this.fallback, min: TOOL_CALL_LIMITS.min, max: TOOL_CALL_LIMITS.max }; }
  /** Set (10–1000) or clear (`null`). @throws `Error('invalid_input')` */
  set(input: unknown) {
    const value = (input as { toolCallLimit?: unknown } | undefined)?.toolCallLimit;
    if (value !== null && toolCallLimitOf(value) !== value) throw new Error('invalid_input');
    this.write(value === null ? undefined : value as number);
    this.value = value === null ? undefined : value as number;
    return this.view();
  }
  routes(): express.Router {
    const router = express.Router();
    router.get('/tool-limit', (_req, res) => { res.json(this.view()); });
    router.put('/tool-limit', express.json({ limit: BODY_LIMIT_BYTES }), (req, res) => {
      try { res.json(this.set(req.body)); } catch { res.status(400).json({ error: 'invalid_input' }); }
    });
    return router;
  }
  private read(): number | undefined {
    try {
      if (lstatSync(this.file).isSymbolicLink()) return undefined;
      const value = (JSON.parse(readFileSync(this.file, 'utf8')) as { toolCallLimit?: unknown }).toolCallLimit;
      return toolCallLimitOf(value) === value ? value as number : undefined;
    } catch { return undefined; }
  }
  private write(value: number | undefined) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp-${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value === undefined ? {} : { toolCallLimit: value })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file);
  }
}
