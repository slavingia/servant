import { useCallback, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, Stack, useFocusEffect, useScrollToTop } from "expo-router";
import { AppIcon } from "../components/AppIcon";
import { Button } from "../components/Button";
import { DesignReviewSheet } from "../components/DesignReviewSheet";
import { PageTitle } from "../components/Band";
import { SkeletonRows } from "../components/Skeleton";
import { designChats, designCreationAccess, designStatus, designTitle, type DesignCreationAccess } from "../lib/designs";
import { api, ServerError, type Chat } from "../lib/server";
import { useSession } from "../lib/session";
import { shortTime as when } from "../lib/time-label";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

export default function Designs() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const listRef = useRef<FlatList<Chat>>(null);
  useScrollToTop(listRef);
  const [designs, setDesigns] = useState<Chat[] | null>(null);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [access, setAccess] = useState<DesignCreationAccess | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sharing, setSharing] = useState<Chat | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    setLoadError(null);
    const [chats, projects] = await Promise.allSettled([
      api.orgChats(account, setAccount),
      api.projects(account),
    ]);
    if (projects.status === "fulfilled") {
      const tier = projects.value.agentTier === undefined
        ? (projects.value.vibeCoder ? 2 : undefined)
        : Number.isInteger(projects.value.agentTier) ? projects.value.agentTier : null;
      setAccess(designCreationAccess(tier, projects.value.vibe));
    } else {
      setAccess({ canCreate: false, explanation: "Couldn't verify design creation access. Pull to refresh and try again." });
    }
    if (chats.status === "fulfilled") {
      setDesigns(designChats(chats.value.mine, chats.value.others));
      setMine(new Set(chats.value.mine.map(chat => chat.id)));
    } else {
      const reason = chats.reason;
      setLoadError(reason instanceof ServerError ? reason.message : "Couldn't load designs");
    }
  }, [account, setAccount]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  };
  const start = async () => {
    if (starting || !access?.canCreate) return;
    setStarting(true);
    setActionError(null);
    try {
      const chat = await api.newChat(account, { mode: "vibe" });
      if (chat.mode !== "vibe") {
        setActionError("This workspace did not create a design workspace. Ask a workspace owner to confirm your Design Studio access.");
        return;
      }
      router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, compose: "1", studio: "1" } });
    } catch (e) {
      setActionError(e instanceof ServerError ? e.message : "Couldn't start a design");
    } finally { setStarting(false); }
  };
  const open = (design: Chat) => {
    const own = mine.has(design.id);
    router.push({ pathname: "/chat/[id]", params: {
      id: design.id,
      title: design.title,
      studio: "1",
      ...(own ? {} : { readOnly: "1", author: design.author?.name ?? "" }),
    } });
  };

  return <View style={styles.root}>
    <Stack.Screen options={{ title: "Designs" }} />
    <FlatList ref={listRef} data={designs ?? []} keyExtractor={design => design.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} tintColor={colors.blue} colors={[colors.blue]} progressBackgroundColor={colors.surface} />}
      ListHeaderComponent={<View>
        <PageTitle description="Create interactive prototypes with the agent, then bring feedback back to your team."
          action={access?.canCreate ? <Button compact label="New design" onPress={() => { void start(); }} busy={starting} /> : undefined}>
          Design Studio
        </PageTitle>
        {access && !access.canCreate ? <View style={styles.accessNote}>
          <AppIcon name="lock" size={15} color={colors.muted} />
          <Text style={styles.accessText}>{access.explanation}</Text>
        </View> : null}
        {actionError ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
        {loadError && designs !== null ? <View style={styles.inlineError}>
          <Text accessibilityRole="alert" style={styles.errorText}>{loadError}</Text>
          <Button compact kind="secondary" label="Try again" onPress={() => { void load(); }} />
        </View> : null}
      </View>}
      ListEmptyComponent={designs === null && !loadError
        ? <SkeletonRows label="Loading designs" count={5} />
        : designs === null ? <View style={styles.empty}>
          <View style={styles.emptyIcon}><AppIcon name="warning" size={28} color={colors.red} /></View>
          <Text accessibilityRole="header" style={styles.emptyTitle}>Couldn't load designs</Text>
          <Text accessibilityRole="alert" style={styles.emptyBody}>{loadError}</Text>
          <Button label="Try again" kind="secondary" onPress={() => { void load(); }} style={styles.emptyAction} />
        </View>
        : access?.canCreate ? <View style={styles.empty}>
          <View style={styles.emptyIcon}><AppIcon name="code" size={28} color={colors.blueDark} /></View>
          <Text accessibilityRole="header" style={styles.emptyTitle}>Create your first design</Text>
          <Text style={styles.emptyBody}>Describe a page or tool. The agent builds it and gives you a live preview to refine and share.</Text>
          <Button label="New design" onPress={() => { void start(); }} busy={starting} style={styles.emptyAction} />
        </View> : <View style={styles.empty}>
          <View style={styles.emptyIcon}><AppIcon name="code" size={28} color={colors.blueDark} /></View>
          <Text accessibilityRole="header" style={styles.emptyTitle}>No designs to review yet</Text>
          <Text style={styles.emptyBody}>{access?.explanation ?? "Shared team designs will appear here."}</Text>
        </View>}
      renderItem={({ item }) => {
        const own = mine.has(item.id);
        const privateForAdmin = !own && item.shared !== true;
        const status = designStatus(item);
        const canShare = !!item.previewUrl && (own || item.shared === true);
        return <View style={styles.rowWrap}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${designTitle(item)}, ${status}${privateForAdmin ? ", private, visible to admins" : ""}`} accessibilityHint="Open design workspace" onPress={() => open(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={styles.icon}><AppIcon name="code" size={19} color={colors.blueDark} /></View>
            <View style={styles.copy}>
              <View style={styles.titleLine}>
                <Text style={styles.designName} numberOfLines={1}>{designTitle(item)}</Text>
                <Text style={styles.when}>{when(item.updatedAt)}</Text>
              </View>
              <View style={styles.detailLine}>
                <View style={[styles.status, status === "Building" && styles.statusBuilding, status === "Ready for review" && styles.statusReady]}>
                  <Text style={[styles.statusText, status === "Building" && styles.statusBuildingText, status === "Ready for review" && styles.statusReadyText]}>{status}</Text>
                </View>
                {!own && item.author?.name ? <Text style={styles.author} numberOfLines={1}>by {item.author.name}</Text> : null}
                {privateForAdmin ? <View style={styles.privateTag}>
                  <AppIcon name="lock" size={12} color={colors.muted} />
                  <Text style={styles.privateText} numberOfLines={1}>Private · visible to admins</Text>
                </View> : null}
              </View>
            </View>
            <AppIcon name="chevronRight" size={16} color={colors.muted} />
          </Pressable>
          {canShare ? <Pressable accessibilityRole="button" accessibilityLabel={`Share ${designTitle(item)} for review`} accessibilityHint="Choose a channel or direct message" onPress={() => setSharing(item)}
            style={({ pressed }) => [styles.share, pressed && { opacity: 0.65 }]}>
            <AppIcon name="send" size={17} color={colors.blue} />
            <Text style={styles.shareText}>Review</Text>
          </Pressable> : null}
        </View>;
      }}
      contentContainerStyle={styles.content} />
    {sharing ? <DesignReviewSheet design={sharing} onClose={() => setSharing(null)} /> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xxl, flexGrow: 1 },
  error: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginBottom: space.sm },
  accessNote: { flexDirection: "row", alignItems: "flex-start", gap: space.xs, marginHorizontal: space.side, marginBottom: space.md, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.subtle },
  accessText: { ...typography.caption, color: colors.muted, flex: 1 },
  inlineError: { flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.side, marginBottom: space.sm },
  errorText: { ...typography.caption, color: colors.red, flex: 1 },
  rowWrap: { flexDirection: "row", alignItems: "stretch", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  row: { minHeight: 76, flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.sm },
  pressed: { backgroundColor: colors.surface },
  icon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.blueSoft },
  copy: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: space.sm },
  designName: { ...typography.bodyStrong, color: colors.ink, flex: 1, minWidth: 0 },
  when: { ...typography.meta, color: colors.muted },
  detailLine: { flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: space.xs },
  status: { alignSelf: "flex-start", borderRadius: radius.pill, backgroundColor: colors.surface, paddingHorizontal: space.xs, paddingVertical: 2 },
  statusBuilding: { backgroundColor: colors.blueSoft },
  statusReady: { backgroundColor: colors.blueSoft },
  statusText: { ...typography.meta, color: colors.muted },
  statusBuildingText: { color: colors.blueDark },
  statusReadyText: { color: colors.blueDark, fontWeight: "600" },
  author: { ...typography.meta, color: colors.muted, flex: 1 },
  privateTag: { flexDirection: "row", alignItems: "center", gap: space.xxs, minWidth: 0, flexShrink: 1 },
  privateText: { ...typography.meta, color: colors.muted, flexShrink: 1 },
  share: { minWidth: 68, alignItems: "center", justifyContent: "center", gap: 2, paddingHorizontal: space.xs },
  shareText: { ...typography.meta, fontWeight: "600", color: colors.blue },
  empty: { alignItems: "center", marginTop: space.xxl, paddingHorizontal: space.lg },
  emptyIcon: { width: 52, height: 52, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.blueSoft },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyBody: { ...typography.body, color: colors.muted, textAlign: "center", maxWidth: 380, marginTop: space.xs },
  emptyAction: { marginTop: space.lg, minWidth: 180 },
}));
