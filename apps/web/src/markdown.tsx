import React, { memo, useEffect, useState } from 'react';
import { MarkdownTextPrimitive, type CodeHeaderProps, type SyntaxHighlighterProps } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

type Highlight = typeof import('./highlight.js').highlight;
let loader: Promise<Highlight> | undefined;
let loaded: Highlight | undefined;
const loadHighlighter = () => loader ??= import('./highlight.js').then(m => (loaded = m.highlight));

/** Plain code first; tokens appear once the lazily loaded highlighter is ready. */
const SyntaxHighlighter = memo(function SyntaxHighlighter({ components: { Pre, Code }, language, code }: SyntaxHighlighterProps) {
  const [highlight, setHighlight] = useState<Highlight | undefined>(() => loaded);
  useEffect(() => { if (!highlight && language) void loadHighlighter().then(fn => setHighlight(() => fn)).catch(() => {}); }, [highlight, language]);
  const tokens = highlight && language ? highlight(code, language) : undefined;
  return <Pre className="code-pre"><Code className={`hljs${language ? ` language-${language}` : ''}`}>{tokens ?? code}</Code></Pre>;
});

function CodeHeader({ language, code }: CodeHeaderProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(t); }, [copied]);
  return <div className="code-header">
    <span>{language || 'text'}</span>
    <button type="button" className="code-copy" aria-label="Copy code" onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => {})}>
      {copied ? <><Check size={13} aria-hidden="true"/>Copied</> : <><Copy size={13} aria-hidden="true"/>Copy</>}
    </button>
  </div>;
}

/** Safe Markdown: raw HTML is skipped, links open in a new tab without referrer, remote images never load. */
export function Markdown() {
  return <MarkdownTextPrimitive className="markdown" remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span className="image-placeholder">[Image: {alt || 'image'}]</span>,
    SyntaxHighlighter, CodeHeader,
  }}/>;
}
