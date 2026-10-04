import type { ThreadMessageLike } from '@assistant-ui/react';
import type { UIMessage } from 'ai';
import type { RuntimeEvent } from '@ai-sdk-letta/server';
import { IMAGE_PLACEHOLDER, type FileInfo } from './attachments.js';
import { knownOutcome, type DecisionOutcome } from './decisions-model.js';
export type Part = Exclude<ThreadMessageLike['content'], string>[number];
/** A file chip in a user bubble: name and description; `available` once stored in the conversation. */
export type FileChip = { name: string; detail: string; kind?: FileInfo['kind'] };

/**
 * Split the "Attached: name (description)" lines the server appends to a
 * user message (the same note the agent received) into chips. Mirrors
 * `parseAttachmentNote` in ai-sdk-letta.
 */
export function splitAttachmentNote(text: string): { text: string; files: FileChip[] } {
  const lines = text.split('\n');
  const files: FileChip[] = [];
  while (lines.length) {
    const match = /^Attached: (.+) \(([^()\n]+)\)$/.exec(lines.at(-1)!.trimEnd());
    if (!match) break;
    const detail = match[2]!.split(', ').join(' · ');
    files.unshift({ name: match[1]!, detail, kind: /^PDF\b/.test(detail) ? 'pdf' : / image\b/.test(detail.split(' · ')[0]!) ? 'image' : 'text' });
    lines.pop();
  }
  return { text: files.length ? lines.join('\n').trimEnd() : text, files };
}
const fileParts = (files: readonly FileChip[]): Part[] => files.map(file => ({ type: 'data-file', data: file }) as unknown as Part);

/** Display time, only when the backend actually recorded one (never "now" for old history). */
export function knownTime(message: Pick<UIMessage, 'metadata'>): string | undefined {
  const value = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}
export function withTime(message: ThreadMessageLike, time: string | undefined): ThreadMessageLike {
  return time ? { ...message, createdAt: new Date(time), metadata: { ...message.metadata, custom: { ...message.metadata?.custom, time } } } : message;
}
/** Who wrote a user turn (team servers), shown above the bubble. */
export type MessageAuthor = { id: string; login: string; name: string; avatar?: string };
/** The author recorded by the server on a history message, when it is well formed. */
export function knownAuthor(message: Pick<UIMessage, 'metadata'>): MessageAuthor | undefined {
  const value = (message.metadata as { author?: Partial<MessageAuthor> } | undefined)?.author;
  return value && typeof value.id === 'string' && typeof value.login === 'string' && typeof value.name === 'string'
    ? { id: value.id, login: value.login, name: value.name, ...(typeof value.avatar === 'string' && value.avatar.startsWith('https://') ? { avatar: value.avatar } : {}) } : undefined;
}
export function withAuthor(message: ThreadMessageLike, author: MessageAuthor | undefined): ThreadMessageLike {
  return author ? { ...message, metadata: { ...message.metadata, custom: { ...message.metadata?.custom, author } } } : message;
}
/** What started a user turn that no person typed (an automation, or a task the agent scheduled). */
export type MessageSource = { kind: 'automation' | 'schedule'; via: 'n8n' | 'conductor' | 'api'; name: string };
/** The source recorded by the server on a history message, when it is well formed. */
export function knownSource(message: Pick<UIMessage, 'metadata'>): MessageSource | undefined {
  const value = (message.metadata as { source?: Partial<MessageSource> } | undefined)?.source;
  return value && (value.kind === 'automation' || value.kind === 'schedule') && (value.via === 'n8n' || value.via === 'conductor' || value.via === 'api') && typeof value.name === 'string'
    ? { kind: value.kind, via: value.via, name: value.name.slice(0, 80) } : undefined;
}
export function withSource(message: ThreadMessageLike, source: MessageSource | undefined): ThreadMessageLike {
  return source ? { ...message, metadata: { ...message.metadata, custom: { ...message.metadata?.custom, source } } } : message;
}

