/** Display logic of decisions (pure, tested): the bell, the card, the compact lines. */

export type DecisionOption = { id: string; label: string; description?: string };
export type DecisionPerson = { id: string; name: string; login?: string; avatar?: string };
/** A decision as the server shows it (`PublicDecision` in @ai-sdk-letta/server). */
export type DecisionView = {
  id: string; threadId: string; question: string; options: DecisionOption[]; context?: string; allowComment: boolean;
  status: 'pending' | 'decided' | 'stopped' | 'cancelled'; createdAt: string;
  requestedBy: { name: string; via?: string; automation?: string };
  runId?: string;
  decidedBy?: DecisionPerson; choice?: DecisionOption; comment?: string; decidedAt?: string;
  cancelledAt?: string; cancelReason?: 'withdrawn' | 'superseded' | 'archived'; supersededBy?: string;
  resume?: { runId: string; state: string; error?: string };
};
/** A pending decision in the notification bell: with its agent and conversation. */
export type FeedDecision = DecisionView & { agent: { id: string; name: string }; thread: { id: string; title: string } };
/** What a decision's outcome turn carries (`metadata.decision` of its message). */
export type DecisionOutcome = { id: string; outcome: 'decided' | 'stopped'; question: string; by: { id: string; name: string }; choice?: { id: string; label: string }; comment?: string };

/** "just now", "3 min ago", "2 h ago", "yesterday", "3 days ago", then a date. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));
}

/** Who someone is on screen: "you" for the signed-in person (or the single-user app's local user), else their name. */
export function personName(person: { id: string; name: string } | undefined, me: string | undefined): string {
  if (!person) return 'someone';
  return person.id === me || (!me && person.id === 'local') ? 'you' : person.name;
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The compact line of a settled decision: "Decided by Mia: CSV table",
 * "Mia stopped this work", "Withdrawn by the agent", "Replaced by a newer
 * decision", "Closed: the conversation was archived". `undefined` while pending.
 */
export function decisionSummary(decision: Pick<DecisionView, 'status' | 'decidedBy' | 'choice' | 'cancelReason'>, me?: string): string | undefined {
  if (decision.status === 'pending') return undefined;
  const who = personName(decision.decidedBy, me);
  if (decision.status === 'decided') return `Decided by ${who}: ${decision.choice?.label ?? 'an option'}`;
  if (decision.status === 'stopped') return `${capital(who)} stopped this work`;
  if (decision.cancelReason === 'superseded') return 'Replaced by a newer decision';
  if (decision.cancelReason === 'archived') return 'Closed: the conversation was archived';
  return 'Withdrawn by the agent';
}
/** The line where a decision's outcome reached the agent: "Decided by Mia: CSV table", "Mia stopped this work". */
export function outcomeSummary(outcome: Pick<DecisionOutcome, 'outcome' | 'by' | 'choice'>, me?: string): string {
  const who = personName(outcome.by, me);
  return outcome.outcome === 'stopped' ? `${capital(who)} stopped this work` : `Decided by ${who}: ${outcome.choice?.label ?? 'an option'}`;
}
/** Who asked, for the card and the bell: "Asked by Olivia", "Asked by you", "From n8n · Weekly report". */
export function askedBy(decision: Pick<DecisionView, 'requestedBy'>, me?: { id: string; name: string }): string {
  const { name, via, automation } = decision.requestedBy;
  if (via) return `From ${via === 'conductor' ? 'Conductor' : via === 'n8n' ? 'n8n' : 'the API'}${automation ? ` · ${automation}` : ''}`;
  // The single-user app's person is recorded as "You".
  return `Asked by ${(me && name === me.name) || (!me && name === 'You') ? 'you' : name}`;
}
/** The bell's label: "Decisions", "1 decision waiting", "3 decisions waiting". */
export function bellLabel(count: number): string {
  return count === 0 ? 'Decisions: none waiting' : count === 1 ? '1 decision waiting' : `${count} decisions waiting`;
}
/** The count on the bell: up to 9, then "9+". */
export const bellCount = (count: number) => count > 9 ? '9+' : String(count);

/** Toast wording for the decide route's codes. */
export function decideError(code: string, decision?: DecisionView, me?: string): string {
  if (code === 'already_decided' && decision) return `${capital(decisionSummary(decision, me) ?? 'Already decided')}. Nothing else was sent.`;
  return ({
    already_decided: 'Someone decided this already. Nothing else was sent.',
    decision_cancelled: 'This decision is no longer open (the agent withdrew or replaced it). Nothing was sent.',
    conversation_archived: 'The conversation is archived. Restore it to decide.',
    invalid_input: 'Choose an option (comments up to 1,000 characters).',
    not_found: 'That decision is gone, or you no longer have access to this agent.',
    session_required: 'The local server restarted. Refresh the page.', csrf_required: 'The local server restarted. Refresh the page.',
  } as Record<string, string>)[code] ?? 'Couldn’t send your decision. Nothing was sent; try again.';
}

/** The outcome a history message carries (`metadata.decision`), when well formed. */
export function knownOutcome(metadata: unknown): DecisionOutcome | undefined {
  const value = (metadata as { decision?: Partial<DecisionOutcome> } | undefined)?.decision;
  if (!value || typeof value.id !== 'string' || (value.outcome !== 'decided' && value.outcome !== 'stopped') || typeof value.question !== 'string' || !value.by || typeof value.by.name !== 'string' || typeof value.by.id !== 'string') return undefined;
  const choice = value.choice && typeof value.choice.id === 'string' && typeof value.choice.label === 'string' ? { id: value.choice.id, label: value.choice.label } : undefined;
  return { id: value.id, outcome: value.outcome, question: value.question, by: { id: value.by.id, name: value.by.name }, ...(choice ? { choice } : {}), ...(typeof value.comment === 'string' && value.comment ? { comment: value.comment } : {}) };
}
/** The decision ID a `request_decision` result names, if the call succeeded. */
export function requestedId(result: unknown): string | undefined {
  let value = result;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return undefined; } }
  const data = value as { requested?: unknown; id?: unknown } | undefined;
  return data && data.requested === true && typeof data.id === 'string' ? data.id : undefined;
}
