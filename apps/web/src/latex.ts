/**
 * LaTeX in assistant replies: `\(...\)` inline and `\[...\]` display, never
 * `$...$` or `$$...$$`, never inside code. Pure functions, no DOM; the KaTeX
 * renderer itself is loaded lazily (see `math.ts`).
 *
 * How: before Markdown parsing, every maths span outside code is replaced by a
 * placeholder made of characters Markdown never interprets (so `*`, `_`, `|`,
 * `<` or line breaks inside maths cannot turn into emphasis, table cells, HTML
 * or new blocks). After parsing, {@link remarkLatex} turns placeholders in text
 * into maths nodes for rehype-katex, or back into the source as plain text
 * when maths is off. Placeholders anywhere else (code, link targets) are
 * always restored to the source, so code is shown exactly as written.
 */

/** A conversation's LaTeX setting: follow the agent, or override it. */
export type LatexOverride = 'inherit' | 'on' | 'off';
/** Used when neither the agent nor the conversation says otherwise (and by older servers). */
export const APP_LATEX_DEFAULT = true;

/** Settings, broadest to narrowest: app default → agent (`ui.latex`) → conversation override. */
export function resolveLatex(agentDefault: boolean | undefined, override: LatexOverride | undefined): boolean {
  if (override === 'on') return true;
  if (override === 'off') return false;
  return agentDefault ?? APP_LATEX_DEFAULT;
}

/** One maths span in Markdown source: offsets of the whole `\(...\)`/`\[...\]` and its TeX. */
export type MathSpan = { start: number; end: number; tex: string; display: boolean };

const FENCE_PREFIX = /^[ \t]*(?:>[ \t]*|(?:[-*+]|\d{1,9}[.)])[ \t]+)*$/;
const runLength = (text: string, at: number, char: string) => { let n = 0; while (text[at + n] === char) n++; return n; };
const lineStartOf = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
const lineEndOf = (text: string, at: number) => { const end = text.indexOf('\n', at); return end < 0 ? text.length : end; };
const blankLine = (line: string) => /^[ \t>]*$/.test(line);

/** End of a fenced code block opened at `at` (end of its closing line), or the end of the text while it is still streaming. */
function fenceEnd(text: string, at: number, char: string, length: number): number {
  let line = lineEndOf(text, at);
  while (line < text.length) {
    const next = lineEndOf(text, line + 1);
    const content = text.slice(line + 1, next).replace(/^[ \t>]*/, '');
    if (content.startsWith(char.repeat(length)) && new RegExp(`^\\${char}+[ \\t]*$`).test(content)) return next;
    line = next;
  }
  return text.length;
}
/** Whether a run of 3+ backticks or tildes at `at` opens a fenced code block. */
function opensFence(text: string, at: number, char: string): boolean {
  if (runLength(text, at, char) < 3 || !FENCE_PREFIX.test(text.slice(lineStartOf(text, at), at))) return false;
  return char === '~' || !text.slice(at + runLength(text, at, char), lineEndOf(text, at)).includes('`');
}
/** End of the code span opened by the backtick run at `at`, or -1 when it never closes (within its paragraph). */
function codeSpanEnd(text: string, at: number): number {
  const length = runLength(text, at, '`');
  for (let j = at + length; j < text.length;) {
    if (text[j] === '\n' && blankLine(text.slice(j + 1, lineEndOf(text, j + 1)))) return -1;
    if (text[j] !== '`') { j++; continue; }
    const run = runLength(text, j, '`');
    if (run === length) return j + run;
    j += run;
  }
  return -1;
}

/** The maths span opened by `\(` or `\[` at `at`, or undefined (unclosed, empty, across a paragraph break or a code span). */
function matchMath(text: string, at: number): MathSpan | undefined {
  const display = text[at + 1] === '[';
  const closer = display ? ']' : ')';
  for (let j = at + 2; j < text.length;) {
    const c = text[j];
    if (c === '\\') {
      if (text[j + 1] === closer) {
        let tex = text.slice(at + 2, j);
        if (!tex.trim()) return undefined;
        // Inside a block quote, continuation lines repeat the quote markers; they are not maths.
        const depth = (text.slice(lineStartOf(text, at), at).match(/^[ \t>]*/)![0].match(/>/g) ?? []).length;
        if (depth && tex.includes('\n')) tex = tex.split('\n').map((line, i) => i ? line.replace(new RegExp(`^(?:[ \\t]*>){0,${depth}}[ \\t]?`), '') : line).join('\n');
        return { start: at, end: j + 2, tex: tex.trim(), display };
      }
      // A control symbol (\\, \{, \$, \) inside \[...\]): two characters of TeX.
      j += 2; continue;
    }
    if (c === '`') return undefined;
    if (c === '\n' && blankLine(text.slice(j + 1, lineEndOf(text, j + 1)))) return undefined;
    j++;
  }
  return undefined;
}

