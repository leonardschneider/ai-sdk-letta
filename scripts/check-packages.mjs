// Checks what each published package would ship, using `npm pack --dry-run`.
// Run after `npm run build`. Never publishes anything.
//
//   node scripts/check-packages.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const published = [
  { dir: 'packages/ai-sdk-letta', license: 'Apache-2.0', notice: true },
  { dir: 'packages/server', license: 'Apache-2.0', notice: true },
  { dir: 'packages/provider', license: 'MIT', notice: false },
];
const privateWorkspaces = ['apps/tui', 'apps/web', 'examples/basic'];
const forbidden = [
  [/(^|\/)test(s)?\//, 'test directory'],
  [/\.test\.[cm]?[jt]sx?$/, 'test file'],
  [/\.e2e\.[cm]?[jt]sx?$/, 'e2e test'],
  [/(^|\/)e2e\//, 'e2e directory'],
  [/(^|\/)fixtures?(\.[jt]s)?(\/|$)/, 'fixture'],
  [/(^|\/)\.env(\.|$)/, '.env file'],
  [/(^|\/)\.(letta|state)\//, 'local state'],
  [/\.(pending|lock)(\.json)?$/, 'state file'],
  [/\.tgz$/, 'tarball'],
  [/(^|\/)vitest[^/]*$|(^|\/)tsup\.config|(^|\/)tsconfig[^/]*\.json$/, 'build config'],
];
const maxUnpacked = 1_000_000;
const failures = [];
const fail = (name, message) => failures.push(`${name}: ${message}`);

for (const { dir, license, notice } of published) {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const { name } = manifest;
  if (manifest.private) fail(name, 'is private');
  if (manifest.license !== license) fail(name, `license is ${manifest.license}, expected ${license}`);
  if (name.startsWith('@') && manifest.publishConfig?.access !== 'public') fail(name, 'scoped package needs publishConfig.access "public"');
  for (const [field, ranges] of Object.entries({ dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies })) {
    for (const [dependency, range] of Object.entries(ranges ?? {})) {
      if (range === '*' || range.startsWith('workspace:') || range.startsWith('file:') || range.startsWith('link:')) fail(name, `${field}.${dependency} uses "${range}", which does not work from npm`);
    }
  }

  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: join(root, dir), encoding: 'utf8' }));
  const files = pack.files.map(file => file.path);
  for (const required of ['package.json', 'README.md', 'LICENSE', ...(notice ? ['NOTICE'] : [])]) {
    if (!files.includes(required)) fail(name, `does not ship ${required}`);
  }
  for (const target of [manifest.main, manifest.module, manifest.types].filter(Boolean)) {
    if (!files.includes(target.replace(/^\.\//, ''))) fail(name, `does not ship ${target} (run npm run build first)`);
  }
  for (const file of files) {
    for (const [pattern, what] of forbidden) if (pattern.test(file)) fail(name, `ships ${what}: ${file}`);
    if (file.endsWith('.map')) {
      const map = JSON.parse(readFileSync(join(root, dir, file), 'utf8'));
      for (const source of [map.sourceRoot ?? '', ...map.sources]) {
        if (source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('file:')) fail(name, `${file} has an absolute source path: ${source}`);
      }
    }
  }
  if (pack.unpackedSize > maxUnpacked) fail(name, `unpacked size ${pack.unpackedSize} exceeds ${maxUnpacked}`);
  console.log(`${pack.id}: ${files.length} files, ${(pack.size / 1024).toFixed(1)} kB packed, ${(pack.unpackedSize / 1024).toFixed(1)} kB unpacked`);
}

for (const dir of privateWorkspaces) {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  if (manifest.private !== true) fail(manifest.name, 'must stay "private": true for now');
}

if (failures.length > 0) {
  console.error(`\n${failures.length} packaging problem(s):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Packaging checks passed.');
