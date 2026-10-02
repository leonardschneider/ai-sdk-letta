// Regenerates packages/ai-sdk-letta/src/adf-schema.json from @atlaskit/adf-schema's JSON schema.
//
//   npm pack @atlaskit/adf-schema@<version> && tar xzf atlaskit-adf-schema-*.tgz
//   node scripts/vendor-adf-schema.mjs package/json-schema/v1/full.json <version>
//
// Then update ADF_SCHEMA_VERSION in packages/ai-sdk-letta/src/adf-schema.ts.
import { readFileSync, writeFileSync } from 'node:fs';

const [file, version] = process.argv.slice(2);
if (!file || !version) { console.error('usage: node scripts/vendor-adf-schema.mjs <full.json> <version>'); process.exit(1); }
const schema = JSON.parse(readFileSync(file, 'utf8'));
delete schema.$schema; // draft-04 marker; Ajv validates the same keywords without it
schema.$comment = `Atlassian Document Format JSON schema from @atlaskit/adf-schema ${version} (json-schema/v1/full.json), Apache-2.0, Copyright Atlassian. Regenerate with scripts/vendor-adf-schema.mjs.`;
const out = new URL('../packages/ai-sdk-letta/src/adf-schema.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(schema)}\n`);
console.log(`Wrote ${out.pathname}; set ADF_SCHEMA_VERSION to ${version} in adf-schema.ts.`);
