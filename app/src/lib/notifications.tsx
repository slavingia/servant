// Native implementation is resolved from notifications.native.tsx by Metro.
// The Mac bridge presents OS notifications while this renderer monitors every
// saved server. A browser that can is offered web push (notifications-web-push.ts),
// and asks for notification access only when the person chooses Enable notifications.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { router, useGlobalSearchParams, usePathname, useRootNavigationState } from 'expo-router';
import { useSession } from './session';
import { accountId, api, listen, request, type Account, type Chat, type Conversation, type Post } from './server';
import { defaultNotifications, notificationApi, type NotificationPreferences, type NotificationSettings } from './notifications-api';
import { normalizeFeatures } from './features';
import { loadIconBadge } from './icon-badge';
import { loadAccountsBadge, notificationAccountRoute } from './notification-accounts';
import { desktopMessageNotifies } from './desktop-notification-rules';
import type { DesktopNotice } from './desktop';
import type { NotificationRoute } from './notification-route';
import { webPushSupported } from './web-push';
import { useWebPushNotifications } from './notifications-web-push';
export type NotificationState = {
  supported: boolean; enabled: boolean; busy: boolean; error: string | null;
  preferences: NotificationPreferences;
  enable: () => Promise<void>;
  update: (p: Partial<NotificationPreferences>) => Promise<void>;
  /** A browser only: stop alerts in this browser. Phones and the Mac app are switched off in their system settings. */
  disable?: () => Promise<void>;
};
const fallback: NotificationState = { supported: false, enabled: false, busy: false, error: null, preferences: defaultNotifications, enable: async () => {}, update: async () => {} };
const Ctx = createContext<NotificationState>(fallback);

// Which notifications this build has is fixed for as long as it runs: the Mac app's bridge, a browser's web
// push, or none (a browser that cannot, such as a tab on an iPhone).
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [kind] = useState(() => typeof window !== 'undefined' && window.servantDesktop?.notifications ? 'desktop' : webPushSupported() ? 'browser' : 'none');
  if (kind === 'desktop') return <DesktopNotifications>{children}</DesktopNotifications>;
  if (kind === 'browser') return <BrowserNotifications>{children}</BrowserNotifications>;
  return <Ctx.Provider value={fallback}>{children}</Ctx.Provider>;
}

