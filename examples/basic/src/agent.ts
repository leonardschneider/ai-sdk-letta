import { tool, jsonSchema } from 'ai';
import { askUserTool, defineAgent, detectSandboxProvider, fileTools, FILE_TOOL_PERMISSIONS, prepareSandbox, sandboxTools, SANDBOX_TOOL_PERMISSIONS, type SandboxConfig, type SandboxProviderName } from 'ai-sdk-letta';

/**
 * One custom tool: pure, no side effects. It runs in this process when the
 * Letta agent calls it, after schema validation and the permission policy.
 */
export const textStats = tool({
  description: 'Count Unicode code points, whitespace-separated words, and lines in text. No external actions.',
  inputSchema: jsonSchema<{ text: string }>({
    type: 'object',
    properties: { text: { type: 'string', maxLength: 8000 } },
    required: ['text'],
    additionalProperties: false,
  }),
  execute: async ({ text }) => ({
    characters: [...text].length,
    words: text.trim() ? text.trim().split(/\s+/u).length : 0,
    lines: text.split('\n').length,
  }),
});

/**
 * Shell commands in a sandbox: Apple Container if it runs here, otherwise
 * Docker, otherwise off. Override with SANDBOX_PROVIDER=apple-container,
 * docker or off; mount a project folder with SANDBOX_PROJECT=/path; set the
 * per-command timeout with SANDBOX_TIMEOUT_MS (default 120000).
 */
async function chooseSandbox(): Promise<SandboxConfig | undefined> {
  const wanted = process.env.SANDBOX_PROVIDER?.trim();
  if (wanted === 'off') { console.error('Sandbox: off (SANDBOX_PROVIDER=off); run_command is not available.'); return undefined; }
  if (wanted && wanted !== 'apple-container' && wanted !== 'docker') throw new Error('SANDBOX_PROVIDER must be apple-container, docker or off');
  const provider = (wanted as SandboxProviderName | undefined) ?? await detectSandboxProvider();
  if (!provider) {
    console.error('Sandbox: off. Neither Apple Container (`brew install container && container system start`) nor Docker is running, so run_command is not available.');
    return undefined;
  }
  const sandbox: SandboxConfig = { provider, ...(process.env.SANDBOX_PROJECT ? { project: process.env.SANDBOX_PROJECT } : {}), ...(process.env.SANDBOX_TIMEOUT_MS ? { timeoutMs: Number(process.env.SANDBOX_TIMEOUT_MS) } : {}), git: { name: process.env.SANDBOX_GIT_NAME ?? 'Example Assistant', email: process.env.SANDBOX_GIT_EMAIL ?? 'assistant@example.invalid' } };
  // Builds the sandbox image on the first run only (about a minute).
  await prepareSandbox(sandbox, line => console.error(line));
  return sandbox;
}
const sandbox = await chooseSandbox();

/**
 * The example agent. `id` is your stable logical identity: the first run
 * creates a Letta agent and records its generated ID in the state directory;
 * later runs reopen the same agent, memory and conversations.
 *
 * Override the model with LETTA_MODEL, and the logical ID with AGENT_ID (for
 * example, a throwaway ID for smoke tests).
 */
export const agent = defineAgent({
  id: process.env.AGENT_ID ?? 'example-assistant',
  name: process.env.AGENT_NAME ?? 'Example Assistant',
  model: process.env.LETTA_MODEL ?? 'openai-codex/gpt-5.5',
  instructions: 'You are a helpful, concise assistant. Use text_stats when asked to count text. When a decision needs the user\'s input, you may call ask_user with clear options. '
    + 'The user can attach files; a message then ends with lines like "Attached: report.pdf (PDF, 12 pages, 2.1 MB)". Use list_files, search_files and read_file to work with them, reading only the pages or lines you need, and cite the page or line you used. '
    + 'When available, run_command runs shell commands in an isolated sandbox without network, where /workspace holds the attached files: use it for calculations (write a Python script), searching with rg, and git. '
    + 'For anything that needs the internet, such as pip install, use run_command_online; the user approves each call. Never push to remote repositories; the user does that.',
  // fileTools adds list_files, read_file and search_files, restricted to the current conversation's attachments.
  // sandboxTools adds run_command (no network) and run_command_online (asks every time); they are only exposed with a sandbox.
  tools: { text_stats: textStats, ask_user: askUserTool, ...fileTools, ...sandboxTools },
  // Fail-closed: every tool is listed. Try 'ask' to require approval per call.
  permissions: { text_stats: process.env.TEXT_STATS_PERMISSION === 'ask' ? 'ask' : 'allow', ask_user: 'allow', ...FILE_TOOL_PERMISSIONS, ...SANDBOX_TOOL_PERMISSIONS },
  ...(sandbox ? { sandbox } : {}),
  dreaming: { trigger: 'step-count', stepCount: 25 },
});
