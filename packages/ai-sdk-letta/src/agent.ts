import { generateText, streamText, stepCountIs, type Agent, type AgentCallParameters, type AgentStreamParameters, type ModelMessage, type ToolSet, type UIMessage } from 'ai';
import type { JSONValue, LanguageModelV4, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { LettaCodeSession, MessageContentItem, SendMessage } from '@letta-ai/letta-agent-sdk';
import { createHash } from 'node:crypto';
import { ToolInteractions } from './interactions.js';
import { assertImageBudget, compactImagePart, decodeImagePart, IMAGE_REFERENCE_PROVIDER, imagePartDigest, ImageInputError, isImagePart, toLettaImage, type DecodedImage } from './images.js';
import { attachmentNote, decodeFilePart, FileInputError, type StoredFile } from './attachments.js';
import type { AttachmentStore } from './resources.js';

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
  /**
   * The conversation's attachment folder. With it, a user turn may carry
   * files (`file` parts): they are stored there and the turn carries a short
   * "Attached: ..." note instead of their content; images are stored too and
   * still sent inline. Without it, only images are accepted.
   */
  attachments?: AttachmentStore;
  /**
   * Runs after every turn, finished or not (for example, to commit what the
   * agent changed in its resources). Errors are ignored.
   */
  afterTurn?: () => Promise<void>;
  /** Runs when a turn starts, before anything is stored or sent (paired with `afterTurn`). Errors are ignored. */
  beforeTurn?: () => void;
}

/**
 * Per-call options of {@link LettaAgent} beyond the AI SDK's.
 *
 * - `otid` sets the Letta message ID (OTID) of the user turn, so an
 *   application can find that turn in history later (for example, to show who
 *   wrote it). 1–100 characters of letters, digits, `-`, `_`, `.` and `:`.
 * - `speaker` tells the agent who wrote this turn when several people share
 *   it: a short `<system-reminder>` line before the message ("This message is
 *   from Alice Example (alice@example.com)."). Display history never shows it.
 */
export type LettaCallOptions = { otid?: string; speaker?: { name: string; login?: string } };
/** The line that tells the agent who is speaking (see {@link LettaCallOptions}). Names are cleaned of markup and controls. */
export function speakerNote(speaker: { name: string; login?: string }): string {
  const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}<>]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const name = clean(speaker.name) || 'A team member';
  const login = speaker.login ? clean(speaker.login) : '';
  return `<system-reminder>\nThis message is from ${name}${login && login !== name ? ` (${login})` : ''}. Several people share this conversation; address them by name when it helps.\n</system-reminder>\n`;
}
type Call<TOOLS extends ToolSet> = AgentCallParameters<never, TOOLS> & LettaCallOptions;
const OTID = /^[A-Za-z0-9._:-]{1,100}$/;
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
      } else if (message.role === 'user' && part.type === 'file') {
        parts.push({ role: message.role, text: null, file: filePartDigest(part), name: part.filename ?? null });
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
      } else throw new Error('Only text, user image and file, and completed application tool history are supported');
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

type FilePartLike = { type: 'file'; data?: unknown; filename?: string; mediaType?: unknown };
/** The content-hash reference in a file part, if it is one. */
function fileReference(part: FilePartLike): string | undefined {
  const data = part.data as { type?: unknown; reference?: Record<string, unknown> } | undefined;
  const reference = data && typeof data === 'object' && data.type === 'reference' ? data.reference?.[IMAGE_REFERENCE_PROVIDER] : undefined;
  return typeof reference === 'string' && /^[a-f0-9]{64}$/.test(reference) ? reference : undefined;
}
/** SHA-256 of a non-image file part's bytes (or its stored reference). */
function filePartDigest(part: FilePartLike): string {
  return fileReference(part) ?? createHash('sha256').update(decodeFilePart(part, Number.MAX_SAFE_INTEGER).bytes).digest('hex');
}
/** A file part as a content-hash reference (name and type kept), so transcripts never hold file bytes. */
function compactFilePart(part: FilePartLike) {
  return { type: 'file' as const, mediaType: typeof part.mediaType === 'string' ? part.mediaType : 'application/octet-stream', ...(part.filename ? { filename: part.filename } : {}),
    data: { type: 'reference' as const, reference: { [IMAGE_REFERENCE_PROVIDER]: filePartDigest(part) } } };
}

