import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, MessageSquare, Trash2 } from 'lucide-react';
import type { AgentInfo } from './api.js';
import { InstructionsPanel, ModelPanel, ProjectPanel, ToolsPanel } from './adoption.js';
import { AppsPanel } from './apps.js';
import { MemoryIntro, MemoryPanel } from './memory.js';
import { AutomationsPanel } from './automations.js';
import { MembersPanel } from './team.js';
import type { ViewPolicy } from './apps-model.js';
import { SECTION_LABELS, settingsSections, type SettingsSection } from './settings-model.js';

export type SettingsProps = {
  agent: AgentInfo; team: boolean;
  /** Back to the conversation (the link, Escape, or picking a conversation). */
  onBack(): void;
  /** Settings changed in the server: reload the session (model, tools, project, view only). */
  onSaved(): void;
  onViewOnly?(value: boolean): void;
  onRemove?(): void;
  onAppsChanged(): void;
  viewPolicy?(appId: string): ViewPolicy; onViewPolicy?(appId: string, value: ViewPolicy): void;
  onOpenThread(id: string): void;
};

/**
 * An agent's settings page, in the main area in place of the conversation:
 * one scrollable page of sections (General, Tools, Instructions, Apps, Memory,
 * Automations, Members, Danger zone; those that don't apply are hidden), with
 * a table of contents on the left on desktop.
 */
export function SettingsPage(props: SettingsProps) {
  const { agent, team } = props;
  const sections = settingsSections(agent, { team });
  const viewOnly = !!agent.viewOnly;
  const admin = !team || agent.role === 'admin';
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<SettingsSection>('general');
  // Escape goes back, unless a menu or dialog is open (it closes that first) or focus is in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="menu"], [role="dialog"]')) return;
      event.preventDefault(); props.onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // The table of contents follows the scroll.
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id.replace('settings-', '') as SettingsSection);
    }, { root, rootMargin: '0px 0px -70% 0px' });
    root.querySelectorAll('.settings-section').forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [sections.join()]);
  const jump = (section: SettingsSection) => { setActive(section); document.getElementById(`settings-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const section = (id: SettingsSection, intro: React.ReactNode, body: React.ReactNode) => sections.includes(id) && <section key={id} id={`settings-${id}`} className={`settings-section${id === 'danger' ? ' danger' : ''}`} aria-labelledby={`settings-${id}-title`}>
    <h2 id={`settings-${id}-title`} className="settings-heading">{SECTION_LABELS[id]}</h2>
    {intro && <div className="settings-intro">{intro}</div>}
    {body}
  </section>;
  return <div className="settings-page" ref={scroller}>
    <div className="settings-inner">
      <div className="settings-top">
        <button type="button" className="link-btn settings-back" onClick={props.onBack}><ArrowLeft size={15} aria-hidden="true"/>Back to conversation</button>
        <h1 className="settings-title">{agent.name}<span className="settings-title-sub">Settings</span></h1>
        <button type="button" className="btn ghost small settings-open-chat" onClick={props.onBack}><MessageSquare size={15} aria-hidden="true"/>Open chat</button>
      </div>
      <div className="settings-body">
        <nav className="settings-toc" aria-label="Settings sections">
          <ul>{sections.map(id => <li key={id}><a href={`#settings-${id}`} aria-current={active === id ? 'location' : undefined} onClick={event => { event.preventDefault(); jump(id); }}>{SECTION_LABELS[id]}</a></li>)}</ul>
        </nav>
        <div className="settings-sections">
          {section('general', null, <>
            <dl className="settings-fields"><dt>Name</dt><dd>{agent.name}</dd>{agent.adopted && <><dt>Letta agent</dt><dd className="mono">{agent.adopted.agentId}</dd></>}</dl>
            <ModelPanel key={`${agent.adopted?.model ?? agent.model}:${agent.adopted?.effort ?? agent.effort}:${viewOnly}`} agent={agent} onSaved={props.onSaved}/>
            {agent.adopted && props.onViewOnly && <label className="settings-switch">
              <input type="checkbox" role="switch" checked={viewOnly} onChange={event => props.onViewOnly!(event.target.checked)}/>
              <span><strong>View only</strong><span className="adopt-meta">Watch it work in Letta Code: conversations update live, nothing is sent from here.</span></span>
            </label>}
          </>)}
          {section('tools', <p className="modal-text">{agent.adopted ? <>What {agent.name} can do in this app. Every tool call follows the app’s permissions. Once its instructions were applied, the app keeps them current after a change.</> : <>{agent.name} is defined in code: you can make a tool ask before each call, or turn it off. Loosening is done in code.</>}</p>, <>
            <ToolsPanel key={`${(agent.adopted?.tools ?? []).join()}:${JSON.stringify(agent.adopted?.overrides ?? {})}`} agent={agent} onSaved={props.onSaved}/>
            {agent.adopted && <div className="settings-sub"><ProjectPanel key={`${agent.adopted?.project}:${agent.adopted?.commandTimeoutMs}`} agent={agent} onSaved={props.onSaved}/></div>}
          </>)}
          {section('instructions', <p className="modal-text">A short section appended to {agent.name}’s system prompt: the tools it has in this app, and how its memory is protected here. Nothing else changes, and you can undo it.</p>,
            <InstructionsPanel key={`${(agent.adopted?.tools ?? []).join()}:${JSON.stringify(agent.adopted?.overrides ?? {})}`} agent={agent}/>)}
          {section('apps', <p className="modal-text">MCP Apps installed for this agent. Each runs in its own container without network access; its views run in a sandbox on their own origin.</p>,
            <AppsPanel onChanged={props.onAppsChanged} {...(props.viewPolicy ? { viewPolicy: props.viewPolicy } : {})} {...(props.onViewPolicy ? { onViewPolicy: props.onViewPolicy } : {})}/>)}
          {section('memory', <MemoryIntro agentName={agent.name} viewOnly={viewOnly}/>, <MemoryPanel admin={!viewOnly && admin} onOpenThread={props.onOpenThread}/>)}
          {section('automations', <p className="modal-text">Let n8n, Conductor or a script start conversations with {agent.name}. Each token belongs to one automation and acts as you.</p>,
            <AutomationsPanel agentName={agent.name} onOpenThread={props.onOpenThread}/>)}
          {section('members', <p className="modal-text">Members share every conversation, file and memory of this agent. Add people by their Tailscale login; they must be in your tailnet.</p>, <MembersPanel agent={agent}/>)}
          {section('danger', null, <div className="settings-danger-row">
            <div><strong>Remove from app</strong><p className="adopt-meta">It disappears from this app only. The Letta agent, its memory and its conversations stay.</p></div>
            {props.onRemove && <button type="button" className="btn danger" onClick={props.onRemove}><Trash2 size={15} aria-hidden="true"/>Remove from app…</button>}
          </div>)}
        </div>
      </div>
    </div>
  </div>;
}
