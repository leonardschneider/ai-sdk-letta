// Regenerates packages/ai-sdk-letta/src/mcp-app-schema.json from @modelcontextprotocol/ext-apps's
// JSON schema (dist/src/generated/schema.json): the definitions the MCP Apps linter validates with
// (tool `_meta.ui`, resource `_meta.ui`, CSP, permissions, visibility).
//
//   node scripts/vendor-mcp-app-schema.mjs [path/to/schema.json]
//
// Defaults to the installed package (node_modules/@modelcontextprotocol/ext-apps). Then update
// MCP_APP_SCHEMA_VERSION in packages/ai-sdk-letta/src/mcp-app-lint.ts if the version changed.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const file = process.argv[2] ?? `${root}node_modules/@modelcontextprotocol/ext-apps/dist/src/generated/schema.json`;
const pkg = JSON.parse(readFileSync(`${root}node_modules/@modelcontextprotocol/ext-apps/package.json`, 'utf8'));
const schema = JSON.parse(readFileSync(file, 'utf8'));
const KEEP = ['McpUiToolMeta', 'McpUiToolVisibility', 'McpUiResourceMeta', 'McpUiResourceCsp', 'McpUiResourcePermissions'];
// Draft 2020-12 markers removed: Ajv validates the same keywords (type, properties, items, anyOf, const, not) without them.
const strip = value => Array.isArray(value) ? value.map(strip) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$schema').map(([key, v]) => [key, strip(v)])) : value;
const out = { $comment: `MCP Apps definitions from @modelcontextprotocol/ext-apps ${pkg.version} (dist/src/generated/schema.json), Apache-2.0 (MIT for parts not yet relicensed), Copyright the Model Context Protocol authors. Regenerate with scripts/vendor-mcp-app-schema.mjs.`, version: pkg.version, $defs: Object.fromEntries(KEEP.map(key => { if (!schema.$defs[key]) throw new Error(`${key} missing from ${file}`); return [key, strip(schema.$defs[key])]; })) };
const target = new URL('../packages/ai-sdk-letta/src/mcp-app-schema.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
console.log(`Wrote ${target.pathname} (ext-apps ${pkg.version}).`);
