import rehypeKatex from 'rehype-katex';

/**
 * rehype-katex and its options. Invalid TeX renders as its source, styled as
 * an error (`.katex-error`), never failing the reply. `trust: false` keeps
 * `\href`, `\url`, `\includegraphics` and HTML extensions inert.
 */
export const katexPlugin = [rehypeKatex, { throwOnError: false, errorColor: 'var(--danger)', strict: 'ignore', trust: false, maxSize: 50, maxExpand: 500, output: 'htmlAndMathml' }] as const;
