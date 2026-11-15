// Notifications in a browser (web push): what You → Notifications turns on and off there, and what keeps the
// alerts right while Servant is open. The phone apps (notifications.native.tsx) and the Mac app
// (notifications.tsx) have their own; web-push.ts holds the browser calls and public/sw.js shows the alert.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useGlobalSearchParams, usePathname, useRootNavigationState } from 'expo-router';
import { useSession } from './session';
import { accountId, ServerError, type Account } from './server';
import { defaultNotifications, notificationApi, type NotificationPreferences, type NotificationSettings } from './notifications-api';
import { normalizeFeatures } from './features';
import { notificationAccountRoute } from './notification-accounts';
import type { NotificationRoute } from './notification-route';
import type { NotificationState } from './notifications';
import { closeShown, launchNotification, subscribe, unsubscribe } from './web-push';

// The service worker starts Servant with an alert's routing ids after the #. They are read once, here, before
// the router moves on from the address, and taken out of it.
let launched: Record<string, string> | null = null;
if (typeof window !== 'undefined' && window.location?.hash) {
  launched = launchNotification(window.location.hash);
  if (launched) try { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search); } catch { /* the address keeps its # */ }
}

// Whether this browser was asked to show alerts. The browser's own permission says it may; this says the
// person wants it, so "Turn off in this browser" holds even though the permission stays granted.
const WANTED = 'servant.notifications.browser';
const wanted = () => { try { return globalThis.localStorage?.getItem(WANTED) === 'on'; } catch { return false; } };
const setWanted = (on: boolean) => { try { if (on) globalThis.localStorage?.setItem(WANTED, 'on'); else globalThis.localStorage?.removeItem(WANTED); } catch { /* private window: on for this visit only */ } };
const allowed = () => typeof Notification !== 'undefined' && Notification.permission === 'granted';

export const BLOCKED = "Notifications are blocked for this site. Allow them in your browser's settings for this site, then choose Enable notifications again.";
export const SERVER_TOO_OLD = 'This server cannot send notifications to a browser yet. Ask its owner to update it.';
class ServerTooOld extends Error {}

