import { useCallback, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { AppIcon } from "../components/AppIcon";
import { Avatar } from "../components/Messaging";
import { ProjectAbout } from "../components/ProjectAbout";
import { ProjectReleases } from "../components/ProjectReleases";
import { rememberProject } from "../lib/projects-store";
import { api, ServerError, type Chat, type Project } from "../lib/server";
import { useSession } from "../lib/session";
import { shortTime as when } from "../lib/time-label";
import { radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../lib/theme";

// Releases first when the project has any, otherwise Chats. ?tab= opens one directly.
const TABS = ["releases", "chats", "about"] as const;
type Tab = typeof TABS[number];
const isTab = (v: unknown): v is Tab => TABS.includes(v as Tab);

// One project: its releases (what ships when, who owns each step), the agent chats in it, and
// About (how the team works, notes, files, people).
export default function ProjectScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const { id, tab: wanted } = useLocalSearchParams<{ id: string; tab?: string }>();
  // What's loaded is tagged with its project id, so moving to another project (the sidebar) starts clean.
  const [page, setPage] = useState<{ id: string; project: Project; chats: Chat[]; teamChats: Chat[] } | null>(null);
  const [picked, setPicked] = useState<{ id: string; tab: Tab } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const project = page && page.id === id ? page.project : null;

  const load = useCallback(async () => {
    if (!account || !id) return;
    try {
      const [detail, all] = await Promise.all([api.project(account, String(id)), api.orgChats(account, setAccount)]);
      const p = detail.project;
      setPage({ id: String(id), project: p, chats: all.mine.filter(c => c.projectId === p.id), teamChats: detail.sharedChats });
      rememberProject(p, account);
      setError(null);
    } catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't load this project"); }
  }, [account, id, setAccount]);
  // Teammates' changes (a cell moved, an item added) show up while the page is open: re-read every few seconds.
  useFocusEffect(useCallback(() => {
    void load();
    const timer = setInterval(() => { if (AppState.currentState === "active") void load(); }, 5000);
    return () => clearInterval(timer);
  }, [load]));
  if (!account) return null;

  if (!project) return <View style={styles.root}><Stack.Screen options={{ title: "Project" }} />
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : <ActivityIndicator style={{ marginTop: space.xxl }} color={colors.blue} />}
  </View>;

  const { chats, teamChats } = page!;
  const update = (p: Project) => { setPage(current => current && { ...current, project: p }); rememberProject(p, account); };
  const shown: Tab = picked?.id === id ? picked.tab : isTab(wanted) ? wanted : project.releases.length ? "releases" : "chats";
  const labels: Record<Tab, string> = { releases: "Releases", chats: `Chats${chats.length ? ` · ${chats.length}` : ""}`, about: "About" };
  const startChat = async () => {
    if (starting) return;
    setStarting(true); setError(null);
    try {
      const chat = await api.newChat(account, { projectId: project.id });
      router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, compose: "1" } });
    } catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't start a chat"); }
    finally { setStarting(false); }
  };
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: project.name }} />
      <View style={styles.header}>
        <View accessibilityRole="tablist" style={styles.tabs}>
          {TABS.map(key => <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: shown === key }} aria-selected={shown === key} onPress={() => setPicked({ id: String(id), tab: key })} style={[styles.tab, shown === key && styles.tabOn]}>
            <Text style={[styles.tabText, shown === key && styles.tabTextOn]}>{labels[key]}</Text>
          </Pressable>)}
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.inlineError}>{error}</Text> : null}
      </View>
      {shown === "releases" ? <ProjectReleases account={account} project={project} onChange={update} />
        : shown === "about" ? <ProjectAbout key={project.id} account={account} project={project} onChange={update} />
        : <ProjectChats chats={chats} teamChats={teamChats} starting={starting} onNew={() => void startChat()} />}
    </View>
  );
}

// Your agent chats in this project, then the ones teammates shared with it.
function ProjectChats({ chats, teamChats, starting, onNew }: { chats: Chat[]; teamChats: Chat[]; starting: boolean; onNew: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const title = (c: Chat) => c.title.replace(/`/g, "");
  return (
    <FlatList data={chats} keyExtractor={c => c.id} contentContainerStyle={{ paddingBottom: space.xxl }}
      ListHeaderComponent={<View>
        <Pressable accessibilityRole="button" accessibilityLabel="New chat in this project" accessibilityState={{ busy: starting }} disabled={starting} onPress={onNew} style={({ pressed }) => [styles.newChat, pressed && { backgroundColor: colors.surface }]}>
          <View style={styles.chatIcon}><AppIcon name="compose" size={18} color={colors.blueDark} /></View>
          <Text style={styles.link}>New chat</Text>
          {starting ? <ActivityIndicator color={colors.blue} /> : null}
        </Pressable>
        {chats.length === 0 ? <Text style={styles.empty}>No chats yet</Text> : null}
      </View>}
      renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={title(item)}
        onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id, title: item.title } })}
        style={({ pressed }) => [styles.chatRow, pressed && { backgroundColor: colors.surface }]}>
        <View style={styles.chatIcon}><AppIcon name={item.mode === "vibe" ? "code" : "sparkles"} size={18} color={colors.blueDark} /></View>
        <Text style={styles.chatTitle}>{title(item)}</Text>
        <Text style={styles.when}>{when(item.updatedAt)}</Text>
      </Pressable>}
      ListFooterComponent={teamChats.length ? <View>
        <View style={styles.sectionRow}><Text accessibilityRole="header" style={styles.section}>Shared with this project</Text></View>
        {teamChats.map(c => <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={`${title(c)}, shared by ${c.author?.name ?? "a teammate"}`}
          onPress={() => router.push({ pathname: "/chat/[id]", params: { id: c.id, title: c.title, readOnly: "1", author: c.author?.name ?? "" } })}
          style={({ pressed }) => [styles.chatRow, pressed && { backgroundColor: colors.surface }]}>
          <Avatar name={c.author?.name ?? "Someone"} size={36} userId={c.author?.id} />
          <View style={styles.chatCopy}>
            <Text style={styles.chatTitle}>{title(c)}</Text>
            <Text style={styles.chatMeta}>{c.author?.name ?? "A teammate"}</Text>
          </View>
          <Text style={styles.when}>{when(c.updatedAt)}</Text>
        </Pressable>)}
      </View> : undefined} />
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  error: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginVertical: space.sm },
  inlineError: { ...typography.caption, color: colors.red, marginTop: space.xs },
  // The same segmented control as Files.
  header: { paddingHorizontal: space.side, paddingTop: space.sm, paddingBottom: space.xs },
  tabs: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.md, padding: 3, width: "100%", maxWidth: 400, alignSelf: "center" },
  tab: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, paddingHorizontal: space.xs },
  tabOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  tabText: { ...typography.captionStrong, color: colors.muted },
  tabTextOn: { color: colors.ink },
  newChat: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side },
  link: { ...typography.bodyStrong, color: colors.blue, flex: 1, ...linkUnderline },
  empty: { ...typography.caption, color: colors.muted, marginHorizontal: space.side, marginVertical: space.sm },
  sectionRow: { marginTop: space.lg, paddingHorizontal: space.side, paddingBottom: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  section: { ...typography.label, color: colors.muted },
  chatRow: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  chatIcon: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  chatCopy: { flex: 1, minWidth: 0 },
  chatTitle: { ...typography.body, flex: 1, color: colors.ink },
  chatMeta: { ...typography.caption, color: colors.muted },
  when: { ...typography.caption, color: colors.muted },
}));
