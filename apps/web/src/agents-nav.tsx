import React from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check, Cpu, Eye, FileDiff, FolderGit2, Trash2, Users, Wrench } from 'lucide-react';
import type { AgentInfo } from './api.js';

/** What an agent's ⋯ menu can do (each absent action is hidden). */
export type AgentActions = {
  onModel?(agent: AgentInfo): void; onTools?(agent: AgentInfo): void; onProject?(agent: AgentInfo): void; onInstructions?(agent: AgentInfo): void;
  onViewOnly?(agent: AgentInfo, value: boolean): void; onRemove?(agent: AgentInfo): void;
  /** Team servers: the members of the agent (only for the current one). */
  onMembers?(agent: AgentInfo): void;
};

/** The model an agent uses, as shown in its row and menu. */
export function agentModel(agent: AgentInfo): string | undefined {
  const handle = agent.adopted?.model ?? agent.model;
  const effort = agent.adopted?.effort ?? agent.effort;
  return handle && effort ? `${handle} · ${effort}` : handle;
}

/** An agent's ⋯ menu (Model…, Tools…, Project folder…, Update instructions…, View only, Remove from app; Members… on team servers), around any trigger. */
export function AgentActionsMenu({ agent, actions, children, open, onOpenChange }: { agent: AgentInfo; actions: AgentActions; children: React.ReactNode; open?: boolean; onOpenChange?(open: boolean): void }) {
  const viewOnly = !!agent.viewOnly;
  const model = agentModel(agent);
  const { onModel, onTools, onProject, onInstructions, onViewOnly, onRemove, onMembers } = actions;
  const items = [
    onModel && (!agent.adopted || !viewOnly) && <DropdownMenu.Item key="model" className="menu-item" onSelect={() => onModel(agent)}><Cpu size={15} aria-hidden="true"/>Model…</DropdownMenu.Item>,
    agent.adopted && !viewOnly && onTools && <DropdownMenu.Item key="tools" className="menu-item" onSelect={() => onTools(agent)}><Wrench size={15} aria-hidden="true"/>Tools…</DropdownMenu.Item>,
    agent.adopted && !viewOnly && onProject && <DropdownMenu.Item key="project" className="menu-item" onSelect={() => onProject(agent)}><FolderGit2 size={15} aria-hidden="true"/>Project folder…</DropdownMenu.Item>,
    agent.adopted && !viewOnly && onInstructions && <DropdownMenu.Item key="instructions" className="menu-item" onSelect={() => onInstructions(agent)}><FileDiff size={15} aria-hidden="true"/>Update instructions…</DropdownMenu.Item>,
    agent.adopted && onViewOnly && <DropdownMenu.CheckboxItem key="viewonly" className="menu-item viewonly-toggle" checked={viewOnly} onCheckedChange={value => onViewOnly(agent, value === true)}>
      <span className="menu-check" aria-hidden="true"><DropdownMenu.ItemIndicator><Check size={15}/></DropdownMenu.ItemIndicator></span>
      <span className="viewonly-text"><span><Eye size={15} aria-hidden="true"/> View only</span><span className="menu-hint">Watch it work in Letta Code: conversations update live, nothing is sent from here.</span></span>
    </DropdownMenu.CheckboxItem>,
    onMembers && <DropdownMenu.Item key="members" className="menu-item" onSelect={() => onMembers(agent)}><Users size={15} aria-hidden="true"/>{agent.role === 'admin' ? 'Manage members…' : 'Members…'}</DropdownMenu.Item>,
  ].filter(Boolean);
  const remove = agent.adopted && onRemove;
  return <DropdownMenu.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
    <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu agent-menu" align="start" side="bottom" sideOffset={4} collisionPadding={8}>
        <DropdownMenu.Label className="menu-label">{agent.name}</DropdownMenu.Label>
        {model && <div className="agent-menu-model" title={`${agent.name} uses ${model}`}><Cpu size={13} aria-hidden="true"/><span>{model}</span></div>}
        {items}
        {!items.length && !remove && <div className="menu-hint agent-menu-empty">Settings for this agent come soon.</div>}
        {remove && <>{!!items.length && <DropdownMenu.Separator className="menu-sep"/>}<DropdownMenu.Item className="menu-item danger" onSelect={() => onRemove!(agent)}><Trash2 size={15} aria-hidden="true"/>Remove from app…</DropdownMenu.Item></>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
