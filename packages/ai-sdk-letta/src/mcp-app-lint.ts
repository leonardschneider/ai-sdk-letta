/**
 * MCP Apps contract linter: checks what an app server declares (tools'
 * `_meta.ui`, its `ui://` resources, their HTML) against the MCP Apps
 * contract, with stable rule ids and short fixes. Validates with the vendored
 * `@modelcontextprotocol/ext-apps` schema (`mcp-app-schema.json`).
 */
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import schema from './mcp-app-schema.json' with { type: 'json' };
import type { McpAppClient, McpToolDefinition } from './mcp-apps.js';

/** The `@modelcontextprotocol/ext-apps` version `mcp-app-schema.json` is vendored from. */
export const MCP_APP_SCHEMA_VERSION = '2.0.3';

export type McpAppLintFinding = { level: 'error' | 'warning'; rule: string; tool?: string; resource?: string; message: string; fix?: string };

const MCP_APP_MIME = 'text/html;profile=mcp-app';
const HTML_CAP = 2 * 1024 * 1024;
const MAX_FINDINGS = 50;
const CALL_TIMEOUT_MS = 10_000;
const FLAT_KEYS = ['ui.resourceUri', 'ui/resourceUri'] as const;

let validators: { tool: ValidateFunction; resource: ValidateFunction } | undefined;
function compiled() {
  if (!validators) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    ajv.addSchema({ $id: 'mcp-app', $defs: schema.$defs });
    validators = { tool: ajv.getSchema('mcp-app#/$defs/McpUiToolMeta')!, resource: ajv.getSchema('mcp-app#/$defs/McpUiResourceMeta')! };
  }
  return validators;
}

const ajvMessage = (errors: ErrorObject[]) => errors.slice(0, 3).map(e => {
  const extra = e.keyword === 'additionalProperties' ? ` (${(e.params as { additionalProperty: string }).additionalProperty})` : '';
  return `${e.instancePath || '(root)'} ${e.message ?? e.keyword}${extra}`;
}).join('; ');

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Rejects when `signal` aborts or after `ms`, whichever is first. */
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, outer: AbortSignal | undefined): Promise<T> {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  signal.throwIfAborted();
  let off = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    off = () => signal.removeEventListener('abort', onAbort);
  });
  try { return await Promise.race([work(signal), aborted]); } finally { off(); }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** The `ui://` (or other) URI a tool points at, from the nested key or a flat one. */
function rawResourceUri(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  const ui = meta.ui;
  const nested = isObject(ui) ? ui.resourceUri : undefined;
  const uri = nested ?? meta['ui/resourceUri'] ?? meta['ui.resourceUri'];
  return typeof uri === 'string' && uri.length > 0 ? uri.slice(0, 500) : undefined;
}

