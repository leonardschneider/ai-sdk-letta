/**
 * The Atlassian Document Format JSON schema (`@atlaskit/adf-schema`'s
 * `json-schema/v1/full.json`, Apache-2.0, Copyright Atlassian), vendored as
 * `adf-schema.json` so documents can be validated with Ajv without the
 * Atlaskit editor packages. Regenerate with `scripts/vendor-adf-schema.mjs`.
 */
import schema from './adf-schema.json' with { type: 'json' };

/** The `@atlaskit/adf-schema` version the schema comes from. */
export const ADF_SCHEMA_VERSION = '57.6.20';
/** The ADF JSON schema (draft-04 keywords; its `$schema` marker removed). */
export const ADF_SCHEMA: Readonly<Record<string, unknown>> = schema;
