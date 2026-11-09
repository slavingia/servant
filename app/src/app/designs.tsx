import { useCallback, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { router, Stack, useFocusEffect, useScrollToTop } from "expo-router";
import { AppIcon } from "../components/AppIcon";
import { Button } from "../components/Button";
import { DesignReviewSheet } from "../components/DesignReviewSheet";
import { DesignActionsSheet, type DesignAction } from "../components/DesignActionsSheet";
import { DesignThumbnail } from "../components/DesignThumbnail";
import { useRadioGroup } from "../components/useRadioGroup";
import { PageTitle } from "../components/Band";
import { SkeletonRows } from "../components/Skeleton";
import { DESIGN_FILTERS, designChatOptions, designChats, designCreationAccess, designCreationErrorMessage, designPreviewPublished, designStatus, designTitle, filterDesigns, isVerifiedDesignChat, type DesignCreationAccess, type DesignFilter } from "../lib/designs";
import { duplicateDesign } from "../lib/design-actions";
import { api, ServerError, type Chat } from "../lib/server";
import { useSession } from "../lib/session";
import { shortTime as when } from "../lib/time-label";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

export default function Designs() {
  const styles = useStyles();
  const narrow = useWindowDimensions().width < 600;
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const listRef = useRef<FlatList<Chat>>(null);
  useScrollToTop(listRef);
  const [designs, setDesigns] = useState<Chat[] | null>(null);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  const [access, setAccess] = useState<DesignCreationAccess | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sharing, setSharing] = useState<Chat | null>(null);
  const [acting, setActing] = useState<Chat | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DesignFilter>("all");
  const [origin, setOrigin] = useState<string | null>(null);
  const filters = useRadioGroup({ values: DESIGN_FILTERS.map(f => f.id), value: filter, onChange: setFilter, label: "Show designs" });

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
      setAgentTier(tier);
      setAccess(designCreationAccess(tier, projects.value.vibe));
      setOrigin(projects.value.prototypeOrigin ?? null);
    } else {
      setAgentTier(null);
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
      const chat = await api.newChat(account, designChatOptions(agentTier));
      if (!isVerifiedDesignChat(chat, agentTier)) {
        await api.deleteChat(account, chat.id).catch(() => {});
        setActionError("This workspace did not create a design workspace. Ask a workspace owner to confirm your Design Studio access.");
        return;
      }
      router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, compose: "1", studio: "1" } });
    } catch (e) {
      setActionError(designCreationErrorMessage(agentTier, e instanceof ServerError ? e : undefined));
    } finally { setStarting(false); }
  };
  // Duplicate: a new design of this person's starts from the other's current page, then opens.
  const duplicate = async (design: Chat) => {
    const chat = await duplicateDesign(account, design, agentTier);
    setActing(null);
    await load();
    router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, studio: "1" } });
  };
  const actionsFor = (design: Chat): DesignAction[] => {
    const own = mine.has(design.id);
    const published = designPreviewPublished(design);
    const after = (work: () => Promise<unknown>) => async () => {
      try { await work(); } catch (e) { throw e instanceof ServerError ? new Error(e.message) : e; }
      setActing(null);
      await load();
    };
    // On narrow screens the row has no room for Share for review, so it's here instead.
    const canShare = designPreviewPublished(design) && (own || design.shared === true);
    return [
      ...(narrow && canShare ? [{ id: "share", label: "Share for review", icon: "send" as const, hint: "Post it in a channel or direct message for feedback", run: () => { setActing(null); setSharing(design); } }] : []),
      ...(published && access?.canCreate ? [{ id: "duplicate", label: "Duplicate", icon: "copy" as const, hint: "Make your own copy to change", run: () => duplicate(design) }] : []),
      ...(published ? [{ id: "versions", label: "Version history", icon: "clock" as const, hint: own ? "Compare or restore earlier versions" : "Look at earlier versions", run: () => { setActing(null); router.push({ pathname: "/versions", params: { chat: design.id } }); } }] : []),
      // Researchers can plan a study around a published design (the study builder checks it again).
      ...(agentTier === 4 && designStatus(design) === "Published" ? [{ id: "study", label: "Use in a study plan", icon: "compose" as const, hint: "Opens a study plan with this prototype. If one is in progress, you choose whether to add it there or start a new plan.", run: () => { setActing(null); router.push({ pathname: "/research-new", params: { kind: "study", prototype: design.id } }); } }] : []),
      ...(own ? [design.archived
        ? { id: "unarchive", label: "Move back to designs", icon: "archive" as const, run: after(() => api.restoreChat(account, design.id)) }
        : { id: "archive", label: "Archive", icon: "archive" as const, hint: "Hides it from your list. Its page and link keep working.", run: after(() => api.archiveChat(account, design.id)) }] : []),
    ];
  };
  const shown = designs ? filterDesigns(designs, { query, filter, mine }) : null;
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
    <Stack.Screen options={{ title: "Design" }} />
    <FlatList ref={listRef} data={shown ?? []} keyExtractor={design => design.id}
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
        {designs?.length ? <View style={styles.tools}>
          <TextInput accessibilityLabel="Search designs" placeholder="Search designs" value={query} onChangeText={setQuery} returnKeyType="search"
            placeholderTextColor={colors.muted} style={styles.search} />
          <View {...filters.group} style={styles.filters}>{DESIGN_FILTERS.map((f, index) => <Pressable key={f.id} {...filters.radio(f.id, index)} accessibilityLabel={f.label}
            style={({ pressed }) => [styles.filter, filter === f.id && styles.filterSelected, pressed && { opacity: 0.75 }]}>
            <Text style={[styles.filterText, filter === f.id && styles.filterTextSelected]}>{f.label}</Text>
          </Pressable>)}</View>
        </View> : null}
        {loadError && designs !== null ? <View style={styles.inlineError}>
          <Text accessibilityRole="alert" style={styles.errorText}>{loadError}</Text>
          <Button compact kind="secondary" label="Try again" onPress={() => { void load(); }} />
        </View> : null}
      </View>}
      ListEmptyComponent={designs?.length && shown && !shown.length ? <View style={styles.empty}>
          <Text accessibilityRole="header" style={styles.emptyTitle}>{query.trim() ? "No designs match" : filter === "archived" ? "Nothing archived" : "No designs here yet"}</Text>
          <Text style={styles.emptyBody}>{query.trim() ? "Try other words, or look in another list." : filter === "archived" ? "Designs you archive are kept here, with their pages and links still working." : "Designs will appear here."}</Text>
          {query.trim() || filter !== "all" ? <Button label="Show all designs" kind="secondary" onPress={() => { setQuery(""); setFilter("all"); }} style={styles.emptyAction} /> : null}
        </View>
        : designs === null && !loadError
        ? <SkeletonRows label="Loading designs" count={5} />
        : designs === null ? <View style={styles.empty}>
          <View style={styles.emptyIcon}><AppIcon name="warning" size={28} color={colors.red} /></View>
          <Text accessibilityRole="header" style={styles.emptyTitle}>Couldn't load designs</Text>
          <Text accessibilityRole="alert" style={styles.emptyBody}>{loadError}</Text>
          <Button label="Try again" kind="secondary" onPress={() => { void load(); }} style={styles.emptyAction} />
        </View>
        : access?.canCreate ? <View style={styles.empty}>
          <View style={styles.emptyIcon}><AppIcon name="brush" size={28} color={colors.blueDark} /></View>
          <Text accessibilityRole="header" style={styles.emptyTitle}>Create your first design</Text>
          <Text style={styles.emptyBody}>Describe a page or tool. The agent builds it and gives you a live preview to refine and share.</Text>
          <Button label="New design" onPress={() => { void start(); }} busy={starting} style={styles.emptyAction} />
        </View> : <View style={styles.empty}>
          <View style={styles.emptyIcon}><AppIcon name="brush" size={28} color={colors.blueDark} /></View>
          <Text accessibilityRole="header" style={styles.emptyTitle}>No designs to review yet</Text>
          <Text style={styles.emptyBody}>{access?.explanation ?? "Shared team designs will appear here."}</Text>
        </View>}
      renderItem={({ item }) => {
        const own = mine.has(item.id);
        const privateForAdmin = !own && item.shared !== true;
        const status = designStatus(item);
        // Only a design with a live preview page can be shared for review.
        const canShare = designPreviewPublished(item) && (own || item.shared === true);
        return <View style={styles.rowWrap}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${designTitle(item)}, ${status}${privateForAdmin ? ", private, visible to admins" : ""}`} accessibilityHint="Open design workspace" onPress={() => open(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <DesignThumbnail url={designPreviewPublished(item) ? item.previewUrl : null} origin={origin} width={narrow ? 48 : 72} height={narrow ? 56 : 64} />
            <View style={styles.copy}>
              <View style={styles.titleLine}>
                <Text style={styles.designName} numberOfLines={narrow ? 2 : 1}>{designTitle(item)}</Text>
                {!narrow ? <Text style={styles.when}>{when(item.updatedAt)}</Text> : null}
              </View>
              <View style={styles.detailLine}>
                <View style={[styles.status, status === "Building" && styles.statusBuilding, status === "Published" && styles.statusReady]}>
                  <Text style={[styles.statusText, status === "Building" && styles.statusBuildingText, status === "Published" && styles.statusReadyText]}>{status}</Text>
                </View>
                {!own && item.author?.name ? <Text style={styles.author} numberOfLines={1}>by {item.author.name}</Text> : null}
                {narrow ? <Text style={styles.when}>{when(item.updatedAt)}</Text> : null}
                {privateForAdmin ? <View style={styles.privateTag}>
                  <AppIcon name="lock" size={12} color={colors.muted} />
                  <Text style={styles.privateText} numberOfLines={1}>Private · visible to admins</Text>
                </View> : null}
              </View>
            </View>
            <AppIcon name="chevronRight" size={16} color={colors.muted} />
          </Pressable>
          {canShare && !narrow ? <Pressable accessibilityRole="button" accessibilityLabel={`Share ${designTitle(item)} for review`} accessibilityHint="Choose a channel or direct message" onPress={() => setSharing(item)}
            style={({ pressed }) => [styles.share, pressed && { opacity: 0.65 }]}>
            <AppIcon name="send" size={17} color={colors.blue} />
            <Text style={styles.shareText}>Share for review</Text>
          </Pressable> : null}
          {own || actionsFor(item).length ? <Pressable accessibilityRole="button" accessibilityLabel={`More for ${designTitle(item)}`} accessibilityHint={narrow ? "Share, rename, duplicate, versions or archive" : "Rename, duplicate, versions or archive"}
            onPress={() => setActing(item)} style={({ pressed }) => [styles.more, pressed && { opacity: 0.65 }]}>
            <AppIcon name="more" size={18} color={colors.muted} />
          </Pressable> : null}
        </View>;
      }}
      contentContainerStyle={styles.content} />
    {sharing ? <DesignReviewSheet design={sharing} onClose={() => setSharing(null)} /> : null}
    {acting ? <DesignActionsSheet title={designTitle(acting)} actions={actionsFor(acting)} onClose={() => setActing(null)}
      onRename={mine.has(acting.id) ? async name => {
        try { await api.renameChat(account, acting.id, name); } catch (e) { throw e instanceof ServerError ? new Error(e.message) : e; }
        setActing(null);
        await load();
      } : undefined} /> : null}
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
  share: { minWidth: 68, maxWidth: 92, alignItems: "center", justifyContent: "center", gap: 2, paddingHorizontal: space.xs },
  more: { width: 44, alignItems: "center", justifyContent: "center" },
  tools: { gap: space.sm, marginHorizontal: space.side, marginBottom: space.sm },
  search: { ...typography.body, color: colors.ink, minHeight: 44, paddingHorizontal: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  filter: { minHeight: 36, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  filterSelected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  filterText: { ...typography.caption, color: colors.ink },
  filterTextSelected: { color: colors.blueDark, fontWeight: "600" },
  shareText: { ...typography.meta, fontWeight: "600", color: colors.blue, textAlign: "center" },
  empty: { alignItems: "center", marginTop: space.xxl, paddingHorizontal: space.lg },
  emptyIcon: { width: 52, height: 52, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.blueSoft },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyBody: { ...typography.body, color: colors.muted, textAlign: "center", maxWidth: 380, marginTop: space.xs },
  emptyAction: { marginTop: space.lg, minWidth: 180 },
}));