function BrowserNotifications({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={useWebPushNotifications()}>{children}</Ctx.Provider>;
}

function DesktopNotifications({ children }: { children: ReactNode }) {
  const { account, accounts, switchAccount } = useSession();
  const bridge = typeof window === 'undefined' ? undefined : window.servantDesktop?.notifications;
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string; conv?: string }>();
  const navigation = useRootNavigationState();
  const conversation = pathname.startsWith('/c/') || pathname.startsWith('/chat/') ? params.id ?? null : pathname === '/thread' ? params.conv ?? null : null;
  const [settings, setSettings] = useState<Record<string, NotificationSettings>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ accountId: string; route: NotificationRoute } | null>(null);
  const latest = useRef({ account, accounts, settings, conversation });
  useEffect(() => { latest.current = { account, accounts, settings, conversation }; }, [account, accounts, settings, conversation]);
  const visible = useCallback((a: Account, id: string) => document.hasFocus() && latest.current.account && accountId(latest.current.account) === accountId(a) && latest.current.conversation === id, []);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const controllers = new Set<AbortController>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const inboxes = new Map<string, Conversation[]>();
    const chatCounts = new Map<string, Map<string, number>>();
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || disposed) return;
      refreshing = true;
      try {
        const total = await loadAccountsBadge(accounts, async a => {
          const controller = new AbortController(); controllers.add(controller);
          const timeout = setTimeout(() => controller.abort(), 10000);
          try {
            const flags = normalizeFeatures(a.features);
            const [conversations, chats, config] = await Promise.all([
              flags.channels || flags.directMessages ? request(a, '/v1/conversations?includeArchived=1', { signal: controller.signal }).then(r => r.json()).then(d => d.conversations as Conversation[]) : Promise.resolve([]),
              request(a, '/v1/chats', { signal: controller.signal }).then(r => r.json()).then(d => d.chats as Chat[]),
              notificationApi.settings(a, controller.signal),
            ]);
            if (disposed) throw new Error('Stopped');
            const id = accountId(a);
            inboxes.set(id, conversations);
            setSettings(current => ({ ...current, [id]: config }));
            const previous = chatCounts.get(id);
            const next = new Map<string, number>();
            for (const chat of chats) {
              const count = chat.archived ? 0 : chat.unread ?? 0;
              next.set(chat.id, count);
              if (previous && count > (previous.get(chat.id) ?? 0) && !visible(a, chat.id) && config.preferences.mode !== 'none' && config.preferences.pausedUntil <= Date.now()) {
                void bridge.show({ accountId: id, title: config.preferences.contentPreviews === false ? 'Servant' : `Agent · ${a.serverName}`, body: 'You have a new agent reply', data: { userId: a.user.id, deviceId: config.deviceId, chatId: chat.id } }).catch(() => {});
              }
            }
            chatCounts.set(id, next);
            return loadIconBadge(async () => conversations, async () => chats);
          } finally { clearTimeout(timeout); controllers.delete(controller); controller.abort(); }
        });
        if (!disposed) await bridge.setBadge(total);
      } catch { /* Keep the last complete badge if any server is offline. */ }
      finally { refreshing = false; }
    };
    const message = async (a: Account, post: Post) => {
      const config = latest.current.settings[accountId(a)];
      const conv = inboxes.get(accountId(a))?.find(c => c.id === post.conversationId);
      if (!config || !conv) return;
      const flags = normalizeFeatures(a.features);
      if ((conv.kind === 'channel' && !flags.channels) || (conv.kind === 'dm' && !flags.directMessages)) return;
      let participant = false;
      if (post.threadRoot && config.preferences.mode === 'mentions' && conv.kind === 'channel') {
        try { const thread = await api.thread(a, conv.id, post.threadRoot); participant = [thread.root, ...thread.replies].some(p => p.user.id === a.user.id); } catch { /* A direct mention can still notify. */ }
      }
      if (disposed || !desktopMessageNotifies({ user: a.user, message: post, kind: conv.kind, preferences: config.preferences, archived: conv.archived, visible: !!visible(a, conv.id), participant })) return;
      await bridge.show({ accountId: accountId(a), title: config.preferences.contentPreviews === false ? 'Servant' : `${conv.title} · ${a.serverName}`, body: 'You have a new message', data: { userId: a.user.id, deviceId: config.deviceId, conversationId: conv.id, ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}), messageId: post.id } }).catch(() => {});
    };
    for (const a of accounts) {
      let cursor: string | undefined;
      let delay = 1000;
      const connect = async () => {
        if (disposed) return;
        const controller = new AbortController(); controllers.add(controller);
        try {
          await listen(a, event => {
            if (disposed) return;
            if (event.event === 'ready') { delay = 1000; void refresh(); }
            if (event.event === 'message.created') { void message(a, event.data); void refresh(); }
            if (event.event === 'messages.read' || event.event === 'conversation.read') void refresh();
          }, controller.signal, { cursor, onCursor: value => { cursor = value; } });
        } catch { /* Resume this server independently of the other connections. */ }
        finally { controllers.delete(controller); }
        if (!disposed) { const timer = setTimeout(() => { timers.delete(timer); void connect(); }, delay); timers.add(timer); delay = Math.min(30000, delay * 2); }
      };
      void connect();
    }
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 15000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { disposed = true; clearInterval(interval); timers.forEach(clearTimeout); controllers.forEach(controller => controller.abort()); window.removeEventListener('focus', focus); };
  }, [accounts, bridge, visible]);

  useEffect(() => {
    if (!bridge || !navigation?.key) return;
    const open = async (notice: DesktopNotice) => {
      const a = latest.current.accounts.find(a => accountId(a) === notice.accountId);
      if (!a) return;
      const config = latest.current.settings[accountId(a)] ?? await notificationApi.settings(a).catch(() => null);
      if (!config) return;
      const target = notificationAccountRoute(notice.data, [{ id: accountId(a), userId: a.user.id, deviceId: config.deviceId, features: normalizeFeatures(a.features) }]);
      if (!target) return;
      setPending(target);
      try { await switchAccount(target.accountId); } catch { setPending(null); setError('Could not open this server. Try again.'); }
    };
    const first = bridge.take(); if (first) void open(first);
    return bridge.onClick(notice => { void open(notice); });
  }, [bridge, navigation?.key, switchAccount]);
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
  const update = useCallback(async (prefs: Partial<NotificationPreferences>) => {
    const a = latest.current.account; if (!a) return;
    setBusy(true); setError(null);
    try { const result = await notificationApi.update(a, prefs); setSettings(current => ({ ...current, [accountId(a)]: result })); }
    catch { setError('Could not save notification settings. Try again.'); }
    finally { setBusy(false); }
  }, []);
  const enable = useCallback(async () => {}, []);
  return <Ctx.Provider value={bridge ? { supported: true, enabled: true, busy, error, preferences: account ? settings[accountId(account)]?.preferences ?? defaultNotifications : defaultNotifications, enable, update } : fallback}>{children}</Ctx.Provider>;
}
export function useNotifications(): NotificationState { return useContext(Ctx); }
