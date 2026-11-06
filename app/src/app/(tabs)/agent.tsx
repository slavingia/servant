import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect, useScrollToTop } from "expo-router";
import { shortTime as when } from "../../lib/time-label";
import { AppIcon } from "../../components/AppIcon";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SwipeRow } from "../../components/SwipeChannelRow";
import { choiceKey, newChatOptions, offered } from "../../lib/new-chat-choice";
import { getItem } from "../../lib/storage";
import { lastChatKey } from "../../lib/new-chat-choice";
import { refreshProjects, useProjects } from "../../lib/projects-store";
import { api, ServerError, type Chat } from "../../lib/server";
import { useSession } from "../../lib/session";
import { useLive } from "../../lib/live";
import { radius, space, typography, useTheme, createThemedStyles } from "../../lib/theme";
import { activeAgentTurn, agentTurnLabel, liveAgentLine } from '../../lib/agent-turns';
import { LiveStatus } from "../../components/LiveStatus";

// The line under the title, like the last message in a DM list.
function lastLine(chat: Chat, author: string, agent = "") {
  const last = chat.lastMessage;
  if (!last) return "";
  const body = last.text || (last.attachments ? `${last.attachments} attachment${last.attachments === 1 ? "" : "s"}` : "");
  return last.role === "user" ? `${author}: ${body}` : agent ? `${agent}: ${body}` : body;
}


let resumedThisLaunch = false;

