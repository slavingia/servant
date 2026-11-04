import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useFocusEffect, useScrollToTop } from "expo-router";
import { shortTime as when } from "../../lib/time-label";
import { AppIcon } from "../../components/AppIcon";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SwipeRow } from "../../components/SwipeChannelRow";
import { ProjectSheet, VIBE_CHOICE } from "../../components/ProjectSheet";
import { getItem, setItem } from "../../lib/storage";
import { api, ServerError, type Chat, type Project } from "../../lib/server";

// The line under the title, like the last message in a DM list.
function lastLine(chat: Chat, author: string, agent = "") {
  const last = chat.lastMessage;
  if (!last) return "";
  const body = last.text || (last.attachments ? `${last.attachments} attachment${last.attachments === 1 ? "" : "s"}` : "");
  return last.role === "user" ? `${author}: ${body}` : agent ? `${agent}: ${body}` : body;
}
import { useSession } from "../../lib/session";
import { useLive } from "../../lib/live";
import { radius, space, typography, useTheme, createThemedStyles } from "../../lib/theme";
import { activeAgentTurn, agentTurnLabel } from '../../lib/agent-turns';


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
  const [picking, setPicking] = useState(false);
  const [naming, setNaming] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  // The projects you're in, from the server (docs/projects.md); vibe says whether vibe coding is set up.
  const [projects, setProjects] = useState<{ list: Project[]; vibeCoder: boolean; vibe: boolean } | null>(null);
  // The last project chosen sticks, so starting a chat is one tap.
  const [choice, setChoice] = useState<string | null>(null);
  const choiceKey = account ? `servant.project.${account.user.id}` : null;
  useEffect(() => {
    if (!choiceKey) return;
    void getItem(choiceKey).then(v => { if (v !== null) setChoice(v || null); }).catch(() => {});
  }, [choiceKey]);
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
      setShared(others);
      api.projects(account).then(r => setProjects({ list: r.projects, vibeCoder: r.vibeCoder, vibe: r.vibe })).catch(() => {});
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
      const timer = setInterval(() => { if (AppState.currentState === 'active') void load(); }, 5000);
      const subscription = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
      return () => { clearInterval(timer); subscription.remove(); };
    }, [load]),
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
  const createProject = async () => {
    const name = projectName.trim();
    if (!name || projectBusy) return;
    setProjectBusy(true); setProjectError(null);
    try {
      const project = await api.createProject(account, { name });
      setNaming(false); setProjectName("");
      setProjects(p => p ? { ...p, list: [...p.list, project] } : p);
      router.push({ pathname: "/project", params: { id: project.id } });
    } catch (e) { setProjectError(e instanceof ServerError ? e.message : "Couldn't make the project"); }
    finally { setProjectBusy(false); }
  };
  const active = (chats ?? []).filter(chat => !chat.archived);
  const archived = (chats ?? []).filter(chat => chat.archived);
  const rows = view === "archived" ? archived : active;
  const VIEWS = [{ key: "active", label: "Active" }, { key: "archived", label: "Archived" }] as const;

  // A remembered choice the server no longer offers (vibe coding off, a project you left) means "Just the agent".
  const offered = (c: string | null) => c === VIBE_CHOICE ? projects?.vibe !== false : !!c && !!projects?.list.some(p => p.id === c);
  const choiceName = choice === VIBE_CHOICE && offered(choice) ? "Vibe coding" : (offered(choice) && projects?.list.find(p => p.id === choice)?.name) || "Just the agent";
  const start = async (project?: string | null) => {
    if (starting) return;
    // Everyone else chooses what the chat is about (including vibe coding);
    // vibe coders always build prototypes.
    if (project === undefined) project = projects && !projects.vibeCoder && offered(choice) ? choice : null;
    setPicking(false);
    setStarting(true);
    setError(null);
    try {
      const chat = await api.newChat(account, project === VIBE_CHOICE ? { mode: "vibe" } : project ? { projectId: project } : {});
      router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, compose: "1" } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't start a chat");
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={styles.root}>
      <ProjectSheet visible={picking} projects={projects?.list ?? []} vibe={projects?.vibe !== false} selected={choice} onPick={project => { setPicking(false); setChoice(project); if (choiceKey) void setItem(choiceKey, project ?? "").catch(() => {}); }} onClose={() => setPicking(false)} />
      <FlatList ref={scrollRef}
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
              <Pressable accessibilityRole="button" accessibilityLabel="New agent conversation" accessibilityState={{ disabled: starting, busy: starting }} disabled={starting} onPress={() => void start()} style={styles.compose}>
                {starting ? <ActivityIndicator color={colors.blue} /> : <AppIcon name="compose" size={22} color={colors.ink} />}
              </Pressable>
            </View>
            {projects && !projects.vibeCoder ? <Pressable accessibilityRole="button" accessibilityLabel={`New chats are about ${choiceName}. Change`} onPress={() => setPicking(true)} style={({ pressed }) => [styles.picker, pressed && { backgroundColor: colors.surface }]}>
              <Text style={styles.pickerLabel}>New chat about</Text>
              <Text style={styles.pickerValue} numberOfLines={1}>{choiceName}</Text>
              <AppIcon name="chevronDown" size={16} color={colors.muted} />
            </Pressable> : null}
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {actionError && !deleting ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
            {account.user.role === 'owner' && chats?.some(chat => chat.latestTurn?.status === 'waiting_for_approval') ? <View style={styles.inbox}>
              <Text accessibilityRole="header" style={styles.inboxTitle}>Needs your approval</Text>
              {chats.filter(chat => chat.latestTurn?.status === 'waiting_for_approval').map(chat => <Pressable key={chat.id} accessibilityRole="button" accessibilityLabel={`Review action in ${chat.title}`} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: chat.id, title: chat.title } })} style={styles.approvalRow}>
                <Text style={styles.rowTitle}>{chat.title}</Text><Text numberOfLines={2} style={styles.approvalDetail}>{chat.latestTurn?.approval?.description || 'Review this action to continue.'}</Text><Text style={styles.review}>Review action →</Text>
              </Pressable>)}
            </View> : null}
            {view === "active" ? <View>
              <View style={styles.projectHead}>
                <Text accessibilityRole="header" style={styles.projectTitle}>Projects</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="New project" onPress={() => { setProjectError(null); setNaming(true); }} hitSlop={8} style={styles.projectAction}>
                  <Text style={styles.projectLink}>New project</Text>
                </Pressable>
              </View>
              {projects && projects.list.length === 0 ? <Text style={styles.projectEmpty}>A project holds a team's chats, with shared notes, files and rules for how you work.</Text> : null}
              {(projects?.list ?? []).map(project => <Pressable key={project.id} accessibilityRole="button" accessibilityLabel={`${project.name}${project.people.length > 1 ? ", shared" : ""}, ${project.chatCount} ${project.chatCount === 1 ? "chat" : "chats"}`}
                onPress={() => router.push({ pathname: "/project", params: { id: project.id } })} style={({ pressed }) => [styles.projectRow, pressed && { backgroundColor: colors.surface }]}>
                <View style={styles.agentIcon}><AppIcon name="folder" size={19} color={colors.blueDark} /></View>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{project.name}</Text>
                  {project.description || project.repo ? <Text style={styles.preview} numberOfLines={1}>{project.description || project.repo}</Text> : null}
                </View>
                {project.people.length > 1 ? <AppIcon name="people" size={16} color={colors.muted} /> : null}
                <Text style={styles.rowWhen}>{project.chatCount}</Text>
                <AppIcon name="chevronRight" size={16} color={colors.muted} />
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
              <Button label={projects?.vibeCoder ? "Start vibe coding" : "New conversation"} onPress={() => void start()} busy={starting} style={styles.emptyAction} />
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
                      {activeAgentTurn(item.latestTurn) ? <Text style={styles.turnLabel} numberOfLines={1}>{agentTurnLabel(item.latestTurn!)}</Text>
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
      <Modal visible={naming} transparent animationType="fade" onRequestClose={() => setNaming(false)}>
        <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={() => setNaming(false)}>
          <Pressable accessibilityViewIsModal style={styles.card} onPress={() => {}}>
            <Text accessibilityRole="header" style={styles.cardTitle}>New project</Text>
            <TextInput accessibilityLabel="Project name" autoFocus value={projectName} onChangeText={setProjectName} onSubmitEditing={() => void createProject()} returnKeyType="done" maxLength={60}
              placeholder="e.g. Refund tracker" placeholderTextColor={colors.muted} style={styles.cardInput} />
            {projectError ? <Text accessibilityRole="alert" style={styles.error}>{projectError}</Text> : null}
            <View style={styles.cardActions}>
              <Button label="Cancel" kind="secondary" onPress={() => setNaming(false)} style={{ flex: 1 }} />
              <Button label="Create" busy={projectBusy} disabled={!projectName.trim()} onPress={() => void createProject()} style={{ flex: 1 }} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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
  rowCopy: { flex: 1, minWidth: 0 }, rowTop: { flexDirection: "row", alignItems: "center" }, byline: { ...typography.meta, color: colors.muted, marginTop: space.xxs }, privateTag: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xxs, marginTop: space.xxs, marginRight: space.sm }, preview: { ...typography.caption, color: colors.muted, flexShrink: 1 }, turnLabel: { ...typography.meta, flex: 1, color: colors.blue, marginTop: space.xxs, marginRight: space.sm },
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
  projectHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: space.side, paddingRight: space.xs },
  projectTitle: { ...typography.label, color: colors.muted },
  projectAction: { minHeight: 44, paddingHorizontal: space.sm, justifyContent: "center" },
  projectLink: { ...typography.bodyStrong, color: colors.blue },
  projectEmpty: { ...typography.caption, color: colors.muted, paddingHorizontal: space.side, paddingBottom: space.sm },
  projectRow: { minHeight: 56, paddingHorizontal: space.side, flexDirection: "row", alignItems: "center", gap: space.sm },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: "rgba(17,46,81,0.42)" },
  card: { width: "100%", maxWidth: 420, backgroundColor: colors.background, borderRadius: radius.lg, padding: space.side },
  cardTitle: { ...typography.heading, color: colors.ink, marginBottom: space.sm },
  cardInput: { ...typography.body, color: colors.ink, minHeight: 48, paddingHorizontal: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  cardActions: { flexDirection: "row", gap: space.sm, marginTop: space.md },
  empty: { marginTop: space.xxl, alignItems: "center", paddingHorizontal: space.side },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyBody: { ...typography.body, marginTop: space.xs, color: colors.muted, textAlign: "center", maxWidth: 360 },
  emptyAction: { alignSelf: "stretch", marginTop: space.lg, marginBottom: space.xl },
  picker: { minHeight: 48, marginHorizontal: space.side, marginBottom: space.xs, paddingHorizontal: space.sm, flexDirection: "row", alignItems: "center", gap: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  pickerLabel: { ...typography.caption, color: colors.muted },
  pickerValue: { ...typography.bodyStrong, flex: 1, color: colors.ink },
}));
