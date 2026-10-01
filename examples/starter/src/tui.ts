import { runTerminal } from '@ai-sdk-letta/tui';
import { agent } from './agent.js';

// Accepts --list, --resume, --new [title], --conversation ID and --state-dir PATH.
process.exitCode = await runTerminal(agent, process.argv.slice(2));
