import test from 'node:test';
import assert from 'node:assert/strict';
import { afterEdit, validateConnectForm } from '../src/integrations-model.js';

test('Connect Atlassian: the missing-field message names the empty fields and is gone once all are filled', () => {
  assert.deepEqual(validateConnectForm({ site: '', email: '', token: '' }), { kind: 'fields', text: 'Enter your site, email and API token.', missing: ['site', 'email', 'token'] });
  assert.deepEqual(validateConnectForm({ site: 'a.atlassian.net', email: ' ', token: '' }), { kind: 'fields', text: 'Enter your email and API token.', missing: ['email', 'token'] });
  assert.equal(validateConnectForm({ site: 'a.atlassian.net', email: 'me@example.com', token: '' })?.text, 'Enter your API token.');
  assert.equal(validateConnectForm({ site: 'a.atlassian.net', email: 'me@example.com', token: 'x' }), undefined, 'all filled: submit goes ahead');
});

test('Connect Atlassian: editing a field clears the field check and a server error; nothing else does', () => {
  const fields = validateConnectForm({ site: '', email: '', token: '' });
  assert.equal(afterEdit(fields), undefined, 'field check cleared on edit (it runs again on submit)');
  assert.equal(afterEdit({ kind: 'server', text: 'Atlassian did not accept this email and API token…' }), undefined, 'server error cleared on edit');
  assert.equal(afterEdit(undefined), undefined);
});
