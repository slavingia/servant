// One live connection to the server for the whole app. Screens subscribe to the
// events they care about; the conversation list and unread badges live here.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Platform } from "react-native";
import { api, listen, relocate, ServerError, type Conversation, type LiveEvent, type Presence } from "./server";
import { useSession } from "./session";
import { usePhotos } from "./photos";
import { agentUnreadTotal } from "./agent-unread";

type Live = {
  conversations: Conversation[] | null;
  error: string | null;
  connected: boolean;
  presence: Record<string, Presence>;
  refresh: () => Promise<void>;
  subscribe: (fn: (e: LiveEvent) => void) => () => void;
  // Called by an open conversation so its unread count stays at zero.
  setOpen: (id: string | null) => void;
  unread: { channels: number; messages: number; agent: number };
  // Re-count unread agent replies (after reading a chat, or with a fresh list).
  refreshAgent: (chats?: { unread?: number; archived?: boolean }[]) => void;
};

const Ctx = createContext<Live | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const { account, setAccount, signOut } = useSession();
  const learnPhotosNow = usePhotos()?.learn;
  const learnRef = useRef(learnPhotosNow);
  useEffect(() => { learnRef.current = learnPhotosNow; }, [learnPhotosNow]);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const identity = account ? JSON.stringify([account.serverKey, account.token, account.user.id]) : "";
  const [presenceState, setPresenceState] = useState<{ identity: string; people: Record<string, Presence> }>({ identity: "", people: {} });
  const subs = useRef(new Set<(e: LiveEvent) => void>());
  const open = useRef<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshVersion = useRef(0);
  const resume = useRef<{ identity: string; cursor?: string } | null>(null);

  // Agent replies have no live event; poll your chats for their unread count.
  const [agentUnread, setAgentUnread] = useState({ identity: "", count: 0 });
  const agentVersion = useRef(0);
  const refreshAgent = useCallback((chats?: { unread?: number; archived?: boolean }[]) => {
    if (!account?.serverKey) return;
    const version = ++agentVersion.current;
    const id = JSON.stringify([account.serverKey, account.token, account.user.id]);
    if (chats) return void setAgentUnread({ identity: id, count: agentUnreadTotal(chats) });
    api.chats(account, setAccount)
      .then(list => { if (version === agentVersion.current && Array.isArray(list)) setAgentUnread({ identity: id, count: agentUnreadTotal(list) }); })
      .catch(() => { /* Keep the last count; a failed refresh never clears it. */ });
  }, [account, setAccount]);
  useEffect(() => {
    if (!account?.serverKey) return;
    const version = agentVersion;
    const first = setTimeout(() => refreshAgent(), 0);
    const timer = setInterval(() => { if (AppState.currentState === "active") refreshAgent(); }, 15000);
    const state = AppState.addEventListener("change", s => { if (s === "active") refreshAgent(); });
    return () => { clearTimeout(first); clearInterval(timer); state.remove(); version.current++; };
  }, [account, refreshAgent]);

  const refresh = useCallback(async () => {
    if (!account?.serverKey) return;
    const version = ++refreshVersion.current;
    try {
      const list = await api.conversations(account, setAccount);
      if (version !== refreshVersion.current) return;
      setConversations(list.map((c) => (c.id === open.current && AppState.currentState === "active" ? { ...c, unread: 0 } : c)));
      setError(null);
    } catch (e) {
      if (version !== refreshVersion.current) return;
      if (e instanceof ServerError && e.status === 401) return void signOut();
      // Keep what's on screen; only say the refresh failed.
      setError(e instanceof ServerError ? e.message : "Couldn't load conversations");
    }
  }, [account, setAccount, signOut]);

  useEffect(() => () => {
    refreshVersion.current++;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
  }, [account]);

  // Many events can arrive at once (an agent reply streams); refetch the list at most every 400 ms.
  const softRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refresh();
    }, 400);
  }, [refresh]);

  // Presence follows foreground use, independently of the stream (which may
  // remain connected while a phone is locked). Each app instance owns a lease.
  useEffect(() => {
    if (!account?.serverKey) return;
    const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let active = AppState.currentState === "active";
    let blurred = false;
    let stopped = false;
    let sending = false;
    let pending = false;
    const pulse = async () => {
      pending = true;
      if (sending) return;
      sending = true;
      while (pending) {
        pending = false;
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 10000);
        try { await api.presence(account, sessionId, !stopped && active && !blurred, ctrl.signal); }
        catch { /* The lease expires if the device cannot reach the server. */ }
        finally { clearTimeout(timeout); }
      }
      sending = false;
    };
    void pulse();
    const timer = setInterval(() => { if (active && !blurred) void pulse(); }, 25000);
    const state = AppState.addEventListener("change", value => { active = value === "active"; void pulse(); });
    const blur = Platform.OS === "android" ? AppState.addEventListener("blur", () => { blurred = true; void pulse(); }) : null;
    const focus = Platform.OS === "android" ? AppState.addEventListener("focus", () => { blurred = false; void pulse(); }) : null;
    return () => {
      stopped = true;
      clearInterval(timer);
      state.remove(); blur?.remove(); focus?.remove();
      void pulse();
    };
  }, [account]);

  useEffect(() => {
    if (!account?.serverKey) { resume.current = null; return; }
    // A tunnel URL can change without changing the server/account. A cursor is
    // only valid for this pinned server identity and authenticated device.
    const identity = JSON.stringify([account.serverKey, account.token, account.user.id]);
    if (resume.current?.identity !== identity) resume.current = { identity };
    const connection = resume.current;
    let stopped = false;
    let ctrl: AbortController | null = null;
    let delay = 1000;
    const disconnected = () => {
      setConnected(false);
      setPresenceState(current => current.identity !== identity ? current : {
        ...current, people: Object.fromEntries(Object.entries(current.people).map(([id, person]) => [id, { ...person, online: false }])),
      });
    };
    let presenceSnapshot: Map<string, Presence> | null = null;
    const refreshPresence = async () => {
      const updates = new Map<string, Presence>();
      presenceSnapshot = updates;
      try {
        const { people } = await api.people(account);
        learnRef.current?.(people);
        if (stopped || presenceSnapshot !== updates) return;
        const snapshot = Object.fromEntries(people.map(person => [person.id, {
          userId: person.id, online: person.online === true, lastSeenAt: person.lastSeenAt ?? null,
        }]));
        for (const [id, value] of updates) snapshot[id] = value;
        setPresenceState({ identity, people: snapshot });
      } catch { /* Member/conversation snapshots remain available offline. */ }
      finally { if (presenceSnapshot === updates) presenceSnapshot = null; }
    };
    const run = async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          await listen(
            account,
            (e) => {
              if (stopped) return;
              if (e.event === "checkpoint") return;
              if (e.event === "ready") {
                setConnected(true);
                delay = 1000;
                refresh();
                refreshAgent();
                void refreshPresence();
                for (const fn of subs.current) fn(e);
                return;
              }
              if (e.event === "person.updated") learnRef.current?.([e.data]);
              if (e.event === "presence.updated") {
                presenceSnapshot?.set(e.data.userId, e.data);
                setPresenceState(current => ({ identity, people: {
                  ...(current.identity === identity ? current.people : {}), [e.data.userId]: e.data,
                } }));
              }
              for (const fn of subs.current) fn(e);
              if (e.event === "message.created" || e.event === "conversation.updated" || e.event === "conversation.read" || e.event === "messages.read") softRefresh();
            },
            ctrl.signal,
            { cursor: connection.cursor, onCursor: cursor => { if (!stopped) connection.cursor = cursor; } },
          );
          if (!stopped) disconnected();
        } catch (e) {
          if (stopped) return;
          disconnected();
          if (e instanceof ServerError && e.status === 401) {
            stopped = true;
            signOut();
            return;
          }
          // Server restarted on a new tunnel address: switch to it (this effect restarts).
          const moved = await relocate(account);
          if (moved && !stopped) {
            stopped = true;
            setAccount(moved);
            return;
          }
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
      }
    };
    run();
    // Phones drop long connections in the background; reconnect when the app comes back.
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        ctrl?.abort();
        delay = 250;
      }
    });
    return () => {
      stopped = true;
      disconnected();
      ctrl?.abort();
      sub.remove();
    };
  }, [account, refresh, refreshAgent, softRefresh, signOut, setAccount]);

  const subscribe = useCallback((fn: (e: LiveEvent) => void) => {
    subs.current.add(fn);
    return () => void subs.current.delete(fn);
  }, []);

  const setOpen = useCallback((id: string | null) => {
    open.current = id;
    if (id) setConversations((list) => list && list.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
  }, []);

  // After sign-out, never show the previous person's conversations.
  const shown = account ? conversations : null;
  const presence = useMemo(() => presenceState.identity === identity ? presenceState.people : {}, [presenceState, identity]);
  const unread = useMemo(() => {
    const u = { channels: 0, messages: 0, agent: agentUnread.identity === identity ? agentUnread.count : 0 };
    for (const c of shown ?? []) {
      if (!c.archived) u[c.kind === "channel" ? "channels" : "messages"] += c.unread;
    }
    return u;
  }, [shown, agentUnread, identity]);

  const value = useMemo(
    () => ({ conversations: shown, error, connected, presence, refresh, subscribe, setOpen, unread, refreshAgent }),
    [shown, error, connected, presence, refresh, subscribe, setOpen, unread, refreshAgent],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive outside LiveProvider");
  return v;
}
