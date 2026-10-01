import { askUserTool, defineAgent } from 'ai-sdk-letta';
import { dateDiff } from './tools.js';

/**
 * The starter agent. Copy this folder, then change `id` and `name` before
 * the first run: the first run creates a persistent Letta agent for this ID
 * and every later run reopens it.
 *
 * `STARTER_AGENT_ID` (for example, a throwaway ID for a smoke test) and
 * `LETTA_MODEL` override the defaults without editing code. The variable is
 * namespaced on purpose: some shells, such as Letta Code's, already export
 * `AGENT_ID` and `AGENT_NAME` for their own agent.
 */
export const agent = defineAgent({
  id: process.env.STARTER_AGENT_ID ?? 'starter-assistant',
  name: 'Starter Assistant',
  model: process.env.LETTA_MODEL ?? 'openai-codex/gpt-5.5',
  instructions: 'You are a concise planning assistant. For any question about the number of days, weeks or business days between dates, '
    + 'or the weekday of a date, call date_diff instead of computing it yourself. '
    + 'When you need a decision from the user, call ask_user with a short question and clear options.',
  tools: { date_diff: dateDiff, ask_user: askUserTool },
  // Fail-closed: every tool needs "allow", "ask" or "deny". Set
  // DATE_DIFF_PERMISSION=ask to approve each call by hand.
  permissions: { date_diff: process.env.DATE_DIFF_PERMISSION === 'ask' ? 'ask' : 'allow', ask_user: 'allow' },
});