/** A message an MCP App's view sent (after the person allowed it): which app, and who allowed it. */
export type MessageApp = { id: string; name: string; toolCallId: string; approvedBy: { id: string; name: string } };
/** The app recorded by the server on a history message, when it is well formed. */
export function knownApp(message: Pick<UIMessage, 'metadata'>): MessageApp | undefined {
  const value = (message.metadata as { app?: Partial<MessageApp> } | undefined)?.app;
  return value && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.toolCallId === 'string' && value.approvedBy && typeof value.approvedBy.name === 'string'
    ? { id: value.id.slice(0, 40), name: value.name.slice(0, 120), toolCallId: value.toolCallId, approvedBy: { id: String(value.approvedBy.id ?? ''), name: value.approvedBy.name.slice(0, 120) } } : undefined;
}
export function withApp(message: ThreadMessageLike, app: MessageApp | undefined): ThreadMessageLike {
  return app ? { ...message, metadata: { ...message.metadata, custom: { ...message.metadata?.custom, app } } } : message;
}

/** The run a user message was sent as (its OTID in history), when it is one: what a rewind edits. */
export function knownRun(message: Pick<UIMessage, 'metadata'>): string | undefined {
  const value = (message.metadata as { otid?: unknown } | undefined)?.otid;
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : undefined;
}
export function withRun(message: ThreadMessageLike, runId: string | undefined): ThreadMessageLike {
  return runId ? { ...message, metadata: { ...message.metadata, custom: { ...message.metadata?.custom, runId } } } : message;
}
/** A decision's outcome turn: shown as a compact "Decided by …" line instead of a bubble. */
export function withDecision(message: ThreadMessageLike, decision: DecisionOutcome | undefined): ThreadMessageLike {
  return decision ? { ...message, metadata: { ...message.metadata, custom: { ...message.metadata?.custom, decision } } } : message;
}

/** A turn the agent listened to without replying: its private note (the agent's own words), if any. */
export type Listened = { reason?: string };
/** Data part of a projected history message that marks a listened turn (`LISTENED_PART` in ai-sdk-letta). */
const LISTENED = 'data-listened';
const isListenedMarker = (part: Part) => (part.type as string) === LISTENED;
/** The listened marker of an assistant message, if the agent listened in that turn. */
export function listenedOf(message: Pick<ThreadMessageLike, 'metadata'>): Listened | undefined {
  return (message.metadata?.custom as { listened?: Listened } | undefined)?.listened;
}
/**
 * Assistant messages after merging: a message with the listened marker
 * becomes a listened turn (metadata `listened`, its reasoning and tool calls
 * kept for the expandable line). Elsewhere reasoning is never shown, so it is
 * dropped from replies.
 */
export function markListened(message: ThreadMessageLike): ThreadMessageLike {
  if (message.role !== 'assistant' || typeof message.content === 'string') return message;
  const marker = message.content.find(isListenedMarker) as { data?: { reason?: unknown } } | undefined;
  if (!marker) {
    const content = message.content.filter(part => part.type !== 'reasoning');
    return content.length === message.content.length ? message : { ...message, content };
  }
  const reason = typeof marker.data?.reason === 'string' && marker.data.reason.trim() ? marker.data.reason.trim() : undefined;
  return { ...message, content: message.content.filter(part => !isListenedMarker(part)), metadata: { ...message.metadata, custom: { ...message.metadata?.custom, listened: reason ? { reason } : {} } } };
}

