import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConversationRow } from "./Messaging";
import { SwipeChannelRow } from "./SwipeChannelRow";
import { api, ServerError, type Conversation, type BrowseChannel } from "../lib/server";
import { useChannelDiscovery } from "../lib/channel-discovery";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

type HomeRow =
  | { kind: "channel" | "dm"; id: string; conversation: Conversation }
  | { kind: "other"; id: string; channel: BrowseChannel }
  | { kind: "section"; id: "channels-section" | "dms-section" }
  | { kind: "action"; id: "add-channels" | "new-message" | "archive-link" }
  | { kind: "note"; id: string; text: string }
  | { kind: "discovery"; id: "discovery-header" | "discovery-status" };

export function ChannelList({ archived = false }: { archived?: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const { conversations, error, refresh, connected } = useLive();
  const reconnecting = !connected && conversations !== null;
  const [refreshing, setRefreshing] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const discovery = useChannelDiscovery(!archived && discovering);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = useRef(false);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeRow = useCallback(() => setOpenId(null), []);

  const reload = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await Promise.all([refresh(), discovery.refresh()]); }
    finally { setRefreshing(false); }
  };
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
  const activeChannels = channels.filter(c => !c.archived);
  const archivedChannels = channels.filter(c => c.archived);
  const dms = (conversations ?? []).filter(c => c.kind === "dm" && !c.archived);
  const shownChannels = activeChannels.filter(c => !unreadOnly || c.unread > 0);
  const shownDms = dms.filter(c => !unreadOnly || c.unread > 0);
  const unreadCount = [...activeChannels, ...dms].filter(c => c.unread > 0).length;
  const joinedIds = new Set(channels.map(c => c.id));
  const others = discovery.channels.filter(c => !joinedIds.has(c.id));
  const rows: HomeRow[] = [];
  if (archived) {
    rows.push(...archivedChannels.map(c => ({ kind: "channel" as const, id: c.id, conversation: c })));
  } else if (conversations !== null) {
    rows.push({ kind: "section", id: "channels-section" });
    if (channelsOpen) {
      rows.push(...shownChannels.map(c => ({ kind: "channel" as const, id: c.id, conversation: c })));
      if (!shownChannels.length) rows.push({ kind: "note", id: "empty-channels", text: unreadOnly ? "No unread channels" : "No channels yet. Add one to get started." });
      if (!unreadOnly) {
        rows.push({ kind: "action", id: "add-channels" });
        if (discovering) {
          rows.push({ kind: "discovery", id: "discovery-header" });
          rows.push(...others.map(c => ({ kind: "other" as const, id: `discover-${c.id}`, channel: c })));
          rows.push({ kind: "discovery", id: "discovery-status" });
        }
      }
      rows.push({ kind: "action", id: "archive-link" });
    }
    rows.push({ kind: "section", id: "dms-section" });
    if (dmsOpen) {
      rows.push(...shownDms.map(c => ({ kind: "dm" as const, id: c.id, conversation: c })));
      if (!shownDms.length) rows.push({ kind: "note", id: "empty-dms", text: unreadOnly ? "No unread direct messages" : "Your direct conversations will appear here." });
      if (!unreadOnly) rows.push({ kind: "action", id: "new-message" });
    }
  }

  return (
    <View style={styles.root}>
      <FlatList
        data={rows}
        keyExtractor={item => item.id}
        extraData={{ openId, busyId, channelsOpen, dmsOpen, discovering }}
        onEndReached={() => { if (discovering && channelsOpen && !unreadOnly && !discovery.error) void discovery.more(); }}
        onEndReachedThreshold={0.4}
        onScrollBeginDrag={closeRow}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.blue} onRefresh={() => void reload()} />}
        ListHeaderComponent={<View>
          {archived ? <Text style={styles.archiveIntro}>Restore a channel to bring it back to Home.</Text> : <View style={styles.filters}>
            {[false, true].map(value => <Pressable key={String(value)} accessibilityRole="button" accessibilityLabel={value ? `Unread conversations, ${unreadCount}` : "All conversations"} accessibilityState={{ selected: unreadOnly === value }}
              onPress={() => { setUnreadOnly(value); closeRow(); }} style={({ pressed }) => [styles.filter, unreadOnly === value && styles.selectedFilter, pressed && styles.pressed]}>
              <Text style={[styles.filterText, unreadOnly === value && styles.selectedFilterText]}>{value ? "Unread" : "All"}</Text>
              {value && unreadCount ? <Text style={[styles.filterCount, unreadOnly && styles.selectedFilterText]}>{unreadCount}</Text> : null}
            </Pressable>)}
          </View>}
          {actionError && !deleting ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
          {error && conversations !== null ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {/* Keep the status line measured so reconnecting never moves the list. */}
          <Text aria-hidden={!reconnecting} style={[styles.note, { opacity: reconnecting ? 1 : 0 }]}>Reconnecting…</Text>
        </View>}
        ListEmptyComponent={conversations === null ?
          error ? <View style={styles.empty}><Text accessibilityRole="alert" style={styles.errorText}>{error}</Text><Button label="Try again" kind="secondary" busy={refreshing} onPress={() => void reload()} /></View> :
            <ActivityIndicator accessibilityLabel="Loading conversations" style={styles.loading} color={colors.blue} /> :
          <View style={styles.empty}>
            <AppIcon name="archive" size={28} color={colors.muted} />
            <Text accessibilityRole="header" style={styles.emptyTitle}>No archived channels</Text>
            <Text style={styles.emptyBody}>Archived channels stay here until you restore them.</Text>
            <Button label="Back to Home" kind="secondary" onPress={() => router.dismissTo("/channels")} />
          </View>}
        renderItem={({ item }) => {
          if (item.kind === "channel") {
            const c = item.conversation;
            return <SwipeChannelRow c={c} compact open={openId === c.id} busy={busyId !== null}
              canDelete={c.name !== "general" && (account.user.role === "owner" || c.createdBy === account.user.id)}
              onOpen={() => setOpenId(c.id)} onClose={closeRow}
              onPress={() => router.push({ pathname: "/c/[id]", params: { id: c.id } })}
              onArchive={() => { void act(c); }} onDelete={() => { setActionError(null); setDeleting(c); }} />;
          }
          if (item.kind === "dm") return <ConversationRow c={item.conversation} compact onPress={() => router.push({ pathname: "/c/[id]", params: { id: item.conversation.id } })} />;
          if (item.kind === "section") {
            const isChannels = item.id === "channels-section";
            const expanded = isChannels ? channelsOpen : dmsOpen;
            const title = isChannels ? "Channels" : "Direct messages";
            return <View style={styles.section}>
              <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }} onPress={() => { closeRow(); if (isChannels) setChannelsOpen(value => !value); else setDmsOpen(value => !value); }} style={styles.sectionToggle}>
                <AppIcon name={expanded ? "chevronDown" : "chevronRight"} size={16} color={colors.muted} />
                <Text style={styles.sectionTitle}>{title}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={isChannels ? "Create a channel" : "New direct message"} onPress={() => router.push(isChannels ? "/new-channel" : "/new-message")} style={styles.iconButton}>
                <AppIcon name="plus" size={18} color={colors.muted} />
              </Pressable>
            </View>;
          }
          if (item.kind === "note") return <Text style={styles.sectionNote}>{item.text}</Text>;
          if (item.kind === "action") {
            if (item.id === "archive-link") return <Pressable accessibilityRole="button" accessibilityLabel={`Archived channels, ${archivedChannels.length}`} onPress={() => { closeRow(); router.push("/archived-channels"); }} style={({ pressed }) => [styles.quietRow, pressed && styles.pressed]}>
              <View style={styles.actionIcon}><AppIcon name="archive" size={17} color={colors.muted} /></View>
              <Text style={styles.quietLabel}>Archived channels</Text>
              {archivedChannels.length ? <Text style={styles.quietCount}>{archivedChannels.length}</Text> : null}
            </Pressable>;
            const addChannels = item.id === "add-channels";
            return <Pressable accessibilityRole="button" accessibilityState={addChannels ? { expanded: discovering } : undefined} onPress={() => { closeRow(); if (addChannels) setDiscovering(value => !value); else router.push("/new-message"); }} style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}>
              <View style={styles.actionIcon}><AppIcon name="plus" size={18} color={colors.muted} /></View>
              <Text style={styles.actionLabel}>{addChannels ? "Add channels" : "New message"}</Text>
            </Pressable>;
          }
          if (item.kind === "other") return <Pressable accessibilityRole="button" accessibilityLabel={`Preview #${item.channel.name}`} accessibilityHint="Read this public channel before joining"
            onPress={() => router.push({ pathname: "/c/[id]", params: { id: item.channel.id } })} style={({ pressed }) => [styles.otherRow, pressed && styles.pressed]}>
            <AppIcon name="hash" size={18} color={colors.muted} />
            <View style={styles.otherContent}>
              <Text style={styles.otherName} numberOfLines={1}>{item.channel.name}</Text>
              <Text style={styles.otherTopic} numberOfLines={1}>{item.channel.topic || `${item.channel.memberCount} ${item.channel.memberCount === 1 ? "member" : "members"}`}</Text>
            </View>
            <AppIcon name="chevronRight" size={16} color={colors.muted} />
          </Pressable>;
          if (item.id === "discovery-header") return <View style={styles.discoveryHeader}>
            <Text accessibilityRole="header" style={styles.discoveryTitle}>Browse public channels</Text>
            <Button compact kind="link" label="Create new" onPress={() => router.push("/new-channel")} />
          </View>;
          return discovery.loading ? <ActivityIndicator accessibilityLabel="Loading channels to join" style={styles.loading} color={colors.blue} /> : discovery.error ?
            <View style={styles.discoveryStatus}><Text accessibilityRole="alert" style={styles.errorText}>Couldn't load channels.</Text><Button compact label="Try again" kind="link" onPress={discovery.retry} /></View> : discovery.hasMore ?
              <Button compact label="Load more channels" kind="link" onPress={() => void discovery.more()} /> : !others.length ?
              <Text style={styles.sectionNote}>You've joined all available public channels.</Text> : null;
        }}
        contentContainerStyle={styles.content}
      />
      <ConfirmDialog visible={!!deleting} title={`Delete #${deleting?.title ?? "channel"}?`}
        description="This permanently deletes the channel and all its messages for everyone. This can't be undone."
        confirmLabel="Delete channel" busy={busyId !== null} error={actionError}
        onCancel={() => { setDeleting(null); setActionError(null); }} onConfirm={() => { if (deleting) void act(deleting, true); }} />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xxl },
  filters: { flexDirection: "row", gap: space.xs, paddingHorizontal: space.side, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  filter: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.xs, borderRadius: radius.md },
  selectedFilter: { backgroundColor: colors.blueSoft },
  filterText: { ...typography.bodyStrong, color: colors.muted },
  selectedFilterText: { color: colors.blueDark },
  filterCount: { ...typography.label, color: colors.muted },
  section: { flexDirection: "row", alignItems: "center", paddingLeft: space.side, paddingRight: space.xs, marginTop: space.sm },
  sectionToggle: { minHeight: 44, flex: 1, flexDirection: "row", alignItems: "center", gap: space.xs },
  sectionTitle: { ...typography.bodyStrong, color: colors.ink, flexShrink: 1 },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  sectionNote: { ...typography.caption, color: colors.muted, paddingLeft: space.side + 38, paddingRight: space.side, paddingVertical: space.xs },
  actionRow: { minHeight: 44, paddingHorizontal: space.side, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm },
  actionIcon: { width: 26, alignItems: "center" },
  actionLabel: { ...typography.body, color: colors.muted, flexShrink: 1 },
  quietRow: { minHeight: 44, paddingHorizontal: space.side, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm },
  quietLabel: { ...typography.caption, color: colors.muted, flexShrink: 1 },
  quietCount: { ...typography.caption, color: colors.muted, marginLeft: "auto" },
  archiveIntro: { ...typography.body, color: colors.muted, margin: space.side },
  discoveryHeader: { marginTop: space.xs, marginHorizontal: space.side, paddingLeft: space.lg, paddingVertical: space.xxs, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.xs, backgroundColor: colors.surface, borderRadius: radius.sm },
  discoveryTitle: { ...typography.label, color: colors.muted, flexShrink: 1 },
  otherRow: { minHeight: 60, paddingLeft: space.side + 24, paddingRight: space.side, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm },
  otherContent: { flex: 1, minWidth: 0 },
  otherName: { ...typography.body, color: colors.ink },
  otherTopic: { ...typography.caption, color: colors.muted, marginTop: 2 },
  discoveryStatus: { paddingHorizontal: space.side, flexDirection: "row", alignItems: "center", justifyContent: "center", flexWrap: "wrap" },
  pressed: { backgroundColor: colors.surface },
  error: { ...typography.caption, marginHorizontal: space.side, marginVertical: space.xs, color: colors.red },
  errorText: { ...typography.caption, color: colors.red },
  note: { ...typography.caption, marginHorizontal: space.side, marginVertical: space.xs, color: colors.muted },
  empty: { marginTop: space.xxl, alignItems: "center", paddingHorizontal: space.lg, gap: space.sm },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, color: colors.muted, textAlign: "center" },
  loading: { margin: space.lg },
}));
