import { createInterface } from 'node:readline/promises';
import { createLettaAgent } from 'ai-sdk-letta';
import { agent } from './agent.js';

/**
 * One turn without a UI: `npm run script -- "How many business days until 2026-12-24?"`.
 * Approvals and ask_user questions are answered on stdin.
 */
const prompt = process.argv.slice(2).join(' ').trim();
if (!prompt) throw new Error('Usage: npm run script -- "your message"');

// The state directory comes from AI_SDK_LETTA_STATE_DIR, or the platform default.
const runtime = await createLettaAgent(agent);
const terminal = createInterface({ input: process.stdin, output: process.stderr });
try {
  // Without a connected handler, "ask" tools and ask_user fail closed.
  runtime.agent.interactions.connect(async request => {
    if (request.kind === 'approval') {
      const answer = await terminal.question(`${request.title} ${request.details ?? ''} [y/N] `);
      return { id: request.id, approved: answer.trim().toLowerCase() === 'y' };
    }
    const options = request.options ?? [];
    options.forEach((option, index) => console.error(`  ${index + 1}. ${option.label}`));
    const answer = (await terminal.question(`${request.title} `)).trim();
    const picked = options[Number(answer) - 1];
    if (picked) return { id: request.id, selected: [picked.id] };
    return request.allowFreeText && answer ? { id: request.id, text: answer } : { id: request.id, cancelled: true };
  });
  const result = await runtime.agent.generate({ prompt });
  for (const call of result.toolResults) console.error(`[tool] ${call.toolName}: ${JSON.stringify(call.output)}`);
  console.log(result.text);
} finally {
  terminal.close();
  await runtime.close();
}
