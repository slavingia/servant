import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Platform, Pressable, StyleSheet, Switch, Text, useWindowDimensions, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { randomUUID } from "expo-crypto";
import { ConversationKeyboardView } from "../../components/ConversationKeyboardView";
import { Avatar, Composer, when } from "../../components/Messaging";
import { Attachments, PendingAttachments } from "../../components/Attachments";
import { MediaGalleryProvider } from "../../components/MediaGallery";
import { mediaFromMessages } from "../../lib/media";
import { Button } from "../../components/Button";
import { MessageText } from "../../components/MessageText";
import { AgentApprovalCard } from "../../components/AgentApprovalCard";
import { activeAgentTurn, agentTurnLabel, canSteer, liveAgentLine, queuedBelow, splitTurns, type AgentTurn } from "../../lib/agent-turns";
import { LiveStatus } from "../../components/LiveStatus";
import { bufferAgentReply } from "../../lib/agent-events";
import { messageDeviceLabel } from "../../lib/message-device";
import { api, sendMessage, ServerError, type Chat, type Message, type Upload } from "../../lib/server";
import { useSession } from "../../lib/session";
import { forwardTitle, parseForward, type ForwardCard } from "../../lib/forward";
import { AppIcon } from "../../components/AppIcon";
import { radius, space, typography, useTheme, createThemedStyles } from "../../lib/theme";
import { useWideLayout } from "../../lib/layout";

type Row = Message & { waitingForAgent?: boolean; queuedTurn?: AgentTurn; agentWorking?: boolean; pending?: boolean; failed?: boolean; localId?: string; uploads?: Upload[]; forwardPreview?: ForwardCard | null };

export default function ChatScreen() {
  const { id, readOnly } = useLocalSearchParams<{ id: string; readOnly?: string }>();
  const { account } = useSession();
  const key = `${account?.serverUrl ?? ""}:${account?.token ?? ""}:${id}`;
  // Someone else's shared chat opens read-only: no composer, turns or controls.
  if (readOnly === "1") return <SharedChatView key={key} />;
  // A different conversation or account starts with fresh draft and send state.
  return <ChatConversation key={key} />;
}

function SharedChatView() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { id, title, author } = useLocalSearchParams<{ id: string; title?: string; author?: string }>();
  const { account } = useSession();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTitle, setShowTitle] = useState(false);
  const load = useCallback(async () => {
    if (!account || !id) return;
    try {
      const [history, info] = await Promise.all([api.messages(account, id), api.chat(account, id)]);
      setMessages(history); setChat(info); setError(null);
    } catch (e) {
      setMessages(current => current ?? []);
      setError(e instanceof ServerError ? e.message : "Check your connection and try again.");
    }
  }, [account, id]);
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);
  const authorName = chat?.author?.name || author || "Someone";
  const media = useMemo(() => mediaFromMessages(messages ?? [], authorName, "Agent"), [messages, authorName]);
  if (!account) return null;
  const data = [...(messages ?? [])].reverse();
  return (
    <MediaGalleryProvider key={id} scope={{ kind: "chat", id }} items={media}>
    <View style={styles.root}>
      <Stack.Screen options={{ title: chat?.title || title || "Conversation", headerTitle: titleButton(showTitle, setShowTitle), ...filesHeader(String(id), chat?.title || title || "Conversation", colors.blue) }} />
      {showTitle ? <FullTitle title={chat?.title || title || "Conversation"} onClose={() => setShowTitle(false)} /> : null}
      <View style={styles.sharedBanner}>
        <Text style={styles.turnLabel}>{authorName}'s conversation</Text>
        <Text style={styles.turnDetail}>{chat?.shared === false
          ? "Private. You can see it because you're an admin."
          : `Shared with ${account.serverName}. Read only: give feedback in a channel or DM.`}</Text>
      </View>
      {messages === null ? <ActivityIndicator style={{ flex: 1 }} color={colors.blue} /> : (
        <FlatList inverted data={data} keyExtractor={(m) => m.id} contentContainerStyle={[styles.list, styles.readOnlyList]}
          ListFooterComponent={messages.length === 0 ? <View style={styles.empty}>
            <Text accessibilityRole="header" style={styles.emptyTitle}>{error ? "Couldn't load this chat" : "No messages yet"}</Text>
            {error ? <><Text accessibilityRole="alert" style={styles.emptyBody}>{error}</Text>
              <Button label="Try again" kind="secondary" onPress={() => { setMessages(null); void load(); }} style={styles.retry} /></> : null}
          </View> : undefined}
          renderItem={({ item }) => {
            const theirs = item.role === "user";
            const timestamp = typeof item.at === "number" ? item.at : item.at ? new Date(item.at).getTime() : NaN;
            return <View accessibilityLabel={theirs ? `${authorName}'s message` : "Agent response"} style={styles.message}>
              <Avatar name={theirs ? authorName : "Agent"} agent={!theirs} userId={theirs ? chat?.author?.id : undefined} size={34} tapToMessage />
              <View style={styles.messageCopy}>
                <View style={styles.messageMeta}>
                  <Text style={styles.author}>{theirs ? authorName : "Agent"}</Text>
                  {!theirs ? <Text style={styles.agentTag}>Agent</Text> : null}
                  {Number.isFinite(timestamp) ? <Text style={styles.time}>{when(timestamp)}</Text> : null}
                </View>
                {theirs ? <ForwardedText item={item} /> : item.text ? <ReplyText text={item.text} /> : null}
                {item.attachments?.length ? <Attachments files={item.attachments} /> : null}
              </View>
            </View>;
          }} />
      )}
    </View>
    </MediaGalleryProvider>
  );
}

