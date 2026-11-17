import { request, type Account } from './server';
import type { WebPushRegistration } from './web-push';
export type NotificationPreferences = { mode: 'all' | 'mentions' | 'none'; previews: boolean; contentPreviews?: boolean; pausedUntil: number };
/** `webPushKey`: the server's public key for browser push (web-push.ts). Absent on a server that cannot send to a browser yet. */
export type NotificationSettings = { preferences: NotificationPreferences; registered: boolean; deviceId: string; webPushKey?: string };
export const defaultNotifications: NotificationPreferences = { mode: 'mentions', previews: true, contentPreviews: true, pausedUntil: 0 };
export const notificationApi = {
  settings: (a: Account, signal: AbortSignal = AbortSignal.timeout(15000)) => request(a, '/v1/notifications', { signal }).then(r => r.json() as Promise<NotificationSettings>),
  register: (a: Account, token: string | null, platform?: string, aggregateBadge = false) => request(a, '/v1/notifications', { signal: AbortSignal.timeout(15000), method: 'PUT', body: JSON.stringify({ token, platform, environment: 'production', aggregateBadge }) }).then(r => r.json() as Promise<NotificationSettings>),
  /** A browser: its push subscription, so the server can alert it while Servant is closed. */
  registerBrowser: (a: Account, registration: WebPushRegistration) => request(a, '/v1/notifications', { signal: AbortSignal.timeout(15000), method: 'PUT', body: JSON.stringify(registration) }).then(r => r.json() as Promise<NotificationSettings>),
  update: (a: Account, prefs: Partial<NotificationPreferences>) => request(a, '/v1/notifications', { signal: AbortSignal.timeout(15000), method: 'PATCH', body: JSON.stringify(prefs) }).then(r => r.json() as Promise<NotificationSettings>),
  presence: (a: Account, conversation: string | null, active: boolean) => request(a, '/v1/notifications/presence', { signal: AbortSignal.timeout(15000), method: 'POST', body: JSON.stringify({ conversation, active }) }),
};