/**
 * Maths spans in Markdown source, outside fenced code blocks and code spans.
 * A backslash escaped by another backslash is literal (`\\(` is the text `\(`),
 * as in Markdown. `$` is never a delimiter.
 */
export function findMath(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if ((c === '`' || c === '~') && opensFence(text, i, c)) { i = fenceEnd(text, i, c, runLength(text, i, c)); continue; }
    if (c === '`') { const end = codeSpanEnd(text, i); i = end > 0 ? end : i + runLength(text, i, '`'); continue; }
    if (c === '\\') {
      const next = text[i + 1];
      if (next === '(' || next === '[') { const span = matchMath(text, i); if (span) { spans.push(span); i = span.end; continue; } }
      i += 2; continue;
    }
    i++;
  }
  return spans;
}

/** Cheap check used to decide whether to load KaTeX at all. */
export const hasMath = (text: string) => text.includes('\\') && findMath(text).length > 0;

const OPEN = '\uE000';
const CLOSE = '\uE001';
const PLACEHOLDER = /\uE000([0-9a-f]+)\uE001/g;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const toHex = (value: string) => Array.from(encoder.encode(value), byte => byte.toString(16).padStart(2, '0')).join('');
function fromHex(hex: string): string | undefined {
  if (hex.length % 2) return undefined;
  try { return decoder.decode(Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16))); } catch { return undefined; }
}
/** The source a placeholder stands for, when it is a valid one. */
function decode(hex: string): { raw: string; tex: string; display: boolean } | undefined {
  const raw = fromHex(hex);
  if (!raw) return undefined;
  const [span] = findMath(raw);
  return span && span.start === 0 && span.end === raw.length ? { raw, tex: span.tex, display: span.display } : undefined;
}

/** `preprocess` for the Markdown renderer: maths spans become placeholders (see the module comment). */
export function protectMath(text: string): string {
  const spans = text.includes('\\') ? findMath(text) : [];
  if (!spans.length) return text;
  let out = '';
  let last = 0;
  for (const span of spans) { out += `${text.slice(last, span.start)}${OPEN}${toHex(text.slice(span.start, span.end))}${CLOSE}`; last = span.end; }
  return out + text.slice(last);
}

/**
 * Put the source back in place of placeholders. With `unescape`, Markdown
 * backslash escapes in the restored source are applied, as the parser would
 * have done (in a link target, `a\(b\)` is `a(b)`); code keeps it raw.
 */
export const restoreMath = (text: string, unescape = false) => text.includes(OPEN)
  ? text.replace(PLACEHOLDER, (match, hex: string) => { const raw = decode(hex)?.raw; return raw === undefined ? match : unescape ? raw.replace(/\\([!-/:-@[-`{-~])/g, '$1') : raw; })
  : text;

type Node = { type: string; value?: string; url?: string; title?: string | null; alt?: string | null; children?: Node[]; data?: Record<string, unknown> };

function mathNode(tex: string, display: boolean): Node {
  // remark-rehype turns this into <code class="language-math math-inline|math-display">, which rehype-katex renders.
  return { type: 'latexMath', value: tex, data: { hName: 'code', hProperties: { className: ['language-math', display ? 'math-display' : 'math-inline'] }, hChildren: [{ type: 'text', value: tex }] } };
}

function transform(node: Node, render: boolean): void {
  for (const key of ['value', 'url', 'title', 'alt'] as const) {
    const value = node[key];
    if (typeof value === 'string' && value.includes(OPEN) && node.type !== 'text') node[key] = restoreMath(value, key !== 'value');
  }
  if (!node.children) return;
  const children: Node[] = [];
  for (const child of node.children) {
    if (child.type !== 'text' || !child.value?.includes(OPEN)) { transform(child, render); children.push(child); continue; }
    let last = 0;
    const value = child.value;
    for (const match of value.matchAll(PLACEHOLDER)) {
      const math = decode(match[1]!);
      if (!math) continue;
      if (match.index > last) children.push({ type: 'text', value: value.slice(last, match.index) });
      children.push(render ? mathNode(math.tex, math.display) : { type: 'text', value: math.raw });
      last = match.index + match[0].length;
    }
    if (last < value.length) children.push({ type: 'text', value: value.slice(last) });
  }
  // Merge adjacent text so raw maths reads as ordinary text.
  node.children = children.reduce<Node[]>((merged, child) => {
    const previous = merged.at(-1);
    if (child.type === 'text' && previous?.type === 'text' && !previous.data && !child.data) previous.value = `${previous.value}${child.value}`; else merged.push(child);
    return merged;
  }, []);
}

/**
 * Remark plugin for text preprocessed by {@link protectMath}. With
 * `render: true`, maths becomes nodes for rehype-katex; with `false`, the
 * source as plain text (LaTeX off, or KaTeX still loading).
 */
export function remarkLatex(options: { render: boolean }) {
  return (tree: Node) => transform(tree, options.render);
}