/** A user bubble's content: images first (as the composer shows them), then file chips, then the text. */
export function userContent(text: string, images: readonly string[] = [], files: readonly FileChip[] = []): Part[] {
  return [...images.map((image): Part => image.startsWith('data:image/') ? { type: 'image', image } : { type: 'text', text: IMAGE_PLACEHOLDER }), ...fileParts(files), ...(text.trim() ? [{ type: 'text' as const, text }] : [])];
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
  const visible = messages.filter(message => (message.role === 'user' || message.role === 'assistant') && !message.parts.some(p => p.type === 'text' && /^\s*<(task-notification|system-reminder)>/.test(p.text)));
  const converted = visible.map(message => withAuthor(withTime({ id: message.id, role: message.role, content: orderUserParts(message.role, message.parts.flatMap((part): Part[] => {
    if (part.type === 'reasoning' && message.role === 'assistant') return part.text.trim() ? [{ type: 'reasoning', text: part.text }] : [];
    if ((part.type as string) === LISTENED && message.role === 'assistant') return [{ type: LISTENED, data: (part as { data?: unknown }).data ?? {} } as unknown as Part];
    if (part.type === 'text') {
      if (message.role !== 'user') return [{ type: 'text', text: part.text }];
      // The attachment note becomes file chips; the rest stays text.
      const split = splitAttachmentNote(part.text);
      return [...fileParts(split.files), ...(split.text.trim() ? [{ type: 'text' as const, text: split.text }] : [])];
    }
    // Restored user images arrive as data: URLs. Anything else (remote URLs) is never loaded.
    if (part.type === 'file' && message.role === 'user') return [/^data:image\/(png|jpeg|gif|webp);base64,/i.test(part.url) ? { type: 'image', image: part.url, ...(part.filename ? { filename: part.filename } : {}) } : { type: 'text', text: IMAGE_PLACEHOLDER }];
    if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
      const tool = part as { type: string; toolName?: string; toolCallId: string; input?: unknown; output?: unknown; state?: string; errorText?: string };
      const taskId = typeof tool.output === 'string' && tool.output.startsWith('External tool ') ? tool.output.match(/Task ID: ([\w-]+)/)?.[1] : undefined;
      const output = taskId ? completions.get(taskId) ?? 'Awaiting a result from the tool.' : tool.output;
      return [{ type: 'tool-call', toolCallId: tool.toolCallId, toolName: tool.toolName ?? tool.type.slice(5), argsText: JSON.stringify(tool.input ?? {}), result: output ?? tool.errorText, isError: tool.state === 'output-error' || !!(tool.output && typeof tool.output === 'object' && 'error' in tool.output) }];
    }
    return [];
  })) }, knownTime(message)), message.role === 'user' ? knownAuthor(message) : undefined)).map((item, index) => withApp(withRun(withDecision(withSource(item, visible[index]!.role === 'user' ? knownSource(visible[index]!) : undefined), visible[index]!.role === 'user' ? knownOutcome(visible[index]!.metadata) : undefined), visible[index]!.role === 'user' ? knownRun(visible[index]!) : undefined), visible[index]!.role === 'user' ? knownApp(visible[index]!) : undefined));
  return mergeAssistantRuns(converted).map(markListened);
}

/** Images (and image placeholders), then file chips, then text in user bubbles; assistant parts keep their order. */
function orderUserParts(role: string, parts: Part[]): Part[] {
  if (role !== 'user') return parts;
  const image = (part: Part) => part.type === 'image' || (part.type === 'text' && part.text === IMAGE_PLACEHOLDER);
  const file = (part: Part) => (part.type as string) === 'data-file';
  return [...parts.filter(image), ...parts.filter(file), ...parts.filter(part => !image(part) && !file(part))];
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

/**
 * Hide the turns the agent listened to (the "hide listened" setting). The
 * messages it listened to stay; only the quiet "Listened" lines go.
 */
export function withoutListened(messages: readonly ThreadMessageLike[]): ThreadMessageLike[] {
  return messages.filter(message => !listenedOf(message));
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
    } else if (event.type === 'reasoning') {
      // Kept for a listened turn's expandable line; never shown in a reply (see markListened).
      const last = parts.at(-1);
      if (last?.type === 'reasoning') parts[parts.length - 1] = { type: 'reasoning', text: last.text + String(d.text) };
      else parts.push({ type: 'reasoning', text: String(d.text) });
    } else if (event.type === 'listened') parts.push({ type: LISTENED, data: typeof d.reason === 'string' ? { reason: d.reason } : {} } as unknown as Part);
    else if (event.type === 'tool_started') parts.push({ type: 'tool-call', toolCallId: String(d.toolCallId), toolName: String(d.name), argsText: JSON.stringify(d.input ?? {}) });
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
