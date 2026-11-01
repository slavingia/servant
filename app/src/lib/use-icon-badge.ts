import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { request, type Account } from './server';
import { createIconBadgeSync, loadIconBadge } from './icon-badge';

export function useIconBadge(account: Account | null, unread: Readonly<Record<string, number>>, connected: boolean) {
  const sync = useRef<ReturnType<typeof createIconBadgeSync> | null>(null);
  useEffect(() => {
    if (!account) return;
    const badge = createIconBadgeSync({
      load: async signal => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) controller.abort();
        const timeout = setTimeout(abort, 10000);
        try {
          return await loadIconBadge(
            () => request(account, '/v1/conversations?includeArchived=1', { signal: controller.signal }).then(r => r.json()).then(d => d.conversations),
            () => request(account, '/v1/chats', { signal: controller.signal }).then(r => r.json()).then(d => d.chats),
          );
        } finally { controller.abort(); clearTimeout(timeout); signal.removeEventListener('abort', abort); }
      },
      setBadge: count => Notifications.setBadgeCountAsync(count),
      active: () => AppState.currentState === 'active',
    });
    sync.current = badge;
    void badge.refresh();
    const state = AppState.addEventListener('change', state => { if (state === 'active') void badge.refresh(); });
    const received = Notifications.addNotificationReceivedListener(() => { void badge.refresh(); });
    return () => { state.remove(); received.remove(); badge.dispose(); if (sync.current === badge) sync.current = null; };
  }, [account]);

  // Registration/permissions and notification-card cleanup must not gate the
  // icon badge. A successful inbox refresh can repair it independently.
  useEffect(() => { void sync.current?.refresh(); }, [unread, connected]);
  return sync;
}
