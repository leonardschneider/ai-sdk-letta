import React from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check, Ear, MessageSquareReply } from 'lucide-react';
import type { ReplyMode, ReplyModeOverride, ReplyModeSetting } from 'ai-sdk-letta/listening';

/** Short names of the reply modes, as people see them. */
export const REPLY_MODE_LABELS: Record<ReplyMode, string> = { always: 'Always reply', 'when-addressed': 'When mentioned or asked', 'agent-decides': 'Agent decides' };
/** One line on what each mode does. */
export const REPLY_MODE_HINTS: Record<ReplyMode, string> = {
  always: 'Replies to every message.',
  'when-addressed': 'Replies when @mentioned, named or asked directly. Otherwise it listens.',
  'agent-decides': 'Replies when it can help. Listens when people talk among themselves.',
};

/**
 * What "Agent default" means for this agent: its fixed mode, or the automatic
 * rule ("auto": always when only you use the agent, agent decides when it is
 * shared), said for the agent as it is now when the member count is known.
 */
export function agentDefaultLabel(setting: ReplyModeSetting | undefined, members?: number): string {
  if (setting && setting !== 'auto') return REPLY_MODE_LABELS[setting];
  if (members === undefined) return 'Always when only one person uses this agent, agent decides when it is shared';
  return members > 1 ? `Agent decides: this agent is shared by ${members} people` : 'Always reply: only you use this agent';
}

/** Tooltip and accessible name of the header button: the mode in effect, and whether it is the agent's default. */
export function replyModeSummary(value: ReplyModeOverride, inEffect: ReplyMode): string {
  return `Replies: ${REPLY_MODE_LABELS[inEffect].toLowerCase()}${value === 'inherit' ? ' (agent default)' : ''}`;
}

/**
 * Header button of a shared conversation: when the agent replies (agent
 * default, always, when mentioned or asked, agent decides), and whether the
 * quiet "Listened" lines are shown.
 */
export function ReplyModeMenu({ value, inEffect, agentDefault, members, showListened, onChange, onShowListened }: { value: ReplyModeOverride; inEffect: ReplyMode; agentDefault?: ReplyModeSetting; members?: number; showListened: boolean; onChange(value: ReplyModeOverride): void; onShowListened(show: boolean): void }) {
  const summary = replyModeSummary(value, inEffect);
  const Icon = inEffect === 'always' ? MessageSquareReply : Ear;
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="icon-btn reply-mode-btn" aria-label={`${summary}. Change`} title={summary} data-override={value !== 'inherit' || undefined} data-listening={inEffect !== 'always' || undefined}>
        <Icon size={17} aria-hidden="true"/>
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu reply-mode-menu" align="end" side="bottom" collisionPadding={8}>
        <DropdownMenu.Label className="menu-label">When the agent replies</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={value} onValueChange={next => onChange(next as ReplyModeOverride)}>
          <DropdownMenu.RadioItem value="inherit" className="menu-item menu-item-two-line">
            <span className="menu-check" aria-hidden="true"><DropdownMenu.ItemIndicator><Check size={15}/></DropdownMenu.ItemIndicator></span>
            <span className="menu-text"><span>Agent default</span><span className="menu-hint">{agentDefaultLabel(agentDefault, members)}</span></span>
          </DropdownMenu.RadioItem>
          {(['always', 'when-addressed', 'agent-decides'] as const).map(mode => <DropdownMenu.RadioItem key={mode} value={mode} className="menu-item menu-item-two-line">
            <span className="menu-check" aria-hidden="true"><DropdownMenu.ItemIndicator><Check size={15}/></DropdownMenu.ItemIndicator></span>
            <span className="menu-text"><span>{REPLY_MODE_LABELS[mode]}</span><span className="menu-hint">{REPLY_MODE_HINTS[mode]}</span></span>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator className="menu-sep"/>
        <DropdownMenu.CheckboxItem className="menu-item" checked={showListened} onCheckedChange={checked => onShowListened(checked === true)} onSelect={event => event.preventDefault()}>
          <span className="menu-check" aria-hidden="true"><DropdownMenu.ItemIndicator><Check size={15}/></DropdownMenu.ItemIndicator></span>Show “Listened” lines
        </DropdownMenu.CheckboxItem>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
