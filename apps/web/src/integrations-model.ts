/** Pure state of the Connect Atlassian form's message (no React, testable). */

/** A message under the form: a missing-field check (`fields`) or the server's answer (`server`, e.g. a wrong token). */
export type FormProblem = { kind: 'fields' | 'server'; text: string; missing?: readonly ConnectField[] };
export type ConnectField = 'site' | 'email' | 'token';
const LABELS: Record<ConnectField, string> = { site: 'site', email: 'email', token: 'API token' };

/** The check on submit: which fields are empty, as a message naming them; undefined when all are filled. */
export function validateConnectForm(values: Record<ConnectField, string>): FormProblem | undefined {
  const missing = (Object.keys(LABELS) as ConnectField[]).filter(field => !values[field].trim());
  if (!missing.length) return undefined;
  const names = missing.map(field => LABELS[field]);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return { kind: 'fields', text: `Enter your ${list}.`, missing };
}

/**
 * The message after the user edits a field: a missing-field message goes away
 * at once (it is checked again on submit), and so does a server error (the
 * input it was about has changed). Programmatic changes (clearing the token
 * after a failed attempt) are not edits and keep the server's message.
 */
export function afterEdit(_problem: FormProblem | undefined): FormProblem | undefined { return undefined; }
