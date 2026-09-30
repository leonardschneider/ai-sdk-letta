import { emitKeypressEvents } from 'node:readline';
import { sanitizeText, searchConversations, type ConversationEntry, type NavigationSource } from 'ai-sdk-letta';

/** True only for a leading `/resume`, `/search` or `/help` command. */
export const localCommandMatches = (text: string) => /^\/(resume|search|help)(?:\s|$)/i.test(text.trim());
export function parseLocalCommand(text: string) {
  const match = /^\/(resume|search|help)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { command: match[1]!.toLowerCase(), query: match[2]?.trim() ?? '' } : undefined;
}
const plain = (text: string) => sanitizeText(text).replace(/\s+/g, ' ').trim();

/** Small plain-text keyboard overlay, owning stdin only while the TUI is paused.
 * No third-party screen internals, markdown, inference, or transcript mutation. */
export class NavigationScreen {
  private lines: string[] = [];
  private onKey?: (text: string, key: { name?: string; ctrl?: boolean }) => void;
  private readonly key = (text: string, key: { name?: string; ctrl?: boolean }) => this.onKey?.(text, key);
  private readonly resize = () => this.paint();
  constructor() {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on('keypress', this.key); process.stdout.on('resize', this.resize);
    process.stdout.write('\x1b[?1049h\x1b[?25l');
  }
  show(lines: string[]) { this.lines = lines; this.paint(); }
  private paint() {
    const width = Math.max(20, (process.stdout.columns || 80) - 1);
    process.stdout.write('\x1b[H\x1b[2J' + this.lines.slice(0, (process.stdout.rows || 24) - 1).map(line => plain(line).slice(0, width)).join('\r\n'));
  }
  async notice(text: string) {
    const width = Math.max(20, (process.stdout.columns || 80) - 1);
    const clean = plain(text);
    const lines = Array.from({ length: Math.ceil(clean.length / width) }, (_, index) => clean.slice(index * width, (index + 1) * width));
    this.show(['Local command', ...lines, '', 'Enter / Esc returns to chat']);
    await new Promise<void>(resolve => { this.onKey = (_text, key) => {
      if (key.name === 'return' || key.name === 'escape' || (key.ctrl && key.name === 'c')) { this.onKey = undefined; resolve(); }
    }; });
  }
  async prompt(title: string): Promise<string | undefined> {
    let input = '';
    const draw = () => this.show([title, 'Enter searches · Esc/back cancels', `> ${input}`]);
    draw();
    return new Promise(resolve => { this.onKey = (text, key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { this.onKey = undefined; resolve(undefined); }
      else if (key.name === 'return') { this.onKey = undefined; resolve(input === 'back' ? undefined : input.trim()); }
      else { if (key.name === 'backspace') input = input.slice(0, -1); else if (!key.ctrl && text && !text.includes('\x1b')) input = (input + sanitizeText(text)).slice(0, 200); draw(); }
    }; });
  }
  async pick(title: string, entries: ConversationEntry[], initial = '', filter = true): Promise<string | undefined> {
    let query = initial, selected = 0;
    const filtered = () => entries.filter(e => !filter || `${e.title} ${e.id} ${e.date}`.toLowerCase().includes(query.toLowerCase()));
    const draw = () => {
      const rows = filtered(); selected = Math.min(selected, Math.max(0, rows.length - 1));
      const count = Math.max(1, Math.floor(((process.stdout.rows || 24) - 8) / 2));
      const start = Math.floor(selected / count) * count;
      this.show([...title.split('\n'), '↑/↓ select · Enter open · Esc back' + (filter ? ' · type to filter' : ''), filter ? `Filter: ${query}` : '', ...rows.slice(start, start + count).flatMap((e, index) => [`${start + index === selected ? '>' : ' '} ${e.title}`, `  ${e.id} · ${e.date}`]), `${rows.length} results${rows.length ? ` · ${selected + 1}/${rows.length}` : ' · change filter or Esc back'}`]);
    };
    draw();
    return new Promise(resolve => { this.onKey = (text, key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { this.onKey = undefined; resolve(undefined); }
      else if (key.name === 'up' || key.name === 'down') { selected = Math.max(0, Math.min(filtered().length - 1, selected + (key.name === 'up' ? -1 : 1))); draw(); }
      else if (key.name === 'return') { const row = filtered()[selected]; if (query === 'back' || row) { this.onKey = undefined; resolve(query === 'back' ? undefined : row?.id); } }
      else if (filter) { if (key.name === 'backspace') query = query.slice(0, -1); else if (!key.ctrl && text && !text.includes('\x1b')) query = (query + sanitizeText(text)).slice(0, 200); selected = 0; draw(); }
    }; });
  }
  async busy<T>(work: (signal: AbortSignal, progress: (text: string) => void) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.onKey = (_text, key) => { if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { controller.abort(); this.show(['Cancelling local read…', 'Waiting for current SDK request; no further pages or inference.']); } };
    this.show(['Loading local conversations…', 'Esc cancels after current SDK request']);
    try { const result = await work(controller.signal, text => { if (!controller.signal.aborted) this.show([text]); }); controller.signal.throwIfAborted(); return result; }
    finally { this.onKey = undefined; }
  }
  close() { this.onKey = undefined; process.stdin.off('keypress', this.key); process.stdout.off('resize', this.resize); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\x1b[?25h\x1b[?1049l'); }
}

export async function navigate(text: string, source: NavigationSource, screen = new NavigationScreen()): Promise<string | undefined> {
  try {
    const command = parseLocalCommand(text);
    if (!command || command.command === 'help') { await screen.notice('/resume [title or ID] · /search [text] · /help. Same agent only. Escape returns to chat.'); return; }
    let query = command.query;
    if (command.command === 'search' && !query) { const input = await screen.prompt('Search current agent’s conversation text'); if (!input) return; query = input; }
    const listing = await screen.busy(async signal => { const result = await source.list(signal); signal.throwIfAborted(); return result; });
    let selected: string | undefined;
    if (command.command === 'resume') {
      selected = await screen.pick(`Resume${listing.limited ? ' · LIMITED newest 200 + default' : ''}\nAgent: ${source.agentId}`, listing.entries.map(entry => ({ ...entry, title: `${entry.title}${entry.id === source.currentId ? ' [current]' : ''}` })), query);
    } else {
      const result = await screen.busy((signal, progress) => searchConversations(source, listing.entries, query, signal, progress));
      const title = `Search “${query}”\n${result.limited || listing.limited ? 'LIMITED' : 'Complete listed history'} · ${result.scanned} conversations / ${result.records} records`;
      const key = await screen.pick(title, result.matches.map((m, i) => ({ id: String(i), title: `${m.role}: ${m.snippet}`, date: `${m.conversation.title} · ${m.conversation.id} · ${m.conversation.date}` })), '', false);
      selected = key === undefined ? undefined : result.matches[Number(key)]?.conversation.id;
    }
    if (!selected || selected === source.currentId) return;
    await screen.busy(async signal => { await source.validate(selected, signal); signal.throwIfAborted(); });
    return selected;
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) await screen.notice('Unable to complete local navigation. History may be pending, unavailable, or search time limit reached. No input sent; Esc returns to chat.');
  } finally { screen.close(); }
}
