import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { PageTitle } from "./Band";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { SwipeChannelRow } from "./SwipeChannelRow";
import { api, ServerError, type Conversation, type BrowseChannel } from "../lib/server";
import { useChannelDiscovery } from "../lib/channel-discovery";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { colors, space, typography } from "../lib/theme";

type ChannelRow =
  | { id: string; joined: Conversation }
  | { id: string; other: BrowseChannel }
  | { id: "your-heading" | "empty-joined" | "archive-link" | "discover-heading" };

export function ChannelList({ archived = false }: { archived?: boolean }) {
  const { account } = useSession();
  const discovery = useChannelDiscovery(!archived);
  const { conversations, error, refresh, connected } = useLive();
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = useRef(false);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeRow = useCallback(() => setOpenId(null), []);

  const act = async (c: Conversation, remove = false) => {
    if (!account || busy.current) return;
    busy.current = true;
    setBusyId(c.id);
    setActionError(null);
    try {
      if (remove) await api.deleteChannel(account, c.id);
      else if (c.archived) await api.restoreChannel(account, c.id);
      else await api.archiveChannel(account, c.id);
      setDeleting(null);
      closeRow();
      await refresh();
    } catch (e) {
      setActionError(e instanceof ServerError ? e.message : "Couldn't update the channel. Try again.");
    } finally {
      busy.current = false;
      setBusyId(null);
    }
  };

  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  if (!account) return null;

  const channels = (conversations ?? []).filter(c => c.kind === "channel");
  const list = channels.filter(c => !!c.archived === archived);
  const archivedCount = channels.filter(c => c.archived).length;
  const joinedIds = new Set(channels.map(c => c.id));
  const others = discovery.channels.filter(c => !joinedIds.has(c.id));
  const rows: ChannelRow[] = archived
    ? list.map(c => ({ id: c.id, joined: c }))
    : conversations === null ? [] : [
      { id: "your-heading" },
      ...list.map(c => ({ id: c.id, joined: c })),
      ...(!list.length ? [{ id: "empty-joined" as const }] : []),
      { id: "archive-link" },
      ...(others.length ? [{ id: "discover-heading" as const }, ...others.map(c => ({ id: c.id, other: c }))] : []),
    ];

  return (
    <View style={styles.root}>
      <FlatList
        data={rows}
        keyExtractor={item => item.id}
        extraData={{ openId, busyId, archivedCount }}
        onEndReached={() => { if (!archived && !discovery.error) void discovery.more(); }}
        onEndReachedThreshold={0.4}
        onScrollBeginDrag={closeRow}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.blue} onRefresh={async () => {
          setRefreshing(true);
          try { await Promise.all([refresh(), discovery.refresh()]); }
          finally { setRefreshing(false); }
        }} />}
        ListHeaderComponent={<View>
          {archived ? <Text style={styles.archiveIntro}>Past conversations, kept for reference. Restore a channel to bring it back to your list.</Text> :
            <PageTitle description="Conversations organized by team and topic." action={<Button compact label="New channel" onPress={() => router.push("/new-channel")} />}>Channels</PageTitle>}
          {actionError && !deleting ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
          {error && conversations !== null ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {!connected && conversations !== null ? <Text style={styles.note}>Reconnecting… Your conversations are still here.</Text> : null}
        </View>}
        ListEmptyComponent={conversations === null ?
          error ? <View style={styles.empty}><Text accessibilityRole="alert" style={styles.errorText}>{error}</Text><Button label="Try again" kind="secondary" onPress={() => { void refresh(); }} /></View> :
            <ActivityIndicator accessibilityLabel="Loading channels" style={styles.loading} color={colors.blue} /> :
          <View style={styles.empty}>
            <Text accessibilityRole="header" style={styles.emptyTitle}>No archived channels</Text>
            <Text style={styles.emptyBody}>Channels you archive will appear here. Their messages stay available for reference.</Text>
            <Button label="Back to channels" kind="secondary" onPress={() => router.replace("/channels")} />
          </View>}
        renderItem={({ item }) => {
          if ("joined" in item) {
            const c = item.joined;
            return <SwipeChannelRow c={c} open={openId === c.id} busy={busyId !== null}
              canDelete={c.name !== "general" && (account.user.role === "owner" || c.createdBy === account.user.id)}
              onOpen={() => setOpenId(c.id)} onClose={closeRow}
              onPress={() => router.push({ pathname: "/c/[id]", params: { id: c.id } })}
              onArchive={() => { void act(c); }} onDelete={() => { setActionError(null); setDeleting(c); }} />;
          }
          if ("other" in item) return <Pressable accessibilityRole="button" accessibilityLabel={`Preview #${item.other.name}`} accessibilityHint="Read this public channel before joining"
            onPress={() => router.push({ pathname: "/c/[id]", params: { id: item.id } })}
            style={({ pressed }) => [styles.otherRow, pressed && styles.pressed]}>
            <View style={styles.otherContent}>
              <Text style={styles.otherName} numberOfLines={2}>#{item.other.name}</Text>
              {item.other.topic ? <Text style={styles.otherTopic} numberOfLines={2}>{item.other.topic}</Text> : null}
              <Text style={styles.otherCount}>{item.other.memberCount} {item.other.memberCount === 1 ? "member" : "members"}</Text>
            </View>
            <Text style={styles.preview}>Preview</Text>
          </Pressable>;
          if (item.id === "your-heading") return <View style={styles.section}><Text accessibilityRole="header" style={styles.sectionTitle}>Your channels</Text><Text style={styles.sectionCount}>{list.length}</Text></View>;
          if (item.id === "empty-joined") return <View style={styles.emptyJoined}><Text style={styles.emptyTitle}>Find your first conversation</Text><Text style={styles.emptyBody}>Join a channel below or create one for your team.</Text></View>;
          if (item.id === "archive-link") return <Pressable accessibilityRole="button" accessibilityLabel={`Archived channels, ${archivedCount}`} accessibilityHint="Open past conversations"
            onPress={() => { closeRow(); router.push("/archived-channels"); }} style={({ pressed }) => [styles.archiveLink, pressed && styles.pressed]}>
            <Text style={styles.archiveLabel}>Archived channels</Text>
            <View style={styles.archiveDetail}><Text style={styles.archiveCount}>{archivedCount}</Text><Text style={styles.chevron} accessibilityElementsHidden importantForAccessibility="no">›</Text></View>
          </Pressable>;
          return <View style={styles.discoverSection}><Text accessibilityRole="header" style={styles.sectionTitle}>Discover channels</Text><Text style={styles.sectionDescription}>Public conversations you can join.</Text></View>;
        }}
        ListFooterComponent={!archived ? discovery.loading ? <ActivityIndicator accessibilityLabel="Loading more channels" style={styles.loading} color={colors.blue} /> : discovery.error ?
          <View style={styles.discoveryError}><Text accessibilityRole="alert" style={styles.errorText}>Couldn't load channels to discover.</Text><Button label="Try again" kind="link" onPress={discovery.retry} /></View> : undefined : undefined}
        contentContainerStyle={styles.content}
      />
      <ConfirmDialog visible={!!deleting} title={`Delete #${deleting?.title ?? "channel"}?`}
        description="This permanently deletes the channel and all its messages for everyone. This can't be undone."
        confirmLabel="Delete channel" busy={busyId !== null} error={actionError}
        onCancel={() => { setDeleting(null); setActionError(null); }} onConfirm={() => { if (deleting) void act(deleting, true); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  content: { paddingBottom: 120 },
  archiveIntro: { ...typography.body, color: colors.muted, margin: space.side },
  section: { paddingHorizontal: space.side, paddingTop: space.sm, paddingBottom: space.xs, flexDirection: "row", alignItems: "center", gap: space.xs },
  sectionTitle: { ...typography.label, color: colors.ink },
  sectionCount: { ...typography.caption, color: colors.muted },
  discoverSection: { marginTop: space.lg, paddingTop: space.lg, paddingBottom: space.xs, paddingHorizontal: space.side, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  sectionDescription: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  otherRow: { minHeight: 76, paddingHorizontal: space.side, paddingVertical: space.md, flexDirection: "row", alignItems: "center", gap: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  otherContent: { flex: 1, minWidth: 0 },
  otherName: { ...typography.bodyStrong, color: colors.ink },
  otherTopic: { ...typography.body, color: colors.muted, marginTop: space.xxs },
  otherCount: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  preview: { ...typography.label, color: colors.blue },
  archiveLink: { minHeight: 48, paddingHorizontal: space.side, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  archiveLabel: { ...typography.caption, color: colors.muted, flexShrink: 1 },
  archiveDetail: { flexDirection: "row", alignItems: "center", gap: space.sm },
  archiveCount: { ...typography.caption, color: colors.muted },
  chevron: { ...typography.heading, color: colors.muted },
  pressed: { backgroundColor: colors.surface },
  error: { ...typography.caption, marginHorizontal: space.side, marginBottom: space.sm, color: colors.red },
  errorText: { ...typography.caption, color: colors.red },
  note: { ...typography.caption, marginHorizontal: space.side, marginBottom: space.sm, color: colors.muted },
  empty: { marginTop: space.xxl, alignItems: "center", paddingHorizontal: space.lg, gap: space.sm },
  emptyJoined: { padding: space.side, gap: space.xs },
  emptyTitle: { ...typography.heading, color: colors.ink },
  emptyBody: { ...typography.body, color: colors.muted },
  loading: { margin: space.lg },
  discoveryError: { padding: space.side, alignItems: "center" },
});
