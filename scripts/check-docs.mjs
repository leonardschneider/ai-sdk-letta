// Typechecks every TypeScript code block in the guides, so an API change that
// outdates the docs fails CI. Only blocks named *.test.ts (offline tests) are
// run; nothing else is executed and no backend is needed.
//
//   node scripts/check-docs.mjs
//
// Each ```ts block becomes one module. A block whose first line is a comment
// naming a file (`// src/tools.ts`) is written to that path, so later blocks
// can import it (`./tools.js`); other blocks are written to src/snippet-N.ts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const guides = ['docs/building-your-own-agent.md'];
const out = join(root, 'docs', '.snippets');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'src'), { recursive: true });
writeFileSync(join(out, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2));
writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { noEmit: true, noUnusedLocals: false }, include: ['src'] }, null, 2));

const written = new Map();
let count = 0;
for (const guide of guides) {
  const text = readFileSync(join(root, guide), 'utf8');
  // Fences may be indented (inside list items); the indentation is removed.
  for (const match of text.matchAll(/^( *)```ts\n([\s\S]*?)^\1```$/gm)) {
    const indent = match[1].length;
    const code = match[2].split('\n').map(line => line.slice(Math.min(indent, line.length - line.trimStart().length))).join('\n');
    const line = text.slice(0, match.index).split('\n').length;
    const named = /^\/\/ (src\/[\w./-]+\.ts)\n/.exec(code)?.[1];
    const path = named ?? `src/snippet-${++count}.ts`;
    if (written.has(path)) throw new Error(`${guide}:${line}: ${path} is already defined at ${written.get(path)}`);
    written.set(path, `${guide}:${line}`);
    mkdirSync(dirname(join(out, path)), { recursive: true });
    // Every file is a module, even one without imports.
    writeFileSync(join(out, path), `// From ${guide}:${line}\n${code}\nexport {};\n`);
  }
}
if (!written.size) throw new Error('No TypeScript blocks found');

const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
try {
  execFileSync(process.execPath, [tsc, '-p', join(out, 'tsconfig.json')], { stdio: 'inherit' });
} catch {
  console.error(`\nA TypeScript block in the docs no longer compiles. Files are in ${out}; each starts with the guide line it came from.`);
  process.exit(1);
}
console.log(`Docs: ${written.size} TypeScript blocks typecheck (${[...written.values()].join(', ')}).`);

// Blocks named *.test.ts are offline tests: run them too, so the behaviour
// the guide shows (results, error codes) stays true.
const tests = [...written.keys()].filter(path => path.endsWith('.test.ts'));
if (tests.length) {
  try {
    execFileSync(process.execPath, ['--conditions=ai-sdk-letta-source', '--import', 'tsx', '--test', ...tests], { cwd: out, stdio: 'inherit' });
  } catch {
    console.error('\nA test block in the docs fails.');
    process.exit(1);
  }
}
