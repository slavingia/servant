import { request, type Account } from './server';
export type NotificationPreferences = { mode: 'all' | 'mentions' | 'none'; previews: boolean; pausedUntil: number };
export type NotificationSettings = { preferences: NotificationPreferences; registered: boolean; deviceId: string };
export const defaultNotifications: NotificationPreferences = { mode: 'mentions', previews: false, pausedUntil: 0 };
export const notificationApi = {
  settings: (a: Account) => request(a, '/v1/notifications').then(r => r.json() as Promise<NotificationSettings>),
  register: (a: Account, token: string | null, platform?: string) => request(a, '/v1/notifications', { method: 'PUT', body: JSON.stringify({ token, platform, environment: 'production' }) }).then(r => r.json() as Promise<NotificationSettings>),
  update: (a: Account, prefs: Partial<NotificationPreferences>) => request(a, '/v1/notifications', { method: 'PATCH', body: JSON.stringify(prefs) }).then(r => r.json() as Promise<NotificationSettings>),
  presence: (a: Account, conversation: string | null, active: boolean) => request(a, '/v1/notifications/presence', { method: 'POST', body: JSON.stringify({ conversation, active }) }),
};
