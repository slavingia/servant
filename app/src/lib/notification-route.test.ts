import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationRoute } from './notification-route.ts';
test('notification taps route to conversations, threads and agent chats only for the registered account', () => {
  const base = { userId: 'u', deviceId: 'd', conversationId: 'ch_test' };
  assert.deepEqual(notificationRoute(base, 'u', 'd'), { pathname: '/c/[id]', params: { id: 'ch_test' } });
  assert.deepEqual(notificationRoute({ ...base, threadRoot: '42' }, 'u', 'd'), { pathname: '/thread', params: { conv: 'ch_test', root: '42' } });
  assert.deepEqual(notificationRoute({ ...base, threadRoot: '42', messageId: '57' }, 'u', 'd'), { pathname: '/thread', params: { conv: 'ch_test', root: '42', focus: '57', from: 'push' } });
  assert.deepEqual(notificationRoute({ ...base, threadRoot: '42', messageId: '42' }, 'u', 'd'), { pathname: '/thread', params: { conv: 'ch_test', root: '42' } });
  assert.deepEqual(notificationRoute({ ...base, threadRoot: '42', messageId: 'x;y' }, 'u', 'd'), { pathname: '/thread', params: { conv: 'ch_test', root: '42' } });
  assert.deepEqual(notificationRoute({ userId: 'u', deviceId: 'd', chatId: 'cht_test' }, 'u', 'd'), { pathname: '/chat/[id]', params: { id: 'cht_test' } });
  assert.equal(notificationRoute(base, 'other', 'd'), null);
  assert.equal(notificationRoute(base, 'u', 'other'), null);
  assert.equal(notificationRoute({ ...base, conversationId: 'https://example.com' }, 'u', 'd'), null);
});
test('a call notification opens the call', () => {
  const base = { userId: 'u', deviceId: 'd', conversationId: 'ch_test', meetingId: 'meet_abc-1' };
  assert.deepEqual(notificationRoute(base, 'u', 'd'), { pathname: '/meeting/[id]', params: { id: 'meet_abc-1' } });
  assert.deepEqual(notificationRoute({ ...base, meetingId: 'x/../y' }, 'u', 'd'), { pathname: '/c/[id]', params: { id: 'ch_test' } });
  assert.equal(notificationRoute(base, 'other', 'd'), null);
});
test('a server that turned a feature off: no tap opens its call, channel or DM', () => {
  const off = { channels: false, directMessages: false, meetings: false, secureInbox: false };
  const call = { userId: 'u', deviceId: 'd', conversationId: 'ch_test', meetingId: 'meet_abc-1' };
  assert.deepEqual(notificationRoute(call, 'u', 'd', { ...off, channels: true }), { pathname: '/c/[id]', params: { id: 'ch_test' } }, 'without meetings the tap lands in the conversation');
  assert.equal(notificationRoute(call, 'u', 'd', off), null);
  assert.equal(notificationRoute({ userId: 'u', deviceId: 'd', conversationId: 'dm_test', threadRoot: '4' }, 'u', 'd', { ...off, channels: true }), null);
  assert.deepEqual(notificationRoute({ userId: 'u', deviceId: 'd', conversationId: 'dm_test' }, 'u', 'd', { ...off, directMessages: true }), { pathname: '/c/[id]', params: { id: 'dm_test' } });
  assert.deepEqual(notificationRoute({ userId: 'u', deviceId: 'd', chatId: 'cht_test' }, 'u', 'd', off), { pathname: '/chat/[id]', params: { id: 'cht_test' } }, 'agent chats always open');
});
// A visitor wrote to the secure inbox: the alert opens that case.
test('a case notification opens the case, and nothing on a server that turned Cases off', () => {
  const base = { userId: 'u', deviceId: 'd', caseId: 'inbox_abc-123' };
  assert.deepEqual(notificationRoute(base, 'u', 'd'), { pathname: '/inbox/[id]', params: { id: 'inbox_abc-123' } });
  assert.equal(notificationRoute(base, 'other', 'd'), null);
  assert.equal(notificationRoute(base, 'u', 'other'), null);
  assert.equal(notificationRoute({ ...base, caseId: 'https://example.gov' }, 'u', 'd'), null);
  assert.equal(notificationRoute({ ...base, caseId: 'inbox_../x' }, 'u', 'd'), null);
  assert.equal(notificationRoute(base, 'u', 'd', { channels: true, directMessages: true, meetings: true, secureInbox: false }), null);
});

test('a code request opens its entry screen, and only a well-formed id does', () => {
  const base = { userId: 'u', deviceId: 'd', codeRequestId: 'code_abcDEF123_-x' };
  assert.deepEqual(notificationRoute(base, 'u', 'd'), { pathname: '/code/[id]', params: { id: 'code_abcDEF123_-x' } });
  assert.equal(notificationRoute(base, 'u', 'other'), null);
  assert.equal(notificationRoute({ ...base, codeRequestId: 'code_../../x' }, 'u', 'd'), null);
  assert.equal(notificationRoute({ ...base, codeRequestId: 'https://example.gov' }, 'u', 'd'), null);
});
