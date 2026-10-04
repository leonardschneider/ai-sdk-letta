import type { TurnActor } from './credentials.js';
import type { GitRunner } from './revert.js';

/**
 * Memory provenance: who and what each change of the agent's memory came
 * from. It is kept on the harness side only (the memory ledger and git
 * commit trailers of the memory repository), never in memory files: the
 * agent can read its memory files and could rewrite anything inside them,
 * but it cannot rewrite commits or the ledger.
 *
 * - A turn's provenance: who acted (person, role, automation token,
 *   scheduled task), whether anyone watched (unattended), and which
 *   untrusted content the turn read (web research, attachments, Atlassian,
 *   other tool output).
 * - Every commit the turn made carries it as trailers (`X-Actor`,
 *   `X-Actor-Role`, `X-Via`, `X-Unattended`, `X-Sources`), next to `X-Turn`.
 * - Per line: `git blame --first-parent` names the commit of each line, and
 *   its trailers (or the ledger) name the turn and its provenance.
 *
 * Pure helpers and git readers; no state. See `MemoryJournal` for where it
 * is recorded and `MemoryGuard` for how it is enforced.
 *
 * @module
 */

/** A source of content a turn read. `untrusted` content may carry instructions written by someone else. */
export type ContentSource = {
  /** `browser`: a page in the headless browser, or the dev server's output (web app development). */
  kind: 'web' | 'attachment' | 'atlassian' | 'tool' | 'browser';
  /** What exactly: the tool name, a file name, a URL (display only; shortened). */
  label?: string;
  /** A person reviewed it before the agent saw it (web research approved in the app). Still untrusted: reviewed is not vouched for. */
  reviewed?: boolean;
};
/** Who acted in a turn. */
export type ProvenanceActor = {
  kind: 'person' | 'automation' | 'schedule' | 'agent' | 'dreaming' | 'harness';
  id?: string; name?: string;
  role?: 'admin' | 'member';
  /** Automations: what started it (`n8n`, `conductor`, `api`) and the token's ID. */
  via?: string; token?: string;
};
/** One turn's provenance, as recorded in the ledger and commit trailers. */
export type TurnProvenance = {
  turn?: string; conversationId?: string;
  actor: ProvenanceActor;
  /** Nobody watched the turn live (started by an automation or a schedule). */
  unattended?: boolean;
  /** Untrusted content the turn read. */
  sources: ContentSource[];
  /** Who wrote the change: the agent in a turn, reflection (dreaming), or the harness (rewind, review). */
  writer: 'agent' | 'reflection' | 'harness';
  /** A person approved this change (a re-applied memory review). */
  approvedBy?: { id: string; name: string };
  /** The person a claim in this change named confirmed it (a re-applied claim confirmation). */
  confirmedBy?: { id: string; name: string };
  /**
   * The conversation trusts Jiminy: protected files are not refused up front
   * in this turn; the reviewer decides (see `MemoryGuard`, trust mode).
   */
  trustMode?: boolean;
  /**
   * Unattended turns: the verdict floor of their untrusted writes to
   * unprotected memory, set per automation token. @default 'flag'
   */
  automationFloor?: 'accept' | 'flag' | 'ask_human';
};

/** Trailer keys of provenance. */
export const PROVENANCE_TRAILERS = Object.freeze({
  actor: 'X-Actor', role: 'X-Actor-Role', via: 'X-Via', unattended: 'X-Unattended', sources: 'X-Sources', writer: 'X-Writer', approvedBy: 'X-Approved-By', review: 'X-Memory-Review', reverts: 'X-Reverts',
  trustMode: 'X-Trust-Mode', automationFloor: 'X-Automation-Floor', confirmedBy: 'X-Confirmed-By',
});

