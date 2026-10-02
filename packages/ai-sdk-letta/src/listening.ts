/**
 * Group conversations: whether the agent replies to a turn or only listens.
 *
 * Every message still reaches the agent (it keeps full context and may use
 * tools and update its memory), but in modes other than `'always'` it may end
 * the turn without a reply by calling the application-owned
 * {@link STAY_SILENT_TOOL} tool. Pure functions, no I/O.
 */

/**
 * When the agent replies to a turn in a shared conversation.
 *
 * - `'always'`: to every message.
 * - `'when-addressed'`: only when the message mentions it (`@Name` or its name)
 *   or asks it directly; otherwise it listens.
 * - `'agent-decides'`: when its contribution is wanted or clearly useful; when
 *   people talk among themselves, it listens.
 */
export type ReplyMode = 'always' | 'when-addressed' | 'agent-decides';
/**
 * An agent's reply mode setting: a fixed {@link ReplyMode}, or `'auto'`:
 * `'always'` for an agent one person uses, `'agent-decides'` for an agent
 * shared by several (from the first message of every conversation).
 */
export type ReplyModeSetting = ReplyMode | 'auto';
/** A conversation's override: `'inherit'` follows the agent's setting. */
export type ReplyModeOverride = ReplyMode | 'inherit';

export const REPLY_MODES: readonly ReplyMode[] = Object.freeze(['always', 'when-addressed', 'agent-decides']);
export const REPLY_MODE_SETTINGS: readonly ReplyModeSetting[] = Object.freeze(['auto', ...REPLY_MODES]);
export const REPLY_MODE_OVERRIDES: readonly ReplyModeOverride[] = Object.freeze(['inherit', ...REPLY_MODES]);

/** Name of the application-owned tool the agent calls to listen without replying. Reserved: definitions cannot use it. */
export const STAY_SILENT_TOOL = 'stay_silent';
/** Description of {@link STAY_SILENT_TOOL} as the model sees it. */
export const STAY_SILENT_DESCRIPTION = 'End this turn without replying: you listened, and nothing needs to be said now. Only when the reply mode of this turn allows it. '
  + 'You may think, use other tools and update memory first. Call it at most once, then write no text at all.';
/** JSON schema of {@link STAY_SILENT_TOOL}'s input: an optional private note, never shown as a reply. */
export const STAY_SILENT_SCHEMA = Object.freeze({
  type: 'object',
  properties: { reason: { type: 'string', maxLength: 500, description: 'Private note on why you stay silent (not a reply; people can look it up).' } },
  additionalProperties: false,
});

/**
 * The reply mode that applies to a conversation: its override, otherwise the
 * agent's setting, where `'auto'` means `'always'` when one person can use
 * the agent and `'agent-decides'` when several can. `members` counts the
 * people who share the agent (its members on a team server).
 */
export function resolveReplyMode(setting: ReplyModeSetting | undefined, override: ReplyModeOverride | undefined, members: number): ReplyMode {
  if (override && override !== 'inherit') return override;
  const value = setting ?? 'auto';
  if (value !== 'auto') return value;
  return members > 1 ? 'agent-decides' : 'always';
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The names a message may use for the agent: the full name, and its first word (e.g. "Desk" of "Desk Helper") when that is at least 3 letters. */
export function mentionNames(agentName: string): string[] {
  const full = agentName.replace(/\s*\([^)]*\)\s*$/u, '').replace(/\s+/g, ' ').trim();
  const first = full.split(' ')[0] ?? '';
  return [...new Set([full, ...(first.length >= 3 ? [first] : [])].filter(Boolean))];
}

/**
 * Does `text` mention the agent: `@` followed by its name (or the first word of
 * its name), or its full name as words? Case-insensitive; never inside other
 * words ("@Deskmate" does not mention "Desk"). Code spans are ignored.
 */
export function mentionsAgent(text: string, agentName: string): boolean {
  const plain = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const names = mentionNames(agentName);
  const full = names[0];
  if (!full) return false;
  const boundary = '(?![\\p{L}\\p{N}_])';
  const at = new RegExp(`(^|[^\\p{L}\\p{N}_@])@(?:${names.map(escape).join('|')})${boundary}`, 'iu');
  if (at.test(plain)) return true;
  return new RegExp(`(^|[^\\p{L}\\p{N}_@])${escape(full)}${boundary}`, 'iu').test(plain);
}

/** One message of a turn: who wrote it (several when queued messages are delivered together). */
export type TurnSpeaker = { name: string; login?: string };

const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}<>[\]]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120);
const who = (speaker: TurnSpeaker) => {
  const name = clean(speaker.name) || 'A team member';
  const login = speaker.login ? clean(speaker.login) : '';
  return `${name}${login && login !== name ? ` (${login})` : ''}`;
};

/** The label of a speaker in a combined turn: `[Mia Example]`. */
export function speakerLabel(speaker: TurnSpeaker): string { return `[${clean(speaker.name) || 'A team member'}]`; }

/**
 * Text of several queued messages delivered as one turn: each message on its
 * own, prefixed with its author's {@link speakerLabel}, in the order sent.
 */
export function combinedText(messages: readonly { speaker: TurnSpeaker; text: string }[]): string {
  return messages.map(({ speaker, text }) => `${speakerLabel(speaker)} ${text.trim()}`).join('\n\n');
}

/** Options of {@link turnNote}. */
export interface TurnNoteOptions {
  /** Who wrote the message, or each message of a combined turn, in order. */
  speakers: readonly TurnSpeaker[];
  /** The reply mode of this turn. Without it, the note only names the speaker. */
  replyMode?: ReplyMode;
  /** The message mentions the agent: it must reply, whatever the mode. */
  addressed?: boolean;
  /** The agent's name, as people mention it. */
  agentName?: string;
}

/**
 * The `<system-reminder>` the agent receives before a shared turn: who wrote
 * it, and whether it is expected to reply or may only listen. Display history
 * never shows it.
 */
export function turnNote(options: TurnNoteOptions): string {
  const speakers = options.speakers.length ? options.speakers : [{ name: '' }];
  const lines: string[] = [];
  if (speakers.length === 1) lines.push(`This message is from ${who(speakers[0]!)}. Several people share this conversation; address them by name when it helps.`);
  else {
    const names = [...new Set(speakers.map(who))];
    lines.push(`These ${speakers.length} messages were sent while you were busy and are delivered together, in order; each starts with its author's name in brackets. They are from ${names.join(', ')}. Several people share this conversation; address them by name when it helps. Answer them in one reply.`);
  }
  const name = options.agentName ? clean(mentionNames(options.agentName)[0] ?? options.agentName) : '';
  const you = name ? `you (${name})` : 'you';
  if (options.replyMode) {
    if (options.addressed) lines.push(`This turn mentions ${you}: reply.`);
    else if (options.replyMode === 'always') lines.push('Reply mode: always. Reply to this turn.');
    else if (options.replyMode === 'when-addressed') lines.push(`Reply mode: when addressed. Reply only if this turn is meant for ${you}: it names you, or continues a conversation you are having (it answers your question or follows up on your reply). Questions to the room or to nobody in particular do not count. Otherwise listen: call ${STAY_SILENT_TOOL} and write no text.`);
    else lines.push(`Reply mode: agent decides. Reply when your contribution is wanted or clearly useful (you are asked something, or people are stuck and you can help). When people are talking among themselves, listen: call ${STAY_SILENT_TOOL} and write no text.`);
  }
  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>\n`;
}