/** Replace user image and file data with content-hash references so the retained transcript never duplicates their bytes. */
function compactTranscript(messages: ModelMessage[]): ModelMessage[] {
  return messages.map(message => message.role === 'user' && typeof message.content !== 'string'
    ? { ...message, content: message.content.map(part => isImagePart(part) ? compactImagePart(part) : part.type === 'file' ? compactFilePart(part) : part) }
    : message);
}

/**
 * Validate the new user turn and build the single Letta message to send:
 * a plain string for text-only turns, or text and `ImageContent` items in
 * their original order.
 * @throws {ImageInputError} for unsupported, invalid or oversized images
 */
export function userTurnContent(content: ModelMessage['content']): { message: SendMessage; text: string; images: DecodedImage[] } {
  const turn = parseUserTurn(content);
  // Whitespace-only text next to images carries nothing; keep text-only turns byte-identical to before.
  return { message: turn.images.length ? turn.items : turn.text, text: turn.text, images: turn.images };
}

const IMAGE_EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** A parsed user turn whose attachments are not stored yet. See {@link parseUserTurn}. */
export interface ParsedTurn {
  text: string;
  images: DecodedImage[];
  /** Text and inline images, in order (whitespace-only text dropped when there are images). */
  items: MessageContentItem[];
  /** Attachments to store, in order: new bytes, or a reference to a stored file by SHA-256 and name. */
  attachments: { name: string; bytes?: Uint8Array; reference?: string }[];
}

/**
 * Validate a new user turn without storing anything: text length, images
 * (type by content, size, count) and, with `limits`, attached files (count,
 * size; remote URLs are refused). Without `limits` (an agent without file
 * tools), non-image files are refused with `image_unsupported_type`, as before.
 * @throws {ImageInputError | FileInputError}
 */
export function parseUserTurn(content: ModelMessage['content'], limits?: AttachmentStore['limits']): ParsedTurn {
  const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
  if (!Array.isArray(parts)) throw new Error('Expected a new user turn');
  const items: MessageContentItem[] = [];
  const images: DecodedImage[] = [];
  const attachments: ParsedTurn['attachments'] = [];
  let files = 0;
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
      if (limits) {
        const filename = part.type === 'file' && typeof part.filename === 'string' && part.filename.trim() ? part.filename : `image.${IMAGE_EXTENSION[image.mediaType]}`;
        attachments.push({ name: filename, bytes: Buffer.from(image.base64, 'base64') });
      }
    } else if (part.type === 'file') {
      // Without file tools nothing could read the file: refuse it exactly as before files existed.
      if (!limits) throw new ImageInputError('image_unsupported_type', `Unsupported attachment type ${String(part.mediaType) || 'unknown'}; only PNG, JPEG, GIF and WebP images are supported`);
      if (++files > limits.maxFilesPerMessage) throw new FileInputError('files_too_many', `Attach up to ${limits.maxFilesPerMessage} files per message`);
      const reference = fileReference(part);
      attachments.push(reference ? { name: part.filename ?? '', reference } : decodeFilePart(part, limits.maxFileBytes));
    } else throw new Error(limits ? 'Only text, image and file input is supported' : 'Only text and image input is supported');
  }
  const text = items.map(item => item.type === 'text' ? item.text : '').join('');
  if (text.length > MAX_INPUT_CHARACTERS) throw new Error(`Input text can be up to ${MAX_INPUT_CHARACTERS} characters`);
  if (!text.trim() && !images.length && !attachments.length) throw new Error(limits ? 'Input must contain text, an image or a file' : 'Input must contain text or an image');
  return { text, images, items: images.length ? items.filter(item => item.type !== 'text' || item.text.trim()) : items, attachments };
}

