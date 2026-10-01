import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Versions of the packages the server is actually running, read from their installed `package.json`. `null` when one cannot be read. */
export interface RuntimeVersions {
  /** `ai-sdk-letta`, as resolved by this server. */
  aiSdkLetta: string | null;
  /** `@ai-sdk-letta/server` itself. */
  server: string | null;
  /** `@letta-ai/letta-agent-sdk`, as resolved by `ai-sdk-letta`. */
  lettaSdk: string | null;
}

const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

function manifest(path: string): { name?: unknown; version?: unknown } | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown }; } catch { return undefined; }
}

/** The version in a `package.json`, if it names `name` (when given) and looks like a version. */
function versionAt(path: string, name?: string): string | null {
  const data = manifest(path);
  if (!data || (name !== undefined && data.name !== name)) return null;
  return typeof data.version === 'string' && VERSION.test(data.version) ? data.version : null;
}

/**
 * Path of the `package.json` of `name`, resolved by Node from the file or
 * directory `from` (an npm install, a workspace link or a source checkout
 * alike). Packages that do not export `./package.json` are found from their
 * entry point.
 */
export function packageJsonPath(name: string, from: string): string | undefined {
  const require = createRequire(from);
  try { return require.resolve(`${name}/package.json`); } catch { /* not exported, or missing */ }
  let entry: string;
  try { entry = require.resolve(name); } catch { return undefined; }
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const candidate = join(dir, 'package.json');
    if (manifest(candidate)?.name === name) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The installed version of `name` as resolved from `from`, or `null`. */
export function packageVersion(name: string, from: string): string | null {
  const path = packageJsonPath(name, from);
  return path ? versionAt(path, name) : null;
}

/**
 * The versions this process runs: the server's own `package.json` (next to
 * `src/` and `dist/`), `ai-sdk-letta` as this server resolves it, and the
 * Letta SDK as `ai-sdk-letta` resolves it. Read from disk, never from the
 * web bundle or a constant.
 * @param own The server's `package.json` (tests point it at another install).
 */
export function runtimeVersions(own = fileURLToPath(new URL('../package.json', import.meta.url))): RuntimeVersions {
  const core = packageJsonPath('ai-sdk-letta', own);
  return {
    aiSdkLetta: core ? versionAt(core, 'ai-sdk-letta') : null,
    server: versionAt(own, '@ai-sdk-letta/server'),
    lettaSdk: core ? packageVersion('@letta-ai/letta-agent-sdk', core) : null,
  };
}