// Long titles get cut off in the header: tap the title to read all of it.
function titleButton(open: boolean, setOpen: (next: boolean) => void) {
  const render = ({ children }: { children: string }) => <HeaderTitle title={children} open={open} onPress={() => setOpen(!open)} />;
  render.displayName = "ChatHeaderTitle";
  return render;
}

function HeaderTitle({ title, open, onPress }: { title: string; open: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = useWideLayout();
  const size = wide ? { fontSize: 16, fontWeight: "700" as const } : { fontSize: typography.bodyStrong.fontSize, fontWeight: typography.bodyStrong.fontWeight };
  // Leave room for Back and Files on a phone.
  const maxWidth = wide ? undefined : Math.max(120, width - 150);
  return <Pressable testID="chat-title" accessibilityRole="button" accessibilityLabel={title}
    accessibilityHint={open ? "Hides the full title" : "Shows the full title"} accessibilityState={{ expanded: open }}
    onPress={onPress} hitSlop={8} style={{ maxWidth, flexShrink: 1, minHeight: 44, justifyContent: "center" }}>
    <Text numberOfLines={1} style={{ ...size, color: colors.ink }}>{title}</Text>
  </Pressable>;
}

function FullTitle({ title, onClose }: { title: string; onClose: () => void }) {
  const styles = useStyles();
  return <View testID="full-title" style={styles.fullTitle}>
    <Text selectable accessibilityRole="header" style={styles.fullTitleText}>{title}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Hide full title" hitSlop={12} onPress={onClose} style={styles.remove}>
      <Text style={styles.removeText}>✕</Text>
    </Pressable>
  </View>;
}

// Your own chat: shared with the server by default; this switch turns it off.
// Files: every photo, video and file in this agent chat.
function filesHeader(id: string, title: string, tint: string) {
  const open = () => router.push({ pathname: "/files", params: { kind: "chat", id, title } });
  return Platform.OS === "ios"
    ? { unstable_headerRightItems: () => [{ type: "button" as const, label: "Files", tintColor: tint, labelStyle: { color: tint, fontWeight: "600" as const }, hidesSharedBackground: true, onPress: open }] }
    : { headerRight: () => <Pressable testID="open-files" accessibilityRole="button" onPress={open} style={{ minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "flex-end", paddingRight: Platform.OS === "web" ? space.side : 0 }}>
        <Text style={{ ...typography.label, color: tint }}>Files</Text>
      </Pressable> };
}

// Vibe coding: the latest prototype opens in the in-app browser.
export function openPreview(url: string) {
  // A fresh query string each time skips cached copies of the last publish.
  const fresh = `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
  if (Platform.OS === "web") { window.open(fresh, "_blank", "noopener"); return; }
  void WebBrowser.openBrowserAsync(fresh, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET, dismissButtonStyle: "done" }).catch(() => {});
}

function VibeBar({ id }: { id: string }) {
  const styles = useStyles();
  const { account } = useSession();
  const [chat, setChat] = useState<{ previewUrl?: string; mode?: string } | null>(null);
  useEffect(() => {
    if (!account || !id) return;
    let live = true;
    api.chat(account, id).then(c => { if (live) setChat(c); }).catch(() => {});
    return () => { live = false; };
  }, [account, id]);
  if (chat?.mode !== "vibe" || !chat.previewUrl) return null;
  return <View style={styles.vibeBar}>
    <View style={styles.turnCopy}>
      <Text style={styles.turnLabel}>Vibe coding</Text>
      <Text style={styles.turnDetail}>Describe what you want. Each change publishes a new preview.</Text>
    </View>
    <Pressable testID="open-preview" accessibilityRole="button" accessibilityLabel="Open preview" onPress={() => openPreview(chat.previewUrl!)} style={({ pressed }) => [styles.previewButton, pressed && { opacity: 0.8 }]}>
      <Text style={styles.previewButtonText}>Preview</Text>
    </Pressable>
  </View>;
}

// A "PREVIEW: <url>" line in a reply becomes a button.
function ReplyText({ text, failed }: { text: string; failed?: boolean }) {
  const styles = useStyles();
  const match = text.match(/(?:^|\n)PREVIEW:\s*(https:\/\/\S+)\s*$/);
  if (!match) return <MessageText text={text} failed={failed} />;
  const body = text.slice(0, match.index).trimEnd();
  return <View>
    {body ? <MessageText text={body} failed={failed} /> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Open preview" onPress={() => openPreview(match[1]!)} style={({ pressed }) => [styles.previewButton, styles.previewInline, pressed && { opacity: 0.8 }]}>
      <Text style={styles.previewButtonText}>Open preview</Text>
    </Pressable>
  </View>;
}

function ShareToggle({ id }: { id: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [shared, setShared] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!account || !id) return;
    let live = true;
    api.chat(account, id).then(chat => { if (live) setShared(chat.shared !== false); }).catch(() => { if (live) setShared(true); });
    return () => { live = false; };
  }, [account, id]);
  if (!account || shared === null) return null;
  const change = async (next: boolean) => {
    setShared(next); setSaving(true); setError(null);
    try { setShared((await api.setChatShared(account, id, next)).shared !== false); }
    catch (e) { setShared(!next); setError(e instanceof ServerError ? e.message : "Couldn't change sharing"); }
    finally { setSaving(false); }
  };
  return <View style={styles.shareRow}>
    <View style={styles.turnCopy}>
      <Text style={styles.turnLabel}>{shared ? `Shared with ${account.serverName}` : "Private"}</Text>
      <Text style={styles.turnDetail}>{shared ? "Others can read this chat to give feedback on your prompts." : "Only you and admins can see this chat."}</Text>
      {error ? <Text accessibilityRole="alert" style={styles.shareError}>{error}</Text> : null}
    </View>
    <Switch accessibilityLabel={`Share this chat with ${account.serverName}`} value={shared} disabled={saving}
      onValueChange={next => { void change(next); }} trackColor={{ true: colors.blue, false: colors.borderStrong }} thumbColor="#FFFFFF" {...(Platform.OS === "web" ? { activeThumbColor: "#FFFFFF" } : {})} />
  </View>;
}

function ChatConversation() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { id, title, compose, forward, forwardAuthor, forwardWhere, forwardText, forwardFiles } = useLocalSearchParams<{ id: string; title?: string; compose?: string; forward?: string; forwardAuthor?: string; forwardWhere?: string; forwardText?: string; forwardFiles?: string }>();
  const { account, setAccount } = useSession();
  // A message brought here with "Ask the agent", until it's sent or removed.
  const [pendingForward, setPendingForward] = useState<string | null>(forward || null);
  const forwardFileCount = Number(forwardFiles) || 0;
  const [messages, setMessages] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [turn, setTurn] = useState<AgentTurn | null>(null);
  // Messages sent while the agent works wait here, oldest first.
  const [waiting, setWaiting] = useState<AgentTurn[]>([]);
  const [steering, setSteering] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [heading, setHeading] = useState(title && title !== "New chat" ? title : "New chat");
  const [showTitle, setShowTitle] = useState(false);
  // Links, pushes and the sidebar may open a chat without its title: read it from the server.
  useEffect(() => {
    if (!account || !id) return;
    let live = true;
    api.chat(account, id).then(c => { if (live && c.title && c.title !== "New chat") setHeading(h => h === "New chat" ? c.title : h); }).catch(() => {});
    return () => { live = false; };
  }, [account, id]);
  const list = useRef<FlatList<Row>>(null);
  const abort = useRef<AbortController | null>(null);
  const currentLoad = useRef<object | null>(null);
  const mounted = useRef(true);
  const lastTurnUpdate = useRef(0);
  // Everything on screen has been seen: clear this conversation's unread count
  // whenever the visible replies change while the app is in front.
  const lastReadReply = useRef<string | null>(null);
  const newestReply = messages?.findLast(m => m.role === "assistant" && !m.pending && !m.localId)?.id ?? null;
  useEffect(() => {
    if (!account || !id || !newestReply || newestReply === lastReadReply.current || AppState.currentState !== "active") return;
    lastReadReply.current = newestReply;
    api.readChat(account, id).catch(() => { lastReadReply.current = null; });
  }, [account, id, newestReply]);
  const delivery = useRef<{ text: string; uploads: Upload[]; id: string; forward?: string | null } | null>(null);

  const load = useCallback(() => {
    if (!account || !id) return;
    const request = {};
    currentLoad.current = request;
    return Promise.all([api.messages(account, id), api.agentTurns(account, id).catch(e => {
      if (e instanceof ServerError && e.status === 404) return [];
      throw e;
    })]).then(([history, turns]) => {
      if (request === currentLoad.current) {
        setMessages(history);
        const split = splitTurns(turns);
        setTurn(split.current); setWaiting(split.waiting);
        lastTurnUpdate.current = Math.max(0, ...turns.map(t => t.updatedAt));
        setLoadError(null);
      }
    }).catch(e => {
      if (request !== currentLoad.current) return;
      setMessages([]);
      setLoadError(e instanceof ServerError ? e.message : "Check your connection and try again.");
    }).finally(() => {
      if (request === currentLoad.current) {
        setBusy(false);
        setStatus(null);
      }
    });
  }, [account, id]);

  useEffect(() => {
    mounted.current = true;
    void load();
    let active = true;
    let refreshing = false;
    let foregroundRefresh = false;
    const refresh = async (foreground = false) => {
      foregroundRefresh ||= foreground;
      if (!account || !id || refreshing || AppState.currentState !== 'active') return;
      refreshing = true;
      try {
        const turns = await api.agentTurns(account, id);
        if (!active) return;
        const { current: latest, waiting: queued } = splitTurns(turns);
        const newest = Math.max(0, ...turns.map(t => t.updatedAt));
        setTurn(current => current && (!latest || current.updatedAt > latest.updatedAt) ? current : latest);
        setWaiting(queued);
        if ((foregroundRefresh || newest !== lastTurnUpdate.current) && !abort.current) {
          const history = await api.messages(account, id);
          if (active && !abort.current) {
            setMessages(history); setLoadError(null); setSendError(null);
            lastTurnUpdate.current = newest;
            foregroundRefresh = false;
          }
        }
      } catch { /* The visible history remains available; foreground retries catch up. */ }
      finally { refreshing = false; }
    };
    const timer = setInterval(() => { void refresh(); }, 2500);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        // The Mac owns the turn. A suspended phone stream is only a viewer.
        abort.current?.abort();
        abort.current = null;
        lastTurnUpdate.current = -1;
        setBusy(false);
        void refresh(true);
      }
    });
    return () => {
      active = false;
      mounted.current = false;
      currentLoad.current = null;
      abort.current?.abort();
      clearInterval(timer);
      subscription.remove();
    };
  }, [load, account, id]);

  const media = useMemo(() => mediaFromMessages(messages ?? [], account?.user.name ?? "You", "Agent"), [messages, account?.user.name]);
  if (!account) return null;

  const refreshTurns = async () => {
    try {
      const split = splitTurns(await api.agentTurns(account, String(id)));
      if (mounted.current) { setTurn(split.current); setWaiting(split.waiting); }
    } catch { /* the 2.5s refresh catches up */ }
  };

  // Sent while the agent is working: the server queues it behind the current
  // reply. We don't follow its stream here; the waiting row shows it until it
  // runs, then the regular refresh shows the reply.
  const queue = async (body: string, attachments: Upload[]) => {
    // Same draft retried after an uncertain send reuses its key: no duplicate.
    const previous = delivery.current;
    if (!previous || previous.text !== body || previous.uploads.length !== attachments.length || previous.forward !== pendingForward) {
      delivery.current = { text: body, uploads: attachments, id: randomUUID(), forward: pendingForward };
    }
    const forwarding = pendingForward ?? undefined;
    const requestId = delivery.current!.id;
    const controller = new AbortController();
    let queued = false;
    try {
      await sendMessage(account, String(id), body, e => {
        if (e.type === 'turn' && e.turn.status === 'queued' && !queued) {
          queued = true;
          setWaiting(w => w.some(t => t.id === e.turn.id) ? w : [...w, e.turn]);
          controller.abort();
        }
      }, controller.signal, setAccount, attachments, requestId, forwarding);
    } catch (e) {
      if (!queued) {
        setSendError(e instanceof ServerError ? e.message : "Couldn't queue your message. Your draft is saved; try again.");
        return false;
      }
    }
    setSendError(null);
    delivery.current = null;
    if (queued && forwarding) setPendingForward(null);
    void refreshTurns();
    return queued;
  };

  // The composer frees itself once the Mac accepts the message (or it fails
  // before that); the reply keeps streaming here without holding the box.
  const send = (text: string, attachments: Upload[] = []) => new Promise<boolean>(resolve => {
    let settled = false;
    const settle = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
    void deliver(text, attachments, () => settle(true)).then(settle, () => settle(false));
  });

  const deliver = async (text: string, attachments: Upload[], onAccepted: () => void) => {
    const body = text.trim();
    if ((!body && !attachments.length && !pendingForward) || messages === null || loadError) return false;
    if (busy || activeAgentTurn(turn)) return await queue(body, attachments);
    setBusy(true);
    setStatus(null);
    setSendError(null);
    setActionError(null);
    // Retain the key after an uncertain delivery; an unchanged draft can be
    // retried without starting another Mac-owned turn.
    const previous = delivery.current;
    if (!previous || previous.text !== body || previous.uploads.length !== attachments.length || previous.forward !== pendingForward
      || previous.uploads.some((upload, i) => upload.name !== attachments[i]?.name || upload.data !== attachments[i]?.data)) {
      delivery.current = { text: body, uploads: attachments, id: randomUUID(), forward: pendingForward };
    }
    const forwarding = pendingForward ?? undefined;
    const forwardPreview: ForwardCard | null = forwarding ? { author: forwardAuthor || "Someone", where: forwardWhere || "", when: "", quote: forwardText || "" } : null;
    const requestId = delivery.current!.id;
    const stamp = Date.now();
    const mineKey = `u${stamp}`;
    const replyKey = `a${stamp}`;
    const mine: Row = { id: mineKey, localId: mineKey, role: "user", text: body, at: stamp, pending: true, uploads: attachments, forwardPreview };
    const reply: Row = { id: replyKey, localId: replyKey, role: "assistant", text: "", pending: true, at: stamp };
    setMessages((m) => [...(m ?? []), mine, reply]);
    const controller = new AbortController();
    abort.current = controller;
    const isCurrent = () => abort.current === controller && !controller.signal.aborted;
    const update = (fn: (r: Row) => Row) => {
      if (isCurrent()) setMessages((m) => (m ?? []).map((r) => (r.localId === replyKey ? fn(r) : r)));
    };
    let failed = false;
    let accepted = false;
    let canonicalMineId: string | undefined;
    let canonicalReplyId: string | undefined;
    let responseSeen = false;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      onAccepted();
      if (heading === "New chat") setHeading(body ? body.replace(/\s+/g, " ").slice(0, 60) : forwarding ? forwardTitle(forwardText || "") : (attachments[0]?.name || "New chat").replace(/\s+/g, " ").slice(0, 60));
      if (forwarding) setPendingForward(null);
      setMessages((m) => (m ?? []).map((r) => r.localId === mineKey ? { ...r, pending: false } : r));
    };
    try {
      await sendMessage(
        account,
        String(id),
        body,
        bufferAgentReply((e) => {
          if (!isCurrent()) return;
          if (e.type === 'turn') {
            setTurn(e.turn);
            if (e.turn.accepted) accept();
          } else if (e.type === 'approval') {
            setTurn(current => current ? { ...current, approval: e.approval, status: 'waiting_for_approval' } : current);
          } else if (e.type === "sent") {
            accept();
            canonicalMineId = e.message.id;
            setMessages((m) => (m ?? []).map((r) => r.localId === mineKey ? { ...e.message, localId: mineKey } : r));
          } else if (e.type === "message") {
            accept();
            canonicalReplyId = e.id ?? canonicalReplyId;
            responseSeen ||= !!e.text || !!e.attachments?.length;
            update((r) => ({ ...r, id: e.id ?? r.id, at: e.at ?? r.at, text: e.text, attachments: e.attachments ?? r.attachments }));
          }
          else if (e.type === "status") setStatus(e.text);
          else if (e.type === "error") {
            failed = true;
            setSendError(e.message);
            update((r) => ({ ...r, pending: false, failed: true }));
          }
          else if (e.type === "done") update((r) => ({ ...r, pending: false }));
        }),
        controller.signal,
        setAccount,
        attachments,
        requestId,
        forwarding,
      );
      if (!failed && isCurrent() && !accepted) {
        failed = true;
        setSendError("Couldn't confirm this message was sent. Your draft is saved; try again.");
      }
      if (!failed && isCurrent()) {
        // Replace temporary upload previews with authenticated media records.
        // A lagging history response must not erase the reply just received.
        try {
          const history = await api.messages(account, String(id));
          const userIndex = canonicalMineId ? history.findIndex(message => message.id === canonicalMineId) : messages.length;
          const hasUser = canonicalMineId ? userIndex >= 0 : history.length > messages.length;
          const hasReply = !responseSeen || (canonicalReplyId ? history.some(message => message.id === canonicalReplyId)
            : history.slice(userIndex + 1).some(message => message.role === "assistant"));
          if (isCurrent() && hasUser && hasReply) setMessages(history);
        } catch { /* The completed reply remains visible if history refresh fails. */ }
      }
    } catch (e) {
      failed = true;
      if (isCurrent()) setSendError(e instanceof ServerError ? e.message : accepted ? "Your message was sent. Reconnecting to the reply saved on your Mac…" : "Couldn't confirm delivery. Your draft is saved; check the conversation before trying again.");
      update((r) => ({ ...r, pending: false, failed: true }));
    } finally {
      if (isCurrent()) {
        setMessages((m) => (m ?? []).filter((r) => {
          if (failed && !accepted && (r.localId === mineKey || r.localId === replyKey)) return false;
          return r.localId !== replyKey || !!r.text || !!r.attachments?.length;
        }).map((r) => r.localId === mineKey || r.localId === replyKey ? { ...r, pending: false } : r));
        setBusy(false);
        setStatus(null);
        abort.current = null;
        lastTurnUpdate.current = -1;
        void refreshTurns();
      }
    }
    // An accepted message stays sent even if Hermes cannot finish its reply.
    if (accepted) delivery.current = null;
    return accepted || !failed;
  };

  const steer = async (target: AgentTurn) => {
    if (steering) return;
    setSteering(target.id); setActionError(null);
    // Optimistic: one tap and it's on its way.
    setWaiting(w => w.map(t => t.id === target.id ? { ...t, steerRequested: true } : t));
    try { await api.steerAgent(account, String(id), target.id); }
    catch (e) {
      if (mounted.current) {
        setWaiting(w => w.map(t => t.id === target.id ? { ...t, steerRequested: false } : t));
        setActionError(e instanceof Error ? e.message : "Couldn't add it now. It'll send next");
      }
    } finally { if (mounted.current) { setSteering(null); void refreshTurns(); } }
  };

  const unqueue = async (target: AgentTurn) => {
    setWaiting(w => w.filter(t => t.id !== target.id));
    try { await api.stopAgent(account, String(id), target.id); } catch { /* refresh restores it */ }
    void refreshTurns();
  };

  const answer = async (choice: 'once' | 'deny') => {
    if (!turn?.approval || actionBusy) return;
    setActionBusy(true); setActionError(null);
    try {
      await api.answerApproval(account, String(id), turn.id, turn.approval.id, choice);
      await refreshTurns();
    } catch (e) { if (mounted.current) setActionError(e instanceof Error ? e.message : 'Could not send your decision. Try again.'); }
    finally { if (mounted.current) setActionBusy(false); }
  };
  const stop = async () => {
    if (!turn?.canStop || actionBusy) return;
    setActionBusy(true); setActionError(null);
    try {
      await api.stopAgent(account, String(id), turn.id);
      await refreshTurns();
    } catch (e) { if (mounted.current) setActionError(e instanceof Error ? e.message : 'Could not stop the agent. Try again.'); }
    finally { if (mounted.current) setActionBusy(false); }
  };

  // A brand-new chat whose first message hasn't reached the agent yet (it's
  // busy elsewhere) has no history. Show that message as sent, not a blank
  // "What can I help with?", while it waits its turn.
  const unstarted = messages?.length === 0 && !loadError
    ? (turn && activeAgentTurn(turn) && !turn.accepted ? turn : waiting[0] ?? null) : null;
  const firstRow: Row | null = unstarted ? { id: `waiting_${unstarted.id}`, role: "user", text: unstarted.text || "Attachment", at: unstarted.createdAt, waitingForAgent: true } : null;
  // The reply in progress lives in the conversation itself. This phone's own
  // stream already has a pending reply row; otherwise (reopened, other device)
  // show one from the turn.
  const streaming = !!messages?.some(m => m.role === "assistant" && m.pending);
  const workingRow: Row | null = turn && !streaming && unstarted?.id !== turn.id && ['running', 'waiting_for_approval', 'stopping'].includes(turn.status)
    ? { id: `working_${turn.id}`, role: "assistant", text: "", at: undefined as unknown as Message["at"], pending: true, agentWorking: true } : null;
  // Messages sent meanwhile sit below it, each with its own one-tap Steer.
  const queuedRows: Row[] = queuedBelow(waiting, [unstarted, turn])
    .map(t => ({ id: `queued_${t.id}`, role: "user", text: t.text || "Attachment", at: t.createdAt, queuedTurn: t }));
  const data = [...(messages ?? []), ...(firstRow ? [firstRow] : []), ...(workingRow ? [workingRow] : []), ...queuedRows].reverse();

  return (
    <MediaGalleryProvider key={id} scope={{ kind: "chat", id }} items={media}>
    <View style={styles.root}>
      <Stack.Screen options={{ title: heading, headerTitle: titleButton(showTitle, setShowTitle), ...filesHeader(String(id), heading, colors.blue) }} />
      {showTitle ? <FullTitle title={heading} onClose={() => setShowTitle(false)} /> : null}
      <VibeBar id={String(id)} />
      <ShareToggle id={String(id)} />
      <ConversationKeyboardView>
        {messages === null ? (
          <ActivityIndicator style={{ flex: 1 }} color={colors.blue} />
        ) : (
          <FlatList
            ref={list}
            inverted
            data={data}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            ListFooterComponent={
              messages.length === 0 && !firstRow ? (
                <View style={styles.empty}>
                  <Text accessibilityRole="header" style={styles.emptyTitle}>{loadError ? "Couldn't load this chat" : "What can I help with?"}</Text>
                  {loadError ? <>
                    <Text accessibilityRole="alert" style={styles.emptyBody}>{loadError}</Text>
                    <Button label="Try again" kind="secondary" onPress={() => { setMessages(null); setLoadError(null); void load(); }} style={styles.retry} />
                  </> : <Text style={styles.emptyBody}>A private conversation with the agent on {account.serverName}.</Text>}
                </View>
              ) : undefined
            }
            renderItem={({ item }) => {
              const mine = item.role === "user";
              const working = !mine && item.pending;
              const queued = item.queuedTurn;
              const timestamp = typeof item.at === "number" ? item.at : item.at ? new Date(item.at).getTime() : NaN;
              const deviceLabel = messageDeviceLabel(account.user.role, item);
              return <View accessibilityLabel={mine ? `Your message${queued ? ", waiting" : item.pending ? ", not yet received" : deviceLabel ? `, sent from ${deviceLabel}` : ""}` : "Agent response"} style={[styles.message, item.failed && styles.failed, item.pending && mine && styles.unconfirmed, queued && styles.queuedMessage]}>
                <Avatar name={mine ? account.user.name : "Agent"} agent={!mine} userId={mine ? account.user.id : undefined} size={34} />
                <View style={styles.messageCopy}>
                  <View style={styles.messageMeta}>
                    <Text style={styles.author}>{mine ? account.user.name : "Agent"}</Text>
                    {!mine ? <Text style={styles.agentTag}>Agent</Text> : null}
                    {Number.isFinite(timestamp) ? <Text style={styles.time}>{when(timestamp)}</Text> : null}
                    {deviceLabel ? <Text testID={`message-device-${item.id}`} accessibilityLabel={`Sent from ${deviceLabel}`} style={styles.time}>· {deviceLabel}</Text> : null}
                  </View>
                  {mine && !working ? <ForwardedText item={item} /> : !working && item.text ? <ReplyText text={item.text} failed={item.failed} /> : null}
                  {!working && item.attachments?.length ? <Attachments files={item.attachments} /> : null}
                  {item.uploads?.length ? <PendingAttachments files={item.uploads} /> : null}
                  {working ? <View style={styles.liveRow}>
                    <LiveStatus text={liveAgentLine(turn && activeAgentTurn(turn) ? turn : null, item.agentWorking ? null : status)} style={styles.live} />
                    {turn?.canStop && activeAgentTurn(turn) ? <Pressable accessibilityRole="button" accessibilityLabel="Stop the agent" accessibilityState={{ disabled: actionBusy || turn.status === 'stopping' }}
                      disabled={actionBusy || turn.status === 'stopping'} hitSlop={12} onPress={() => { void stop(); }} style={styles.stop}>
                      <Text style={[styles.stopText, (actionBusy || turn.status === 'stopping') && styles.dim]}>Stop</Text>
                    </Pressable> : null}
                  </View> : null}
                  {queued ? <View style={styles.liveRow}>
                    <Text accessibilityLiveRegion="polite" style={styles.queuedDetail}>{queued.steerRequested ? "Adding this to the current reply…" : "Sends when the agent is free"}</Text>
                    {canSteer(queued, turn) ? <Pressable accessibilityRole="button" accessibilityLabel="Steer: add this to the current reply" accessibilityState={{ busy: steering === queued.id }}
                      disabled={!!steering} hitSlop={8} onPress={() => { void steer(queued); }} style={styles.steer}>
                      {steering === queued.id ? <ActivityIndicator size="small" color={colors.blue} /> : <Text style={styles.steerText}>Steer</Text>}
                    </Pressable> : null}
                    {!queued.steerRequested ? <Pressable accessibilityRole="button" accessibilityLabel="Remove waiting message" hitSlop={12}
                      onPress={() => { void unqueue(queued); }} style={styles.remove}><Text style={styles.removeText}>✕</Text></Pressable> : null}
                  </View> : null}
                  {item.interrupted ? <Text style={styles.typing}>Cut off before it finished</Text> : null}
                  {item.waitingForAgent ? <Text accessibilityLiveRegion="polite" style={styles.typing}>Sends when the agent is free</Text> : null}
                </View>
              </View>;
            }}
          />
        )}
        {sendError ? <Text accessibilityRole="alert" style={styles.sendError}>{sendError}</Text> : null}
        {turn?.approval && turn.status === 'waiting_for_approval' && account.user.role === 'owner'
          ? <AgentApprovalCard approval={turn.approval} busy={actionBusy} error={actionError} onAnswer={choice => { void answer(choice); }} /> : null}
        {turn && ['cancelled', 'interrupted', 'failed'].includes(turn.status) ? <View style={styles.turnStatus}><Text accessibilityLiveRegion="polite" style={styles.turnLabel}>{agentTurnLabel(turn)}</Text></View> : null}
        {actionError && !turn?.approval ? <Text accessibilityRole="alert" style={styles.sendError}>{actionError}</Text> : null}
        {pendingForward && messages !== null && !loadError ? <View testID="forward-draft" style={styles.forwardDraft}>
          <View style={styles.forwardDraftCopy}>
            <ForwardBlock card={{ author: forwardAuthor || "Someone", where: forwardWhere || "", when: "", quote: forwardText || "" }} files={forwardFileCount} lines={3} />
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Don't forward this message" hitSlop={12} onPress={() => setPendingForward(null)} style={styles.remove}>
            <AppIcon name="close" size={16} color={colors.muted} />
          </Pressable>
        </View> : null}
        {messages !== null && !loadError ? <Composer autoFocus={compose === "1"} placeholder={pendingForward ? "Ask about this message, or just send" : "Message the agent"} onSend={send} allowFileAttachments={false} canSendEmpty={!!pendingForward} /> : null}
      </ConversationKeyboardView>
    </View>
    </MediaGalleryProvider>
  );
}

// Your message, with a forwarded channel/DM message shown as a card.
function ForwardedText({ item }: { item: Row }) {
  const styles = useStyles();
  const parsed = item.forwardPreview ? { forward: item.forwardPreview, rest: item.text } : parseForward(item.text);
  if (!parsed) return item.text ? <Text selectable style={[styles.text, item.failed && styles.failedText]}>{item.text}</Text> : null;
  return <>
    <ForwardBlock card={parsed.forward} />
    {parsed.rest ? <Text selectable style={[styles.text, item.failed && styles.failedText]}>{parsed.rest}</Text> : null}
  </>;
}

function ForwardBlock({ card, files = 0, lines }: { card: ForwardCard; files?: number; lines?: number }) {
  const styles = useStyles();
  const where = [card.where, card.when].filter(Boolean).join(" · ");
  return <View accessible accessibilityLabel={`Forwarded message from ${card.author}${where ? `, ${where}` : ""}. ${card.quote || "No text"}`} style={styles.forward}>
    <Text style={styles.forwardLabel}>Forwarded from {card.author}{where ? <Text style={styles.forwardWhere}> · {where}</Text> : null}</Text>
    {card.quote ? <Text selectable={!lines} numberOfLines={lines} style={styles.forwardQuote}>{card.quote}</Text> : null}
    {files ? <Text style={styles.forwardWhere}>{files === 1 ? "1 attachment" : `${files} attachments`}</Text> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  forward: { borderLeftWidth: 3, borderLeftColor: colors.blue, paddingLeft: space.sm, paddingVertical: 2, marginTop: 2, marginBottom: space.xxs, gap: 2 },
  forwardLabel: { ...typography.captionStrong, color: colors.ink },
  forwardWhere: { ...typography.meta, fontWeight: "400", color: colors.muted },
  forwardQuote: { ...typography.body, color: colors.ink },
  forwardDraft: { flexDirection: "row", alignItems: "flex-start", gap: space.xs, paddingLeft: space.side, paddingRight: space.xs, paddingTop: space.sm, paddingBottom: space.xxs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.background },
  forwardDraftCopy: { flex: 1, minWidth: 0 },
  turnStatus: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs, backgroundColor: colors.surface },
  queue: { backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  queued: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs },
  queuedText: { ...typography.body, color: colors.ink },
  remove: { paddingHorizontal: space.xs, paddingVertical: space.xxs }, removeText: { ...typography.body, color: colors.muted },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2, minHeight: 28 },
  live: { ...typography.body, color: colors.muted, flexShrink: 1 },
  stop: { paddingHorizontal: space.xs, paddingVertical: space.xxs }, stopText: { ...typography.captionStrong, color: colors.red }, dim: { opacity: 0.5 },
  queuedMessage: { opacity: 0.85 },
  queuedDetail: { ...typography.meta, color: colors.muted, flexShrink: 1 },
  steer: { minHeight: 28, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.sm, borderRadius: 14, borderWidth: 1, borderColor: colors.blue },
  steerText: { ...typography.captionStrong, color: colors.blue },
  turnCopy: { flex: 1 }, turnLabel: { ...typography.captionStrong, color: colors.ink }, turnDetail: { ...typography.meta, color: colors.muted },
  list: { paddingVertical: space.sm },
  readOnlyList: { paddingTop: space.xl },
  fullTitle: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.sm, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  fullTitleText: { ...typography.bodyStrong, flex: 1, color: colors.ink },
  sharedBanner: { paddingHorizontal: space.side, paddingVertical: space.xs, backgroundColor: colors.blueSoft },
  vibeBar: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.sm, backgroundColor: colors.blueSoft },
  previewButton: { minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  previewInline: { alignSelf: "flex-start", marginTop: space.xs },
  previewButtonText: { ...typography.captionStrong, color: colors.onPrimary },
  shareRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.xs, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  shareError: { ...typography.meta, color: colors.red, marginTop: space.xxs },
  message: { flexDirection: "row", paddingHorizontal: space.side, paddingVertical: space.sm, gap: 10 },
  messageCopy: { flex: 1, minWidth: 0 },
  messageMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.xs, marginBottom: 1 },
  author: { ...typography.bodyStrong, color: colors.ink },
  agentTag: { ...typography.meta, color: colors.muted, backgroundColor: colors.subtle, paddingHorizontal: space.xxs },
  time: { ...typography.meta, color: colors.muted },
  failed: { backgroundColor: colors.redSoft },
  // Sent but not yet received by the server; full opacity once it's accepted.
  unconfirmed: { opacity: 0.9 },
  text: { ...typography.body, color: colors.ink },
  failedText: { color: colors.red },
  sendError: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, paddingHorizontal: space.side, paddingVertical: space.xs },
  typing: { ...typography.body, color: colors.muted, fontStyle: "italic" },
  empty: { alignItems: "center", marginTop: space.xxl, paddingHorizontal: space.side, paddingBottom: space.lg },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, marginTop: space.xs, color: colors.muted, textAlign: "center", maxWidth: 360 },
  retry: { marginTop: space.lg },
}));
