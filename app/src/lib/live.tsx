// One live connection to the server for the whole app. Screens subscribe to the
// events they care about; the conversation list and unread badges live here.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Context, type ReactNode } from "react";
import { AppState, Platform } from "react-native";
import { api, listen, relocate, ServerError, type Conversation, type LiveEvent, type Presence } from "./server";
import { useSession } from "./session";
import { useSessionExpiry } from "./session-expiry";
import { isSessionExpired, isSignedOut } from "./session-expiry-rules";
import { usePhotos } from "./photos";
import { agentUnreadTotal } from "./agent-unread";
import { reuseEqual } from "./reuse-equal";
import { setRowChange, withRowChanges, type RowChange, type RowChanges } from "./row-changes";

// What a screen can ask the connection to do. These never change while you stay signed in, so a
// screen that only listens or refreshes (an open conversation, a thread) is not re-rendered when
// the list, the badges or someone's presence change.
type LiveActions = {
  refresh: () => Promise<void>;
  subscribe: (fn: (e: LiveEvent) => void) => () => void;
  // Called by an open conversation so its unread count stays at zero.
  setOpen: (id: string | null) => void;
  // Re-count unread agent replies (after reading a chat, or with a fresh list).
  refreshAgent: (chats?: { unread?: number; archived?: boolean }[]) => void;
  // A conversation as the list has it right now, read once without following the list: an opening
  // conversation shows its title at once instead of waiting for its own copy.
  peek: (id: string) => Conversation | undefined;
  // Archive, restore or delete a conversation's row at once, before the server has answered; null takes the
  // change off again (when the server has answered, or refused). See lib/row-changes.ts.
  change: (id: string, change: RowChange | null) => void;
};
type LiveList = { conversations: Conversation[] | null; error: string | null; connected: boolean };
type LivePresence = { presence: Record<string, Presence>; connected: boolean };
type LiveUnread = { channels: number; messages: number; agent: number };

// One context per kind of change: each screen re-renders only for what it reads.
const ActionsCtx = createContext<LiveActions | null>(null);
const ListCtx = createContext<LiveList | null>(null);
const PresenceCtx = createContext<LivePresence | null>(null);
const UnreadCtx = createContext<LiveUnread | null>(null);

