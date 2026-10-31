import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useChromeHeight } from "../../components/AppChrome";
import { Avatar, Composer, when } from "../../components/Messaging";
import { Attachments, PendingAttachments } from "../../components/Attachments";
import { MediaGalleryProvider } from "../../components/MediaGallery";
import { mediaFromMessages } from "../../lib/media";
import { Button } from "../../components/Button";
import { MessageText } from "../../components/MessageText";
import { AgentApprovalCard } from "../../components/AgentApprovalCard";
import { activeAgentTurn, agentTurnLabel, type AgentTurn } from "../../lib/agent-turns";
import { api, sendMessage, ServerError, type Message, type Upload } from "../../lib/server";
import { useSession } from "../../lib/session";
import { colors, space, typography } from "../../lib/theme";

type Row = Message & { pending?: boolean; failed?: boolean; localId?: string; uploads?: Upload[] };

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { account } = useSession();
  // A different conversation or account starts with fresh draft and send state.
  return <ChatConversation key={`${account?.serverUrl ?? ""}:${account?.token ?? ""}:${id}`} />;
}

function ChatConversation() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const { account, setAccount } = useSession();
  const headerHeight = useHeaderHeight();
  const chromeHeight = useChromeHeight();
  const [messages, setMessages] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [turn, setTurn] = useState<AgentTurn | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [heading, setHeading] = useState(title && title !== "New chat" ? title : "New chat");
  const list = useRef<FlatList<Row>>(null);
  const abort = useRef<AbortController | null>(null);
  const currentLoad = useRef<object | null>(null);
  const mounted = useRef(true);
  const lastTurnUpdate = useRef(0);
  const delivery = useRef<{ text: string; uploads: Upload[]; id: string } | null>(null);

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
        setTurn(turns[0] ?? null);
        lastTurnUpdate.current = turns[0]?.updatedAt ?? 0;
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
        const latest = turns[0] ?? null;
        setTurn(current => current && (!latest || current.updatedAt > latest.updatedAt) ? current : latest);
        if ((foregroundRefresh || (latest?.updatedAt ?? 0) !== lastTurnUpdate.current) && !abort.current) {
          const history = await api.messages(account, id);
          if (active && !abort.current) {
            setMessages(history); setLoadError(null); setSendError(null);
            lastTurnUpdate.current = latest?.updatedAt ?? 0;
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

  const media = useMemo(() => mediaFromMessages(messages ?? [], account?.user.name ?? "You", "Servant"), [messages, account?.user.name]);
  if (!account) return null;

  const send = async (text: string, attachments: Upload[] = []) => {
    const body = text.trim();
    if ((!body && !attachments.length) || busy || activeAgentTurn(turn) || messages === null || loadError) return false;
    setBusy(true);
    setStatus(null);
    setSendError(null);
    setActionError(null);
    // Retain the key after an uncertain delivery; an unchanged draft can be
    // retried without starting another Mac-owned turn.
    const previous = delivery.current;
    if (!previous || previous.text !== body || previous.uploads.length !== attachments.length
      || previous.uploads.some((upload, i) => upload.name !== attachments[i]?.name || upload.data !== attachments[i]?.data)) {
      delivery.current = { text: body, uploads: attachments, id: randomUUID() };
    }
    const requestId = delivery.current!.id;
    const stamp = Date.now();
    const mineKey = `u${stamp}`;
    const replyKey = `a${stamp}`;
    const mine: Row = { id: mineKey, localId: mineKey, role: "user", text: body, at: stamp, pending: true, uploads: attachments };
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
      if (heading === "New chat") setHeading((body || attachments[0]?.name || "New chat").replace(/\s+/g, " ").slice(0, 60));
      setMessages((m) => (m ?? []).map((r) => r.localId === mineKey ? { ...r, pending: false } : r));
    };
    try {
      await sendMessage(
        account,
        String(id),
        body,
        (e) => {
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
          } else if (e.type === "delta") {
            if (e.text) { accept(); responseSeen = true; }
            setStatus(null);
            update((r) => ({ ...r, text: r.text + e.text }));
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
        },
        controller.signal,
        setAccount,
        attachments,
        requestId,
      );
      if (!failed && isCurrent() && !accepted) {
        failed = true;
        setSendError("Couldn't confirm this message was sent. Your draft is saved; try again.");
      }
      if (!failed && isCurrent()) {
        // Replace temporary upload previews with authenticated media records.
        // A lagging history response must not erase the turn just streamed.
        try {
          const history = await api.messages(account, String(id));
          const userIndex = canonicalMineId ? history.findIndex(message => message.id === canonicalMineId) : messages.length;
          const hasUser = canonicalMineId ? userIndex >= 0 : history.length > messages.length;
          const hasReply = !responseSeen || (canonicalReplyId ? history.some(message => message.id === canonicalReplyId)
            : history.slice(userIndex + 1).some(message => message.role === "assistant"));
          if (isCurrent() && hasUser && hasReply) setMessages(history);
        } catch { /* The streamed turn remains visible if history refresh fails. */ }
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
        void api.agentTurns(account, String(id)).then(turns => { if (mounted.current) setTurn(turns[0] ?? null); }).catch(() => {});
      }
    }
    // An accepted message stays sent even if Hermes cannot finish its reply.
    if (accepted) delivery.current = null;
    return accepted || !failed;
  };

  const answer = async (choice: 'once' | 'deny') => {
    if (!turn?.approval || actionBusy) return;
    setActionBusy(true); setActionError(null);
    try {
      await api.answerApproval(account, String(id), turn.id, turn.approval.id, choice);
      const turns = await api.agentTurns(account, String(id));
      if (mounted.current) setTurn(turns[0] ?? null);
    } catch (e) { if (mounted.current) setActionError(e instanceof Error ? e.message : 'Could not send your decision. Try again.'); }
    finally { if (mounted.current) setActionBusy(false); }
  };
  const stop = async () => {
    if (!turn?.canStop || actionBusy) return;
    setActionBusy(true); setActionError(null);
    try {
      await api.stopAgent(account, String(id), turn.id);
      const turns = await api.agentTurns(account, String(id));
      if (mounted.current) setTurn(turns[0] ?? null);
    } catch (e) { if (mounted.current) setActionError(e instanceof Error ? e.message : 'Could not stop the agent. Try again.'); }
    finally { if (mounted.current) setActionBusy(false); }
  };

  const data = [...(messages ?? [])].reverse();

  return (
    <MediaGalleryProvider key={id} scope={{ kind: "chat", id }} items={media}>
    <View style={styles.root}>
      <Stack.Screen options={{ title: heading }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight + chromeHeight}>
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
              messages.length === 0 ? (
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
              const timestamp = typeof item.at === "number" ? item.at : item.at ? new Date(item.at).getTime() : NaN;
              return <View accessibilityLabel={mine ? "Your message" : "Agent response"} style={[styles.message, item.failed && styles.failed]}>
                <Avatar name={mine ? account.user.name : "Servant"} agent={!mine} size={34} />
                <View style={styles.messageCopy}>
                  <View style={styles.messageMeta}>
                    <Text style={styles.author}>{mine ? account.user.name : "Servant"}</Text>
                    {!mine ? <Text style={styles.agentTag}>Agent</Text> : null}
                    {Number.isFinite(timestamp) ? <Text style={styles.time}>{when(timestamp)}</Text> : null}
                  </View>
                  {item.text ? mine ? <Text selectable style={[styles.text, item.failed && styles.failedText]}>{item.text}</Text> : <MessageText text={item.text} failed={item.failed} /> : null}
                  {item.attachments?.length ? <Attachments files={item.attachments} /> : null}
                  {item.uploads?.length ? <PendingAttachments files={item.uploads} /> : null}
                  {item.pending && mine ? <Text style={styles.typing}>Sending…</Text> : null}
                  {item.pending && !mine && !item.text && !item.attachments?.length ? <Text style={styles.typing}>{status ?? "Thinking…"}</Text> : null}
                  {item.interrupted ? <Text style={styles.typing}>Saved before the agent was interrupted.</Text> : null}
                </View>
              </View>;
            }}
          />
        )}
        {sendError ? <Text accessibilityRole="alert" style={styles.sendError}>{sendError}</Text> : null}
        {turn?.approval && turn.status === 'waiting_for_approval' && account.user.role === 'owner'
          ? <AgentApprovalCard approval={turn.approval} busy={actionBusy} error={actionError} onAnswer={choice => { void answer(choice); }} /> : null}
        {turn && activeAgentTurn(turn) ? <View style={styles.turnStatus}>
          <View style={styles.turnCopy}><Text accessibilityLiveRegion="polite" style={styles.turnLabel}>{agentTurnLabel(turn)}</Text><Text style={styles.turnDetail}>{turn.status === 'waiting_for_approval' ? 'The agent is paused until you decide.' : turn.status === 'stopping' ? 'Your partial reply will stay here.' : 'You can leave this conversation. The Mac keeps working.'}</Text></View>
          {turn.canStop ? <Button label="Stop" kind="danger" compact busy={actionBusy} disabled={turn.status === 'stopping'} onPress={() => { void stop(); }} /> : null}
        </View> : null}
        {turn && ['cancelled', 'interrupted', 'failed'].includes(turn.status) ? <View style={styles.turnStatus}><Text accessibilityLiveRegion="polite" style={styles.turnLabel}>{agentTurnLabel(turn)}</Text></View> : null}
        {actionError && !turn?.approval ? <Text accessibilityRole="alert" style={styles.sendError}>{actionError}</Text> : null}
        {messages !== null && !loadError ? <Composer placeholder="Message the agent" onSend={send} allowFileAttachments={false} /> : null}
      </KeyboardAvoidingView>
    </View>
    </MediaGalleryProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  turnStatus: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs, backgroundColor: colors.surface },
  turnCopy: { flex: 1 }, turnLabel: { ...typography.captionStrong, color: colors.ink }, turnDetail: { ...typography.meta, color: colors.muted },
  list: { paddingVertical: space.sm },
  message: { flexDirection: "row", paddingHorizontal: space.side, paddingVertical: space.sm, gap: 10 },
  messageCopy: { flex: 1, minWidth: 0 },
  messageMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.xs, marginBottom: 1 },
  author: { ...typography.bodyStrong, color: colors.ink },
  agentTag: { ...typography.meta, color: colors.muted, backgroundColor: colors.subtle, paddingHorizontal: space.xxs },
  time: { ...typography.meta, color: colors.muted },
  failed: { backgroundColor: colors.redSoft },
  text: { ...typography.body, color: colors.ink },
  failedText: { color: colors.red },
  sendError: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, paddingHorizontal: space.side, paddingVertical: space.xs },
  typing: { ...typography.body, color: colors.muted, fontStyle: "italic" },
  empty: { alignItems: "center", marginTop: space.xxl, paddingHorizontal: space.side, paddingBottom: space.lg },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, marginTop: space.xs, color: colors.muted, textAlign: "center", maxWidth: 360 },
  retry: { marginTop: space.lg },
});
