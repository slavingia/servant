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