const clean = (value: string, max = 120) => value.replace(/[\p{Cc}\p{Cf}\r\n,;=]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Whether a turn read untrusted content. Reviewed web research is still untrusted (a person saw it, nobody vouched for it). */
export const untrusted = (provenance: Pick<TurnProvenance, 'sources'>) => provenance.sources.length > 0;
/**
 * A turn that may send protected-file changes to Jiminy instead of being
 * refused (trust mode): its conversation trusts Jiminy, an identified person
 * sent it, and someone watched it (never automations or schedules).
 */
export function trustEligible(provenance: Pick<TurnProvenance, 'actor' | 'unattended' | 'writer' | 'trustMode'>): boolean {
  return !!provenance.trustMode && provenance.writer === 'agent' && provenance.actor.kind === 'person' && !!provenance.actor.id && !provenance.unattended;
}
/** An admin's attended turn that read nothing untrusted: the only turn that may change protected memory files (outside trust mode). */
export function adminClean(provenance: Pick<TurnProvenance, 'actor' | 'unattended' | 'sources' | 'writer'>): boolean {
  return provenance.writer === 'agent' && provenance.actor.kind === 'person' && provenance.actor.role === 'admin' && !provenance.unattended && !untrusted(provenance);
}

/** The provenance of a turn from who acted for it (see `TurnActor`) and how it ran. */
export function turnProvenance(input: { turn?: string; conversationId?: string; actor?: TurnActor; unattended?: { source?: string; onBehalfOf?: string; memoryFloor?: 'accept' | 'flag' | 'ask_human' } | undefined; automation?: { kind: 'automation' | 'schedule'; via?: string; token?: string; name?: string }; sources?: ContentSource[]; trustMode?: boolean }): TurnProvenance {
  const automation = input.automation ?? (input.unattended ? { kind: 'automation' as const, ...(input.unattended.source ? { via: input.unattended.source } : {}) } : undefined);
  const actor: ProvenanceActor = automation
    ? { kind: automation.kind, ...(automation.via ? { via: automation.via } : {}), ...(automation.token ? { token: automation.token } : {}), ...(automation.name ? { name: automation.name } : {}),
      // On whose behalf: the member the token acts for (never an admin's authority).
      ...(input.actor ? { id: input.actor.id } : {}), ...(input.actor?.role ? { role: input.actor.role } : {}) }
    : input.actor ? { kind: 'person', id: input.actor.id, ...(input.actor.name ? { name: input.actor.name } : {}), ...(input.actor.role ? { role: input.actor.role } : {}) }
      : { kind: 'agent' };
  const floor = input.unattended?.memoryFloor;
  return { ...(input.turn ? { turn: input.turn } : {}), ...(input.conversationId ? { conversationId: input.conversationId } : {}), actor, ...(automation || input.unattended ? { unattended: true } : {}), sources: dedupe(input.sources ?? []), writer: 'agent',
    ...(input.trustMode ? { trustMode: true } : {}), ...(floor === 'accept' || floor === 'flag' || floor === 'ask_human' ? { automationFloor: floor } : {}) };
}
function dedupe(sources: readonly ContentSource[]): ContentSource[] {
  const seen = new Map<string, ContentSource>();
  for (const source of sources) {
    const key = `${source.kind}:${source.label ?? ''}`;
    const known = seen.get(key);
    if (!known) seen.set(key, { kind: source.kind, ...(source.label ? { label: clean(source.label, 80) } : {}), ...(source.reviewed ? { reviewed: true } : {}) });
    else if (!source.reviewed) delete known.reviewed;
  }
  return [...seen.values()].slice(0, 20);
}
/** Add a source to a running turn's provenance (deduplicated, at most 20). */
export function withSource(provenance: TurnProvenance, source: ContentSource): TurnProvenance {
  return { ...provenance, sources: dedupe([...provenance.sources, source]) };
}

/**
 * The untrusted content a tool call brings into a turn, by tool. Tools of
 * the application whose results come from elsewhere count as `tool`;
 * memory tools and the agent's own bookkeeping tools bring none.
 */
export function sourceOfTool(name: string, internal: ReadonlySet<string> = TRUSTED_TOOLS): ContentSource | undefined {
  // Page content (browser tools, dev server output) is untrusted whatever the trusted tools say.
  if (name.startsWith('browser_') || name === 'dev_server_logs' || name === 'dev_server_start') return { kind: 'browser', label: name };
  if (internal.has(name)) return undefined;
  if (name === 'web_search') return { kind: 'web', label: 'web research' };
  if (name.startsWith('atlassian_')) return { kind: 'atlassian', label: name };
  if (name === 'read_file' || name === 'search_files') return { kind: 'attachment', label: name };
  return { kind: 'tool', label: name };
}
/** Tools whose results carry nothing written by others: asking people, deciding, scheduling, listing files, staying silent, the web development guide and controls. */
export const TRUSTED_TOOLS: ReadonlySet<string> = new Set(['ask_user', 'stay_silent', 'request_decision', 'cancel_decision', 'schedule_task', 'list_files', 'memory_provenance', 'Read', 'Write', 'Edit', 'Bash', 'web_dev_guide', 'dev_server_stop', 'allow_web_origin']);

/** The trailers of a provenance (empty values omitted). */
export function provenanceTrailers(provenance: TurnProvenance): Record<string, string | undefined> {
  const { actor } = provenance;
  const who = actor.kind === 'person' ? `person:${clean(actor.id ?? '')}${actor.name ? ` (${clean(actor.name, 60)})` : ''}`
    : actor.kind === 'automation' || actor.kind === 'schedule' ? `${actor.kind}:${clean(actor.via ?? 'api', 20)}${actor.token ? `:${clean(actor.token, 60)}` : ''}${actor.name ? ` (${clean(actor.name, 60)})` : ''}${actor.id ? ` for ${clean(actor.id)}` : ''}`
      : actor.kind;
  return {
    [PROVENANCE_TRAILERS.actor]: who,
    [PROVENANCE_TRAILERS.role]: actor.role,
    [PROVENANCE_TRAILERS.unattended]: provenance.unattended ? 'yes' : undefined,
    [PROVENANCE_TRAILERS.sources]: provenance.sources.length ? provenance.sources.map(s => `${s.kind}${s.label ? `=${clean(s.label, 60)}` : ''}${s.reviewed ? '+reviewed' : ''}`).join('; ') : 'none',
    [PROVENANCE_TRAILERS.writer]: provenance.writer,
    [PROVENANCE_TRAILERS.approvedBy]: provenance.approvedBy ? `${clean(provenance.approvedBy.id)} (${clean(provenance.approvedBy.name, 60)})` : undefined,
    [PROVENANCE_TRAILERS.trustMode]: provenance.trustMode ? 'jiminy' : undefined,
    [PROVENANCE_TRAILERS.confirmedBy]: provenance.confirmedBy ? `${clean(provenance.confirmedBy.id)} (${clean(provenance.confirmedBy.name, 60)})` : undefined,
    [PROVENANCE_TRAILERS.automationFloor]: provenance.automationFloor,
  };
}
/** Parse provenance trailers back (the inverse of {@link provenanceTrailers}; unknown parts ignored). */
export function parseProvenanceTrailers(trailers: Readonly<Record<string, string | undefined>>): Omit<TurnProvenance, 'turn' | 'conversationId'> | undefined {
  const who = trailers[PROVENANCE_TRAILERS.actor];
  if (!who) return undefined;
  const role = trailers[PROVENANCE_TRAILERS.role] === 'admin' || trailers[PROVENANCE_TRAILERS.role] === 'member' ? trailers[PROVENANCE_TRAILERS.role] as 'admin' | 'member' : undefined;
  let actor: ProvenanceActor;
  const person = /^person:([^ ]*)(?: \((.*)\))?$/.exec(who);
  const automated = /^(automation|schedule):([^: ]+)(?::([^ ]+))?(?: \(([^)]*)\))?(?: for (.+))?$/.exec(who);
  if (person) actor = { kind: 'person', ...(person[1] ? { id: person[1] } : {}), ...(person[2] ? { name: person[2] } : {}) };
  else if (automated) actor = { kind: automated[1] as 'automation' | 'schedule', via: automated[2]!, ...(automated[3] ? { token: automated[3] } : {}), ...(automated[4] ? { name: automated[4] } : {}), ...(automated[5] ? { id: automated[5] } : {}) };
  else actor = { kind: (['agent', 'dreaming', 'harness'] as const).find(k => k === who) ?? 'agent' };
  if (role) actor.role = role;
  const sources: ContentSource[] = [];
  const listed = trailers[PROVENANCE_TRAILERS.sources];
  if (listed && listed !== 'none') for (const part of listed.split(';').map(s => s.trim()).filter(Boolean)) {
    const match = /^(web|attachment|atlassian|tool|browser)(?:=(.*?))?(\+reviewed)?$/.exec(part);
    if (match) sources.push({ kind: match[1] as ContentSource['kind'], ...(match[2] ? { label: match[2] } : {}), ...(match[3] ? { reviewed: true } : {}) });
  }
  const writer = trailers[PROVENANCE_TRAILERS.writer];
  const approved = /^([^ ]+) \((.*)\)$/.exec(trailers[PROVENANCE_TRAILERS.approvedBy] ?? '');
  const floor = trailers[PROVENANCE_TRAILERS.automationFloor];
  const confirmed = /^([^ ]+) \((.*)\)$/.exec(trailers[PROVENANCE_TRAILERS.confirmedBy] ?? '');
  return { ...(confirmed ? { confirmedBy: { id: confirmed[1]!, name: confirmed[2]! } } : {}), actor, ...(trailers[PROVENANCE_TRAILERS.unattended] === 'yes' ? { unattended: true } : {}), sources, writer: writer === 'reflection' || writer === 'harness' ? writer : 'agent', ...(approved ? { approvedBy: { id: approved[1]!, name: approved[2]! } } : {}),
    ...(trailers[PROVENANCE_TRAILERS.trustMode] === 'jiminy' ? { trustMode: true } : {}), ...(floor === 'accept' || floor === 'flag' || floor === 'ask_human' ? { automationFloor: floor } : {}) };
}

