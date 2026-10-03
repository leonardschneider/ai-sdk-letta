/**
 * Web research (`web_search`) as the app shows it: the review card's data
 * (from the approval preview) and the one-line outcome where the search was
 * made (from the tool result). Pure functions; links are only ever `http(s)`.
 */
import { safeLinkHref } from 'ai-sdk-letta/title';

export type ResearchClaim = { text: string; sources: number[] };
export type ResearchSource = { n: number; title: string; url: string; href?: string; relevance?: number; note: string; host: string };
export type Research = { query: string; purpose?: string; summary: string; claims: ResearchClaim[]; sources: ResearchSource[]; dropped: number; pagesRead?: number };

const str = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

function sources(value: unknown): ResearchSource[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const source = item as Record<string, unknown>;
    const url = str(source.url, 600);
    const n = typeof source.n === 'number' && Number.isInteger(source.n) ? source.n : 0;
    if (!url || n < 1) return [];
    const href = safeLinkHref(url);
    return [{ n, url, ...(href && /^https?:/i.test(href) ? { href } : {}), title: str(source.title, 160) || host(url) || url, note: str(source.note, 200), host: host(url),
      ...(typeof source.relevance === 'number' ? { relevance: Math.max(0, Math.min(1, source.relevance)) } : {}) }];
  });
}
function claims(value: unknown, known: Set<number>): ResearchClaim[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const claim = item as Record<string, unknown>;
    const text = str(claim.text, 400);
    const cited = Array.isArray(claim.sources) ? claim.sources.filter((n): n is number => typeof n === 'number' && known.has(n)) : [];
    return text ? [{ text, sources: cited }] : [];
  });
}

/** The research of a review card (`request.preview.data` of kind `web-research`), or undefined. */
export function researchFromPreview(preview: { kind?: string; data?: Record<string, unknown> } | undefined): Research | undefined {
  if (preview?.kind !== 'web-research' || !preview.data) return undefined;
  const data = preview.data;
  const list = sources(data.sources);
  const query = str(data.query, 300);
  if (!query) return undefined;
  return { query, ...(str(data.purpose, 500) ? { purpose: str(data.purpose, 500) } : {}), summary: str(data.summary, 1200), claims: claims(data.claims, new Set(list.map(s => s.n))), sources: list,
    dropped: typeof data.dropped === 'number' && data.dropped >= 0 ? Math.floor(data.dropped) : 0, ...(typeof data.pagesRead === 'number' ? { pagesRead: data.pagesRead } : {}) };
}

/** "Expires at 4:52 PM" for a review card, or undefined. */
export function expiryLabel(expiresAt: string | undefined, format = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })): string | undefined {
  const time = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(time) ? `Expires at ${format(new Date(time))} if nobody reviews it.` : undefined;
}

/** What a finished `web_search` call shows where it was made. */
export type ResearchOutcome =
  | { state: 'approved'; label: string; research: Research; reviewed: boolean }
  | { state: 'dismissed'; label: string; note?: string }
  | { state: 'awaiting'; label: string; decision: string }
  | { state: 'empty' | 'failed' | 'needed-approval' | 'cancelled' | 'expired'; label: string; detail?: string };

const FAILED: Record<string, string> = {
  web_search_unavailable: 'Web search isn’t set up on this server',
  search_unavailable: 'The search engine couldn’t be reached',
  search_json_disabled: 'The search engine refuses JSON requests',
  search_timeout: 'The search took too long',
  summary_failed: 'The results couldn’t be summarized',
  summary_invalid: 'The results couldn’t be summarized',
  tool_timeout: 'The search took too long',
};

/** The one-line outcome of a finished `web_search` call (`args`: its arguments; `result`: what the agent received). */
export function researchOutcome(args: Record<string, unknown>, result: unknown): ResearchOutcome {
  const query = str(args.query, 300);
  let data = result;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return { state: 'failed', label: `Web research didn’t complete: ${query}` }; } }
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  if (value.kind === 'web_research' && value.untrusted === true) {
    const list = sources(value.sources);
    const research: Research = { query: str(value.query, 300) || query, summary: str(value.summary, 1200), claims: claims(value.claims, new Set(list.map(s => s.n))), sources: list, dropped: 0 };
    const reviewed = value.reviewed !== false;
    return { state: 'approved', label: `${reviewed ? 'Web research approved' : 'Web research (pre-approved, not reviewed)'}: ${research.query}`, research, reviewed };
  }
  if (value.error === 'user_denied') return { state: 'dismissed', label: `Web research dismissed: ${query}`, ...(str(value.note, 1000) ? { note: str(value.note, 1000) } : {}) };
  if (value.awaiting_review === true && typeof value.decision === 'string') return { state: 'awaiting', label: `Web research waiting for review: ${query}`, decision: value.decision };
  if (value.error === 'review_expired') return { state: 'expired', label: `Web research expired: ${query}`, detail: 'Nobody reviewed the result in time, so the agent got none of it.' };
  if (value.error === 'approval_required') return { state: 'needed-approval', label: `Web research needed review: ${query}`, detail: 'Started by an automation, so nobody could review the result. Nothing was searched. Pre-approve web search for that automation to let it search unreviewed.' };
  if (value.error === 'approval_cancelled' || value.error === 'tool_cancelled' || value.error === 'unattended_stopped') return { state: 'cancelled', label: `Web research cancelled: ${query}` };
  if (value.results === 0) return { state: 'empty', label: `Web research found nothing relevant: ${query}` };
  const code = typeof value.error === 'string' ? value.error : '';
  return { state: 'failed', label: `Web research didn’t complete: ${query}`, ...(FAILED[code] ? { detail: FAILED[code] } : {}) };
}

/** The research of a web research decision (`decision.research`, as stored on the server), for its card. */
export function researchFromDecision(research: Record<string, unknown> | undefined): Research | undefined {
  return research ? researchFromPreview({ kind: 'web-research', data: research }) : undefined;
}
