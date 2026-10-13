import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type express from 'express';

/**
 * The build the browser is talking to: changes when the server restarts (a
 * new process) or the web app is rebuilt (its `index.html` names the new
 * hashed bundles). The app polls `GET /build.json` and reloads itself when it
 * changes. Public (outside the session check: after a restart the old session
 * is gone) and reveals nothing but an opaque ID.
 */
export function buildIdRoute(assets: string, boot: string = randomBytes(8).toString('hex')): express.RequestHandler {
  const index = join(assets, 'index.html');
  let cached: { mtimeMs: number; size: number; hash: string } | undefined;
  const indexHash = () => {
    try {
      const { mtimeMs, size } = statSync(index);
      if (!cached || cached.mtimeMs !== mtimeMs || cached.size !== size) cached = { mtimeMs, size, hash: createHash('sha256').update(readFileSync(index)).digest('hex').slice(0, 16) };
      return cached.hash;
    } catch { return 'none'; }
  };
  return (_req, res) => { res.json({ build: `${boot}-${indexHash()}` }); };
}
