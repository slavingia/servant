// One live connection to the server for the whole app. Screens subscribe to the
// events they care about; the conversation list and unread badges live here.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, listen, relocate, ServerError, type Conversation, type LiveEvent } from "./server";
import { useSession } from "./session";

type Live = {
  conversations: Conversation[] | null;
  error: string | null;
  connected: boolean;
  refresh: () => Promise<void>;
  subscribe: (fn: (e: LiveEvent) => void) => () => void;
  // Called by an open conversation so its unread count stays at zero.
  setOpen: (id: string | null) => void;
  unread: { channels: number; messages: number };
};

const Ctx = createContext<Live | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const { account, setAccount, signOut } = useSession();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const subs = useRef(new Set<(e: LiveEvent) => void>());
  const open = useRef<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!account) return;
    try {
      const list = await api.conversations(account, setAccount);
      setConversations(list.map((c) => (c.id === open.current && AppState.currentState === "active" ? { ...c, unread: 0 } : c)));
      setError(null);
    } catch (e) {
      if (e instanceof ServerError && e.status === 401) return void signOut();
      // Keep what's on screen; only say the refresh failed.
      setError(e instanceof ServerError ? e.message : "Couldn't load conversations");
    }
  }, [account, setAccount, signOut]);

  // Many events can arrive at once (an agent reply streams); refetch the list at most every 400 ms.
  const softRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refresh();
    }, 400);
  }, [refresh]);

  useEffect(() => {
    if (!account) return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    let delay = 1000;
    const run = async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          await listen(
            account,
            (e) => {
              if (e.event === "ready") {
                setConnected(true);
                delay = 1000;
                refresh();
                return;
              }
              for (const fn of subs.current) fn(e);
              if (e.event === "message.created" || e.event === "conversation.updated" || e.event === "conversation.read") softRefresh();
            },
            ctrl.signal,
          );
        } catch (e) {
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
        setConnected(false);
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
      ctrl?.abort();
      sub.remove();
    };
  }, [account, refresh, softRefresh, signOut, setAccount]);

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
  const unread = useMemo(() => {
    const u = { channels: 0, messages: 0 };
    for (const c of shown ?? []) {
      if (!c.archived) u[c.kind === "channel" ? "channels" : "messages"] += c.unread;
    }
    return u;
  }, [shown]);

  const value = useMemo(
    () => ({ conversations: shown, error, connected, refresh, subscribe, setOpen, unread }),
    [shown, error, connected, refresh, subscribe, setOpen, unread],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive outside LiveProvider");
  return v;
}
