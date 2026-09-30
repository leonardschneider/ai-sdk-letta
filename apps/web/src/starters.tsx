import React from 'react';
import { ThreadPrimitive } from '@assistant-ui/react';
import { Calculator, Lightbulb, MessageCircleQuestion, PenLine } from 'lucide-react';

/** Starter prompts for empty conversations. Clicking sends the prompt like a typed message. */
const starters = [
  { icon: Lightbulb, title: 'Brainstorm', prompt: 'Help me brainstorm five ideas for a relaxing weekend. Keep each to one line.' },
  { icon: PenLine, title: 'Write', prompt: 'Draft a short, friendly note thanking a colleague for their help this week.' },
  { icon: Calculator, title: 'Use a tool', prompt: 'Use one of your tools to help me, and tell me which one you used.' },
  { icon: MessageCircleQuestion, title: 'Ask me', prompt: 'Ask me a multiple-choice question to learn which kind of music I like, then suggest an album.' },
];
export function Starters() {
  return <div className="starters" role="group" aria-label="Suggestions">
    {starters.map(({ icon: Icon, title, prompt }) => <ThreadPrimitive.Suggestion key={title} prompt={prompt} send className="starter">
      <Icon size={16} aria-hidden="true"/><span className="starter-title">{title}</span><span className="starter-prompt">{prompt}</span>
    </ThreadPrimitive.Suggestion>)}
  </div>;
}
