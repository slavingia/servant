import { Radio } from "./Radio";
import { memo, useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect, useIsFocused, useScrollToTop } from "expo-router";
import { useWhileHidden } from "../lib/hidden-screen";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { PageTitle } from "./Band";
import { EmailNudge } from "./EmailNudge";
import { SkeletonRows } from "./Skeleton";
import { HomeListSkeleton } from "./HomeSkeleton";
import { SwipeChannelRow, useConversationActions } from "./SwipeChannelRow";
import { ReorderableList } from "./ReorderableList";
import { ChannelSortSheet } from "./ChannelSortSheet";
import { CHANNEL_SORTS, sortChannels, withPositions } from "../lib/channel-sort";
import { setChannelSort, setPendingOrder, useChannelSort } from "../lib/channel-sort-store";
import { NewProjectDialog } from "./NewProjectDialog";
import { refreshProjects, useProjects } from "../lib/projects-store";
import { api } from "../lib/server";
import { type Conversation, type BrowseChannel, type Project } from "../lib/server";
import { useChannelDiscovery } from "../lib/channel-discovery";
import { useLiveActions, useLiveList } from "../lib/live";
import { useSession } from "../lib/session";
import { openingConversation } from "../lib/conversation-cache";
import { landingHref, useFeatures } from "../lib/features";
import { radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../lib/theme";

type HomeRow =
  | { kind: "channel" | "dm"; id: string; conversation: Conversation }
  | { kind: "channels"; id: "channels"; channels: Conversation[] }
  | { kind: "other"; id: string; channel: BrowseChannel }
  | { kind: "project"; id: string; project: Project }
  | { kind: "section"; id: "projects-section" | "channels-section" | "dms-section" }
  | { kind: "action"; id: "add-channels" | "new-message" | "archive-link" | "new-project" }
  | { kind: "note"; id: string; text: string }
  | { kind: "discovery"; id: "discovery-header" | "discovery-status" };

export function ChannelList({ archived = false }: { archived?: boolean }) {
  // Under another screen the list is handed what it last showed until the changes pause (lib/hidden-screen.ts):
  // it does not draw every row for every message anywhere, and coming back draws nothing when nothing changed.
  const list = useWhileHidden(useLiveList(), useIsFocused());
  return <ChannelRows archived={archived} conversations={list.conversations} error={list.error} connected={list.connected} />;
}

const ChannelRows = memo(function ChannelRows({ archived, conversations, error, connected }: { archived: boolean; conversations: Conversation[] | null; error: string | null; connected: boolean }) {
  const styles = useStyles();
  // Tapping the tab you're already on scrolls back to the top.
  const scrollRef = useRef<FlatList<HomeRow>>(null);
  useScrollToTop(scrollRef);
  const { colors } = useTheme();
  const { account } = useSession();
  const { refresh } = useLiveActions();
  const reconnecting = !connected && conversations !== null;
  const [refreshing, setRefreshing] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(true);
  const [naming, setNaming] = useState(false);
  const projects = useProjects();
  const features = useFeatures();
  const [discovering, setDiscovering] = useState(false);
  const discovery = useChannelDiscovery(!archived && discovering);
  const { openId, busyId, closeRow, rowProps, dialog, actionError } = useConversationActions(account, refresh);
  const { sort, pending } = useChannelSort();
  const [sortOpen, setSortOpen] = useState(false);
  // Reorder mode: unlocked by a long press, ended with Done.
  const [reordering, setReordering] = useState(false);
  const [lifted, setLifted] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  const saveOrder = async (ids: string[]) => {
    if (!account) return;
    setChannelSort("custom");
    setPendingOrder(ids);
    setOrderError(null);
    try {
      await api.setChannelOrder(account, ids);
      await refresh();
    } catch {
      setOrderError("Couldn't save the new order. Try again.");
    } finally {
      setPendingOrder(null);
    }
  };

  const reload = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await Promise.all([refresh(), discovery.refresh()]); }
    finally { setRefreshing(false); }
  };
  useFocusEffect(useCallback(() => { void refresh(); if (account) void refreshProjects(account); }, [refresh, account]));
  if (!account) return null;
  // The conversation's request leaves at the press, before its screen is built (lib/conversation-cache.ts).
  const openConversation = (c: Conversation) => { openingConversation(account, c.id); router.push({ pathname: "/c/[id]", params: { id: c.id } }); };

  const channels = (conversations ?? []).filter(c => c.kind === "channel");
  const activeChannels = sortChannels(withPositions(channels.filter(c => !c.archived), pending), sort);
  const archivedChannels = channels.filter(c => c.archived);
  const dms = (conversations ?? []).filter(c => c.kind === "dm" && !c.archived);
  const archivedDms = (conversations ?? []).filter(c => c.kind === "dm" && c.archived);
  const archivedCount = archivedChannels.length + archivedDms.length;
  const shownChannels = activeChannels.filter(c => !unreadOnly || c.unread > 0);
  const shownDms = dms.filter(c => !unreadOnly || c.unread > 0);
  const unreadCount = [...(features.channels ? activeChannels : []), ...(features.directMessages ? dms : [])].filter(c => c.unread > 0).length;
  const joinedIds = new Set(channels.map(c => c.id));
  const others = discovery.channels.filter(c => !joinedIds.has(c.id));
  const rows: HomeRow[] = [];
  if (archived) {
    rows.push(...archivedChannels.map(c => ({ kind: "channel" as const, id: c.id, conversation: c })));
    rows.push(...archivedDms.map(c => ({ kind: "dm" as const, id: c.id, conversation: c })));
  } else if (conversations !== null) {
    // Projects first: they hold the team's releases, chats, notes and files. Hidden with the Unread filter (nothing to count).
    if (!unreadOnly && (account.user.role === "owner" || (projects?.list.length ?? 0) > 0)) {
      rows.push({ kind: "section", id: "projects-section" });
      if (projectsOpen) {
        rows.push(...(projects?.list ?? []).map(p => ({ kind: "project" as const, id: `project-${p.id}`, project: p })));
        if (projects && !projects.list.length) rows.push({ kind: "note", id: "empty-projects", text: "No projects" });
        rows.push({ kind: "action", id: "new-project" });
      }
    }
    // Deep work keeps Home for projects and hides the channels and chats under them.
    if (features.channels) rows.push({ kind: "section", id: "channels-section" });
    if (features.channels && channelsOpen) {
      if (shownChannels.length) rows.push({ kind: "channels", id: "channels", channels: shownChannels });
      if (!shownChannels.length) rows.push({ kind: "note", id: "empty-channels", text: unreadOnly ? "No unread channels" : "No channels" });
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
    if (features.directMessages) rows.push({ kind: "section", id: "dms-section" });
    if (features.directMessages && dmsOpen) {
      rows.push(...shownDms.map(c => ({ kind: "dm" as const, id: c.id, conversation: c })));
      if (!shownDms.length) rows.push({ kind: "note", id: "empty-dms", text: unreadOnly ? "No unread chats" : "No chats" });
      if (!unreadOnly) rows.push({ kind: "action", id: "new-message" });
    }
  }

  return (
    <View style={styles.root}>
      <FlatList ref={scrollRef} contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={item => item.id}
        extraData={{ openId, busyId, projectsOpen, channelsOpen, dmsOpen, discovering, reordering, sort }}
        scrollEnabled={!lifted}
        onEndReached={() => { if (discovering && channelsOpen && !unreadOnly && !discovery.error) void discovery.more(); }}
        onEndReachedThreshold={0.4}
        onScrollBeginDrag={closeRow}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.blue} onRefresh={() => void reload()} />}
        ListHeaderComponent={<View>
          {archived ? null : <PageTitle>Home</PageTitle>}
          {archived ? null : <EmailNudge />}
          {!archived ? <View accessibilityRole="radiogroup" accessibilityLabel="Show" style={styles.filters}>
            {[false, true].map(value => <Radio key={String(value)} accessibilityLabel={value ? `Unread conversations, ${unreadCount}` : "All conversations"} accessibilityState={{ checked: unreadOnly === value }} aria-checked={unreadOnly === value}
              onPress={() => { setUnreadOnly(value); closeRow(); }} style={({ pressed }) => [styles.filter, unreadOnly === value && styles.selectedFilter, pressed && styles.pressed]}>
              <Text style={[styles.filterText, unreadOnly === value && styles.selectedFilterText]}>{value ? "Unread" : "All"}</Text>
              {value && unreadCount ? <View style={styles.filterCount}><Text style={styles.filterCountText}>{unreadCount > 99 ? "99+" : unreadCount}</Text></View> : null}
            </Radio>)}
            {/* Reconnecting sits beside the filters, so it never takes a line or moves the list. */}
            <Text aria-hidden={!reconnecting} accessibilityLiveRegion="polite" style={[styles.status, { opacity: reconnecting ? 1 : 0 }]}>Reconnecting…</Text>
          </View> : null}
          {orderError ? <Text accessibilityRole="alert" style={styles.error}>{orderError}</Text> : null}
          {actionError ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
          {error && conversations !== null ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {archived && reconnecting ? <Text style={styles.note}>Reconnecting…</Text> : null}
        </View>}
        ListEmptyComponent={conversations === null ?
          error ? <View style={styles.empty}><Text accessibilityRole="alert" style={styles.errorText}>{error}</Text><Button label="Try again" kind="secondary" busy={refreshing} onPress={() => void reload()} /></View> :
            // Home loads in the shape the launch screen drew (HomeSkeleton.tsx), so opening the app never redraws it.
            archived ? <SkeletonRows label="Loading conversations" avatar={false} /> : <HomeListSkeleton label="Loading conversations" /> :
          <View style={styles.empty}>
            <AppIcon name="archive" size={28} color={colors.muted} />
            <Text accessibilityRole="header" style={styles.emptyTitle}>No archived conversations</Text>
            <Button label={features.home ? "Back to Home" : "Back to the agent"} kind="secondary" onPress={() => router.dismissTo(landingHref(features))} />
          </View>}
        renderItem={({ item }) => {
          if (item.kind === "channels") return <ReorderableList items={item.channels}
            onLift={() => {
              closeRow();
              // Dragging starts from what's on screen, then becomes the custom order.
              if (!reordering) setReordering(true);
              setLifted(true);
            }}
            onSettle={() => setLifted(false)}
            onDrop={ids => void saveOrder(ids)}
            renderRow={(c, drag) => <SwipeChannelRow {...rowProps(c)} compact drag={unreadOnly ? undefined : drag} reordering={reordering}
              onPress={() => openConversation(c)} />} />;
          if (item.kind === "channel" || item.kind === "dm") {
            const c = item.conversation;
            return <SwipeChannelRow {...rowProps(c)} compact onPress={() => openConversation(c)} />;
          }
          if (item.kind === "project") return <Pressable accessibilityRole="button" accessibilityLabel={item.project.name} onPress={() => { closeRow(); router.push({ pathname: "/project", params: { id: item.project.id } }); }} style={({ pressed }) => [styles.projectRow, pressed && styles.pressed]}>
            <View style={styles.projectIcon}><AppIcon name="project" size={19} color={colors.muted} /></View>
            <Text style={styles.projectName}>{item.project.name}</Text>
          </Pressable>;
          if (item.kind === "section") {
            const isProjects = item.id === "projects-section";
            const isChannels = item.id === "channels-section";
            const expanded = isProjects ? projectsOpen : isChannels ? channelsOpen : dmsOpen;
            const title = isProjects ? "Projects" : isChannels ? "Channels" : "Chats";
            return <View style={styles.section}>
              <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => { closeRow(); if (isProjects) setProjectsOpen(value => !value); else if (isChannels) setChannelsOpen(value => !value); else setDmsOpen(value => !value); }} style={styles.sectionToggle}>
                <AppIcon name={expanded ? "chevronDown" : "chevronRight"} size={16} color={colors.muted} />
                <Text style={styles.sectionTitle}>{title}</Text>
              </Pressable>
              {isChannels && reordering ? <Pressable accessibilityRole="button" accessibilityLabel="Done reordering" onPress={() => setReordering(false)} style={styles.sortButton}>
                <Text style={styles.doneText}>Done</Text>
              </Pressable> : isChannels ? <Pressable accessibilityRole="button" accessibilityLabel={`Sort channels, ${CHANNEL_SORTS.find(s => s.value === sort)?.label}`} onPress={() => { closeRow(); setSortOpen(true); }} style={styles.sortButton}>
                <Text style={styles.sortText}>{CHANNEL_SORTS.find(s => s.value === sort)?.label}</Text>
                <AppIcon name="chevronDown" size={14} color={colors.muted} />
              </Pressable> : null}
              {isChannels && reordering ? null : <Pressable accessibilityRole="button" accessibilityLabel={isProjects ? "New project" : isChannels ? "Create a channel" : "New message"} onPress={() => { if (isProjects) setNaming(true); else router.push(isChannels ? "/new-channel" : "/new-message"); }} style={styles.iconButton}>
                <AppIcon name="plus" size={18} color={colors.muted} />
              </Pressable>}
            </View>;
          }
          if (item.kind === "note") return <Text style={styles.sectionNote}>{item.text}</Text>;
          if (item.kind === "action") {
            if (item.id === "archive-link") return <Pressable accessibilityRole="button" accessibilityLabel={`Archived, ${archivedCount}`} onPress={() => { closeRow(); router.push("/archived-channels"); }} style={({ pressed }) => [styles.quietRow, pressed && styles.pressed]}>
              <View style={styles.actionIcon}><AppIcon name="archive" size={17} color={colors.muted} /></View>
              <Text style={styles.quietLabel}>Archived</Text>
              {archivedCount ? <Text style={styles.quietCount}>{archivedCount}</Text> : null}
            </Pressable>;
            const addChannels = item.id === "add-channels";
            const label = item.id === "new-project" ? "New project" : addChannels ? "Add channels" : "New message";
            return <Pressable accessibilityRole="button" accessibilityState={addChannels ? { expanded: discovering } : undefined} onPress={() => { closeRow(); if (item.id === "new-project") setNaming(true); else if (addChannels) setDiscovering(value => !value); else router.push("/new-message"); }} style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}>
              <View style={styles.actionIcon}><AppIcon name="plus" size={18} color={colors.muted} /></View>
              <Text style={styles.actionLabel}>{label}</Text>
            </Pressable>;
          }
          if (item.kind === "other") return <Pressable accessibilityRole="button" accessibilityLabel={`Preview #${item.channel.name}`} accessibilityHint="Read this public channel before joining"
            onPress={() => router.push({ pathname: "/c/[id]", params: { id: item.channel.id } })} style={({ pressed }) => [styles.otherRow, pressed && styles.pressed]}>
            <AppIcon name="hash" size={18} color={colors.muted} />
            <View style={styles.otherContent}>
              <Text style={styles.otherName}>{item.channel.name}</Text>
              <Text style={styles.otherTopic}>{`${item.channel.memberCount} ${item.channel.memberCount === 1 ? "member" : "members"}`}</Text>
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
              <Text style={styles.sectionNote}>No more channels</Text> : null;
        }}
        contentContainerStyle={styles.content}
      />
      {dialog}
      <NewProjectDialog visible={naming} onClose={() => setNaming(false)} />
      <ChannelSortSheet visible={sortOpen} value={sort} onClose={() => setSortOpen(false)} onChange={value => {
        setChannelSort(value);
        // Picking Custom also unlocks dragging; any other sort locks it again.
        setReordering(value === "custom" && !unreadOnly);
      }} />
    </View>
  );
});

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xxl },
  status: { ...typography.caption, marginLeft: "auto", alignSelf: "center", color: colors.muted },
  filters: { flexDirection: "row", gap: space.xs, paddingHorizontal: space.side, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  filter: { minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.xs, borderRadius: radius.pill, backgroundColor: colors.surface },
  selectedFilter: { backgroundColor: colors.blueSoft },
  filterText: { ...typography.bodyStrong, color: colors.muted },
  selectedFilterText: { color: colors.blueDark },
  // Same blue circle with a white number as the unread badges on each row.
  filterCount: { minWidth: 24, height: 24, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xs },
  filterCountText: { ...typography.captionStrong, color: colors.onPrimary },
  section: { flexDirection: "row", alignItems: "center", paddingLeft: space.side, paddingRight: space.xs, marginTop: space.sm },
  sectionToggle: { minHeight: 44, flex: 1, flexDirection: "row", alignItems: "center", gap: space.xs },
  sectionTitle: { ...typography.bodyStrong, color: colors.ink, flexShrink: 1 },
  sortButton: { minHeight: 44, paddingHorizontal: space.xs, flexDirection: "row", alignItems: "center", gap: 4 },
  sortText: { ...typography.caption, color: colors.muted },
  doneText: { ...typography.bodyStrong, color: colors.blue, ...linkUnderline },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  sectionNote: { ...typography.caption, color: colors.muted, paddingLeft: space.side + 38, paddingRight: space.side, paddingVertical: space.xs },
  // Project rows match the compact channel rows: a glyph, then the name.
  projectRow: { minHeight: 44, paddingHorizontal: space.side, paddingVertical: space.xxs, flexDirection: "row", alignItems: "center" },
  projectIcon: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
  projectName: { ...typography.body, flex: 1, minWidth: 0, color: colors.ink, marginLeft: space.sm },
  actionRow: { minHeight: 44, paddingHorizontal: space.side, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm },
  actionIcon: { width: 26, alignItems: "center" },
  actionLabel: { ...typography.body, color: colors.muted, flexShrink: 1 },
  quietRow: { minHeight: 44, paddingHorizontal: space.side, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm },
  quietLabel: { ...typography.caption, color: colors.muted, flexShrink: 1 },
  quietCount: { ...typography.caption, color: colors.muted, marginLeft: "auto" },
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
  loading: { margin: space.lg },
}));
