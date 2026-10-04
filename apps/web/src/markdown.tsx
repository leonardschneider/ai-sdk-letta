import React, { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { MarkdownTextPrimitive, type CodeHeaderProps, type SyntaxHighlighterProps } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { hasMath, protectDocumentMath, protectMath, remarkLatex, restoreMath, type MathMode } from './latex.js';

type Highlight = typeof import('./highlight.js').highlight;
let loader: Promise<Highlight> | undefined;
let loaded: Highlight | undefined;
const loadHighlighter = () => loader ??= import('./highlight.js').then(m => (loaded = m.highlight));

type Katex = typeof import('./math.js').katexPlugin;
let mathLoader: Promise<Katex> | undefined;
let mathLoaded: Katex | undefined;
const loadMath = () => mathLoader ??= import('./math.js').then(m => (mathLoaded = m.katexPlugin)).catch(error => { mathLoader = undefined; throw error; });

/** Whether replies render LaTeX (`\(...\)`, `\[...\]`). Set per conversation by the app. */
export const LatexContext = createContext(false);

/** Plain code first; tokens appear once the lazily loaded highlighter is ready. Code is shown exactly as written. */
const SyntaxHighlighter = memo(function SyntaxHighlighter({ components: { Pre, Code }, language, code: protectedCode }: SyntaxHighlighterProps) {
  const code = restoreMath(protectedCode);
  const [highlight, setHighlight] = useState<Highlight | undefined>(() => loaded);
  useEffect(() => { if (!highlight && language) void loadHighlighter().then(fn => setHighlight(() => fn)).catch(() => {}); }, [highlight, language]);
  const tokens = highlight && language ? highlight(code, language) : undefined;
  return <Pre className="code-pre"><Code className={`hljs${language ? ` language-${language}` : ''}`}>{tokens ?? code}</Code></Pre>;
});

function CodeHeader({ language, code: protectedCode }: CodeHeaderProps) {
  const code = restoreMath(protectedCode);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(t); }, [copied]);
  return <div className="code-header">
    <span>{language || 'text'}</span>
    <button type="button" className="code-copy" aria-label="Copy code" onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => {})}>
      {copied ? <><Check size={13} aria-hidden="true"/>Copied</> : <><Copy size={13} aria-hidden="true"/>Copy</>}
    </button>
  </div>;
}

const components = {
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  img: ({ alt }: { alt?: string }) => <span className="image-placeholder">[Image: {alt || 'image'}]</span>,
  SyntaxHighlighter, CodeHeader,
};
// Stable plugin lists, so the renderer's memo holds between renders.
const remarkPlain = [remarkGfm, [remarkLatex, { render: false }]] as const;
const remarkMath = [remarkGfm, [remarkLatex, { render: true }]] as const;
const none: never[] = [];

/**
 * YAML (`---`) or TOML (`+++`) front matter at the very top of a Markdown
 * file, and the length of the source it takes (with the blank lines after it).
 */
export function splitFrontMatter(text: string): { fence: string; body: string; length: number } | undefined {
  const match = /^\uFEFF?(---|\+\+\+)[ \t]*\r?\n([^]*?)\r?\n\1[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/.exec(text);
  if (!match) return undefined;
  return { fence: match[1]!, body: match[2]!, length: match[0].length };
}
const withoutFrontMatter = (text: string) => text.slice(splitFrontMatter(text)?.length ?? 0);
/** Preprocessing for Markdown files: front matter is shown apart, maths uses the document rules. */
const preprocessDocument = (text: string) => protectDocumentMath(withoutFrontMatter(text));

/**
 * Safe Markdown: raw HTML is skipped, links open in a new tab without referrer,
 * remote images never load. With `latex`, `\(...\)` and `\[...\]` render with
 * KaTeX (loaded the first time a reply has maths); until then, and when off,
 * they show as written. Copying a message copies its Markdown source.
 *
 * `document` is for Markdown files (previews) rather than replies: maths is
 * always on, with the document delimiters (`$$...$$`, `$...$`, `\\(...\\)`;
 * see `MathMode`), and front matter shows as a muted metadata block instead of
 * a rule and a paragraph.
 */
export function Markdown({ latex: latexProp, document = false }: { latex?: boolean; document?: boolean } = {}) {
  const contextLatex = useContext(LatexContext);
  const latex = document || (latexProp ?? contextLatex);
  const mode: MathMode = document ? 'document' : 'reply';
  const text = useAuiState(s => (s.part as { type: string; text?: string }).type === 'text' ? (s.part as { text: string }).text : '');
  const wanted = useMemo(() => latex && hasMath(document ? withoutFrontMatter(text) : text, mode), [latex, document, text, mode]);
  const [katex, setKatex] = useState<Katex | undefined>(() => mathLoaded);
  useEffect(() => { if (wanted && !katex) void loadMath().then(plugin => setKatex(() => plugin)).catch(() => {}); }, [wanted, katex]);
  const render = wanted && !!katex;
  const rehypePlugins = useMemo(() => render ? [katex as never] : none, [render, katex]);
  const frontMatter = useMemo(() => document ? splitFrontMatter(text) : undefined, [document, text]);
  const markdown = <MarkdownTextPrimitive className="markdown" preprocess={document ? preprocessDocument : protectMath} remarkPlugins={(render ? remarkMath : remarkPlain) as never} rehypePlugins={rehypePlugins} skipHtml components={components}/>;
  if (!frontMatter) return markdown;
  return <>
    <pre className="markdown-front-matter" aria-label={`Front matter (${frontMatter.fence === '+++' ? 'TOML' : 'YAML'})`}><code>{frontMatter.body}</code></pre>
    {markdown}
  </>;
}
