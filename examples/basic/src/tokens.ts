/**
 * Automation tokens from the command line (the server owner), also while the
 * server runs. The app's Automations dialog does the same for agent admins.
 *
 *   npm run tokens -- create --name "Nightly report" --via n8n [--pre-approve text_stats] [--actor alex@example.com]
 *   npm run tokens -- list
 *   npm run tokens -- revoke <id>
 *
 * Options: --state-dir <dir>. The new token is printed once; only its hash is stored.
 */
import { createAutomationToken, listAutomationTokens, revokeAutomationToken, type AutomationVia } from '@ai-sdk-letta/server';
import { agent } from './agent.js';

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const all = (name: string) => args.flatMap((arg, i) => arg === name && args[i + 1] ? args[i + 1]!.split(',').map(s => s.trim()).filter(Boolean) : []);
const stateDirectory = flag('--state-dir');
if (command === 'create') {
  const name = flag('--name');
  if (!name) throw new Error('Give the token a --name');
  const { id, secret, token } = createAutomationToken(agent, { name, via: (flag('--via') ?? 'api') as AutomationVia, preApproved: all('--pre-approve'), ...(flag('--actor') ? { actor: flag('--actor')! } : {}), ...(stateDirectory ? { stateDirectory } : {}) });
  console.log(`Created "${token.name}" (${id}), acting as ${token.actor.name}${token.preApproved.length ? `, pre-approved: ${token.preApproved.join(', ')}` : ''}.\nToken (shown once):\n${secret}`);
} else if (command === 'list') {
  for (const token of listAutomationTokens(agent, stateDirectory ? { stateDirectory } : {})) console.log(`${token.id}  ${token.name}  via ${token.via}  ${token.hint}  as ${token.actor.name}  last used ${token.lastUsedAt ?? 'never'}`);
} else if (command === 'revoke' && args[0]) {
  console.log(revokeAutomationToken(agent, args[0], stateDirectory ? { stateDirectory } : {}) ? 'Revoked.' : 'No such token.');
} else {
  console.error('Usage: tokens create --name <name> [--via n8n|conductor|api] [--pre-approve tool,...] [--actor login] | list | revoke <id>');
  process.exitCode = 2;
}