/** A short, human line of a provenance: "Alice (admin) · web research, report.pdf", "n8n · unattended". */
export function provenanceLabel(provenance: Pick<TurnProvenance, 'actor' | 'unattended' | 'sources' | 'writer' | 'approvedBy' | 'trustMode' | 'confirmedBy'>): string {
  const { actor } = provenance;
  const who = provenance.writer === 'reflection' ? 'Dreaming' : provenance.writer === 'harness' ? 'The app' : actor.kind === 'person' ? `${actor.name ?? actor.id ?? 'Someone'}${actor.role ? ` (${actor.role})` : ''}`
    : actor.kind === 'automation' || actor.kind === 'schedule' ? `${actor.kind === 'schedule' ? 'Scheduled task' : actor.via ?? 'Automation'}${actor.name ? ` “${actor.name}”` : ''}` : 'The agent';
  const parts = [who];
  if (provenance.unattended) parts.push('unattended');
  if (provenance.sources.length) parts.push(`read ${provenance.sources.map(s => s.label ?? s.kind).slice(0, 3).join(', ')}${provenance.sources.length > 3 ? ` +${provenance.sources.length - 3}` : ''}`);
  if (provenance.approvedBy) parts.push(`approved by ${provenance.approvedBy.name}`);
  if (provenance.confirmedBy) parts.push(`confirmed by ${provenance.confirmedBy.name}`);
  if (provenance.trustMode && provenance.actor.kind === 'person') parts.push('trusts Jiminy');
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Per-line provenance: git blame --first-parent                       */
/* ------------------------------------------------------------------ */

/** Who changed one line last (its commit on the first-parent chain, and that commit's provenance). */
export type LineProvenance = { line: number; text: string; commit: string; subject: string; date: string; author: string; turn?: string; provenance?: Omit<TurnProvenance, 'turn' | 'conversationId'> };
/** A file's lines grouped into runs of the same commit (a section). */
export type SectionProvenance = Omit<LineProvenance, 'line' | 'text'> & { from: number; to: number; lines: string[] };

/** Trailers of commits, by commit (one `git log` call). */
export async function commitTrailers(git: GitRunner, commits: readonly string[]): Promise<Map<string, { subject: string; date: string; author: string; trailers: Record<string, string> }>> {
  const found = new Map<string, { subject: string; date: string; author: string; trailers: Record<string, string> }>();
  const unique = [...new Set(commits)].filter(c => /^[a-f0-9]{40}$/.test(c));
  for (let i = 0; i < unique.length; i += 200) {
    // Trailers, and the provenance note (refs/notes/provenance) of commits made without them.
    const out = (await git(['-c', 'notes.displayRef=refs/notes/provenance', 'show', '-s', '-z', '--notes=refs/notes/provenance', '--format=%H%x1f%s%x1f%cI%x1f%an <%ae>%x1f%(trailers:only,unfold)%x1f%N', ...unique.slice(i, i + 200)])).stdout.toString();
    for (const record of out.split('\0').map(s => s.replace(/^\n/, '')).filter(Boolean)) {
      const [commit, subject, date, author, raw, note] = record.split('\x1f');
      const trailers: Record<string, string> = {};
      for (const line of `${note ?? ''}\n${raw ?? ''}`.split('\n')) { const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line); if (m) trailers[m[1]!] = m[2]!; }
      found.set(commit!, { subject: subject ?? '', date: date ?? '', author: author ?? '', trailers });
    }
  }
  return found;
}

