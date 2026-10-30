import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { router, useGlobalSearchParams, usePathname, useRootNavigationState } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import { useSession } from './session';
import { useLive } from './live';
import { HubError } from './hub';
import { notificationApi, defaultNotifications, type NotificationPreferences } from './notifications-api';
import { notificationRoute } from './notification-route';
import type { NotificationState } from './notifications';

const Ctx = createContext<NotificationState | null>(null);
// Default to silent until a paired account and its current screen are known.
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }) });
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  const { unread } = useLive();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string; conv?: string }>();
  const navigation = useRootNavigationState();
  const conversation = pathname.startsWith('/c/') || pathname.startsWith('/chat/') ? params.id ?? null : pathname === '/thread' ? params.conv ?? null : null;
  const [preferences, setPreferences] = useState<NotificationPreferences>(defaultNotifications);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const latest = useRef(account);
  const lastOpened = useRef('');
  useEffect(() => { latest.current = account; }, [account]);

  const sync = useCallback(async (ask: boolean) => {
    const a = latest.current;
    if (!a) return;
    setBusy(true); setError(null);
    try {
      if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('messages', { name: 'Messages and mentions', importance: AndroidImportance.HIGH, sound: 'default', vibrationPattern: [0, 200, 100, 200], lightColor: '#0071BC' });
      let permission = await Notifications.getPermissionsAsync();
      if (ask && !permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
      const allowed = permission.granted || permission.ios?.status === IosAuthorizationStatus.PROVISIONAL;
      const settings = await notificationApi.settings(a);
      if (latest.current?.token !== a.token) return;
      setPreferences(settings.preferences); setDeviceId(settings.deviceId);
      if (allowed) {
        const token = await Notifications.getDevicePushTokenAsync();
        if (latest.current?.token !== a.token) return;
        await notificationApi.register(a, String(token.data), Platform.OS);
      } else await notificationApi.register(a, null);
      if (latest.current?.token === a.token) setEnabled(allowed);
    } catch (e) {
      if (latest.current?.token === a.token) { setEnabled(false); setError(e instanceof HubError ? e.message : 'Could not enable push notifications. Try again'); }
    } finally { setBusy(false); }
  }, []);
  const enable = useCallback(async () => {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && !permission.canAskAgain) { await Linking.openSettings(); return; }
    await sync(true);
  }, [sync]);
  const update = useCallback(async (prefs: Partial<NotificationPreferences>) => {
    const a = latest.current; if (!a) return;
    setBusy(true); setError(null);
    try { const result = await notificationApi.update(a, prefs); if (latest.current?.token === a.token) setPreferences(result.preferences); }
    catch (e) { setError(e instanceof HubError ? e.message : 'Could not save notification settings'); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    if (!account) {
      void Notifications.dismissAllNotificationsAsync();
      void Notifications.setBadgeCountAsync(0);
      return;
    }
    void sync(true);
    const tokenSub = Notifications.addPushTokenListener(token => {
      const a = latest.current;
      if (a) void notificationApi.register(a, String(token.data), Platform.OS).catch(() => setError('Could not register the refreshed notification token. Try again'));
    });
    const stateSub = AppState.addEventListener('change', state => { if (state === 'active') void sync(false); });
    return () => { tokenSub.remove(); stateSub.remove(); };
  }, [account, sync]);

  useEffect(() => {
    Notifications.setNotificationHandler({ handleNotification: async n => {
      const data = n.request.content.data ?? {};
      const matches = !!account && data.userId === account.user.id && data.deviceId === deviceId;
      const visible = AppState.currentState === 'active' && conversation && (data.conversationId === conversation || data.chatId === conversation);
      const show = !!matches && !visible && preferences.mode !== 'none' && preferences.pausedUntil <= Date.now();
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: show };
    } });
  }, [account, conversation, deviceId, preferences]);

  useEffect(() => {
    if (!account) return;
    const presence = () => {
      void notificationApi.presence(account, conversation, AppState.currentState === 'active').catch(() => {});
      if (AppState.currentState === 'active' && conversation) {
        void Notifications.getPresentedNotificationsAsync().then(list => Promise.all(list.filter(n => n.request.content.data?.conversationId === conversation || n.request.content.data?.chatId === conversation).map(n => Notifications.dismissNotificationAsync(n.request.identifier)))).catch(() => {});
      }
    };
    presence();
    const sub = AppState.addEventListener('change', presence);
    const timer = setInterval(presence, 30000);
    return () => { clearInterval(timer); sub.remove(); };
  }, [account, conversation]);

  useEffect(() => { if (account) void Notifications.setBadgeCountAsync(unread.channels + unread.messages); }, [account, unread.channels, unread.messages]);

  useEffect(() => {
    if (!account || !deviceId || !navigation?.key) return;
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (lastOpened.current === id) return;
      const route = notificationRoute(response.notification.request.content.data ?? {}, account.user.id, deviceId);
      if (!route) return;
      lastOpened.current = id;
      router.push(route);
      void Notifications.clearLastNotificationResponseAsync();
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then(open);
    return () => sub.remove();
  }, [account, deviceId, navigation?.key]);

  return <Ctx.Provider value={{ supported: true, enabled, busy, error, preferences, enable, update }}>{children}</Ctx.Provider>;
}
export function useNotifications() {
  const context = useContext(Ctx);
  if (!context) throw new Error('useNotifications outside provider');
  return context;
}
