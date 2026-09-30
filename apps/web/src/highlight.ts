/**
 * Lazily loaded syntax highlighter (own chunk). lowlight returns a hast tree of
 * plain `span.hljs-*` nodes, converted to React elements — no HTML strings.
 */
import { createLowlight, common } from 'lowlight';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import type { ReactNode } from 'react';

const lowlight = createLowlight(common);
const aliases: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', sh: 'bash', zsh: 'bash', shell: 'bash', py: 'python', rb: 'ruby', yml: 'yaml', html: 'xml', md: 'markdown', 'c++': 'cpp', rs: 'rust', kt: 'kotlin' };

export function highlight(code: string, language: string): ReactNode | undefined {
  const name = aliases[language.toLowerCase()] ?? language.toLowerCase();
  if (!name || !lowlight.registered(name) || code.length > 60_000) return undefined;
  const tree = lowlight.highlight(name, code);
  return toJsxRuntime(tree, { Fragment, jsx, jsxs });
}
