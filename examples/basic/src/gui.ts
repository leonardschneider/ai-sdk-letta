import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { closeOnSignals, startGuiServer, startTeamServer, type AutomationOptions } from '@ai-sdk-letta/server';
import { agent } from './agent.js';

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const list = (name: string) => args.flatMap((arg, i) => arg === name && args[i + 1] ? args[i + 1]!.split(',').map(s => s.trim()).filter(Boolean) : []);
const port = Number(flag('--port') ?? process.env.PORT ?? 4400);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
// The built assistant-ui app ships in @ai-sdk-letta/web's dist directory.
const assets = join(dirname(createRequire(import.meta.url).resolve('@ai-sdk-letta/web/package.json')), 'dist');
const stateDirectory = flag('--state-dir');

/**
 * Automations (n8n, Conductor, scripts): --automation-port 4402 serves the
 * automation API on 127.0.0.1:4402 (tokens: Automations in the app).
 * For schedule_task (SCHEDULING=1 in agent.ts), name the orchestrator:
 * N8N_URL + N8N_API_KEY, or CONDUCTOR_URL. It calls this server back at
 * AUTOMATION_CALLBACK_URL (default http://host.docker.internal:<port>, for
 * an orchestrator in Docker on this machine).
 */
const automationPort = flag('--automation-port') ?? process.env.AUTOMATION_PORT;
let automation: AutomationOptions | undefined;
if (automationPort !== undefined) {
  const portNumber = Number(automationPort);
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) throw new Error('Invalid --automation-port');
  const callbackUrl = process.env.AUTOMATION_CALLBACK_URL ?? `http://host.docker.internal:${portNumber}`;
  automation = { port: portNumber, ...(flag('--automation-host') ? { host: flag('--automation-host')! } : {}),
    ...(process.env.N8N_URL && process.env.N8N_API_KEY ? { scheduler: { kind: 'n8n' as const, url: process.env.N8N_URL, apiKey: process.env.N8N_API_KEY, callbackUrl } }
      : process.env.CONDUCTOR_URL ? { scheduler: { kind: 'conductor' as const, url: process.env.CONDUCTOR_URL, callbackUrl } } : {}) };
}

// Web app previews (WEBDEV=1): their own loopback listener; --preview-port picks its port (default: a free one).
const previewPort = flag('--preview-port') ?? process.env.PREVIEW_PORT;
if (previewPort !== undefined && (!Number.isInteger(Number(previewPort)) || Number(previewPort) < 0 || Number(previewPort) > 65535)) throw new Error('Invalid --preview-port');

// Team mode (several people, through `tailscale serve`): --tailscale --owner you@example.com --origin https://machine.tailnet.ts.net
const server = args.includes('--tailscale')
  ? await startTeamServer([agent], assets, { port, stateDirectory, owners: list('--owner'), origins: list('--origin'), ...(automation ? { automation } : {}) })
  // Add agent (in the app) opens your existing local Letta agents in place; they get the same sandbox, if any.
  : await startGuiServer(agent, assets, { port, stateDirectory, ...(automation ? { automation } : {}), ...(previewPort !== undefined ? { previewPort: Number(previewPort) } : {}), adoption: { ...(agent.sandbox ? { sandbox: agent.sandbox } : {}) } });
closeOnSignals(server);
