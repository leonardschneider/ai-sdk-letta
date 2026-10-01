// Fails on high or critical advisories in production dependencies, except
// advisories on the allowlist (.github/audit-allowlist.json) that have not
// expired. Lower severities and allowlisted advisories are reported but do not
// fail. Expired entries fail, so every exception is reviewed again; entries
// that no longer match anything are reported so they can be removed.
//
//   node scripts/check-audit.mjs
//
// Reads `npm audit --omit=dev --json`; needs network access to the registry.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const failing = new Set(['high', 'critical']);
const allowlist = JSON.parse(readFileSync(new URL('../.github/audit-allowlist.json', import.meta.url), 'utf8')).advisories;
const today = new Date().toISOString().slice(0, 10);

let output;
try {
  output = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  // npm audit exits non-zero when it finds anything; the report is still on stdout.
  output = error.stdout;
}
let report;
try { report = JSON.parse(output); } catch { report = undefined; }
if (!report?.vulnerabilities) {
  console.error(`npm audit did not return a report:\n${output || '(no output)'}`);
  process.exit(1);
}

// npm lists each vulnerable package; the advisories themselves are the object
// entries in `via` (string entries only point at another vulnerable package).
const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities)) {
  for (const via of vulnerability.via) {
    if (typeof via !== 'object') continue;
    const id = via.url.split('/').pop();
    const key = `${via.name} ${id}`;
    const entry = advisories.get(key) ?? { id, name: via.name, severity: via.severity, title: via.title, url: via.url, range: via.range, paths: new Set() };
    for (const node of vulnerability.nodes) entry.paths.add(node);
    advisories.set(key, entry);
  }
}

const failures = [];
const used = new Set();
for (const advisory of advisories.values()) {
  const allowed = allowlist.find(entry => entry.id === advisory.id && entry.package === advisory.name);
  const line = `${advisory.severity} ${advisory.name} ${advisory.range}: ${advisory.title} (${advisory.url})\n    at ${[...advisory.paths].join(', ')}`;
  if (allowed) used.add(allowed);
  if (!failing.has(advisory.severity)) {
    console.log(`note: ${line}`);
  } else if (!allowed) {
    failures.push(`not allowlisted: ${line}`);
  } else if (allowed.expires < today) {
    failures.push(`allowlist entry expired on ${allowed.expires}; review it: ${line}`);
  } else {
    console.log(`allowed until ${allowed.expires}: ${line}\n    reason: ${allowed.reason}`);
  }
}
for (const entry of allowlist) {
  if (!used.has(entry)) console.log(`stale allowlist entry (no longer reported; remove it): ${entry.package} ${entry.id}`);
}

if (failures.length) {
  console.error(`\nProduction dependency audit failed:\n${failures.map(failure => `  ${failure}`).join('\n')}`);
  console.error('\nFix the dependency, or, if the fix is upstream-only, add an entry with a reason and an expiry to .github/audit-allowlist.json.');
  process.exit(1);
}
console.log(`\nProduction dependency audit passed (${advisories.size} advisories reported, none unapproved at high or critical).`);
