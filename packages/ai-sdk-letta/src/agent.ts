import { generateText, streamText, stepCountIs, type Agent, type AgentCallParameters, type AgentStreamParameters, type ModelMessage, type ToolSet, type UIMessage } from 'ai';
import type { JSONValue, LanguageModelV4, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { LettaCodeSession, MessageContentItem, SendMessage } from '@letta-ai/letta-agent-sdk';
import { ToolInteractions } from './interactions.js';
import { assertImageBudget, compactImagePart, decodeImagePart, imagePartDigest, ImageInputError, isImagePart, toLettaImage, type DecodedImage } from './images.js';

/** Most characters of text in one user turn. */
export const MAX_INPUT_CHARACTERS = 8000;

/** The subset of a Letta session a turn needs. */
export type TurnSession = Pick<LettaCodeSession, 'send' | 'stream' | 'abort' | 'close'>;

/** Display-only state restored when the agent was opened. Never sent to the model. */
export interface AgentPresentation {
  conversationId: string;
  title: string;
  /** Projected backend history for display (text and completed application tool cards). */
  initialMessages: UIMessage[];
  /** Human-readable startup summary. */
  status: string;
  memoryDirectory: string;
  historyTruncated: boolean;
}

/** Durable delivery hooks: `begin` before sending, `complete` after a confirmed finish. */
export interface DeliveryHooks { begin(): void; complete(): void }

/** Options for constructing a {@link LettaAgent} directly (normally done by `openLettaAgent`). */
export interface LettaAgentOptions<TOOLS extends ToolSet> {
  /** Logical definition ID. */
  id: string;
  tools: TOOLS;
  /** Opens a per-turn view of the (long-lived) Letta session. */
  open: (signal: AbortSignal) => TurnSession;
  /** Harness tool names hidden from AI SDK results (MemFS operations). */
  memoryTools?: readonly string[];
  /** Letta-generated agent ID. */
  lettaAgentId?: string;
  /** Model handle reported as `modelId` on results. */
  modelId?: string;
  presentation?: AgentPresentation;
  delivery?: DeliveryHooks;
  interactions?: ToolInteractions;
}

type Call<TOOLS extends ToolSet> = AgentCallParameters<never, TOOLS>;
const usage = (): LanguageModelV4Usage => ({ inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } });

/**
 * Canonical key of a semantic transcript (text, user images and completed tool
 * calls), ignoring SDK metadata and step boundaries. Used to reject replayed or
 * edited history: a new call must extend exactly what this process already
 * sent. Images are compared by a SHA-256 of their bytes, so a transcript may
 * carry either the image data or a compact reference to it.
 */
export function historyKey(messages: ModelMessage[]): string {
  const parts: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') throw new Error('System messages are not supported');
    const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    for (const part of content) {
      if (part.type === 'text') {
        const last = parts.at(-1) as { role?: string; text?: string } | undefined;
        if (last?.role === message.role && typeof last.text === 'string') last.text += part.text;
        else parts.push({ role: message.role, text: part.text });
      } else if (message.role === 'user' && isImagePart(part)) {
        // A boundary like text: an image between two texts is not the same turn as the joined text.
        parts.push({ role: message.role, text: null, image: imagePartDigest(part) });
      } else if (part.type === 'tool-call' && message.role === 'assistant') {
        parts.push({ call: part.toolCallId, name: part.toolName, input: part.input });
      } else if (part.type === 'tool-result' && (message.role === 'assistant' || message.role === 'tool')) {
        // UI error cards stringify provider error objects; conversion returns an
        // error-json string whereas response.messages retains the original JSON.
        // Normalize only error payloads, never successful text/JSON outputs.
        let output = part.output;
        if (output.type === 'error-json' && typeof output.value === 'string') {
          try { output = { ...output, value: JSON.parse(output.value) }; } catch { /* plain error text */ }
        }
        parts.push({ result: part.toolCallId, name: part.toolName, output });
      } else throw new Error('Only text, user image and completed application tool history are supported');
    }
  }
  // Parallel calls arrive call/call/result/result, while UI cards convert as
  // call/result/call/result. Canonicalize contiguous tool groups only; retain
  // every ID, name, input and output and all text/turn boundaries.
  const canonical: unknown[] = [];
  let tools: unknown[] = [];
  const flush = () => {
    tools.sort((a, b) => {
      const key = (value: unknown) => { const p = value as { call?: string; result?: string }; return `${p.call ?? p.result}\u0000${p.call ? '0' : '1'}`; };
      return key(a).localeCompare(key(b));
    });
    canonical.push(...tools); tools = [];
  };
  for (const part of parts) {
    if ('text' in (part as object)) { flush(); canonical.push(part); }
    else tools.push(part);
  }
  flush();
  return JSON.stringify(canonical);
}

