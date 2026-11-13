import type { Features } from './features.ts';
import { notificationRoute, type NotificationRoute } from './notification-route.ts';

export type RegisteredNotificationAccount = { id: string; userId: string; deviceId: string; features?: Features };
// A device id belongs to a registration on one server. Never guess when an old
// or copied server state makes the same payload match more than one account.
export function notificationAccountRoute(data: Record<string, unknown>, registrations: readonly RegisteredNotificationAccount[]): { accountId: string; route: NotificationRoute } | null {
  const matches = registrations.flatMap(a => {
    const route = notificationRoute(data, a.userId, a.deviceId, a.features);
    return route ? [{ accountId: a.id, route }] : [];
  });
  return matches.length === 1 ? matches[0] : null;
}

// An incomplete snapshot must not clear unread items on an unreachable server.
export async function loadAccountsBadge<T>(accounts: readonly T[], load: (account: T) => Promise<number>): Promise<number> {
  const counts = await Promise.all(accounts.map(load));
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error('Invalid unread count');
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Invalid unread total');
  return total;
}
