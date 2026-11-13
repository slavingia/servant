import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAccountsBadge, notificationAccountRoute } from './notification-accounts.ts';

test('a notification from an inactive server identifies that account before routing', () => {
  const registrations = [{ id: 'alpha', userId: 'u', deviceId: 'a' }, { id: 'beta', userId: 'u', deviceId: 'b' }];
  assert.deepEqual(notificationAccountRoute({ userId: 'u', deviceId: 'b', conversationId: 'ch_room' }, registrations), { accountId: 'beta', route: { pathname: '/c/[id]', params: { id: 'ch_room' } } });
  assert.equal(notificationAccountRoute({ userId: 'u', deviceId: 'gone', conversationId: 'ch_room' }, registrations), null);
  assert.equal(notificationAccountRoute({ userId: 'u', deviceId: 'b', conversationId: 'https://evil.test' }, registrations), null);
});
test('ambiguous copied registrations cannot open another server by accident', () => {
  assert.equal(notificationAccountRoute({ userId: 'u', deviceId: 'd', chatId: 'cht_room' }, [{ id: 'a', userId: 'u', deviceId: 'd' }, { id: 'b', userId: 'u', deviceId: 'd' }]), null);
});
test('badges aggregate every server and signing out removes only that contribution', async () => {
  const counts = { a: 3, b: 7 };
  assert.equal(await loadAccountsBadge(['a', 'b'] as const, async id => counts[id]), 10);
  assert.equal(await loadAccountsBadge(['b'] as const, async id => counts[id]), 7);
  assert.equal(await loadAccountsBadge([], async () => 1), 0);
});
test('a failed server or invalid count cannot silently replace the aggregate with a partial total', async () => {
  await assert.rejects(loadAccountsBadge(['a', 'b'], async id => { if (id === 'b') throw new Error('offline'); return 0; }));
  await assert.rejects(loadAccountsBadge(['a', 'b'], async id => id === 'b' ? -1 : 5));
});