/** Replace user image data with content-hash references so the retained transcript never duplicates image bytes. */
function compactTranscript(messages: ModelMessage[]): ModelMessage[] {
  return messages.map(message => message.role === 'user' && typeof message.content !== 'string'
    ? { ...message, content: message.content.map(part => isImagePart(part) ? compactImagePart(part) : part) }
    : message);
}

/**
 * Validate the new user turn and build the single Letta message to send:
 * a plain string for text-only turns, or text and `ImageContent` items in
 * their original order.
 * @throws {ImageInputError} for unsupported, invalid or oversized images
 */
export function userTurnContent(content: ModelMessage['content']): { message: SendMessage; text: string; images: DecodedImage[] } {
  const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
  if (!Array.isArray(parts)) throw new Error('Expected a new user turn');
  const items: MessageContentItem[] = [];
  const images: DecodedImage[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      const last = items.at(-1);
      if (last?.type === 'text') last.text += part.text;
      else items.push({ type: 'text', text: part.text });
    } else if (isImagePart(part)) {
      const image = decodeImagePart(part);
      images.push(image);
      assertImageBudget(images);
      items.push(toLettaImage(image));
    } else if (part.type === 'file') {
      throw new ImageInputError('image_unsupported_type', `Unsupported attachment type ${String(part.mediaType) || 'unknown'}; only PNG, JPEG, GIF and WebP images are supported`);
    } else throw new Error('Only text and image input is supported');
  }
  const text = items.map(item => item.type === 'text' ? item.text : '').join('');
  if (text.length > MAX_INPUT_CHARACTERS) throw new Error(`Input text can be up to ${MAX_INPUT_CHARACTERS} characters`);
  if (!text.trim() && !images.length) throw new Error('Input must contain text or an image');
  // Whitespace-only text next to images carries nothing; keep text-only turns byte-identical to before.
  const message: SendMessage = images.length ? items.filter(item => item.type !== 'text' || item.text.trim()) : text;
  return { message, text, images };
}

/**
 * A persistent, Letta-backed Vercel AI SDK `Agent`.
 *
 * Letta owns the only reasoning and tool loop: each call sends exactly one new
 * user message, and application tools run in this process through the Letta
 * client-tool protocol (reported as `providerExecuted`). The AI SDK never
 * dispatches tools itself. History you pass in must extend what this instance
 * already sent; edits, regeneration and replay are rejected. After any failure
 * or cancellation the instance refuses further turns, because delivery is
 * uncertain; reopen it after inspecting the backend.
 */
export class LettaAgent<TOOLS extends ToolSet = ToolSet> implements Agent<never, TOOLS> {
  readonly version = 'agent-v1' as const;
  readonly id: string;
  readonly tools: TOOLS;
  /** Letta-generated agent ID, when known. */
  readonly lettaAgentId?: string;
  /** Display-only restored state. */
  readonly presentation?: AgentPresentation;
  /** Broker for approvals and `ask_user` questions; connect a renderer to it. */
  readonly interactions: ToolInteractions;
  private readonly open: (signal: AbortSignal) => TurnSession;
  private readonly memoryTools: readonly string[];
  private readonly delivery?: DeliveryHooks;
  private readonly modelId: string;
  private history: ModelMessage[] = [];
  private busy = false;
  private unusable = false;
  private active?: AbortController;

