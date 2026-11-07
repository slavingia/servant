import { useCallback, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, Stack, useFocusEffect, useScrollToTop } from "expo-router";
import { AppIcon, type AppIconName } from "../components/AppIcon";
import { PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { SkeletonRows } from "../components/Skeleton";
import {
  RESEARCH_TASKS,
  researchChatKind,
  researchChats,
  researchDisplayTitle,
  researchTask,
  type ResearchTaskKind,
} from "../lib/research-studio";
import { api, ServerError, type Chat } from "../lib/server";
import { useSession } from "../lib/session";
import { shortTime as when } from "../lib/time-label";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

const taskIcons: Record<ResearchTaskKind, AppIconName> = {
  study: "people",
  synthesis: "search",
  "design-review": "eye",
};

export default function ResearchStudio() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const listRef = useRef<FlatList<Chat>>(null);
  useScrollToTop(listRef);
  const [work, setWork] = useState<Chat[] | null>(null);
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!account) return;
    const [chats, projects] = await Promise.allSettled([
      api.orgChats(account, setAccount),
      api.projects(account),
    ]);
    if (chats.status === "fulfilled") {
      // Research Studio is personal work for now. Sharing remains the ordinary
      // chat/message flow, so another client's shared chats are never relabeled.
      setWork(researchChats(chats.value.mine));
      setLoadError(null);
    } else {
      setLoadError(chats.reason instanceof ServerError ? chats.reason.message : "Couldn't load your research work");
    }
    if (projects.status === "fulfilled") {
      const tier = projects.value.agentTier;
      if (typeof tier === "number" && Number.isInteger(tier)) {
        setAgentTier(tier);
        setAccessError(null);
      } else {
        setAgentTier(null);
        setAccessError("This workspace did not report Researcher access.");
      }
    } else {
      setAgentTier(null);
      setAccessError("Researcher access could not be verified. Pull to refresh and try again.");
    }
  }, [account, setAccount]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;

  const unlocked = agentTier === 4;
  const checking = agentTier === undefined;
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  };
  const start = (kind: ResearchTaskKind) => {
    if (!unlocked) return;
    router.push({ pathname: "/research-new", params: { kind } });
  };
  const open = (chat: Chat) => router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, research: "1" } });

  return <View style={styles.root}>
    <Stack.Screen options={{ title: "Research Studio" }} />
    <FlatList ref={listRef} data={work ?? []} keyExtractor={chat => chat.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} tintColor={colors.blue} colors={[colors.blue]} progressBackgroundColor={colors.surface} />}
      ListHeaderComponent={<View>
        <PageTitle description="Plan studies, synthesize evidence, and review designs with the restricted researcher agent.">Research Studio</PageTitle>
        <View style={[styles.access, unlocked ? styles.accessReady : styles.accessLocked]}>
          <View style={styles.accessIcon}><AppIcon name={unlocked ? "check" : "lock"} size={17} color={unlocked ? colors.blueDark : colors.muted} /></View>
          <View style={styles.accessCopy}>
            <Text style={styles.accessTitle}>{checking ? "Checking Researcher access…" : unlocked ? "Researcher access is ready" : "Researcher access is required"}</Text>
            <Text style={styles.accessBody}>{checking
              ? "Your workspace controls which agent tools are available."
              : unlocked
                ? "New work starts as an ordinary private Servant chat, so teammates on the original app can read and continue it when you share."
                : accessError ?? "Ask a workspace owner to grant the Researcher agent tier. Your onboarding preference does not change access."}</Text>
          </View>
        </View>
        <Text accessibilityRole="header" style={styles.sectionTitle}>Start new research</Text>
        <View style={styles.actions}>
          {RESEARCH_TASKS.map(task => <Pressable key={task.kind} accessibilityRole="button" accessibilityLabel={task.actionLabel}
            accessibilityHint={unlocked ? task.description : "Researcher access is required"} accessibilityState={{ disabled: !unlocked }} disabled={!unlocked}
            onPress={() => start(task.kind)} style={({ pressed }) => [styles.action, !unlocked && styles.actionDisabled, pressed && unlocked && styles.pressed]}>
            <View style={styles.actionIcon}><AppIcon name={taskIcons[task.kind]} size={20} color={unlocked ? colors.blueDark : colors.muted} /></View>
            <View style={styles.actionCopy}>
              <Text style={styles.actionTitle}>{task.actionLabel}</Text>
              <Text style={styles.actionBody}>{task.description}</Text>
            </View>
            <AppIcon name={unlocked ? "chevronRight" : "lock"} size={16} color={colors.muted} />
          </Pressable>)}
        </View>
        <View style={styles.listHeading}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>Your research work</Text>
          {loadError && work !== null ? <Button compact kind="secondary" label="Retry" onPress={() => { void load(); }} /> : null}
        </View>
        {loadError && work !== null ? <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text> : null}
      </View>}
      ListEmptyComponent={work === null && !loadError
        ? <SkeletonRows label="Loading research work" count={4} />
        : work === null ? <View style={styles.empty}>
          <View style={styles.emptyIcon}><AppIcon name="warning" size={26} color={colors.red} /></View>
          <Text accessibilityRole="header" style={styles.emptyTitle}>Couldn't load research work</Text>
          <Text accessibilityRole="alert" style={styles.emptyBody}>{loadError}</Text>
          <Button label="Try again" kind="secondary" onPress={() => { void load(); }} style={styles.emptyAction} />
        </View> : <View style={styles.empty}>
          <View style={styles.emptyIcon}><AppIcon name="search" size={26} color={colors.blueDark} /></View>
          <Text accessibilityRole="header" style={styles.emptyTitle}>No research work yet</Text>
          <Text style={styles.emptyBody}>{unlocked ? "Choose a starting point above. Your brief will open as a draft for you to review before sending." : "Research chats you start after access is granted will appear here."}</Text>
        </View>}
      renderItem={({ item }) => {
        const kind = researchChatKind(item)!;
        const task = researchTask(kind);
        const preview = item.lastMessage?.text?.trim();
        return <Pressable accessibilityRole="button" accessibilityLabel={`${task.label}: ${researchDisplayTitle(item)}`} accessibilityHint="Open research chat"
          onPress={() => open(item)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
          <View style={styles.rowIcon}><AppIcon name={taskIcons[kind]} size={18} color={colors.blueDark} /></View>
          <View style={styles.rowCopy}>
            <View style={styles.rowTitleLine}>
              <Text numberOfLines={1} style={styles.rowTitle}>{researchDisplayTitle(item)}</Text>
              <Text style={styles.when}>{when(item.updatedAt)}</Text>
            </View>
            <Text numberOfLines={1} style={styles.rowMeta}>{preview || task.label}</Text>
          </View>
          <AppIcon name="chevronRight" size={16} color={colors.muted} />
        </Pressable>;
      }}
      contentContainerStyle={styles.content} />
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xxl, flexGrow: 1 },
  access: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginHorizontal: space.side, padding: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  accessReady: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
  accessLocked: { backgroundColor: colors.surface, borderColor: colors.line },
  accessIcon: { width: 28, height: 28, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  accessCopy: { flex: 1, minWidth: 0 },
  accessTitle: { ...typography.bodyStrong, color: colors.ink },
  accessBody: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  sectionTitle: { ...typography.heading, color: colors.ink, marginHorizontal: space.side, marginTop: space.lg, marginBottom: space.sm },
  actions: { gap: space.sm, paddingHorizontal: space.side },
  action: { minHeight: 92, flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background },
  actionDisabled: { opacity: 0.58, backgroundColor: colors.surface },
  pressed: { backgroundColor: colors.surface, opacity: 0.82 },
  actionIcon: { width: 42, height: 42, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft },
  actionCopy: { flex: 1, minWidth: 0 },
  actionTitle: { ...typography.bodyStrong, color: colors.ink },
  actionBody: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  listHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, paddingRight: space.side },
  error: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginBottom: space.sm },
  row: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowIcon: { width: 38, height: 38, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: space.sm },
  rowTitle: { ...typography.bodyStrong, color: colors.ink, flex: 1, minWidth: 0 },
  rowMeta: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  when: { ...typography.meta, color: colors.muted },
  empty: { alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.xl },
  emptyIcon: { width: 50, height: 50, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.blueSoft },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyBody: { ...typography.body, color: colors.muted, textAlign: "center", maxWidth: 380, marginTop: space.xs },
  emptyAction: { marginTop: space.lg, minWidth: 180 },
}));