export default function Chats() {
  const styles = useStyles();
  // Tapping the tab you're already on scrolls back to the top.
  const scrollRef = useRef<FlatList<Chat>>(null);
  useScrollToTop(scrollRef);
  const { colors } = useTheme();
  const { account, setAccount, signOut } = useSession();
  const { refreshAgent } = useLive();
  const [chats, setChats] = useState<Chat[] | null>(null);
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
  const [view, setView] = useState<"active" | "archived">("active");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = useRef(false);
  const [deleting, setDeleting] = useState<Chat | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeRow = useCallback(() => setOpenId(null), []);

  const load = useCallback(async () => {
    if (!account) return;
    try {
      const { mine, others } = await api.orgChats(account, setAccount);
      setChats(mine);
      refreshAgent(mine);
      if (!resumedThisLaunch) {
        // Once per launch, pick up where you left off: reopen the last chat with the message box focused.
        resumedThisLaunch = true;
        void getItem(lastChatKey(account.user.id)).then(id => {
          const chat = id ? mine.find(c => c.id === id && !c.archived) : null;
          if (chat) router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, compose: "1" } });
        }).catch(() => {});
      }
      setShared(others);
      void refreshProjects(account);
      setError(null);
    } catch (e) {
      if (e instanceof ServerError && e.status === 401) {
        await signOut();
        router.replace("/welcome");
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

  const act = async (chat: Chat, remove = false) => {
    if (busy.current) return;
    busy.current = true;
    setBusyId(chat.id);
    setActionError(null);
    try {
      if (remove) await api.deleteChat(account, chat.id);
      else if (chat.archived) await api.restoreChat(account, chat.id);
      else await api.archiveChat(account, chat.id);
      setDeleting(null);
      closeRow();
      await load();
    } catch (e) {
      setActionError(e instanceof ServerError ? e.message : "Couldn't update the conversation. Try again.");
    } finally {
      busy.current = false;
      setBusyId(null);
    }
  };
  const active = (chats ?? []).filter(chat => !chat.archived);
  const archived = (chats ?? []).filter(chat => chat.archived);
  const rows = view === "archived" ? archived : active;
  const VIEWS = [{ key: "active", label: "Active" }, { key: "archived", label: "Archived" }] as const;

  // One tap: a chat about the remembered choice (vibe coders always build prototypes).
  const start = async () => {
    if (starting) return;
    const project = projects && !projects.vibeCoder && offered(projects, choice) ? choice : null;
    setStarting(true);
    setError(null);
    try {
      const chat = await api.newChat(account, newChatOptions(project));
      router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, compose: "1" } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't start a chat");
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={styles.root}>
      <FlatList ref={scrollRef} contentInsetAdjustmentBehavior="automatic"
        data={chats === null ? [] : rows}
        keyExtractor={(c) => c.id}
        extraData={{ openId, busyId, view }}
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
              {chats.filter(chat => chat.latestTurn?.status === 'waiting_for_approval').map(chat => <Pressable key={chat.id} accessibilityRole="button" accessibilityLabel={`Review action in ${chat.title}`} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: chat.id, title: chat.title } })} style={styles.approvalRow}>
                <Text style={styles.rowTitle}>{chat.title}</Text><Text numberOfLines={2} style={styles.approvalDetail}>{chat.latestTurn?.approval?.description || 'Review this action to continue.'}</Text><Text style={styles.review}>Review action →</Text>
              </Pressable>)}
            </View> : null}
            <View accessibilityRole="tablist" style={styles.filters}>{VIEWS.map(({ key, label }) => <Pressable key={key} accessibilityRole="tab" accessibilityLabel={key === "archived" && archived.length ? `${label}, ${archived.length}` : label} accessibilityState={{ selected: view === key }} aria-selected={view === key} onPress={() => { closeRow(); setView(key); }} style={({ pressed }) => [styles.filter, view === key && styles.selectedFilter, pressed && { opacity: 0.7 }]}>
              <Text style={[styles.filterText, view === key && styles.selectedFilterText]}>{label}</Text>
            </Pressable>)}</View>
          </View>
        }
        ListEmptyComponent={
          chats !== null && view !== "active" ? (
            <View style={styles.empty}>
              <AppIcon name="archive" size={32} color={colors.muted} />
              <Text accessibilityRole="header" style={styles.emptyTitle}>No archived conversations</Text>
              <Text style={styles.emptyBody}>Conversations you archive will appear here.</Text>
              <Button label="Show active conversations" kind="secondary" onPress={() => setView("active")} style={styles.emptyAction} />
            </View>
          ) : chats === null ? (
            error ? <Button label="Try again" kind="link" busy={refreshing} onPress={() => { setRefreshing(true); void load().finally(() => setRefreshing(false)); }} style={styles.retry} /> : <ActivityIndicator accessibilityLabel="Loading agent conversations" style={{ marginTop: space.xl }} color={colors.blue} />
          ) : (
            <View style={styles.empty}>
              <AppIcon name="sparkles" size={32} color={colors.blue} />
              <Text accessibilityRole="header" style={styles.emptyTitle}>Start with a question</Text>
              <Text style={styles.emptyBody}>Ask the agent for help, then return to your conversation here.</Text>
              <Button label={projects?.vibeCoder ? "Start vibe coding" : "New chat"} onPress={() => void start()} busy={starting} style={styles.emptyAction} />
            </View>
          )
        }
        renderItem={({ item }) => {
          const unread = item.unread ?? 0;
          const title = item.title.replace(/`/g, "");
          return (
            <SwipeRow name={title} kind="conversation" archived={!!item.archived} open={openId === item.id} busy={busyId !== null} canDelete
              onOpen={() => setOpenId(item.id)} onClose={closeRow} onArchive={() => { void act(item); }} onDelete={() => { setActionError(null); setDeleting(item); }}>
              {(bind) => (
                <View style={styles.rowWrap}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${title}${unread ? `, ${unread} unread ${unread === 1 ? "reply" : "replies"}` : ""}${item.shared === true ? ", shared with everyone" : ""}${lastLine(item, "You") ? `. ${lastLine(item, "You")}` : ""}`}
                  onPress={() => bind.onPress(() => {
                    // Clear the badge right away; the chat screen tells the server.
                    if (unread) setChats(list => list?.map(chat => chat.id === item.id ? { ...chat, unread: 0 } : chat) ?? list);
                    router.push({ pathname: "/chat/[id]", params: { id: item.id, title: item.title } });
                  })}
                  onLongPress={bind.onLongPress}
                  accessibilityActions={bind.accessibilityActions}
                  onAccessibilityAction={bind.onAccessibilityAction}
                  style={({ pressed }) => [styles.row, bind.trailing ? styles.rowWithTrailing : null, pressed && { backgroundColor: colors.surface }]}
                >
                  <View style={styles.agentIcon}><AppIcon name={item.mode === "vibe" ? "code" : "sparkles"} size={19} color={colors.blueDark} /></View>
                  <View style={styles.rowCopy}>
                    <View style={styles.rowTop}>
                      <Text style={[styles.rowTitle, styles.readTitle, unread > 0 && styles.unreadTitle]} numberOfLines={1}>{title}</Text>
                      <Text style={[styles.rowWhen, unread > 0 && styles.unreadWhen]}>{when(item.updatedAt)}</Text>
                    </View>
                    {item.mode === "vibe" || item.project ? <Text style={styles.projectTag} numberOfLines={1}>{[item.project?.name, item.mode === "vibe" ? "Vibe coding" : null].filter(Boolean).join(" · ")}</Text> : null}
                    <View style={styles.rowTop}>
                      {activeAgentTurn(item.latestTurn) ? <View style={styles.turnLive}>{item.latestTurn!.status === 'running'
                          ? <LiveStatus text={liveAgentLine(item.latestTurn)} style={styles.turnLiveText} />
                          : <Text style={styles.turnLabel} numberOfLines={1}>{agentTurnLabel(item.latestTurn!)}</Text>}</View>
                        : <View style={styles.privateTag}>
                          {item.shared === true ? <AppIcon name="people" size={12} color={colors.muted} /> : null}
                          <Text style={[styles.preview, unread > 0 && { color: colors.ink }]} numberOfLines={1}>{lastLine(item, "You") || (item.shared === true ? "Shared" : "")}</Text>
                        </View>}
                      {unread > 0 ? <View style={styles.unreadBadge}><Text style={styles.unreadBadgeText}>{unread > 99 ? "99+" : unread}</Text></View> : null}
                    </View>
                  </View>
                </Pressable>
                {/* Beside the row, not inside it: a button can't hold a button on the web. */}
                {bind.trailing}
                </View>
              )}
            </SwipeRow>
          );
        }}
        ListFooterComponent={shared.length && view === "active" ? <View>
          <Text accessibilityRole="header" style={styles.sectionTitle}>{account.user.role === "owner" ? "Everyone's conversations" : "Shared by others"}</Text>
          {shared.map(item => <Pressable key={item.id} accessibilityRole="button"
            accessibilityLabel={`${item.title.replace(/`/g, "")}, by ${item.author?.name ?? "someone"}${item.shared === false ? ", private" : ""}${lastLine(item, item.author?.name ?? "Someone", "Agent") ? `. ${lastLine(item, item.author?.name ?? "Someone", "Agent")}` : ""}`}
            onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id, title: item.title, readOnly: "1", author: item.author?.name ?? "" } })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
            <View style={styles.agentIcon}><AppIcon name="sparkles" size={19} color={colors.blueDark} /></View>
            <View style={styles.rowCopy}>
              <View style={styles.rowTop}>
                <Text style={[styles.rowTitle, styles.readTitle]} numberOfLines={1}>{item.title.replace(/`/g, "")}</Text>
                <Text style={styles.rowWhen}>{when(item.updatedAt)}</Text>
              </View>
              <View style={styles.rowTop}>
                <View style={styles.privateTag}>
                  {item.shared === false ? <AppIcon name="lock" size={12} color={colors.muted} /> : null}
                  <Text style={styles.preview} numberOfLines={1}>{lastLine(item, item.author?.name ?? "Someone", "Agent") || (item.author?.name ?? "Someone")}{item.shared === false ? " · Private (visible to admins)" : ""}</Text>
                </View>
              </View>
            </View>
          </Pressable>)}
        </View> : undefined}
        contentContainerStyle={{ paddingBottom: space.xxl }}
      />
      <ConfirmDialog visible={!!deleting} title="Delete this conversation?"
        description="This permanently deletes your conversation with the agent and everything in it. This can't be undone."
        confirmLabel="Delete conversation" busy={busyId !== null} error={actionError}
        onCancel={() => { setDeleting(null); setActionError(null); }} onConfirm={() => { if (deleting) void act(deleting, true); }} />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  inbox: { marginHorizontal: space.side, marginBottom: space.md, padding: space.md, backgroundColor: colors.blueSoft, borderRadius: radius.lg },
  inboxTitle: { ...typography.bodyStrong, color: colors.brandText, marginBottom: space.xs },
  approvalRow: { paddingVertical: space.xs, gap: space.xxs }, approvalDetail: { ...typography.caption, color: colors.ink }, review: { ...typography.captionStrong, color: colors.blue },
  rowCopy: { flex: 1, minWidth: 0 }, rowTop: { flexDirection: "row", alignItems: "center" }, byline: { ...typography.meta, color: colors.muted, marginTop: space.xxs }, privateTag: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xxs, marginTop: space.xxs, marginRight: space.sm }, preview: { ...typography.caption, color: colors.muted, flexShrink: 1 }, turnLive: { flex: 1, minWidth: 0, marginTop: space.xxs, marginRight: space.sm }, turnLiveText: { ...typography.meta, color: colors.blue }, turnLabel: { ...typography.meta, flex: 1, color: colors.blue, marginTop: space.xxs, marginRight: space.sm },
  header: { minHeight: 60, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs },
  title: { ...typography.title, color: colors.ink, flexShrink: 1 },
  compose: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  error: { ...typography.caption, marginBottom: space.sm, marginHorizontal: space.side, color: colors.red },
  sectionTitle: { ...typography.label, color: colors.muted, paddingHorizontal: space.side, paddingTop: space.sm, paddingBottom: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  retry: { marginHorizontal: space.side },
  rowWrap: { flexDirection: "row", alignItems: "center", backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
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
  agentIcon: { width: 36, height: 36, marginRight: space.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft, borderRadius: radius.sm },
  projectTag: { ...typography.meta, color: colors.blueDark, marginTop: 1 },
  rowTitle: { ...typography.bodyStrong, flex: 1, color: colors.ink, marginRight: space.sm },
  rowWhen: { ...typography.caption, color: colors.muted },
  // Telegram-style: only your own conversations with unread replies are bold. Other people's are always read.
  readTitle: { fontWeight: "400" },
  unreadTitle: { fontWeight: "700" },
  unreadWhen: { color: colors.blue },
  unreadBadge: { minWidth: 22, minHeight: 22, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  unreadBadgeText: { ...typography.captionStrong, color: colors.onPrimary },
  // Same filter row as the DM tab.
  filters: { flexDirection: "row", gap: space.xs, paddingHorizontal: space.side, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  filter: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.sm, justifyContent: "center", borderRadius: radius.md },
  selectedFilter: { backgroundColor: colors.blueSoft },
  filterText: { ...typography.bodyStrong, color: colors.muted },
  selectedFilterText: { color: colors.blueDark },
  empty: { marginTop: space.xxl, alignItems: "center", paddingHorizontal: space.side },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyBody: { ...typography.body, marginTop: space.xs, color: colors.muted, textAlign: "center", maxWidth: 360 },
  emptyAction: { alignSelf: "stretch", marginTop: space.lg, marginBottom: space.xl },
}));