  constructor(options: LettaAgentOptions<TOOLS>) {
    this.id = options.id;
    this.tools = options.tools;
    this.open = options.open;
    this.memoryTools = options.memoryTools ?? [];
    this.lettaAgentId = options.lettaAgentId;
    this.presentation = options.presentation;
    this.delivery = options.delivery;
    this.interactions = options.interactions ?? new ToolInteractions();
    this.modelId = options.modelId ?? 'letta';
  }

  /**
   * A copy of the transcript this instance has sent and received (images as
   * content-hash references, never bytes). To send a multimodal turn without
   * keeping your own history, pass `messages: [...agent.transcript, newUserMessage]`.
   */
  get transcript(): ModelMessage[] { return structuredClone(this.history); }

  /** Abort any running turn, cancel pending prompts, and refuse further turns. */
  close(): void { this.unusable = true; this.active?.abort(); this.interactions.close(); }

  private prepare(options: Call<TOOLS>) {
    if (this.unusable) throw new Error('Session closed or delivery uncertain; inspect backend history before reopening (no retries).');
    if (this.busy) throw new Error('A turn is already running');
    for (const [key, value] of Object.entries(options)) {
      if (!['prompt', 'messages', 'abortSignal'].includes(key) && value !== undefined) throw new Error(`Unsupported agent option: ${key}`);
    }
    if (options.prompt !== undefined && options.messages !== undefined) throw new Error('Use prompt or messages, not both');
    const messages = typeof options.prompt === 'string' ? [...this.history, { role: 'user' as const, content: options.prompt }] : options.messages ?? options.prompt;
    if (!Array.isArray(messages) || !messages.length) throw new Error('Expected a new user turn');
    const last = messages.at(-1)!;
    if (last.role !== 'user') throw new Error('History edits, replay, and regeneration are not supported');
    // Validate the new turn first, so an oversized or unsupported image is reported as such.
    const turn = userTurnContent(last.content);
    if (historyKey(messages.slice(0, -1)) !== historyKey(this.history)) throw new Error('History edits, replay, and regeneration are not supported');
    options.abortSignal?.throwIfAborted();
    this.busy = true;
    const control = new AbortController();
    this.active = control;
    const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, control.signal]) : control.signal;
    // The retained transcript keeps images as hashes only; Letta already holds the bytes.
    // (Compact before cloning: URL objects in image parts are not cloneable.)
    return { messages: structuredClone(compactTranscript(messages)), message: turn.message, prompt: turn.text.trim() ? turn.text : '[Image]', signal };
  }

  private model(message: SendMessage, signal: AbortSignal): LanguageModelV4 {
    const run = async (emit: (part: LanguageModelV4StreamPart) => void) => {
      let session: TurnSession | undefined;
      let completed = false;
      const abort = () => { void session?.abort().catch(() => {}); session?.close(); };
      const calls = new Map<string, string>();
      const memoryCalls = new Set<string>();
      const tokens = usage();
      let textId = 0;
      let textOpen = false;
      const endText = () => { if (textOpen) { emit({ type: 'text-end', id: String(textId) }); textOpen = false; } };
      try {
        signal.throwIfAborted();
        session = this.open(signal);
        signal.addEventListener('abort', abort, { once: true });
        this.delivery?.begin();
        await session.send(message);
        signal.throwIfAborted();
        for await (const event of session.stream()) {
          signal.throwIfAborted();
          if (event.type === 'assistant') {
            if (!textOpen) { textId++; emit({ type: 'text-start', id: String(textId) }); textOpen = true; }
            emit({ type: 'text-delta', id: String(textId), delta: event.content });
          } else if (event.type === 'tool_call') {
            endText();
            if (calls.has(event.toolCallId) || memoryCalls.has(event.toolCallId)) throw new Error('Duplicate tool call');
            // Harness memory operations are not application tool cards/history.
            if (this.memoryTools.includes(event.toolName)) { memoryCalls.add(event.toolCallId); continue; }
            if (!Object.hasOwn(this.tools, event.toolName)) throw new Error('Unexpected tool call');
            calls.set(event.toolCallId, event.toolName);
            emit({ type: 'tool-call', toolCallId: event.toolCallId, toolName: event.toolName, input: JSON.stringify(event.toolInput), providerExecuted: true });
          } else if (event.type === 'tool_result') {
            // The SDK can emit provisional Bash output as a tool_result before
            // the authoritative result. Only known internal calls may use it.
            if (memoryCalls.has(event.toolCallId) && event.uuid.startsWith('synthetic-tool-return-stream-')) continue;
            if (memoryCalls.delete(event.toolCallId)) continue;
            const toolName = calls.get(event.toolCallId);
            if (!toolName) throw new Error('Unmatched tool result');
            let result: JSONValue = event.content;
            try { result = JSON.parse(event.content); } catch { /* SDK text output */ }
            emit({ type: 'tool-result', toolCallId: event.toolCallId, toolName, result: result ?? 'null', isError: event.isError });
            calls.delete(event.toolCallId);
          } else if (event.type === 'stream_event' && event.event.message_type === 'usage_statistics') {
            if (typeof event.event.prompt_tokens === 'number') tokens.inputTokens.total = event.event.prompt_tokens;
            if (typeof event.event.completion_tokens === 'number') tokens.outputTokens.total = event.event.completion_tokens;
          } else if (event.type === 'result') {
            if (!event.success || calls.size || memoryCalls.size) throw new Error('Letta turn failed or left incomplete tools');
            endText(); completed = true;
            emit({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: tokens });
            return;
          }
        }
        throw new Error('Letta stream closed before completion');
      } catch (error) {
        this.unusable = true;
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        if (!completed) void session?.abort().catch(() => {});
        session?.close();
      }
    };
    return {
      specificationVersion: 'v4', provider: 'ai-sdk-letta', modelId: this.modelId, supportedUrls: {},
      doGenerate: async () => {
        const content: Awaited<ReturnType<LanguageModelV4['doGenerate']>>['content'] = [];
        let tokens = usage();
        await run(part => {
          if (part.type === 'text-delta') {
            const last = content.at(-1);
            if (last?.type === 'text') last.text += part.delta;
            else content.push({ type: 'text', text: part.delta });
          } else if (part.type === 'tool-call' || part.type === 'tool-result') content.push(part);
          else if (part.type === 'finish') tokens = part.usage;
        });
        return { content, usage: tokens, warnings: [], finishReason: { unified: 'stop', raw: 'stop' } };
      },
      doStream: async () => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({
        start: controller => {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          void run(part => controller.enqueue(part)).catch(error => {
            try { controller.enqueue({ type: 'error', error }); } catch { /* reader closed */ }
          }).finally(() => { try { controller.close(); } catch { /* reader closed */ } });
        },
        cancel: () => this.close(),
      }) }),
    };
  }

  /** Run one turn and wait for the full result. */
  async generate(options: Call<TOOLS>) {
    const turn = this.prepare(options);
    try {
      const result = await generateText({ model: this.model(turn.message, turn.signal), prompt: turn.prompt, tools: this.tools, maxRetries: 0, stopWhen: stepCountIs(1), abortSignal: turn.signal });
      this.delivery?.complete();
      this.history = [...turn.messages, ...result.response.messages];
      return result;
    } catch (error) { this.unusable = true; throw error; }
    finally { this.busy = false; this.active = undefined; }
  }

  /** Run one turn as a stream (text deltas, provider-executed tool calls and results). */
  async stream(options: AgentStreamParameters<never, TOOLS>) {
    const turn = this.prepare(options);
    return streamText({ model: this.model(turn.message, turn.signal), prompt: turn.prompt, tools: this.tools, maxRetries: 0, stopWhen: stepCountIs(1), abortSignal: turn.signal,
      onError: () => { this.unusable = true; this.busy = false; },
      onAbort: () => { this.close(); this.busy = false; },
      onFinish: result => {
        try { if (!this.unusable && result.finishReason === 'stop') this.delivery?.complete(); }
        catch (error) { this.unusable = true; throw error; }
        finally { this.busy = false; this.active = undefined; }
        this.history = [...turn.messages, ...result.response.messages];
      },
    });
  }
}
