import { useCallback, useRef, useState } from "react";
import { SkeletonRows } from "../../components/Skeleton";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Redirect, router, useFocusEffect, useScrollToTop } from "expo-router";
import { AppIcon } from "../../components/AppIcon";
import { SwipeChannelRow, useConversationActions } from "../../components/SwipeChannelRow";
import { Button } from "../../components/Button";
import { useLive } from "../../lib/live";
import type { Conversation } from "../../lib/server";
import { useSession } from "../../lib/session";
import { landingHref, useFeatures } from "../../lib/features";
import { radius, space, typography, useTheme, createThemedStyles } from "../../lib/theme";

export default function Messages() {
  const styles = useStyles();
  // Tapping the tab you're already on scrolls back to the top.
  const scrollRef = useRef<FlatList<Conversation>>(null);
  useScrollToTop(scrollRef);
  const { colors } = useTheme();
  const { account } = useSession();
  const { conversations, error, refresh, connected } = useLive();
  const reconnecting = !connected && conversations !== null;
  const [refreshing, setRefreshing] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { openId, busyId, closeRow, rowProps, dialog, actionError } = useConversationActions(account, refresh);
  const features = useFeatures();
  useFocusEffect(
    useCallback(() => {
      if (features.directMessages) refresh();
    }, [refresh, features.directMessages]),
  );
  const reload = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };
  if (!account) return null;
  // A server without direct messages has no DMs tab; a stale link here goes where the app lands.
  if (!features.directMessages) return <Redirect href={landingHref(features)} />;
  const dms = (conversations ?? []).filter((c) => c.kind === "dm" && !c.archived);
  const list = dms.filter(c => !unreadOnly || c.unread > 0);
  return (
    <View style={styles.root}>
      <FlatList ref={scrollRef} contentInsetAdjustmentBehavior="automatic"
        data={list}
        keyExtractor={(c) => c.id}
        extraData={{ openId, busyId }}
        onScrollBeginDrag={closeRow}
        refreshControl={
          <RefreshControl
            tintColor={colors.blue}
            colors={[colors.blue]}
            progressBackgroundColor={colors.surface}
            refreshing={refreshing}
            onRefresh={() => void reload()}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <Text accessibilityRole="header" style={styles.title}>Chats</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="New message" onPress={() => router.push("/new-message")} style={styles.compose}>
                <AppIcon name="compose" size={22} color={colors.ink} />
              </Pressable>
            </View>
            <View accessibilityRole="tablist" style={styles.filters}>{[false, true].map(value => <Pressable key={String(value)} accessibilityRole="tab" accessibilityState={{ selected: unreadOnly === value }} aria-selected={unreadOnly === value} onPress={() => setUnreadOnly(value)} style={({ pressed }) => [styles.filter, unreadOnly === value && styles.selectedFilter, pressed && { opacity: 0.7 }]}>
              <Text style={[styles.filterText, unreadOnly === value && styles.selectedFilterText]}>{value ? "Unread" : "All"}</Text>
            </Pressable>)}
            {/* Beside the filters, as on Home, so it never takes a line or moves the list. */}
            <Text aria-hidden={!reconnecting} accessibilityLiveRegion="polite" style={[styles.status, { opacity: reconnecting ? 1 : 0 }]}>Reconnecting…</Text>
            </View>
            {actionError ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
            {error && conversations ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          conversations === null ? (
            error ? <View style={styles.empty}><Text accessibilityRole="alert" style={styles.emptyBody}>{error}</Text><Button label="Try again" kind="secondary" busy={refreshing} onPress={() => void reload()} style={styles.emptyAction} /></View> : <SkeletonRows label="Loading messages" />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{unreadOnly ? "No unread messages" : "No chats yet"}</Text>
              <Button label={unreadOnly ? "Show all messages" : "New message"} kind="secondary" onPress={() => unreadOnly ? setUnreadOnly(false) : router.push("/new-message")} style={styles.emptyAction} />
            </View>
          )
        }
        renderItem={({ item }) => <SwipeChannelRow {...rowProps(item)} onPress={() => router.push({ pathname: "/c/[id]", params: { id: item.id } })} />}
        contentContainerStyle={styles.content}
      />
      {dialog}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xxl, flexGrow: 1 },
  header: { minHeight: 60, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs },
  title: { ...typography.title, color: colors.ink, flexShrink: 1 },
  compose: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  filters: { flexDirection: "row", gap: space.xs, paddingHorizontal: space.side, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  filter: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.sm, justifyContent: "center", borderRadius: radius.md },
  selectedFilter: { backgroundColor: colors.blueSoft },
  filterText: { ...typography.bodyStrong, color: colors.muted },
  selectedFilterText: { color: colors.blueDark },
  loading: { marginTop: space.xxl },
  error: { ...typography.caption, marginTop: space.xs, marginHorizontal: space.side, color: colors.red },
  status: { ...typography.caption, marginLeft: "auto", alignSelf: "center", color: colors.muted },
  empty: { marginTop: space.xxl, alignItems: "center", paddingHorizontal: space.lg },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyBody: { ...typography.body, marginTop: space.xs, maxWidth: 320, color: colors.muted, textAlign: "center" },
  emptyAction: { marginTop: space.lg },
}));
