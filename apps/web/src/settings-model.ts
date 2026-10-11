/** Pure model of the agent settings page: its URL hash, and which sections apply to an agent. No I/O. */
import type { AgentInfo } from './api.js';

/** The hash of an agent's settings page. */
export const settingsHash = (agentId: string) => `#/agents/${encodeURIComponent(agentId)}/settings`;

/** The agent whose settings page a hash opens (`#/agents/<id>/settings`), or undefined (the conversation). */
export function settingsAgent(hash: string): string | undefined {
  const match = /^#\/agents\/([^/]+)\/settings\/?$/.exec(hash);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!) || undefined; } catch { return undefined; }
}

/** The agent a hash opens settings for, when it is one of `known` (a reload keeps the page; an unknown or removed agent closes it). */
export function settingsTarget(hash: string, known: readonly string[]): string | undefined {
  const id = settingsAgent(hash);
  return id && known.includes(id) ? id : undefined;
}

/** What opening or closing the settings page does from the current agent: show it in place, switch agents first, or close it. */
export function settingsPlan(currentId: string, hash: string): { kind: 'open' } | { kind: 'switch'; agentId: string } | { kind: 'close' } {
  const id = settingsAgent(hash);
  if (!id) return { kind: 'close' };
  return id === currentId ? { kind: 'open' } : { kind: 'switch', agentId: id };
}

export type SettingsSection = 'general' | 'tools' | 'instructions' | 'apps' | 'memory' | 'automations' | 'members' | 'danger';
export const SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'General', tools: 'Tools', instructions: 'Instructions', apps: 'Apps', memory: 'Memory', automations: 'Automations', members: 'Members', danger: 'Danger zone',
};

/**
 * The sections of an agent's settings page, in order. Adopted agents get Tools,
 * Instructions and the Danger zone (Tools and Instructions not while view only),
 * the app's own agent Tools (tighten only, `toolControl`);
 * Apps and Automations need the feature, admins on a team server, and not view
 * only; Memory needs memory review; Members is for team admins.
 */
export function settingsSections(agent: AgentInfo, options: { team?: boolean } = {}): SettingsSection[] {
  const viewOnly = !!agent.viewOnly;
  const admin = !options.team || agent.role === 'admin';
  const adopted = !!agent.adopted && !options.team;
  const sections: SettingsSection[] = ['general'];
  if (adopted && !viewOnly) sections.push('tools', 'instructions');
  else if (agent.toolControl && !options.team && !viewOnly) sections.push('tools');
  if (agent.apps && admin && !viewOnly) sections.push('apps');
  if (agent.memory) sections.push('memory');
  if (agent.automations && admin && !viewOnly) sections.push('automations');
  if (options.team && agent.role === 'admin') sections.push('members');
  if (adopted) sections.push('danger');
  return sections;
}
