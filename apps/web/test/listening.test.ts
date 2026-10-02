import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyMessages, listenedOf, markListened, observedParts, withoutListened } from '../src/messages.js';
import { insertMention, mentionMatches, mentionName, mentionQuery } from '../src/mentions.js';
import { typingText } from '../src/team.js';
import { agentDefaultLabel, replyModeSummary } from '../src/reply-mode-menu.js';

test('a listened turn from history becomes one quiet message with its note and reasoning; replies never show reasoning', () => {
  const messages = historyMessages([
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Otto, lunch?' }], metadata: { author: { id: 'm', login: 'mia@x', name: 'Mia' } } },
    { id: 'r1', role: 'assistant', parts: [{ type: 'reasoning', text: 'They are planning lunch.' }] },
    { id: 'l1', role: 'assistant', parts: [{ type: 'data-listened', data: { reason: 'Mia asks Otto.' } } as never] },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: '@Desk capital?' }] },
    { id: 'r2', role: 'assistant', parts: [{ type: 'reasoning', text: 'Easy one.' }] },
    { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Canberra.' }] },
  ]);
  assert.equal(messages.length, 4);
  assert.deepEqual(listenedOf(messages[1]!), { reason: 'Mia asks Otto.' });
  assert.deepEqual((messages[1]!.content as unknown as { type: string }[]).map(p => p.type), ['reasoning'], 'the marker is metadata; the reasoning stays for the expandable line');
  assert.equal(listenedOf(messages[3]!), undefined);
  assert.deepEqual(messages[3]!.content, [{ type: 'text', text: 'Canberra.' }], 'a reply never shows reasoning');
  // The hide toggle drops only the listened lines; the messages people wrote stay.
  assert.deepEqual(withoutListened(messages).map(m => m.id), ['u1', 'u2', 'r2']);
});

test('a live listened turn (events) renders like history: reasoning kept, listened marker, no text', () => {
  const parts = observedParts([
    { sequence: 1, type: 'started', data: {} },
    { sequence: 2, type: 'reasoning', data: { text: 'Not ' } }, { sequence: 3, type: 'reasoning', data: { text: 'for me.' } },
    { sequence: 4, type: 'listened', data: { reason: 'chatting' } }, { sequence: 5, type: 'completed', data: {} },
  ]);
  const message = markListened({ id: 'x', role: 'assistant', content: parts });
  assert.deepEqual(listenedOf(message), { reason: 'chatting' });
  assert.deepEqual(message.content, [{ type: 'reasoning', text: 'Not for me.' }]);
  // A listened marker without a note.
  assert.deepEqual(listenedOf(markListened({ id: 'y', role: 'assistant', content: observedParts([{ sequence: 1, type: 'listened', data: {} }]) })), {});
});

test('@ mentions: the query before the caret, matching names, and insertion', () => {
  assert.deepEqual(mentionQuery('hey @Te', 7), { start: 4, query: 'Te' });
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
  assert.equal(mentionQuery('mail me@team', 12), undefined, 'not inside an email address');
  assert.equal(mentionQuery('hey @Te am', 10), undefined, 'only directly before the caret');
  assert.equal(mentionName('Team Desk (throwaway)'), 'Team Desk');
  assert.equal(mentionMatches('', 'Team Desk'), true);
  assert.equal(mentionMatches('de', 'Team Desk'), true);
  assert.equal(mentionMatches('x', 'Team Desk'), false);
  assert.deepEqual(insertMention('hey @Te how are you', 4, 7, 'Team Desk'), { text: 'hey @Team Desk how are you', caret: 15 });
  assert.deepEqual(insertMention('@', 0, 1, 'Team Desk'), { text: '@Team Desk ', caret: 11 });
});

test('typing line text and reply mode labels', () => {
  assert.equal(typingText([]), '');
  assert.equal(typingText(['Mia']), 'Mia is typing…');
  assert.equal(typingText(['Mia', 'Otto']), 'Mia and Otto are typing…');
  assert.equal(typingText(['Mia', 'Otto', 'Sam']), 'Mia, Otto and Sam are typing…');
  assert.equal(typingText(['Mia', 'Otto', 'Sam', 'Ann']), 'Mia, Otto and 2 others are typing…');
  assert.equal(agentDefaultLabel('auto'), 'Always when only one person uses this agent, agent decides when it is shared');
  assert.equal(agentDefaultLabel('auto', 1), 'Always reply: only you use this agent');
  assert.equal(agentDefaultLabel('auto', 3), 'Agent decides: this agent is shared by 3 people');
  assert.equal(agentDefaultLabel('always', 3), 'Always reply');
  assert.equal(agentDefaultLabel('when-addressed'), 'When mentioned or asked');
  assert.equal(replyModeSummary('inherit', 'agent-decides'), 'Replies: agent decides (agent default)');
  assert.equal(replyModeSummary('always', 'always'), 'Replies: always reply');
});

test('avatar initials use letters and digits only, with sensible fallbacks', async () => {
  const { initials } = await import('../src/team.js');
  assert.equal(initials('Mia (simulated)'), 'MS');
  assert.equal(initials('Otto'), 'O');
  assert.equal(initials('Leonard Schneider'), 'LS');
  assert.equal(initials('🎉 Party Bot'), 'PB');
  assert.equal(initials('[admin] zoë'), 'AZ');
  assert.equal(initials('ångström'), 'Å');
  assert.equal(initials('李 小龙'), '李小');
  assert.equal(initials('R2-D2'), 'RD');
  assert.equal(initials('mia.sim@example.com'), 'MS');
  // Nothing usable in the name: the login's first letter, then "?".
  assert.equal(initials('(…) 🎉', 'otto.sim@example.com'), 'O');
  assert.equal(initials('', '_x@example.com'), 'X');
  assert.equal(initials('!!!', '@@'), '?');
  assert.equal(initials(''), '?');
});
