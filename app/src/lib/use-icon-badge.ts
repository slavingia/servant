import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { request, type Account } from './server';
import { createIconBadgeSync, createIconBadgeWriter, loadIconBadge } from './icon-badge';
import { normalizeFeatures } from './features';
import { loadAccountsBadge } from './notification-accounts';

export function useIconBadge(accounts: readonly Account[], screen: string) {
  const sync = useRef<ReturnType<typeof createIconBadgeSync> | null>(null);
  useEffect(() => {
    const badge = createIconBadgeSync({
      load: async signal => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) controller.abort();
        const timeout = setTimeout(abort, 10000);
        try {
          return await loadAccountsBadge(accounts, account => loadIconBadge(
            () => normalizeFeatures(account.features).channels || normalizeFeatures(account.features).directMessages ? request(account, '/v1/conversations?includeArchived=1', { signal: controller.signal }).then(r => r.json()).then(d => d.conversations) : Promise.resolve([]),
            () => request(account, '/v1/chats', { signal: controller.signal }).then(r => r.json()).then(d => d.chats),
          ));
        } finally { controller.abort(); clearTimeout(timeout); signal.removeEventListener('abort', abort); }
      },
      setBadge: createIconBadgeWriter(Platform.OS, count => Notifications.setBadgeCountAsync(count)),
      active: () => AppState.currentState === 'active',
    });
    sync.current = badge;
    void badge.refresh();
    const timer = setInterval(() => { void badge.refresh(); }, 15000);
    const state = AppState.addEventListener('change', state => { if (state === 'active') void badge.refresh(); });
    const received = Notifications.addNotificationReceivedListener(() => { void badge.refresh(); });
    return () => { clearInterval(timer); state.remove(); received.remove(); badge.dispose(); if (sync.current === badge) sync.current = null; };
  }, [accounts]);

  // A conversation marks itself read after mounting. Refresh once that request
  // can complete, independently of token registration and card cleanup.
  useEffect(() => { const timer = setTimeout(() => { void sync.current?.refresh(); }, 1000); return () => clearTimeout(timer); }, [screen]);
  return sync;
}
