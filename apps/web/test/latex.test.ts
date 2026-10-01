import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { APP_LATEX_DEFAULT, findMath, hasMath, protectMath, remarkLatex, resolveLatex, restoreMath } from '../src/latex.js';
import { katexPlugin } from '../src/katex-plugin.js';

/** The same pipeline as the app's Markdown component, rendered to HTML. */
function html(markdown: string, render = true): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, [remarkLatex, { render }]],
    rehypePlugins: render ? [katexPlugin as never] : [],
    skipHtml: true,
    children: protectMath(markdown),
  }));
}
const tex = (h: string) => [...h.matchAll(/<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/g)].map(m => m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
const displays = (h: string) => (h.match(/class="katex-display"/g) ?? []).length;
const inlines = (h: string) => (h.match(/class="katex"/g) ?? []).length - displays(h);

test('settings resolve from the app default, then the agent, then the conversation', () => {
  assert.equal(APP_LATEX_DEFAULT, true);
  assert.equal(resolveLatex(undefined, undefined), true, 'older server: app default');
  assert.equal(resolveLatex(undefined, 'inherit'), true);
  assert.equal(resolveLatex(true, 'inherit'), true);
  assert.equal(resolveLatex(false, 'inherit'), false, 'agent off');
  assert.equal(resolveLatex(false, undefined), false, 'older thread without an override inherits');
  assert.equal(resolveLatex(false, 'on'), true, 'conversation on beats agent off');
  assert.equal(resolveLatex(true, 'off'), false, 'conversation off beats agent on');
});

test('\\(...\\) is inline and \\[...\\] is display maths', () => {
  const h = html('The roots are \\(x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\\) and\n\n\\[\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n\\]\n\nDone.');
  assert.deepEqual(tex(h), ['x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}', '\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}']);
  assert.equal(inlines(h), 1); assert.equal(displays(h), 1);
  assert.match(h, /<p>The roots are <span class="katex">/);
  assert.match(h, /<p>Done\.<\/p>/);
  // Display maths inside a paragraph and on one line.
  assert.equal(displays(html('Before \\[a^2+b^2=c^2\\] after')), 1);
});

test('dollar signs are never maths: prices stay text', () => {
  for (const text of ['It costs $5 and $10.', 'Between $5-$10', 'Pay $x$ now', 'Display $$x^2$$ here', '$$\nx\n$$']) {
    const h = html(text);
    assert.equal(tex(h).length, 0, text);
    assert.equal(findMath(text).length, 0, text);
  }
  assert.match(html('It costs $5 and $10.'), /<p>It costs \$5 and \$10\.<\/p>/);
  // Prices next to real maths.
  const mixed = html('From $5 to $10, and \\(x^2\\).');
  assert.deepEqual(tex(mixed), ['x^2']);
  assert.match(mixed, /From \$5 to \$10, and <span class="katex">/);
});

test('code blocks and inline code are never touched', () => {
  const source = 'Use `\\(x\\)` literally.\n\n```latex\n\\[ \\int_0^1 x\\,dx \\]\n\\(a\\)\n```\n\n~~~\n\\(b\\)\n~~~\n\nBut \\(y\\) renders.';
  assert.deepEqual(findMath(source).map(s => s.tex), ['y']);
  const h = html(source);
  assert.deepEqual(tex(h), ['y']);
  assert.match(h, /<code>\\\(x\\\)<\/code>/);
  assert.ok(h.includes('\\[ \\int_0^1 x\\,dx \\]\n\\(a\\)'), 'fenced code exactly as written');
  assert.ok(h.includes('\\(b\\)'), 'tilde fence as written');
  // A still-streaming (unclosed) fence protects everything after it.
  assert.equal(findMath('```\n\\(x\\)').length, 0);
  // Double-backtick spans with a single backtick inside.
  assert.equal(findMath('``a ` \\(x\\)`` and').length, 0);
});

test('escaped backslashes are literal, as in Markdown', () => {
  assert.equal(findMath('Write \\\\(x\\\\) for a literal.').length, 0);
  assert.match(html('Write \\\\(x\\\\) to show it.'), /<p>Write \\\(x\\\) to show it\.<\/p>/);
  // Escaped delimiters inside maths: \\ (newline in TeX) and \{ \} stay part of the TeX.
  const [span] = findMath('\\[ \\begin{aligned} a &= 1 \\\\ b &= \\{2\\} \\end{aligned} \\]');
  assert.equal(span!.tex, '\\begin{aligned} a &= 1 \\\\ b &= \\{2\\} \\end{aligned}');
  assert.equal(displays(html('\\[ \\begin{aligned} a &= 1 \\\\ b &= 2 \\end{aligned} \\]')), 1);
  // Unclosed or empty delimiters are text.
  for (const text of ['\\(x', '\\[x', '\\(\\)', '\\[ \\]', 'a \\) b \\]']) assert.equal(findMath(text).length, 0, text);
});

test('Markdown syntax inside maths is not interpreted', () => {
  // `*` and `_` would be emphasis, `|` a table cell, `<` HTML, a leading `-` a list.
  const h = html('\\(a * b * c\\) and \\(x_1 + y_1 = z_1\\) and \\(|x| < 1\\)\n\n\\[\n- a\n\\]');
  assert.deepEqual(tex(h), ['a * b * c', 'x_1 + y_1 = z_1', '|x| < 1', '- a']);
  assert.ok(!h.includes('<em>'), h);
  const table = html('| a | b |\n|---|---|\n| \\(|x|\\) | 2 |');
  assert.match(table, /<td>.*class="katex"/);
});

test('invalid LaTeX shows its source as an error without breaking the reply', () => {
  const h = html('Good \\(x^2\\), bad \\(\\frac{1}{\\), more **text**.');
  assert.deepEqual(tex(h), ['x^2']);
  assert.match(h, /<span class="katex-error" title="ParseError[^"]*"[^>]*>\\frac\{1\}\{<\/span>/);
  assert.match(h, /<strong>text<\/strong>/);
  // Untrusted commands do nothing.
  const links = html('\\(\\href{javascript:alert(1)}{x}\\) \\(\\url{https://e.com}\\)');
  assert.ok(!/<a /.test(links) && !links.includes('href="javascript'), links);
});

test('with LaTeX off (or KaTeX not loaded yet), maths shows exactly as written', () => {
  const source = 'Roots \\(x = \\frac{-b}{2a}\\) and \\(a * b * c\\)\n\n\\[\n\\sum_k k\n\\]';
  const h = html(source, false);
  assert.ok(!h.includes('katex'));
  assert.ok(h.includes('Roots \\(x = \\frac{-b}{2a}\\) and \\(a * b * c\\)'), h);
  assert.ok(h.includes('\\[\n\\sum_k k\n\\]'), h);
  assert.ok(!h.includes('\uE000') && !h.includes('<em>'), 'no placeholders or emphasis leak');
});

test('placeholders round-trip and never leak; detection is cheap and exact', () => {
  for (const text of ['a \\(x\\) b', '\\[\n x \n\\]', 'plain', 'Unicode \\(\\text{café ☕}\\)', '> quoted \\[\n> x^2\n> \\]']) {
    assert.equal(restoreMath(protectMath(text)), text, text);
  }
  assert.deepEqual(findMath('> quoted \\[\n> x^2\n> \\]').map(s => s.tex), ['x^2']);
  assert.equal(restoreMath('forged \uE000zz\uE001 and \uE00041\uE001'), 'forged \uE000zz\uE001 and \uE00041\uE001', 'only valid placeholders are decoded');
  assert.equal(hasMath('no maths here, $5'), false);
  assert.equal(hasMath('see \\(x\\)'), true);
  assert.equal(hasMath('`\\(x\\)`'), false);
  // A paragraph break ends an unclosed span.
  assert.equal(findMath('\\(a\n\nb\\)').length, 0);
  // Links: maths in link text renders, link targets are kept as written.
  const h = html('[about \\(x\\)](https://example.com/a\\(b\\))');
  assert.match(h, /href="https:\/\/example.com\/a\(b\)"/);
  assert.deepEqual(tex(h), ['x']);
});
