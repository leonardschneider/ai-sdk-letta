import React from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check, ShieldCheck, ShieldHalf } from 'lucide-react';
import { trustChoices, trustSummary, type TrustOverride } from './memory-model.js';

/**
 * Header button: whether this conversation trusts Jiminy with protected
 * memory (agent default, on, off). On team servers only admins change it.
 */
export function TrustMenu({ value, agentDefault, mayChange, onChange }: { value: TrustOverride; agentDefault: boolean; mayChange: boolean; onChange(value: TrustOverride): void }) {
  const on = value === 'inherit' ? agentDefault : value === 'on';
  const summary = trustSummary(value, agentDefault);
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="icon-btn trust-btn" aria-label={`${summary}. Change`} title={summary} data-active={on || undefined} data-override={value !== 'inherit' || undefined}>
        {on ? <ShieldHalf size={17} aria-hidden="true"/> : <ShieldCheck size={17} aria-hidden="true"/>}
        {on && <span className="trust-badge">Trusts Jiminy</span>}
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu trust-menu" align="end" side="bottom" collisionPadding={8}>
        <DropdownMenu.Label className="menu-label">Protected memory in this conversation</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={value} onValueChange={next => onChange(next as TrustOverride)}>
          {trustChoices(agentDefault).map(choice => <DropdownMenu.RadioItem key={choice.value} value={choice.value} className="menu-item" disabled={!mayChange && choice.value !== 'off'}>
            <span className="menu-check" aria-hidden="true"><DropdownMenu.ItemIndicator><Check size={15}/></DropdownMenu.ItemIndicator></span>{choice.label}
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
        <p className="menu-note">{on
          ? 'Trusts Jiminy: anyone’s changes to the persona, rules and goals go to the reviewer, which keeps or reverts them. Automations and new root files stay blocked.'
          : 'Strict: only an admin’s own turn that read nothing untrusted can change the persona, rules and goals.'}{mayChange ? '' : ' You can make this conversation Strict; only an admin can loosen it.'}</p>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