/**
 * Store a parsed turn's attachments in the conversation's folder and build
 * the single Letta message: the user's text and inline images, followed by
 * a short note per attachment such as "Attached: report.pdf (PDF, 12 pages,
 * 2.1 MB)". File content is never inlined; the model reads it with the file
 * tools. Without `store` (or attachments), the message is exactly what
 * {@link userTurnContent} builds.
 * @throws {FileInputError}
 */
export async function storeUserTurn(turn: ParsedTurn, store?: AttachmentStore, signal?: AbortSignal): Promise<{ message: SendMessage; files: StoredFile[] }> {
  if (!store || !turn.attachments.length) return { message: turn.images.length ? turn.items : turn.text, files: [] };
  const existing = turn.attachments.some(a => a.reference) ? store.list().filter(f => !f.name.includes('/')) : [];
  const files: (StoredFile | undefined)[] = turn.attachments.map(a => {
    if (!a.reference) return undefined;
    const file = existing.find(f => f.sha256 === a.reference && f.name === a.name);
    if (!file) throw new FileInputError('file_not_found', `${a.name || 'A referenced file'} is not stored in this conversation`);
    return file;
  });
  const fresh = turn.attachments.flatMap((a, i) => a.reference ? [] : [{ i, name: a.name, bytes: a.bytes! }]);
  const stored = fresh.length ? await store.save(fresh, { signal }) : [];
  fresh.forEach(({ i }, n) => { files[i] = stored[n]; });
  const note = attachmentNote(files as StoredFile[]);
  const message: SendMessage = turn.images.length
    ? [...turn.items, { type: 'text', text: `${turn.items.some(item => item.type === 'text') ? '\n\n' : ''}${note}` }]
    : `${turn.text.trimEnd()}${turn.text.trim() ? '\n\n' : ''}${note}`;
  return { message, files: files as StoredFile[] };
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
  /** This conversation's attachment folder, when the agent accepts files. */
  readonly attachments?: AttachmentStore;
  private readonly open: (signal: AbortSignal) => TurnSession;
  private readonly memoryTools: readonly string[];
  private readonly delivery?: DeliveryHooks;
  private readonly afterTurn?: () => Promise<void>;
  private readonly beforeTurn?: () => void;
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
    this.attachments = options.attachments;
    this.afterTurn = options.afterTurn;
    this.beforeTurn = options.beforeTurn;
  }
  private settled?: Promise<void>;
  /** Resolves when the work after the last turn (see `afterTurn`) is done. */
  idle(): Promise<void> { return this.settled ?? Promise.resolve(); }
  private finishTurn() { if (this.afterTurn) this.settled = (this.settled ?? Promise.resolve()).then(() => this.afterTurn!()).catch(() => {}); }

  /**
   * A copy of the transcript this instance has sent and received (images as
   * content-hash references, never bytes). To send a multimodal turn without
   * keeping your own history, pass `messages: [...agent.transcript, newUserMessage]`.
   */
  get transcript(): ModelMessage[] { return structuredClone(this.history); }

  /** Abort any running turn, cancel pending prompts, and refuse further turns. */
  close(): void { this.unusable = true; this.active?.abort(); this.interactions.close(); }

  private async prepare(options: Call<TOOLS>) {
    if (this.unusable) throw new Error('Session closed or delivery uncertain; inspect backend history before reopening (no retries).');
    if (this.busy) throw new Error('A turn is already running');
    for (const [key, value] of Object.entries(options)) {
      if (!['prompt', 'messages', 'abortSignal', 'otid', 'speaker'].includes(key) && value !== undefined) throw new Error(`Unsupported agent option: ${key}`);
    }
    if (options.otid !== undefined && (typeof options.otid !== 'string' || !OTID.test(options.otid))) throw new Error('Invalid otid');
    if (options.prompt !== undefined && options.messages !== undefined) throw new Error('Use prompt or messages, not both');
    const messages = typeof options.prompt === 'string' ? [...this.history, { role: 'user' as const, content: options.prompt }] : options.messages ?? options.prompt;
    if (!Array.isArray(messages) || !messages.length) throw new Error('Expected a new user turn');
    const last = messages.at(-1)!;
    if (last.role !== 'user') throw new Error('History edits, replay, and regeneration are not supported');
    // Validate the new turn first, so an oversized or unsupported image or file is reported as such.
    const parsed = parseUserTurn(last.content, this.attachments?.limits);
    if (historyKey(messages.slice(0, -1)) !== historyKey(this.history)) throw new Error('History edits, replay, and regeneration are not supported');
    options.abortSignal?.throwIfAborted();
    this.busy = true;
    try { this.beforeTurn?.(); } catch { /* observer */ }
    // Attachments are stored before delivery; a turn that then fails leaves them in the folder (harmless, and listed).
    let turn: Awaited<ReturnType<typeof storeUserTurn>>;
    try { turn = await storeUserTurn(parsed, this.attachments, options.abortSignal); options.abortSignal?.throwIfAborted(); }
    catch (error) { this.busy = false; this.finishTurn(); throw error; }
    const control = new AbortController();
    this.active = control;
    const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, control.signal]) : control.signal;
    // The retained transcript keeps images as hashes only; Letta already holds the bytes.
    // (Compact before cloning: URL objects in image parts are not cloneable.)
    if (options.speaker !== undefined && (!options.speaker || typeof options.speaker.name !== 'string')) throw new Error('Invalid speaker');
    const preface = options.speaker ? speakerNote(options.speaker) : '';
    const message: SendMessage = !preface ? turn.message : typeof turn.message === 'string' ? `${preface}${turn.message}` : [{ type: 'text', text: preface }, ...turn.message];
    return { otid: options.otid, messages: structuredClone(compactTranscript(messages)), message, prompt: parsed.text.trim() ? parsed.text : parsed.attachments.length > parsed.images.length ? '[File]' : '[Image]', signal, files: turn.files };
  }

  private model(message: SendMessage, signal: AbortSignal, otid?: string): LanguageModelV4 {
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
        await (otid ? session.send(message, { otid }) : session.send(message));
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
    const turn = await this.prepare(options);
    try {
      const result = await generateText({ model: this.model(turn.message, turn.signal, turn.otid), prompt: turn.prompt, tools: this.tools, maxRetries: 0, stopWhen: stepCountIs(1), abortSignal: turn.signal });
      this.delivery?.complete();
      this.history = [...turn.messages, ...result.response.messages];
      return result;
    } catch (error) { this.unusable = true; throw error; }
    finally { this.busy = false; this.active = undefined; this.finishTurn(); }
  }

  /** Run one turn as a stream (text deltas, provider-executed tool calls and results). */
  async stream(options: AgentStreamParameters<never, TOOLS> & LettaCallOptions) {
    const turn = await this.prepare(options);
    return streamText({ model: this.model(turn.message, turn.signal, turn.otid), prompt: turn.prompt, tools: this.tools, maxRetries: 0, stopWhen: stepCountIs(1), abortSignal: turn.signal,
      onError: () => { this.unusable = true; this.busy = false; this.finishTurn(); },
      onAbort: () => { this.close(); this.busy = false; this.finishTurn(); },
      onFinish: result => {
        try { if (!this.unusable && result.finishReason === 'stop') this.delivery?.complete(); }
        catch (error) { this.unusable = true; throw error; }
        finally { this.busy = false; this.active = undefined; this.finishTurn(); }
        this.history = [...turn.messages, ...result.response.messages];
      },
    });
  }
}