export function useWebPushNotifications(): NotificationState {
  const { account, accounts, switchAccount } = useSession();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string; conv?: string }>();
  const navigation = useRootNavigationState();
  const conversation = pathname.startsWith('/c/') || pathname.startsWith('/chat/') || pathname.startsWith('/inbox/') ? params.id ?? null : pathname === '/thread' ? params.conv ?? null : null;
  const [settings, setSettings] = useState<Record<string, NotificationSettings>>({});
  const [on, setOn] = useState(() => wanted() && allowed());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ accountId: string; route: NotificationRoute } | null>(null);
  const latest = useRef({ account, accounts });
  useEffect(() => { latest.current = { account, accounts }; }, [account, accounts]);
  const syncVersion = useRef(0);
  // Still the signed-in account it was when a request for it left.
  const current = useCallback((a: Account) => latest.current.accounts.some(saved => accountId(saved) === accountId(a) && saved.token === a.token), []);
  const registrations = useMemo(() => accounts.flatMap(a => settings[accountId(a)]?.deviceId ? [{ id: accountId(a), userId: a.user.id, deviceId: settings[accountId(a)]!.deviceId, features: normalizeFeatures(a.features) }] : []), [accounts, settings]);

  // Every saved server's settings and, with notifications on, this browser subscribed and registered with each.
  const sync = useCallback(async (subscribing: boolean) => {
    const version = ++syncVersion.current;
    const saved = latest.current.accounts;
    if (!saved.length) return;
    setBusy(true); setError(null);
    try {
      const results = await Promise.allSettled(saved.map(async a => {
        let config = await notificationApi.settings(a);
        if (subscribing) {
          if (!config.webPushKey) { if (version === syncVersion.current && current(a)) setSettings(all => ({ ...all, [accountId(a)]: config })); throw new ServerTooOld(); }
          config = await notificationApi.registerBrowser(a, await subscribe(accountId(a), config.webPushKey));
        }
        if (version === syncVersion.current && current(a)) setSettings(all => ({ ...all, [accountId(a)]: config }));
      }));
      if (version !== syncVersion.current || !subscribing) return;
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (!failed.length) return;
      // Nothing subscribed anywhere: it is not on. Some servers did: it is, and the rest are named.
      if (failed.length === saved.length) { setOn(false); setWanted(false); }
      const tooOld = failed.every(result => result.reason instanceof ServerTooOld);
      const reason = failed[0]!.reason;
      setError(tooOld ? SERVER_TOO_OLD : saved.length > 1 ? 'Could not turn on notifications for every server. Try again.'
        : reason instanceof ServerError ? reason.message : 'Could not turn on notifications in this browser. Try again.');
    } finally { if (version === syncVersion.current) setBusy(false); }
  }, [current]);

  const enable = useCallback(async () => {
    setError(null);
    // The browser shows its question only in answer to a click, so nothing is awaited before it.
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission !== 'granted') { setOn(false); setError(BLOCKED); return; }
    setWanted(true); setOn(true);
    await sync(true);
  }, [sync]);

  const disable = useCallback(async () => {
    const version = ++syncVersion.current;
    setWanted(false); setOn(false); setBusy(true); setError(null);
    const results = await Promise.allSettled(latest.current.accounts.map(async a => {
      await unsubscribe(accountId(a));
      const config = await notificationApi.register(a, null);
      if (current(a)) setSettings(all => ({ ...all, [accountId(a)]: config }));
    }));
    if (version !== syncVersion.current) return;
    // The browser has stopped listening either way; a server that could not be told finds out when it next sends.
    if (results.some(result => result.status === 'rejected')) setError('Notifications are off in this browser. A server could not be told yet; it will stop on its own.');
    setBusy(false);
  }, [current]);

  const update = useCallback(async (prefs: Partial<NotificationPreferences>) => {
    const a = latest.current.account; if (!a) return;
    setBusy(true); setError(null);
    try {
      const result = await notificationApi.update(a, prefs);
      if (current(a)) setSettings(all => ({ ...all, [accountId(a)]: result }));
    } catch (e) { setError(e instanceof ServerError ? e.message : 'Could not save notification settings. Try again.'); }
    finally { setBusy(false); }
  }, [current]);

  // On load and whenever the saved servers change: a server signed in to later is subscribed too, and one
  // signed out of stops being listened for.
  const known = useRef<string[]>([]);
  useEffect(() => {
    const ids = accounts.map(accountId);
    for (const gone of known.current.filter(id => !ids.includes(id))) void unsubscribe(gone).catch(() => {});
    known.current = ids;
    const version = syncVersion;
    const timer = setTimeout(() => {
      if (!accounts.length) { version.current++; setSettings({}); setBusy(false); }
      else void sync(wanted() && allowed());
    }, 0);
    return () => { clearTimeout(timer); version.current++; };
  }, [accounts, sync]);

  // The permission can be taken away in the browser's own settings while Servant is open.
  useEffect(() => {
    const check = () => setOn(wanted() && allowed());
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);

  // Tell the server what is on screen, so it does not alert for the conversation being read, and take down
  // alerts already showing for it.
  const registered = !!account && on && settings[accountId(account)]?.registered === true;
  const deviceId = account ? settings[accountId(account)]?.deviceId : undefined;
  useEffect(() => {
    if (!account || !registered) return;
    const id = accountId(account);
    const looking = () => document.visibilityState === 'visible' && document.hasFocus();
    const presence = () => {
      void notificationApi.presence(account, conversation, looking()).catch(() => {});
      if (looking() && conversation && deviceId) {
        void closeShown(id, data => data.userId === account.user.id && data.deviceId === deviceId && (data.conversationId === conversation || data.chatId === conversation || data.caseId === conversation)).catch(() => {});
      }
    };
    presence();
    document.addEventListener('visibilitychange', presence);
    window.addEventListener('focus', presence);
    window.addEventListener('blur', presence);
    const timer = setInterval(presence, 30000);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', presence);
      window.removeEventListener('focus', presence);
      window.removeEventListener('blur', presence);
      void notificationApi.presence(account, null, false).catch(() => {});
    };
  }, [account, conversation, registered, deviceId]);

  // A clicked alert: the service worker says which, here or in the address it started Servant with. It opens
  // only if it is for a person and browser signed in here, on that server.
  const waiting = useRef<Record<string, unknown> | null>(launched);
  const open = useCallback((data: Record<string, unknown>) => {
    const target = notificationAccountRoute(data, registrations);
    if (!target) return false;
    setPending(target);
    void switchAccount(target.accountId).catch(() => { setPending(null); setError('Could not switch to the server for this notification. Try again.'); });
    return true;
  }, [registrations, switchAccount]);
  useEffect(() => {
    if (!navigation?.key) return;
    if (waiting.current && registrations.length && open(waiting.current)) { waiting.current = null; launched = null; }
    const clicked = (event: MessageEvent) => {
      const message = event.data as { type?: unknown; data?: unknown } | null;
      if (message?.type !== 'servant-notification' || !message.data || typeof message.data !== 'object') return;
      if (!open(message.data as Record<string, unknown>)) waiting.current = message.data as Record<string, unknown>;
    };
    navigator.serviceWorker.addEventListener('message', clicked);
    return () => navigator.serviceWorker.removeEventListener('message', clicked);
  }, [navigation?.key, open, registrations.length]);
  useEffect(() => {
    if (!pending || !account || accountId(account) !== pending.accountId || !navigation?.key) return;
    const timer = setTimeout(() => { router.push(pending.route); setPending(null); }, 0);
    return () => clearTimeout(timer);
  }, [account, pending, navigation?.key]);
  useEffect(() => {
    if (!pending || accounts.some(a => accountId(a) === pending.accountId)) return;
    const timer = setTimeout(() => setPending(null), 0);
    return () => clearTimeout(timer);
  }, [accounts, pending]);

  const mine = account ? settings[accountId(account)] : undefined;
  // On, unless this server is known not to have this browser (it is too old, or the registration failed).
  return { supported: true, enabled: on && mine?.registered !== false, busy, error, preferences: mine?.preferences ?? defaultNotifications, enable, update, disable };
}