/**
 * Per-line provenance of `path` at HEAD: `git blame --first-parent`, so a
 * line a dream merged in is attributed to the merge (the moment it entered
 * memory), not to the reflection branch's own commit; and each commit's
 * provenance from its trailers. `ledger` maps commits to the turn
 * provenance recorded for them (it wins over trailers, which older commits
 * lack). `ignore`: commits whose lines belong to the commit before them
 * (reverts that restored earlier text).
 */
export async function blameProvenance(git: GitRunner, path: string, ledger: ReadonlyMap<string, TurnProvenance> = new Map(), ignore: readonly string[] = []): Promise<LineProvenance[]> {
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw new Error('invalid_path');
  // Reverts made by the review restore earlier lines: those lines keep the provenance of the commit that wrote them.
  const skip = ignore.filter(c => /^[a-f0-9]{40}$/.test(c)).slice(-200).flatMap(c => ['--ignore-rev', c]);
  const out = (await git(['blame', '--first-parent', ...skip, '--line-porcelain', 'HEAD', '--', path])).stdout.toString();
  const lines: { commit: string; line: number; text: string }[] = [];
  let commit = '';
  let line = 0;
  for (const row of out.split('\n')) {
    const header = /^([a-f0-9]{40}) \d+ (\d+)/.exec(row);
    if (header) { commit = header[1]!; line = Number(header[2]); continue; }
    if (row.startsWith('\t')) lines.push({ commit, line, text: row.slice(1) });
  }
  const info = await commitTrailers(git, lines.map(l => l.commit));
  return lines.map(l => {
    const meta = info.get(l.commit);
    const recorded = ledger.get(l.commit);
    const parsed = recorded ?? (meta ? parseProvenanceTrailers(meta.trailers) : undefined);
    const turn = recorded?.turn ?? meta?.trailers['X-Turn'];
    const { turn: _turn, conversationId: _conversation, ...provenance } = (parsed ?? {}) as TurnProvenance;
    return { line: l.line, text: l.text, commit: l.commit, subject: meta?.subject ?? '', date: meta?.date ?? '', author: meta?.author ?? '', ...(turn ? { turn } : {}), ...(parsed ? { provenance } : {}) };
  });
}
/** Consecutive lines of the same commit as one section. */
export function sections(lines: readonly LineProvenance[]): SectionProvenance[] {
  const result: SectionProvenance[] = [];
  for (const l of lines) {
    const last = result.at(-1);
    if (last && last.commit === l.commit && last.to === l.line - 1) { last.to = l.line; last.lines.push(l.text); continue; }
    const { line, text, ...rest } = l;
    result.push({ ...rest, from: line, to: line, lines: [text] });
  }
  return result;
}