/** Checks an MCP App server against the MCP Apps contract. At most 50 findings. */
export async function lintMcpApp(client: McpAppClient, options: { signal?: AbortSignal } = {}): Promise<McpAppLintFinding[]> {
  const findings: McpAppLintFinding[] = [];
  const add = (finding: McpAppLintFinding) => { if (findings.length < MAX_FINDINGS) findings.push(finding); };
  const full = () => findings.length >= MAX_FINDINGS;
  const { tool: validateTool, resource: validateResource } = compiled();

  const { tools } = await bounded(() => client.listTools(), options.signal);
  const uiTools = new Map<string, string[]>();

  for (const tool of (tools ?? []) as McpToolDefinition[]) {
    if (full()) return findings;
    const name = tool.name;
    const meta = isObject(tool._meta) ? tool._meta : undefined;
    const nested = isObject(meta?.ui) ? (meta!.ui as Record<string, unknown>).resourceUri : undefined;
    for (const key of FLAT_KEYS) {
      if (meta && key in meta) {
        // The SDK's registerAppTool also emits the legacy flat key next to the nested one, for older hosts: fine when they agree.
        if (nested !== undefined) {
          if (nested !== meta[key]) add({ level: 'warning', rule: 'flat-resource-uri', tool: name, message: `_meta has the legacy flat key "${key}" (${JSON.stringify(String(meta[key])).slice(0, 120)}) and a different _meta.ui.resourceUri; hosts read the nested one`, fix: `Make "${key}" equal to _meta.ui.resourceUri, or drop it` });
          continue;
        }
        add({ level: 'error', rule: 'flat-resource-uri', tool: name, message: `_meta uses the flat key "${key}"; hosts read the nested _meta.ui.resourceUri`, fix: `Declare _meta: { ui: { resourceUri: ${JSON.stringify(String(meta[key]))} } } (registerAppTool from @modelcontextprotocol/ext-apps/server does this)` });
      }
    }
    const ui = meta?.ui;
    if (ui !== undefined) {
      if (!validateTool(ui)) {
        const errors = (validateTool.errors ?? []).filter(e => !e.instancePath.startsWith('/visibility'));
        if (errors.length) add({ level: 'error', rule: 'tool-meta-schema', tool: name, message: `_meta.ui does not match McpUiToolMeta: ${ajvMessage(errors)}`, fix: 'Keep only resourceUri (string) and visibility (["model"|"app"]) in a tool\'s _meta.ui; csp and permissions belong on the resource' });
      }
      const visibility = isObject(ui) ? ui.visibility : undefined;
      if (visibility !== undefined) {
        const bad = Array.isArray(visibility) ? visibility.filter(v => v !== 'model' && v !== 'app') : [visibility];
        if (!Array.isArray(visibility) || visibility.length === 0 || bad.length) {
          add({ level: 'error', rule: 'visibility', tool: name, message: Array.isArray(visibility) && visibility.length === 0 ? '_meta.ui.visibility is empty: nobody can call this tool' : `_meta.ui.visibility has invalid values: ${JSON.stringify(bad).slice(0, 200)}`, fix: 'Use visibility: ["model", "app"] (default), ["model"] or ["app"]' });
        }
      }
    }
    const uri = rawResourceUri(meta);
    if (uri) uiTools.set(uri, [...uiTools.get(uri) ?? [], name]);
  }

  if (uiTools.size === 0) {
    add({ level: 'warning', rule: 'no-ui-tools', message: 'No tool declares a UI resource (_meta.ui.resourceUri): this server has no app views', fix: 'Register a ui:// resource and point a tool at it with _meta: { ui: { resourceUri: "ui://<app>/view.html" } }' });
    return findings;
  }

  let listed: Set<string> | undefined;
  if (client.listResources) {
    try { listed = new Set((await bounded(signal => client.listResources!(signal), options.signal)).resources.map(r => r.uri)); }
    catch (error) { options.signal?.throwIfAborted(); add({ level: 'warning', rule: 'resource-missing', message: `resources/list failed: ${errorText(error)}`, fix: 'Implement resources/list and include every ui:// resource' }); }
  }

  for (const [uri, names] of uiTools) {
    if (full()) return findings;
    const tool = names[0];
    if (listed && !listed.has(uri)) add({ level: 'warning', rule: 'resource-missing', tool, resource: uri, message: `${uri} is not in resources/list`, fix: 'Register the view with registerAppResource (or server.registerResource) so it is listed' });
    let contents;
    try { contents = (await bounded(signal => client.readResource(uri, signal), options.signal)).contents ?? []; }
    catch (error) {
      options.signal?.throwIfAborted();
      add({ level: 'error', rule: 'resource-missing', tool, resource: uri, message: `resources/read ${uri} failed: ${errorText(error)}`, fix: `Register a resource at exactly ${uri} that returns the view's HTML` });
      continue;
    }
    const content = contents.find(c => c.uri === uri) ?? contents[0];
    if (!content) { add({ level: 'error', rule: 'resource-missing', tool, resource: uri, message: `resources/read ${uri} returned no contents`, fix: `Return { contents: [{ uri: "${uri}", mimeType: "${MCP_APP_MIME}", text: html }] }` }); continue; }
    if (content.mimeType !== MCP_APP_MIME) add({ level: 'error', rule: 'resource-mime', tool, resource: uri, message: `${uri} has mimeType ${JSON.stringify(content.mimeType ?? null)}, not "${MCP_APP_MIME}"`, fix: `Set mimeType: "${MCP_APP_MIME}" (RESOURCE_MIME_TYPE from @modelcontextprotocol/ext-apps/server)` });
    const resourceUi = isObject(content._meta) ? content._meta.ui : undefined;
    if (resourceUi !== undefined && !validateResource(resourceUi)) {
      add({ level: 'error', rule: 'resource-meta-schema', tool, resource: uri, message: `_meta.ui does not match McpUiResourceMeta: ${ajvMessage(validateResource.errors ?? [])}`, fix: 'Use _meta: { ui: { csp: { connectDomains: ["https://api.example.com"], resourceDomains: [...] }, permissions: { camera: {} }, prefersBorder: true } }: domain lists are string arrays, permissions are empty objects' });
    }
    let html = '';
    if (typeof content.text === 'string') html = content.text.slice(0, HTML_CAP);
    else if (typeof content.blob === 'string') html = Buffer.from(content.blob.slice(0, Math.ceil(HTML_CAP / 3) * 4), 'base64').toString('utf8');
    if (!html) continue;
    if (!/@modelcontextprotocol\/ext-apps|ext-apps|\bApp\(|new App\b|\buseApp\b|ui\/initialize/.test(html)) {
      add({ level: 'warning', rule: 'app-sdk-missing', tool, resource: uri, message: `${uri} does not seem to load the MCP Apps SDK (no ext-apps import, App or ui/initialize)`, fix: 'Bundle @modelcontextprotocol/ext-apps into the HTML: const app = new App({ name, version }); await app.connect();' });
    }
    if (/callServerTool\s*\(\s*['"`]/.test(html)) {
      add({ level: 'error', rule: 'call-server-tool-string', tool, resource: uri, message: `${uri} calls callServerTool with a string tool name`, fix: 'Use app.callServerTool({ name: "tool", arguments: { ... } })' });
    }
  }
  return findings;
}
