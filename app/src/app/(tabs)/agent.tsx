import { useCallback, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { AppIcon } from "../../components/AppIcon";
import { Button } from "../../components/Button";
import { api, ServerError, type Chat } from "../../lib/server";
import { useSession } from "../../lib/session";
import { radius, space, typography, useTheme, createThemedStyles } from "../../lib/theme";
import { activeAgentTurn, agentTurnLabel } from '../../lib/agent-turns';

function when(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function Chats() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount, signOut } = useSession();
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [shared, setShared] = useState<Chat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    if (!account) return;
    try {
      const { mine, others } = await api.orgChats(account, setAccount);
      setChats(mine);
      setShared(others);
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
  }, [account, setAccount, signOut]);

  useFocusEffect(
    useCallback(() => {
      void load();
      const timer = setInterval(() => { if (AppState.currentState === 'active') void load(); }, 5000);
      const subscription = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
      return () => { clearInterval(timer); subscription.remove(); };
    }, [load]),
  );

  if (!account) return null;

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const chat = await api.newChat(account);
      router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't start a chat");
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={styles.root}>
      <FlatList
        data={chats ?? []}
        keyExtractor={(c) => c.id}
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
              <Pressable accessibilityRole="button" accessibilityLabel="New agent conversation" accessibilityState={{ disabled: starting, busy: starting }} disabled={starting} onPress={start} style={styles.compose}>
                {starting ? <ActivityIndicator color={colors.blue} /> : <AppIcon name="compose" size={22} color={colors.ink} />}
              </Pressable>
            </View>
            <Text style={styles.description}>Your conversations with the agent. They're shared with {account.serverName} so people can learn from each other's prompts. Turn sharing off in any chat.</Text>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {account.user.role === 'owner' && chats?.some(chat => chat.latestTurn?.status === 'waiting_for_approval') ? <View style={styles.inbox}>
              <Text accessibilityRole="header" style={styles.inboxTitle}>Needs your approval</Text>
              {chats.filter(chat => chat.latestTurn?.status === 'waiting_for_approval').map(chat => <Pressable key={chat.id} accessibilityRole="button" accessibilityLabel={`Review action in ${chat.title}`} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: chat.id, title: chat.title } })} style={styles.approvalRow}>
                <Text style={styles.rowTitle}>{chat.title}</Text><Text numberOfLines={2} style={styles.approvalDetail}>{chat.latestTurn?.approval?.description || 'Review this action to continue.'}</Text><Text style={styles.review}>Review action →</Text>
              </Pressable>)}
            </View> : null}
            {chats?.length ? <Text accessibilityRole="header" style={styles.sectionTitle}>Recent conversations</Text> : null}
          </View>
        }
        ListEmptyComponent={
          chats === null ? (
            error ? <Button label="Try again" kind="link" busy={refreshing} onPress={() => { setRefreshing(true); void load().finally(() => setRefreshing(false)); }} style={styles.retry} /> : <ActivityIndicator accessibilityLabel="Loading agent conversations" style={{ marginTop: space.xl }} color={colors.blue} />
          ) : (
            <View style={styles.empty}>
              <AppIcon name="sparkles" size={32} color={colors.blue} />
              <Text accessibilityRole="header" style={styles.emptyTitle}>Start with a question</Text>
              <Text style={styles.emptyBody}>Ask the agent for help, then return to your conversation here.</Text>
              <Button label="New conversation" onPress={start} busy={starting} style={styles.emptyAction} />
            </View>
          )
        }
        renderItem={({ item }) => {
          const unread = item.unread ?? 0;
          const title = item.title.replace(/`/g, "");
          return <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${title}${unread ? `, ${unread} unread ${unread === 1 ? "reply" : "replies"}` : ""}${item.shared === false ? ", private" : ""}`}
            onPress={() => {
              // Clear the badge right away; the chat screen tells the server.
              if (unread) setChats(list => list?.map(chat => chat.id === item.id ? { ...chat, unread: 0 } : chat) ?? list);
              router.push({ pathname: "/chat/[id]", params: { id: item.id, title: item.title } });
            }}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}
          >
            <View style={styles.agentIcon}><AppIcon name="sparkles" size={19} color={colors.blueDark} /></View>
            <View style={styles.rowCopy}><Text style={[styles.rowTitle, styles.readTitle, unread > 0 && styles.unreadTitle]} numberOfLines={1}>{title}</Text>
              {activeAgentTurn(item.latestTurn) ? <Text style={styles.turnLabel}>{agentTurnLabel(item.latestTurn!)}</Text>
                : item.shared === false ? <View style={styles.privateTag}><AppIcon name="lock" size={12} color={colors.muted} /><Text style={styles.byline}>Private</Text></View> : null}
            </View>
            <View style={styles.rowEnd}>
              <Text style={[styles.rowWhen, unread > 0 && styles.unreadWhen]}>{when(item.updatedAt)}</Text>
              {unread > 0 ? <View style={styles.unreadBadge}><Text style={styles.unreadBadgeText}>{unread > 99 ? "99+" : unread}</Text></View> : null}
            </View>
          </Pressable>;
        }}
        ListFooterComponent={shared.length ? <View>
          <Text accessibilityRole="header" style={styles.sectionTitle}>{account.user.role === "owner" ? "Everyone's conversations" : "Shared by others"}</Text>
          {shared.map(item => <Pressable key={item.id} accessibilityRole="button"
            accessibilityLabel={`${item.title.replace(/`/g, "")}, by ${item.author?.name ?? "someone"}${item.shared === false ? ", private" : ""}`}
            onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id, title: item.title, readOnly: "1", author: item.author?.name ?? "" } })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
            <View style={styles.agentIcon}><AppIcon name="sparkles" size={19} color={colors.blueDark} /></View>
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle} numberOfLines={1}>{item.title.replace(/`/g, "")}</Text>
              <View style={styles.privateTag}>
                {item.shared === false ? <AppIcon name="lock" size={12} color={colors.muted} /> : null}
                <Text style={styles.byline} numberOfLines={1}>{item.author?.name ?? "Someone"}{item.shared === false ? " · Private (visible to admins)" : ""}</Text>
              </View>
            </View>
            <Text style={styles.rowWhen}>{when(item.updatedAt)}</Text>
          </Pressable>)}
        </View> : undefined}
        contentContainerStyle={{ paddingBottom: space.xxl }}
      />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  inbox: { marginHorizontal: space.side, marginBottom: space.md, padding: space.md, backgroundColor: colors.blueSoft, borderRadius: radius.lg },
  inboxTitle: { ...typography.bodyStrong, color: colors.brandText, marginBottom: space.xs },
  approvalRow: { paddingVertical: space.xs, gap: space.xxs }, approvalDetail: { ...typography.caption, color: colors.ink }, review: { ...typography.captionStrong, color: colors.blue },
  rowCopy: { flex: 1 }, byline: { ...typography.meta, color: colors.muted, marginTop: space.xxs }, privateTag: { flexDirection: "row", alignItems: "center", gap: space.xxs, marginTop: space.xxs }, turnLabel: { ...typography.meta, color: colors.blue, marginTop: space.xxs },
  header: { minHeight: 60, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs },
  title: { ...typography.title, color: colors.ink, flexShrink: 1 },
  compose: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  description: { ...typography.caption, color: colors.muted, paddingHorizontal: space.side, paddingBottom: space.md },
  error: { ...typography.caption, marginBottom: space.sm, marginHorizontal: space.side, color: colors.red },
  sectionTitle: { ...typography.label, color: colors.muted, paddingHorizontal: space.side, paddingTop: space.sm, paddingBottom: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  retry: { marginHorizontal: space.side },
  row: {
    minHeight: 64,
    paddingVertical: space.sm,
    paddingHorizontal: space.side,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  agentIcon: { width: 36, height: 36, marginRight: space.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft, borderRadius: radius.sm },
  rowTitle: { ...typography.bodyStrong, flex: 1, color: colors.ink, marginRight: space.sm },
  rowWhen: { ...typography.caption, color: colors.muted },
  rowEnd: { alignItems: "flex-end", justifyContent: "center", gap: space.xxs, minHeight: 48 },
  // Telegram-style: only conversations with unread replies are bold.
  readTitle: { fontWeight: "400" },
  unreadTitle: { fontWeight: "700" },
  unreadWhen: { color: colors.blue },
  unreadBadge: { minWidth: 22, minHeight: 22, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  unreadBadgeText: { ...typography.captionStrong, color: colors.onPrimary },
  empty: { marginTop: space.xxl, alignItems: "center", paddingHorizontal: space.side },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyBody: { ...typography.body, marginTop: space.xs, color: colors.muted, textAlign: "center", maxWidth: 360 },
  emptyAction: { marginTop: space.lg },
}));
