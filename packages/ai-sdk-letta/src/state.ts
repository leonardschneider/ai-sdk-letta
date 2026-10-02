import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Environment variable that overrides the state directory. */
export const STATE_DIR_ENV = 'AI_SDK_LETTA_STATE_DIR';

/**
 * Resolve the root state directory.
 *
 * Order: explicit argument, `AI_SDK_LETTA_STATE_DIR`, then the platform state
 * location: `$XDG_STATE_HOME/ai-sdk-letta` or `~/.local/state/ai-sdk-letta` on
 * Linux and macOS, `%LOCALAPPDATA%\ai-sdk-letta\state` on Windows.
 *
 * The identity mapping lives in `<stateDir>/agents/`; point this at an
 * existing directory to keep using an agent created earlier.
 */
export function resolveStateDirectory(explicit?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const chosen = explicit ?? env[STATE_DIR_ENV];
  if (chosen !== undefined) {
    if (!chosen.trim()) throw new Error('State directory must not be empty');
    return resolve(chosen);
  }
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ai-sdk-letta', 'state');
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'state'), 'ai-sdk-letta');
}

/** Well-known subdirectories of a state root. */
export function statePaths(root: string) {
  return {
    root,
    /** Identity mappings, locks and pending-intent files; also the Letta session cwd. */
    agents: join(root, 'agents'),
    /** Metadata-only tool audit trail. */
    traces: join(root, 'tool-traces'),
    /** Per-definition HTTP runtime state (threads, runs). */
    server: (definitionId: string) => join(root, 'server', definitionId),
    /** Attached files of earlier versions (`<attachments>/<lettaAgentId>/<conversationId>/`), migrated into `resources` on open. */
    attachments: join(root, 'attachments'),
    /** Resources: `<resources>/<lettaAgentId>/` holds `files/` (one folder per conversation, git-versioned), `git/`, `cache/` and `state.json`. */
    resources: join(root, 'resources'),
    /** Per-user integration secrets (`credentials/<integration>/<hash of user ID>.json`, 0600). Never in the resources. */
    credentials: join(root, 'credentials'),
  };
}
