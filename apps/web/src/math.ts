/**
 * KaTeX, loaded on demand: only when a reply with maths is shown and LaTeX is
 * on. The fonts and stylesheet are bundled with the app and served from it
 * (no CDN); see `vite.config.ts`.
 */
import 'katex/dist/katex.min.css';
export { katexPlugin } from './katex-plugin.js';

/**
 * Copying a selection that includes rendered maths copies its TeX source,
 * with the delimiters the reply used (`\(...\)` inline, `\[...\]` display),
 * instead of KaTeX's visual text. Registered once, when KaTeX loads.
 */
document.addEventListener('copy', event => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !event.clipboardData) return;
  const range = selection.getRangeAt(0).cloneRange();
  const katexOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('.katex');
  const start = katexOf(range.startContainer); if (start) range.setStartBefore(start.closest('.katex-display') ?? start);
  const end = katexOf(range.endContainer); if (end) range.setEndAfter(end.closest('.katex-display') ?? end);
  const fragment = range.cloneContents();
  if (!fragment.querySelector('.katex-mathml')) return;
  for (const element of [...fragment.querySelectorAll('.katex-display, .katex')]) {
    if (!fragment.contains(element)) continue; // inside a display block already replaced
    const display = element.classList.contains('katex-display');
    const tex = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '';
    element.replaceWith(display ? `\\[${tex}\\]` : `\\(${tex}\\)`);
  }
  event.clipboardData.setData('text/plain', fragment.textContent ?? '');
  event.preventDefault();
});
