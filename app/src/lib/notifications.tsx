// Web doesn't register a native push token. Native implementation is resolved
// from notifications.native.tsx by Metro.
import type { ReactNode } from 'react';
import { defaultNotifications, type NotificationPreferences } from './notifications-api';
export type NotificationState = {
  supported: boolean; enabled: boolean; busy: boolean; error: string | null;
  preferences: NotificationPreferences;
  enable: () => Promise<void>;
  update: (p: Partial<NotificationPreferences>) => Promise<void>;
};
export function NotificationsProvider({ children }: { children: ReactNode }) { return children; }
export function useNotifications(): NotificationState {
  return { supported: false, enabled: false, busy: false, error: null, preferences: defaultNotifications, enable: async () => {}, update: async () => {} };
}
