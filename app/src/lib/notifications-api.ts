import { request, type Account } from './server';
export type NotificationPreferences = { mode: 'all' | 'mentions' | 'none'; previews: boolean; contentPreviews?: boolean; pausedUntil: number };
export type NotificationSettings = { preferences: NotificationPreferences; registered: boolean; deviceId: string };
export const defaultNotifications: NotificationPreferences = { mode: 'mentions', previews: true, contentPreviews: true, pausedUntil: 0 };
export const notificationApi = {
  settings: (a: Account, signal: AbortSignal = AbortSignal.timeout(15000)) => request(a, '/v1/notifications', { signal }).then(r => r.json() as Promise<NotificationSettings>),
  register: (a: Account, token: string | null, platform?: string, aggregateBadge = false) => request(a, '/v1/notifications', { signal: AbortSignal.timeout(15000), method: 'PUT', body: JSON.stringify({ token, platform, environment: 'production', aggregateBadge }) }).then(r => r.json() as Promise<NotificationSettings>),
  /** iPhone: the PushKit token for incoming calls. Android: say this build rings with a full-screen call. */
  registerCalls: (a: Account, body: { token: string | null; environment?: 'production' | 'development' } | { android: true }) => request(a, '/v1/notifications/voip', { signal: AbortSignal.timeout(15000), method: 'PUT', body: JSON.stringify(body) }),
  update: (a: Account, prefs: Partial<NotificationPreferences>) => request(a, '/v1/notifications', { signal: AbortSignal.timeout(15000), method: 'PATCH', body: JSON.stringify(prefs) }).then(r => r.json() as Promise<NotificationSettings>),
  presence: (a: Account, conversation: string | null, active: boolean) => request(a, '/v1/notifications/presence', { signal: AbortSignal.timeout(15000), method: 'POST', body: JSON.stringify({ conversation, active }) }),
};
