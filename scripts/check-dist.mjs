// prepack guard for the published packages: refuse to pack or publish
// without a fresh build. Run from a package directory.
import { existsSync, readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const required = [manifest.main, manifest.module, manifest.types].filter(Boolean);
const missing = required.filter(file => !existsSync(file));
if (missing.length > 0) {
  console.error(`${manifest.name}: ${missing.join(', ')} missing. Run \`npm run build\` at the repository root first.`);
  process.exit(1);
}
