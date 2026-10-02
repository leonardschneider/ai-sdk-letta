import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { closeOnSignals, startGuiServer, startTeamServer } from '@ai-sdk-letta/server';
import { agent } from './agent.js';

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const list = (name: string) => args.flatMap((arg, i) => arg === name && args[i + 1] ? args[i + 1]!.split(',').map(s => s.trim()).filter(Boolean) : []);
const port = Number(flag('--port') ?? process.env.PORT ?? 4400);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
// The built assistant-ui app ships in @ai-sdk-letta/web's dist directory.
const assets = join(dirname(createRequire(import.meta.url).resolve('@ai-sdk-letta/web/package.json')), 'dist');
const stateDirectory = flag('--state-dir');

// Team mode (several people, through `tailscale serve`): --tailscale --owner you@example.com --origin https://machine.tailnet.ts.net
const server = args.includes('--tailscale')
  ? await startTeamServer([agent], assets, { port, stateDirectory, owners: list('--owner'), origins: list('--origin') })
  : await startGuiServer(agent, assets, { port, stateDirectory });
closeOnSignals(server);