// How many live events have touched each conversation, and how many times the stream started over.
// A request made a moment before its screen was listening compares the number before and after: if
// it moved, something may have been missed and the screen looks again (lib/conversation-cache.ts).
const touched = new Map<string, number>();
let restarts = 0;
export const liveEventCount = (conversationId: string) => restarts * 1_000_000 + (touched.get(conversationId) ?? 0);
function countLiveEvent(e: LiveEvent) {
  if (e.event === "ready") { if (e.data.reset !== false) { restarts++; touched.clear(); } return; }
  const id = e.event === "message.created" || e.event === "message.updated" || e.event === "messages.read" ? e.data.conversationId
    : e.event === "conversation.updated" || e.event === "conversation.read" ? e.data.id : null;
  if (id) touched.set(id, (touched.get(id) ?? 0) + 1);
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { account, setAccount, signOut, learnDeepWork } = useSession();
  const { epoch: sessionEpoch } = useSessionExpiry();
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
    // The count is polled; the same count again changes nothing and re-renders nothing.
    const count = (total: number) => setAgentUnread(current => current.identity === id && current.count === total ? current : { identity: id, count: total });
    if (chats) return void count(agentUnreadTotal(chats));
    api.chats(account, setAccount)
      .then(list => { if (version === agentVersion.current && Array.isArray(list)) count(agentUnreadTotal(list)); })
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
      // The list is refetched after every message and on every visit. Keep what did not change, so
      // only the rows that did are drawn again (and nothing is when the list says the same thing).
      setConversations(current => reuseEqual(current, list.map((c) => (c.id === open.current && AppState.currentState === "active" ? { ...c, unread: 0 } : c))));
      setError(null);
    } catch (e) {
      if (version !== refreshVersion.current) return;
      if (isSignedOut(e)) return void signOut();
      if (isSessionExpired(e)) return; // the confirm screen is up; keep what's on screen
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
      setPresenceState(current => current.identity !== identity ? current : reuseEqual(current, {
        ...current, people: Object.fromEntries(Object.entries(current.people).map(([id, person]) => [id, { ...person, online: false }])),
      }));
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
          userId: person.id, online: person.online === true, lastSeenAt: person.lastSeenAt ?? null, ...(person.deepWork === true ? { deepWork: true } : {}),
        }]));
        for (const [id, value] of updates) snapshot[id] = value;
        setPresenceState(current => reuseEqual(current, { identity, people: snapshot }));
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
              countLiveEvent(e);
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
                // Your own presence carries your deep work switch: a flip on another device lands here (deep-work.ts).
                if (e.data.userId === account.user.id) learnDeepWork(e.data.deepWork === true);
                presenceSnapshot?.set(e.data.userId, e.data);
                setPresenceState(current => reuseEqual(current, { identity, people: {
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
          if (isSignedOut(e)) {
            stopped = true;
            signOut();
            return;
          }
          // Session ended: stop here. This effect runs again (sessionEpoch) once the code is accepted.
          if (isSessionExpired(e)) {
            stopped = true;
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
  }, [account, refresh, refreshAgent, softRefresh, signOut, setAccount, learnDeepWork, sessionEpoch]);

  const subscribe = useCallback((fn: (e: LiveEvent) => void) => {
    subs.current.add(fn);
    return () => void subs.current.delete(fn);
  }, []);

  const setOpen = useCallback((id: string | null) => {
    open.current = id;
    if (id) setConversations((list) => list && list.some(c => c.id === id && c.unread) ? list.map((c) => (c.id === id ? { ...c, unread: 0 } : c)) : list);
  }, []);

  const [changes, setChanges] = useState<RowChanges>(() => new Map());
  const change = useCallback((id: string, next: RowChange | null) => setChanges(waiting => setRowChange(waiting, id, next)), []);
  // After sign-out, never show the previous person's conversations.
  const shown = useMemo(() => account && conversations ? withRowChanges(conversations, changes) : null, [account, conversations, changes]);
  const latest = useRef(shown);
  useEffect(() => { latest.current = shown; }, [shown]);
  const peek = useCallback((id: string) => latest.current?.find(c => c.id === id), []);
  const presence = useMemo(() => presenceState.identity === identity ? presenceState.people : {}, [presenceState, identity]);
  const counted = useMemo(() => {
    const u = { channels: 0, messages: 0 };
    for (const c of shown ?? []) {
      if (!c.archived) u[c.kind === "channel" ? "channels" : "messages"] += c.unread;
    }
    return u;
  }, [shown]);
  const agent = agentUnread.identity === identity ? agentUnread.count : 0;
  // The badges are numbers: the same numbers from a new list are the same badges.
  const unread = useMemo(() => ({ channels: counted.channels, messages: counted.messages, agent }), [counted.channels, counted.messages, agent]);

  const actions = useMemo(() => ({ refresh, subscribe, setOpen, refreshAgent, peek, change }), [refresh, subscribe, setOpen, refreshAgent, peek, change]);
  const list = useMemo(() => ({ conversations: shown, error, connected }), [shown, error, connected]);
  const people = useMemo(() => ({ presence, connected }), [presence, connected]);
  return (
    <ActionsCtx.Provider value={actions}><ListCtx.Provider value={list}><PresenceCtx.Provider value={people}><UnreadCtx.Provider value={unread}>
      {children}
    </UnreadCtx.Provider></PresenceCtx.Provider></ListCtx.Provider></ActionsCtx.Provider>
  );
}

function useLivePart<T>(context: Context<T | null>, name: string): T {
  const value = useContext(context);
  if (!value) throw new Error(`${name} outside LiveProvider`);
  return value;
}

/** Refresh, listen and mark open. Never causes a re-render: use it where a screen reads nothing else from the connection. */
export const useLiveActions = () => useLivePart(ActionsCtx, "useLiveActions");
/** The conversation list, its error and whether the connection is up. */
export const useLiveList = () => useLivePart(ListCtx, "useLiveList");
/** Who is online or in deep work. */
export const useLivePresence = () => useLivePart(PresenceCtx, "useLivePresence");
/** The unread badges. */
export const useLiveUnread = () => useLivePart(UnreadCtx, "useLiveUnread");

