import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { INTERNAL_MEMORY_TOOLS } from './definition.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The only shell command the agent may run: commit Markdown changes in its own
 * MemFS repository, with hooks disabled and a fixed author.
 */
export function memoryCommitCommand(root: string, author = 'ai-sdk-letta agent'): string {
  const git = `git -c core.hooksPath=/dev/null -C ${quote(root)}`;
  return `${git} add -- '*.md' && ${git} -c user.name=${quote(author.replace(/[\r\n]/g, ' '))} -c user.email='agent@localhost' commit -m 'Update agent memory'`;
}

/**
 * Strict per-call permission for harness memory tools: own Markdown files only;
 * no general shell, traversal, dot-files (including `.git`), symlinks or hard links.
 */
export function allowMemoryTool(name: string, input: Record<string, unknown>, root?: string, author?: string): boolean {
  if (!root || !(INTERNAL_MEMORY_TOOLS as readonly string[]).includes(name)) return false;
  if (name === 'Bash') return input.command === memoryCommitCommand(root, author) && !input.run_in_background;
  if (typeof input.file_path !== 'string' || !isAbsolute(input.file_path) || !input.file_path.endsWith('.md')) return false;
  try {
    const canonicalRoot = realpathSync(root);
    const path = resolve(input.file_path);
    // Accept the backend-provided spelling (e.g. macOS /var -> /private/var)
    // or its canonical spelling; inspect every component below the real root.
    const rawSuffix = relative(resolve(root), path);
    const suffix = !rawSuffix.startsWith(`..${sep}`) && rawSuffix !== '..' && !isAbsolute(rawSuffix) ? rawSuffix : relative(canonicalRoot, path);
    if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..' || isAbsolute(suffix)) return false;
    const parts = suffix.split(sep);
    if (parts.some(part => part.startsWith('.'))) return false;
    let current = canonicalRoot;
    for (const part of parts) {
      current = resolve(current, part);
      try { const stat = lstatSync(current); if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    }
    return true;
  } catch { return false; }
}
