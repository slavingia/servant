import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applicationId } from "expo-application";
import { AppState, Linking, Platform } from 'react-native';
import { router, useGlobalSearchParams, usePathname, useRootNavigationState } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import { useSession } from './session';
import { accountId, ServerError } from './server';
import { normalizeFeatures } from './features.ts';
import { notificationApi, defaultNotifications, type NotificationSettings, type NotificationPreferences } from './notifications-api';
import { notificationAccountRoute } from './notification-accounts';
import type { NotificationRoute } from './notification-route';
import type { NotificationState } from './notifications';
import { useIconBadge } from './use-icon-badge';

const Ctx = createContext<NotificationState | null>(null);
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }) });

// This provider stays mounted while the account-specific navigation tree resets.
// Registrations, notification taps and the badge always cover all saved servers.
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { account, accounts, switchAccount } = useSession();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string; conv?: string }>();
  const navigation = useRootNavigationState();
  const conversation = pathname.startsWith('/c/') || pathname.startsWith('/chat/') || pathname.startsWith('/inbox/') ? params.id ?? null : pathname === '/thread' ? params.conv ?? null : null;
  useIconBadge(accounts, `${account ? accountId(account) : ''}:${pathname}:${conversation ?? ''}`);
  const [settings, setSettings] = useState<Record<string, NotificationSettings>>({});
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ accountId: string; route: NotificationRoute; notificationId?: string } | null>(null);
  const latest = useRef({ account, accounts });
  useEffect(() => { latest.current = { account, accounts }; }, [account, accounts]);
  const lastOpened = useRef('');
  const syncVersion = useRef(0);
  const registrationsQueue = useRef<Promise<unknown>>(Promise.resolve());
  const preferences = account ? settings[accountId(account)]?.preferences ?? defaultNotifications : defaultNotifications;
  const registrations = useMemo(() => accounts.flatMap(a => settings[accountId(a)]?.deviceId ? [{ id: accountId(a), userId: a.user.id, deviceId: settings[accountId(a)].deviceId, features: normalizeFeatures(a.features) }] : []), [accounts, settings]);

  const sync = useCallback(async (ask: boolean) => {
    const version = ++syncVersion.current;
    const saved = latest.current.accounts;
    if (!saved.length) return;
    setBusy(true); setError(null);
    try {
      if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('messages', { name: 'Messages and mentions', importance: AndroidImportance.HIGH, sound: 'default', vibrationPattern: [0, 200, 100, 200], lightColor: '#0071BC' });
      let permission = await Notifications.getPermissionsAsync();
      if (ask && !permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
      const allowed = permission.granted || permission.ios?.status === IosAuthorizationStatus.PROVISIONAL;
      const token = allowed ? String((await Notifications.getDevicePushTokenAsync()).data) : null;
      // Serialize registrations so an older one-server sync cannot finish
      // after a newer two-server sync and restore per-server badge writes.
      const work = registrationsQueue.current.catch(() => {}).then(async () => {
        if (version !== syncVersion.current) return [];
        return Promise.allSettled(saved.map(async a => {
          const result = await notificationApi.register(a, token, Platform.OS, saved.length > 1, applicationId);
          if (version === syncVersion.current && latest.current.accounts.some(current => accountId(current) === accountId(a) && current.token === a.token)) {
            setSettings(current => ({ ...current, [accountId(a)]: result }));
          }
        }));
      });
      registrationsQueue.current = work;
      const results = await work;
      if (version !== syncVersion.current) return;
      setEnabled(allowed);
      if (results.some(result => result.status === 'rejected')) setError('Could not update notifications for every server. They will retry when you return to the app.');
    } catch (e) {
      if (version === syncVersion.current) { setEnabled(false); setError(e instanceof ServerError ? e.message : 'Could not enable push notifications. Try again'); }
    } finally { if (version === syncVersion.current) setBusy(false); }
  }, []);
  const enable = useCallback(async () => {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && !permission.canAskAgain) { await Linking.openSettings(); return; }
    await sync(true);
  }, [sync]);
  const update = useCallback(async (prefs: Partial<NotificationPreferences>) => {
    const a = latest.current.account; if (!a) return;
    setBusy(true); setError(null);
    try {
      const result = await notificationApi.update(a, prefs);
      if (latest.current.accounts.some(current => accountId(current) === accountId(a) && current.token === a.token)) setSettings(current => ({ ...current, [accountId(a)]: result }));
    } catch (e) { setError(e instanceof ServerError ? e.message : 'Could not save notification settings'); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    const version = syncVersion;
    const timer = setTimeout(() => {
      if (!accounts.length) {
        version.current++;
        setSettings({}); setEnabled(false); setBusy(false);
        void Notifications.dismissAllNotificationsAsync();
        void Notifications.setBadgeCountAsync(0);
      } else void sync(true);
    }, 0);
    return () => { clearTimeout(timer); version.current++; };
  }, [accounts, sync]);

  useEffect(() => {
    const tokenSub = Notifications.addPushTokenListener(() => { void sync(false); });
    const stateSub = AppState.addEventListener('change', state => { if (state === 'active') void sync(false); });
    return () => { tokenSub.remove(); stateSub.remove(); };
  }, [sync]);

  useEffect(() => {
    Notifications.setNotificationHandler({ handleNotification: async n => {
      const data = n.request.content.data ?? {};
      const target = notificationAccountRoute(data, registrations);
      const selected = !!target && !!account && target.accountId === accountId(account);
      const visible = selected && AppState.currentState === 'active' && conversation && (data.conversationId === conversation || data.chatId === conversation || data.caseId === conversation);
      const prefs = target ? settings[target.accountId]?.preferences : null;
      const show = !!target && !visible && !!prefs && prefs.mode !== 'none' && prefs.pausedUntil <= Date.now();
      // A per-server push count must never replace the all-server foreground total.
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: show && accounts.length === 1 && AppState.currentState !== 'active' };
    } });
  }, [account, accounts.length, conversation, registrations, settings]);

  useEffect(() => {
    if (!account) return;
    const id = accountId(account);
    const presence = () => {
      void notificationApi.presence(account, conversation, AppState.currentState === 'active').catch(() => {});
      const deviceId = settings[id]?.deviceId;
      if (AppState.currentState === 'active' && conversation && deviceId) {
        void Notifications.getPresentedNotificationsAsync().then(list => Promise.all(list.filter(n => {
          const data = n.request.content.data;
          return data?.userId === account.user.id && data?.deviceId === deviceId && (data.conversationId === conversation || data.chatId === conversation || data.caseId === conversation);
        }).map(n => Notifications.dismissNotificationAsync(n.request.identifier)))).catch(() => {});
      }
    };
    presence();
    const sub = AppState.addEventListener('change', presence);
    const timer = setInterval(presence, 30000);
    return () => { clearInterval(timer); sub.remove(); void notificationApi.presence(account, null, false).catch(() => {}); };
  }, [account, conversation, settings]);

  useEffect(() => {
    if (!pending || accounts.some(a => accountId(a) === pending.accountId)) return;
    const timer = setTimeout(() => setPending(null), 0);
    return () => clearTimeout(timer);
  }, [accounts, pending]);

  const openTarget = useCallback(async (target: NonNullable<typeof pending>) => {
    if (!latest.current.accounts.some(a => accountId(a) === target.accountId)) return;
    setPending(target);
    try { await switchAccount(target.accountId); }
    catch { setPending(null); setError('Could not switch to the server for this notification. Try again.'); }
  }, [switchAccount]);

  useEffect(() => {
    if (!pending || !account || accountId(account) !== pending.accountId || !navigation?.key) return;
    const timer = setTimeout(() => {
      router.push(pending.route);
      if (pending.notificationId) { lastOpened.current = pending.notificationId; void Notifications.clearLastNotificationResponseAsync(); }
      setPending(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [account, navigation?.key, pending]);

  useEffect(() => {
    if (!registrations.length || !navigation?.key) return;
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;

      if (lastOpened.current === id || pending?.notificationId === id) return;
      const target = notificationAccountRoute(response.notification.request.content.data ?? {}, registrations);
      if (target) void openTarget({ ...target, notificationId: id });

    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then(open).catch(() => {});
    return () => sub.remove();
  }, [registrations, navigation?.key, openTarget, pending]);

  return <Ctx.Provider value={{ supported: true, enabled, busy, error, preferences, enable, update }}>{children}</Ctx.Provider>;
}
export function useNotifications() {
  const context = useContext(Ctx);
  if (!context) throw new Error('useNotifications outside provider');
  return context;
}
