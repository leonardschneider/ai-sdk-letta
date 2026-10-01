import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { closeOnSignals, startGuiServer } from '@ai-sdk-letta/server';
import { agent } from './agent.js';

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const port = Number(flag('--port') ?? process.env.PORT ?? 4400);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
// The built browser app is the dist/ directory of @ai-sdk-letta/web (a workspace of this repository).
const assets = join(dirname(createRequire(import.meta.url).resolve('@ai-sdk-letta/web/package.json')), 'dist');
const server = await startGuiServer(agent, assets, { port, stateDirectory: flag('--state-dir') });
closeOnSignals(server);
