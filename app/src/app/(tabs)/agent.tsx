import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect, useScrollToTop } from "expo-router";
import { shortTime as when } from "../../lib/time-label";
import { AppIcon } from "../../components/AppIcon";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { deleteDescription } from "../../lib/records-notice";
import { SwipeRow } from "../../components/SwipeChannelRow";
import { canonical, choiceKey, newChatOptions, offered } from "../../lib/new-chat-choice";
import { getItem } from "../../lib/storage";
import { refreshProjects, useProjects } from "../../lib/projects-store";
import { isSessionExpired, isSignedOut } from "../../lib/session-expiry-rules";
import { api, ServerError, type Chat } from "../../lib/server";
import { useSession } from "../../lib/session";
import { useLiveActions } from "../../lib/live";
import { openingChat, warmChats } from "../../lib/chat-cache";
import { reuseEqual } from "../../lib/reuse-equal";
import { setRowChange, withRowChanges, type RowChanges } from "../../lib/row-changes";
import { radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../../lib/theme";
import { activeAgentTurn, agentTurnLabel, liveAgentLine, replyTime, type AgentTurn, type ReplyTime } from '../../lib/agent-turns';
import { useNow } from "../../lib/use-now";
import { LiveStatus } from "../../components/LiveStatus";
import { ReplyBar } from "../../components/ReplyBar";
import { ServeLoader } from "../../components/ServeLoader";

// The line under the title, like the last message in a DM list.
function lastLine(chat: Chat, author: string, agent = "") {
  const last = chat.lastMessage;
  if (!last) return "";
  const body = last.text || (last.attachments ? `${last.attachments} attachment${last.attachments === 1 ? "" : "s"}` : "");
  return last.role === "user" ? `${author}: ${body}` : agent ? `${agent}: ${body}` : body;
}

// What a row says about the reply in progress: what the agent is doing, or what it is waiting for.
const turnLine = (turn: AgentTurn) => turn.status === "running" ? liveAgentLine(turn) : agentTurnLabel(turn);

// A row whose reply has an estimate looks at the clock itself, every few seconds, so what it says about time
// stays true, on screen and for a screen reader, without the list being drawn again. No other row ticks.
function ReplyClock({ turn, children }: { turn: AgentTurn | null | undefined; children: (time: ReplyTime | null) => ReactNode }) {
  const estimated = activeAgentTurn(turn) && typeof turn?.usualMs === "number";
  const now = useNow(estimated ? 5_000 : null);
  return children(estimated ? replyTime(turn, now) : null);
}

export default function Chats() {
  const styles = useStyles();
  // Tapping the tab you're already on scrolls back to the top.
  const scrollRef = useRef<FlatList<Chat>>(null);
  useScrollToTop(scrollRef);
  const { colors } = useTheme();
  const { account, setAccount, signOut } = useSession();
  const { refreshAgent } = useLiveActions();
  const [shared, setShared] = useState<Chat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  // The projects you're in (docs/projects.md); vibeCoder means every chat builds a prototype.
  const projects = useProjects();
  // A new chat starts about the last choice; the chat offers the change right above its message box.
  const [choice, setChoice] = useState<string | null>(null);
  const userId = account?.user.id;
  // Like the DM tab: Active and Archived. Only you archive a conversation.
  const [view, setView] = useState<"active" | "everyone" | "archived">("active");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = useRef(false);
  const [deleting, setDeleting] = useState<Chat | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeRow = useCallback(() => setOpenId(null), []);
  // Archive, restore and delete show at once: the change waits here, over every copy of the list, until the server answers.
  const [changes, setChanges] = useState<RowChanges>(() => new Map());
  const [loadedChats, setChats] = useState<Chat[] | null>(null);
  const chats = useMemo(() => loadedChats && withRowChanges(loadedChats, changes), [loadedChats, changes]);

  const load = useCallback(async () => {
    if (!account) return;
    try {
      const { mine, others } = await api.orgChats(account, setAccount);
      // The list is read every five seconds. What did not change is kept, so a look that finds nothing new draws nothing.
      setChats(current => reuseEqual(current, mine));
      refreshAgent(mine);
      warmChats(account, mine);
      setShared(current => reuseEqual(current, others));
      void refreshProjects(account);
      setError(null);
    } catch (e) {
      if (isSessionExpired(e)) return; // the confirm screen is up; keep the list
      if (isSignedOut(e)) {
        await signOut();
        return;
      }
      // Keep the list we already have; just say the refresh failed.
      setError(e instanceof ServerError ? e.message : "Couldn't load chats");
    }
  }, [account, setAccount, signOut, refreshAgent]);

  useFocusEffect(
    useCallback(() => {
      void load();
      if (userId) void getItem(choiceKey(userId)).then(value => setChoice(value || null)).catch(() => {});
      const timer = setInterval(() => { if (AppState.currentState === 'active') void load(); }, 5000);
      const subscription = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
      return () => { clearInterval(timer); subscription.remove(); };
    }, [load, userId]),
  );

  if (!account) return null;
  // A chat from your own list: the screen is told whose it is (it need not ask) and its requests leave at the
  // press, before the screen has been built (lib/chat-cache.ts). The list says when a chat is someone else's.
  const openChat = (chat: Chat, extra: { compose?: string } = {}) => {
    openingChat(account, chat.id, chat.readOnly === true);
    router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, ...(chat.readOnly ? { readOnly: "1", author: chat.author?.name ?? "" } : { mine: "1" }), ...extra } });
  };

  const act = async (chat: Chat, remove = false) => {
    if (busy.current) return;
    busy.current = true;
    setBusyId(chat.id);
    setActionError(null);
    // The row moves at once (lib/row-changes.ts). The server does the work as it always has: where records are
    // kept, a delete saves its copy first. If the server refuses, the row is back where it was and the error says why.
    setChanges(waiting => setRowChange(waiting, chat.id, remove ? { deleted: true } : { archived: !chat.archived }));
    setDeleting(null);
    closeRow();
    try {
      if (remove) await api.deleteChat(account, chat.id);
      else if (chat.archived) await api.restoreChat(account, chat.id);
      else await api.archiveChat(account, chat.id);
      await load();
    } catch (e) {
      setActionError(e instanceof ServerError ? e.message : "Couldn't update the conversation. Try again.");
      // A delete that was refused asks again, with the reason, wherever the list is scrolled to.
      if (remove) setDeleting(chat);
    } finally {
      // The reloaded list has the change now, or it was refused: either way it no longer waits.
      setChanges(waiting => setRowChange(waiting, chat.id, null));
      busy.current = false;
      setBusyId(null);
    }
  };
  const active = (chats ?? []).filter(chat => !chat.archived);
  const archived = (chats ?? []).filter(chat => chat.archived);
  const everyoneLabel = account.user.role === "owner" ? "Everyone's" : "Shared by others";
  const unreadTotal = active.reduce((n, c) => n + (c.unread ?? 0), 0) + shared.reduce((n, c) => n + (c.unread ?? 0), 0);
  const unreadEveryone = shared.reduce((n, c) => n + (c.unread ?? 0), 0);
  // The tab is there whenever other people have conversations you can read.
  type View = "active" | "everyone" | "archived";
  const VIEWS: { key: View; label: string }[] = [{ key: "active", label: "Active" }, ...(shared.length ? [{ key: "everyone" as const, label: everyoneLabel }] : []), { key: "archived", label: "Archived" }];
  const rows = view === "archived" ? archived : view === "everyone" ? shared : active;
  const markAllRead = async () => {
    if (busy.current || !unreadTotal) return;
    busy.current = true; setActionError(null);
    // Clear the badges right away; the server catches up.
    setChats(list => list?.map(c => c.unread ? { ...c, unread: 0 } : c) ?? list);
    setShared(list => list.map(c => c.unread ? { ...c, unread: 0 } : c));
    try { await api.readAllChats(account); refreshAgent(); }
    catch (e) { setActionError(e instanceof ServerError ? e.message : "Couldn't mark everything read. Try again."); await load(); }
    finally { busy.current = false; }
  };

  // One tap: a chat about the remembered choice (business owners always build prototypes).
  const start = async () => {
    if (starting) return;
    const project = projects && !projects.vibeCoder && offered(projects, choice) ? canonical(projects, choice) : null;
    setStarting(true);
    setError(null);
    try {
      const chat = await api.newChat(account, newChatOptions(project));
      openChat(chat, { compose: "1" });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't start a chat");
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={styles.root}>
      <FlatList ref={scrollRef} contentInsetAdjustmentBehavior="automatic"
        data={chats === null ? [] : view === "everyone" ? shared : rows}
        keyExtractor={(c) => c.id}
        extraData={{ openId, busyId, view, shared }}
        refreshControl={
          <RefreshControl
            tintColor={colors.blue}
            colors={[colors.blue]}
            progressBackgroundColor={colors.surface}
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              try { await load(); }
              finally { setRefreshing(false); }
            }}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <Text accessibilityRole="header" style={styles.title}>Agent</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="New chat" accessibilityState={{ disabled: starting, busy: starting }} disabled={starting} onPress={() => void start()} style={styles.compose}>
                {starting ? <ActivityIndicator color={colors.blue} /> : <AppIcon name="compose" size={22} color={colors.ink} />}
              </Pressable>
            </View>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {actionError && !deleting ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
            {account.user.role === 'owner' && chats?.some(chat => chat.latestTurn?.status === 'waiting_for_approval') ? <View style={styles.inbox}>
              <Text accessibilityRole="header" style={styles.inboxTitle}>Needs your approval</Text>
              {chats.filter(chat => chat.latestTurn?.status === 'waiting_for_approval').map(chat => <Pressable key={chat.id} accessibilityRole="button" accessibilityLabel={`Review action in ${chat.title}`} onPress={() => openChat(chat)} style={styles.approvalRow}>
                <Text style={styles.rowTitle}>{chat.title}</Text><Text style={styles.approvalDetail}>{chat.latestTurn?.approval?.description || 'Review this action to continue.'}</Text><Text style={styles.review}>Review action →</Text>
              </Pressable>)}
            </View> : null}
            <View accessibilityRole="tablist" style={styles.filters}>{VIEWS.map(({ key, label }) => <Pressable key={key} accessibilityRole="tab" accessibilityLabel={key === "archived" && archived.length ? `${label}, ${archived.length}` : key === "everyone" && unreadEveryone ? `${label}, ${unreadEveryone} unread` : label} accessibilityState={{ selected: view === key }} aria-selected={view === key} onPress={() => { closeRow(); setView(key); }} style={({ pressed }) => [styles.filter, view === key && styles.selectedFilter, pressed && { opacity: 0.7 }]}>
              <Text style={[styles.filterText, view === key && styles.selectedFilterText]}>{label}</Text>
              {key === "everyone" && unreadEveryone > 0 ? <View style={styles.tabDot} /> : null}
            </Pressable>)}</View>
            {unreadTotal > 0 ? <Pressable testID="mark-all-read" accessibilityRole="button" accessibilityLabel={`Mark all as read, ${unreadTotal} unread`} onPress={() => void markAllRead()} style={({ pressed }) => [styles.markAll, pressed && { opacity: 0.7 }]}>
              <AppIcon name="check" size={16} color={colors.blue} /><Text style={styles.markAllText}>Mark all as read</Text>
            </Pressable> : null}
          </View>
        }
        ListEmptyComponent={
          chats !== null && view === "everyone" ? (
            <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.emptyTitle}>Nothing shared yet</Text>
            </View>
          ) : chats !== null && view === "archived" ? (
            <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.emptyTitle}>No archived conversations</Text>
              <Button label="Show active conversations" kind="secondary" onPress={() => setView("active")} style={styles.emptyAction} />
            </View>
          ) : chats === null ? (
            error ? <Button label="Try again" kind="link" busy={refreshing} onPress={() => { setRefreshing(true); void load().finally(() => setRefreshing(false)); }} style={styles.retry} /> : <ServeLoader accessibilityLabel="Loading agent conversations" style={{ marginTop: space.xl }} />
          ) : (
            <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.emptyTitle}>No conversations yet</Text>
              <Button label={projects?.vibeCoder ? "Start prototyping" : "New chat"} onPress={() => void start()} busy={starting} style={styles.emptyAction} />
            </View>
          )
        }
        renderItem={({ item }) => {
          const unread = item.unread ?? 0;
          const title = item.title.replace(/`/g, "");
          if (view === "everyone") {
            const by = item.author?.name ?? "Someone", line = lastLine(item, by, "Agent");
            return (
              <Pressable accessibilityRole="button"
                accessibilityLabel={`${title}, by ${item.author?.name ?? "someone"}${unread ? `, ${unread} unread ${unread === 1 ? "reply" : "replies"}` : ""}${item.shared === false ? ", private" : ""}${line ? `. ${line}` : ""}`}
                onPress={() => {
                  // Opening it reads it; the server records that when the chat loads.
                  if (unread) setShared(list => list.map(chat => chat.id === item.id ? { ...chat, unread: 0 } : chat));
                  openingChat(account, item.id, true);
                  router.push({ pathname: "/chat/[id]", params: { id: item.id, title: item.title, readOnly: "1", author: item.author?.name ?? "" } });
                }}
                style={({ pressed }) => [styles.row, styles.rowWrap, pressed && { backgroundColor: colors.surface }]}>
                <View style={styles.rowCopy}>
                  <View style={styles.rowTop}>
                    <Text style={[styles.rowTitle, styles.readTitle, unread > 0 && styles.unreadTitle]}>{title}</Text>
                    <Text style={[styles.rowWhen, unread > 0 && styles.unreadWhen]}>{when(item.updatedAt)}</Text>
                  </View>
                  <View style={styles.rowTop}>
                    <View style={styles.privateTag}>
                      {item.shared === false ? <AppIcon name="lock" size={12} color={colors.muted} /> : null}
                      <Text style={[styles.preview, unread > 0 && { color: colors.ink }]} numberOfLines={1}>{line || by}{item.shared === false ? " · Private (visible to admins)" : ""}</Text>
                    </View>
                    {unread > 0 ? <View style={styles.unreadBadge}><Text style={styles.unreadBadgeText}>{unread > 99 ? "99+" : unread}</Text></View> : null}
                  </View>
                </View>
              </Pressable>
            );
          }
          return (
            <SwipeRow name={title} kind="conversation" archived={!!item.archived} open={openId === item.id} busy={busyId !== null} canDelete
              onOpen={() => setOpenId(item.id)} onClose={closeRow} onArchive={() => { void act(item); }} onDelete={() => { setActionError(null); setDeleting(item); }}>
              {(bind) => (
                <View style={styles.rowWrap}>
                <ReplyClock turn={item.latestTurn}>{(time) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${title}${unread ? `, ${unread} unread ${unread === 1 ? "reply" : "replies"}` : ""}${item.shared === true ? ", shared with everyone" : ""}${lastLine(item, "You") ? `. ${lastLine(item, "You")}` : ""}${activeAgentTurn(item.latestTurn) ? `. ${turnLine(item.latestTurn!)}${time?.spoken ? `, ${time.spoken}` : ""}` : ""}`}
                  onPress={() => bind.onPress(() => {
                    // Clear the badge right away; the chat screen tells the server.
                    if (unread) setChats(list => list?.map(chat => chat.id === item.id ? { ...chat, unread: 0 } : chat) ?? list);
                    openChat(item);
                  })}
                  onLongPress={bind.onLongPress}
                  accessibilityActions={bind.accessibilityActions}
                  onAccessibilityAction={bind.onAccessibilityAction}
                  style={({ pressed }) => [styles.row, bind.trailing ? styles.rowWithTrailing : null, pressed && { backgroundColor: colors.surface }]}
                >
                  <View style={styles.rowCopy}>
                    <View style={styles.rowTop}>
                      <Text style={[styles.rowTitle, styles.readTitle, unread > 0 && styles.unreadTitle]}>{title}</Text>
                      <Text style={[styles.rowWhen, unread > 0 && styles.unreadWhen]}>{when(item.updatedAt)}</Text>
                    </View>
                    {item.mode === "vibe" || item.project ? <Text style={styles.projectTag}>{[item.project?.name, item.mode === "vibe" ? "Prototyping" : null].filter(Boolean).join(" · ")}</Text> : null}
                    <View style={styles.rowTop}>
                      {activeAgentTurn(item.latestTurn) ? <View style={styles.turnLive}>{item.latestTurn!.status === 'running'
                          ? <View style={styles.turnLine}>
                            <LiveStatus text={liveAgentLine(item.latestTurn)} style={styles.turnLiveText} />
                            {/* About how long is left, when the server has an estimate (lib/agent-turns.ts, replyTime). */}
                            {time?.text ? <Text style={styles.turnTime}>· {time.text}</Text> : null}
                          </View>
                          : <Text style={styles.turnLabel}>{agentTurnLabel(item.latestTurn!)}</Text>}
                          {time && time.progress !== null ? <ReplyBar progress={time.progress} paused={time.paused} style={styles.turnBar} /> : null}</View>
                        : <View style={styles.privateTag}>
                          {item.shared === true ? <AppIcon name="people" size={12} color={colors.muted} /> : null}
                          <Text style={[styles.preview, unread > 0 && { color: colors.ink }]} numberOfLines={1}>{lastLine(item, "You") || (item.shared === true ? "Shared" : "")}</Text>
                        </View>}
                      {unread > 0 ? <View style={styles.unreadBadge}><Text style={styles.unreadBadgeText}>{unread > 99 ? "99+" : unread}</Text></View> : null}
                    </View>
                  </View>
                </Pressable>
                )}</ReplyClock>
                {/* Beside the row, not inside it: a button can't hold a button on the web. */}
                {bind.trailing}
                </View>
              )}
            </SwipeRow>
          );
        }}
        contentContainerStyle={{ paddingBottom: space.xxl }}
      />
      <ConfirmDialog visible={!!deleting} title="Delete this conversation?"
        description={deleteDescription("agent-chat", account.recordsKept === true)}
        confirmLabel="Delete conversation" busy={busyId !== null} error={actionError}
        onCancel={() => { setDeleting(null); setActionError(null); }} onConfirm={() => { if (deleting) void act(deleting, true); }} />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  inbox: { marginHorizontal: space.side, marginBottom: space.md, padding: space.md, backgroundColor: colors.blueSoft, borderRadius: radius.lg },
  inboxTitle: { ...typography.bodyStrong, color: colors.brandText, marginBottom: space.xs },
  approvalRow: { paddingVertical: space.xs, gap: space.xxs }, approvalDetail: { ...typography.caption, color: colors.ink }, review: { ...typography.captionStrong, color: colors.blue, ...linkUnderline },
  rowCopy: { flex: 1, minWidth: 0 }, rowTop: { flexDirection: "row", alignItems: "center" }, byline: { ...typography.meta, color: colors.muted, marginTop: space.xxs }, privateTag: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xxs, marginTop: space.xxs, marginRight: space.sm }, preview: { ...typography.caption, color: colors.muted, flexShrink: 1 }, turnLive: { flex: 1, minWidth: 0, marginTop: space.xxs, marginRight: space.sm }, turnLiveText: { ...typography.meta, color: colors.blue }, turnLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.xxs }, turnTime: { ...typography.meta, color: colors.muted }, turnBar: { marginTop: space.xxs }, turnLabel: { ...typography.meta, flex: 1, color: colors.blue, marginTop: space.xxs, marginRight: space.sm },
  header: { minHeight: 60, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs },
  title: { ...typography.title, color: colors.ink, flexShrink: 1 },
  compose: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  error: { ...typography.caption, marginBottom: space.sm, marginHorizontal: space.side, color: colors.red },
  sectionTitle: { ...typography.label, color: colors.muted, paddingHorizontal: space.side, paddingTop: space.sm, paddingBottom: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  retry: { marginHorizontal: space.side },
  rowWrap: { flexDirection: "row", alignItems: "center", backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  // No icon: every row here is an agent chat, so the title gets the width.
  row: {
    flex: 1,
    minWidth: 0,
    minHeight: 64,
    paddingVertical: space.sm,
    paddingHorizontal: space.side,
    flexDirection: "row",
    alignItems: "center",
  },
  // Same as the DM rows: the ••• button beside the row supplies the right inset.
  rowWithTrailing: { paddingRight: space.xs },
  projectTag: { ...typography.meta, color: colors.blueDark, marginTop: 1 },
  rowTitle: { ...typography.bodyStrong, flex: 1, color: colors.ink, marginRight: space.sm },
  rowWhen: { ...typography.caption, color: colors.muted },
  // Telegram-style: conversations with unread replies are bold, in your own and in everyone else's.
  readTitle: { fontWeight: "400" },
  unreadTitle: { fontWeight: "700" },
  unreadWhen: { color: colors.blue },
  unreadBadge: { minWidth: 24, height: 24, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xs },
  unreadBadgeText: { ...typography.captionStrong, color: colors.onPrimary },
  // Same filter row as the DM tab.
  filters: { flexDirection: "row", gap: space.xs, paddingHorizontal: space.side, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  filter: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.sm, justifyContent: "center", borderRadius: radius.pill },
  selectedFilter: { backgroundColor: colors.blueSoft },
  filterText: { ...typography.bodyStrong, color: colors.muted },
  selectedFilterText: { color: colors.blueDark },
  tabDot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.primary, marginLeft: space.xs },
  markAll: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.side, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  markAllText: { ...typography.bodyStrong, color: colors.blue, ...linkUnderline },
  empty: { marginTop: space.xxl, alignItems: "center", paddingHorizontal: space.side },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyAction: { alignSelf: "stretch", marginTop: space.lg, marginBottom: space.xl },
}));
