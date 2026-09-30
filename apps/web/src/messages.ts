import type { ThreadMessageLike } from '@assistant-ui/react';
import type { UIMessage } from 'ai';
import type { RuntimeEvent } from '@ai-sdk-letta/server';
import { IMAGE_PLACEHOLDER } from './attachments.js';
export type Part = Exclude<ThreadMessageLike['content'], string>[number];

/** Display time, only when the backend actually recorded one (never "now" for old history). */
export function knownTime(message: Pick<UIMessage, 'metadata'>): string | undefined {
  const value = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}
export function withTime(message: ThreadMessageLike, time: string | undefined): ThreadMessageLike {
  return time ? { ...message, createdAt: new Date(time), metadata: { ...message.metadata, custom: { ...message.metadata?.custom, time } } } : message;
}

/** A user bubble's content: images first (as the composer shows them), then the text. */
export function userContent(text: string, images: readonly string[] = []): Part[] {
  return [...images.map((image): Part => image.startsWith('data:image/') ? { type: 'image', image } : { type: 'text', text: IMAGE_PLACEHOLDER }), ...(text.trim() ? [{ type: 'text' as const, text }] : [])];
}

export function historyMessages(messages: UIMessage[]): ThreadMessageLike[] {
  const completions = new Map<string, unknown>();
  for (const message of messages) {
    const text = message.parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (!text.trim().startsWith('<task-notification>')) continue;
    const id = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
    const result = text.match(/<result>([\s\S]*?)<\/result>/)?.[1];
    if (id && result) { try { completions.set(id, JSON.parse(result)); } catch { /* Unstructured notifications stay hidden. */ } }
  }
  const converted = messages.filter(message => (message.role === 'user' || message.role === 'assistant') && !message.parts.some(p => p.type === 'text' && /^\s*<(task-notification|system-reminder)>/.test(p.text))).map(message => withTime({ id: message.id, role: message.role, content: orderUserParts(message.role, message.parts.flatMap((part): Part[] => {
    if (part.type === 'text') return [{ type: 'text', text: part.text }];
    // Restored user images arrive as data: URLs. Anything else (remote URLs) is never loaded.
    if (part.type === 'file' && message.role === 'user') return [/^data:image\/(png|jpeg|gif|webp);base64,/i.test(part.url) ? { type: 'image', image: part.url, ...(part.filename ? { filename: part.filename } : {}) } : { type: 'text', text: IMAGE_PLACEHOLDER }];
    if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
      const tool = part as { type: string; toolName?: string; toolCallId: string; input?: unknown; output?: unknown; state?: string; errorText?: string };
      const taskId = typeof tool.output === 'string' && tool.output.startsWith('External tool ') ? tool.output.match(/Task ID: ([\w-]+)/)?.[1] : undefined;
      const output = taskId ? completions.get(taskId) ?? 'Awaiting a result from the tool.' : tool.output;
      return [{ type: 'tool-call', toolCallId: tool.toolCallId, toolName: tool.toolName ?? tool.type.slice(5), argsText: JSON.stringify(tool.input ?? {}), result: output ?? tool.errorText, isError: tool.state === 'output-error' || !!(tool.output && typeof tool.output === 'object' && 'error' in tool.output) }];
    }
    return [];
  })) }, knownTime(message)));
  return mergeAssistantRuns(converted);
}

/** Images (and image placeholders) before text in user bubbles; assistant parts keep their order. */
function orderUserParts(role: string, parts: Part[]): Part[] {
  if (role !== 'user') return parts;
  const image = (part: Part) => part.type === 'image' || (part.type === 'text' && part.text === IMAGE_PLACEHOLDER);
  return [...parts.filter(image), ...parts.filter(part => !image(part))];
}

/**
 * Backend history stores each tool call as its own assistant record. Rendering one
 * reply per turn (as live streaming does) keeps order identical and lets adjacent
 * tools group. Parts are only concatenated in their original order.
 */
export function mergeAssistantRuns(messages: ThreadMessageLike[]): ThreadMessageLike[] {
  const merged: ThreadMessageLike[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last?.role === 'assistant' && message.role === 'assistant' && typeof last.content !== 'string' && typeof message.content !== 'string') {
      merged[merged.length - 1] = { ...last, content: [...last.content, ...message.content] };
    } else merged.push(message);
  }
  return merged.filter(message => message.role !== 'assistant' || typeof message.content === 'string' || message.content.length);
}

/** Display reducer only. Tool calls/results never dispatch any executable callback. */
export function observedParts(events: RuntimeEvent[]): Part[] {
  const parts: Part[] = [];
  for (const event of events) {
    const d = event.data;
    if (event.type === 'text') {
      const last = parts.at(-1);
      if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + String(d.text) };
      else parts.push({ type: 'text', text: String(d.text) });
    } else if (event.type === 'tool_started') parts.push({ type: 'tool-call', toolCallId: String(d.toolCallId), toolName: String(d.name), argsText: JSON.stringify(d.input ?? {}) });
    else if (event.type === 'tool_completed' || event.type === 'tool_failed') {
      const index = parts.findIndex(p => p.type === 'tool-call' && p.toolCallId === d.toolCallId);
      const part = parts[index];
      // A fixed failure reason (e.g. user_denied) is shaped like the restored history result.
      const failure = typeof d.reason === 'string' ? JSON.stringify({ error: d.reason }) : d.code;
      if (part?.type === 'tool-call') parts[index] = { ...part, result: event.type === 'tool_failed' ? failure : d.output, isError: event.type === 'tool_failed' };
    }
  }
  const failure = events.find(event => event.type === 'failed');
  return parts.map(part => failure && part.type === 'tool-call' && part.result === undefined
    ? { ...part, isError: true, result: `Turn ended: ${String(failure.data.code)}; execution not confirmed.` } : part);
}
