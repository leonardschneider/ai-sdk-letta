import React from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check, Sigma } from 'lucide-react';
import type { LatexOverride } from './latex.js';

/** The three choices, with labels naming what "Agent default" currently means. */
export function latexChoices(agentDefault: boolean): { value: LatexOverride; label: string }[] {
  return [
    { value: 'inherit', label: `Agent default (${agentDefault ? 'on' : 'off'})` },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ];
}

/** Short state for tooltips and labels: "LaTeX: on (agent default)". */
export function latexSummary(value: LatexOverride, agentDefault: boolean): string {
  return value === 'inherit' ? `LaTeX: ${agentDefault ? 'on' : 'off'} (agent default)` : `LaTeX: ${value}`;
}

/** Header button: shows whether maths renders in this conversation and switches it (agent default, on, off). */
export function LatexMenu({ value, agentDefault, onChange }: { value: LatexOverride; agentDefault: boolean; onChange(value: LatexOverride): void }) {
  const on = value === 'inherit' ? agentDefault : value === 'on';
  const summary = latexSummary(value, agentDefault);
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="icon-btn latex-btn" aria-label={`${summary}. Change`} title={summary} data-active={on || undefined} data-override={value !== 'inherit' || undefined}>
        <Sigma size={17} aria-hidden="true"/>
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu" align="end" side="bottom" collisionPadding={8}>
        <DropdownMenu.Label className="menu-label">LaTeX in replies</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={value} onValueChange={next => onChange(next as LatexOverride)}>
          {latexChoices(agentDefault).map(choice => <DropdownMenu.RadioItem key={choice.value} value={choice.value} className="menu-item">
            <span className="menu-check" aria-hidden="true"><DropdownMenu.ItemIndicator><Check size={15}/></DropdownMenu.ItemIndicator></span>{choice.label}
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
