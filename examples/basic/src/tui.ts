import { runTerminal } from '@ai-sdk-letta/tui';
import { agent } from './agent.js';

process.exitCode = await runTerminal(agent, process.argv.slice(2));
