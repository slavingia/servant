import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, router, useFocusEffect } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { AppIcon } from "../components/AppIcon";
import { NewCaseDialog } from "../components/NewCaseDialog";
import { Button, ButtonGroup } from "../components/Button";
import { Avatar } from "../components/Messaging";
import { request, type Account } from "../lib/server";
import { useSession } from "../lib/session";
import { landingHref, useFeatures } from "../lib/features";
import { createInboxClient, inboxDueLabel, inboxOverdue, pollInbox, type InboxConversation, type InboxFilter, type InboxScope } from "../lib/secure-inbox";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";
import { ServeLoader } from "../components/ServeLoader";

export default function InboxScreen() {
  const { account } = useSession();
  const features = useFeatures();
  if (!account) return null;
  if (!features.secureInbox) return <Redirect href={landingHref(features)} />;
  return <Inbox key={`${account.serverUrl}:${account.token}:${account.serverKey}`} account={account} />;
}

function Inbox({ account }: { account: Account }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const client = useMemo(() => createInboxClient((path, init) => request(account, path, init)), [account]);
  const [status, setStatus] = useState<InboxFilter>("open");
  const [scope, setScope] = useState<InboxScope>("all");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; status: InboxFilter; scope: InboxScope; list: InboxConversation[]; hasMore: boolean; publicUrl: string | null } | null>(null);
  const [pages, setPages] = useState(1);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => { setQuery(search); setPages(1); }, 250);
    return () => clearTimeout(timer);
  }, [search, query]);
  useFocusEffect(useCallback(() => {
    return pollInbox(async signal => {
      if ((AppState.currentState && AppState.currentState !== "active") || (Platform.OS === "web" && document.hidden)) return;
      let offset = 0;
      let hasMore = false;
      let publicUrl: string | null = null;
      const conversations = new Map<string, InboxConversation>();
      for (let page = 0; page < pages; page++) {
        const next = await client.list(status, query, signal, offset, scope);
        if (signal.aborted) return;
        for (const conversation of next.conversations) conversations.set(conversation.id, conversation);
        publicUrl = next.publicUrl;
        hasMore = next.hasMore;
        if (!hasMore) break;
        if (next.nextOffset === null || next.nextOffset <= offset) throw new Error("Couldn't load the next conversations. Try again.");
        offset = next.nextOffset;
      }
      if (!signal.aborted) { setResult({ query, status, scope, list: [...conversations.values()], hasMore, publicUrl }); setError(""); }
    }, cause => setError(cause instanceof Error ? cause.message : "Couldn't load the inbox. Try again."));
    // A manual retry restarts the focused poll immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, query, status, scope, pages, attempt]));
  const current = result?.query === query && result.status === status && result.scope === scope ? result : null;
  const list = current?.list ?? null;

  const copyLink = async () => {
    if (!result?.publicUrl) return;
    try { await Clipboard.setStringAsync(result.publicUrl); setCopied(true); setActionError(""); }
    catch { setActionError("Couldn't copy the public link. Try again."); }
  };
  const linkNote = result?.publicUrl ? "Anyone with your public link can start a private chat and share files."
    : result ? "Public chat link unavailable. Ask an owner to configure a public HTTPS address for this server." : "Loading public chat link…";
  return <View style={styles.root}>
    <FlatList data={list ?? []} keyExtractor={item => item.id} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      ListHeaderComponent={<View style={styles.header}>
        {/* The screen's header already says Cases, so the two things to do come first, with one line on what the public link is. */}
        <View style={styles.actions}>
          <ButtonGroup>
            <Button label="New case" compact onPress={() => setCreating(true)} />
            {result?.publicUrl ? <Button label={copied ? "Link copied" : "Copy public link"} compact kind="secondary" onPress={() => void copyLink()} /> : null}
          </ButtonGroup>
          <Text style={styles.caption}>{linkNote}</Text>
        </View>
        {/* Open, Resolved and All divide the list, like the tabs on Saved; the chips under the search narrow it. */}
        <View accessibilityRole="tablist" accessibilityLabel="Case status" style={styles.tabs}>{(["open", "resolved", "all"] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityLabel={value === "all" ? "All conversations" : value === "open" ? "Open conversations" : "Resolved conversations"} accessibilityState={{ selected: status === value }} aria-selected={status === value} onPress={() => { setStatus(value); setPages(1); }} style={[styles.tab, status === value && styles.tabOn]}>
          <Text style={[styles.tabText, status === value && styles.tabTextOn]}>{value === "all" ? "All" : value === "open" ? "Open" : "Resolved"}</Text>
        </Pressable>)}</View>
        <TextInput accessibilityLabel="Search cases" placeholder="Case reference, person, email, or subject" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} style={styles.search} returnKeyType="search" autoCapitalize="none" />
        {/* The four wrap rather than scroll sideways, so none is cut off at the edge of a phone. */}
        <View accessibilityRole="radiogroup" accessibilityLabel="Cases to show" style={styles.chips}>
          {SCOPES.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: scope === item.id }} aria-checked={scope === item.id} onPress={() => { setScope(item.id); setPages(1); }} style={[styles.chip, scope === item.id && styles.chipOn]}>
            <Text style={[styles.chipText, scope === item.id && styles.chipTextOn]}>{item.label}</Text>
          </Pressable>)}
        </View>
        {error ? <View style={styles.errorRow}><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Button label="Try again" compact kind="link" onPress={() => setAttempt(value => value + 1)} /></View> : null}
        {actionError ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
      </View>}
      ListEmptyComponent={error ? undefined : list === null ? <ServeLoader style={styles.empty} accessibilityLabel="Loading cases" /> : <View style={styles.empty}><AppIcon name="chat" size={28} color={colors.muted} /><Text style={styles.emptyTitle}>{query.trim() ? "No matching cases" : status === "resolved" ? "No resolved cases" : "You're all caught up"}</Text><Text style={styles.emptyText}>{query.trim() ? "Try a different reference, name, or subject." : "Create a case or share your public link to start helping someone."}</Text></View>}
      ListFooterComponent={current?.hasMore ? <Button label="Load more cases" kind="secondary" onPress={() => setPages(value => value + 1)} style={{ marginTop: space.md }} /> : undefined}
      renderItem={({ item }) => <InboxRow item={item} />} />
    {creating ? <NewCaseDialog client={client} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); router.push({ pathname: "/inbox/[id]", params: { id } }); }} /> : null}
  </View>;
}

const SCOPES: { id: InboxScope; label: string }[] = [{ id: "all", label: "All cases" }, { id: "mine", label: "My cases" }, { id: "unassigned", label: "Unassigned" }, { id: "due", label: "Due follow-ups" }];

// Who, about what, the latest words, then where it stands: the reference, its owner and what is still to do.
function InboxRow({ item }: { item: InboxConversation }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const followUps = item.openTaskCount ? ` · ${item.openTaskCount} ${item.openTaskCount === 1 ? "follow-up" : "follow-ups"}` : "";
  return <View style={styles.row}>
    <Avatar name={item.name} size={40} />
    <View style={styles.rowCopy}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${item.subject}, ${item.name}${item.unread ? `, ${item.unread} unread` : ""}`} onPress={() => router.push({ pathname: "/inbox/[id]", params: { id: item.id } })} style={({ pressed }) => [styles.mainRow, pressed && { backgroundColor: colors.surface }]}>
        <View style={styles.rowTop}><Text style={[styles.name, item.unread > 0 && styles.unread]}>{item.name}</Text><Text style={styles.date}>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</Text></View>
        <Text style={styles.subject}>{item.subject}</Text>
        <Text numberOfLines={2} style={styles.preview}>{item.lastMessage ? `${item.lastMessage.sender === "staff" ? "Team: " : ""}${item.lastMessage.text || "Shared a file"}` : "No public messages yet"}</Text>
        <View style={styles.rowMeta}>
          <Text style={styles.meta}>{item.reference} · {item.assigneeName || "Unassigned"}{followUps}</Text>
          {item.status === "resolved" ? <Text style={styles.status}>Resolved</Text> : null}
          {item.unread > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{item.unread > 99 ? "99+" : item.unread}</Text></View> : null}
        </View>
      </Pressable>
      {item.nextAction ? <Pressable accessibilityRole="button" accessibilityLabel={`Next action for ${item.reference}: ${item.nextAction.text}`} onPress={() => router.push({ pathname: "/inbox/[id]", params: { id: item.id, tab: "tasks" } })} style={({ pressed }) => [styles.nextAction, pressed && { backgroundColor: colors.subtle }]}>
        <Text numberOfLines={2} style={styles.nextText}>Next: {item.nextAction.text}</Text>
        <Text style={[styles.caption, inboxOverdue(item.nextAction.dueDate) && styles.overdue]}>{inboxDueLabel(item.nextAction.dueDate)}</Text>
      </Pressable> : null}
    </View>
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  search: controls.input,
  root: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, paddingHorizontal: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 960, alignSelf: "center" },
  header: { paddingTop: space.md, paddingBottom: space.xs, gap: space.sm },
  actions: { gap: space.xs },
  caption: { ...typography.caption, color: colors.muted },
  // The same segmented tabs as Saved and a project.
  tabs: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.pill, padding: 3, width: "100%", maxWidth: 400 },
  tab: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, paddingHorizontal: space.xs },
  tabOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  tabText: { ...typography.captionStrong, color: colors.muted },
  tabTextOn: { color: colors.ink },
  // The same chips as To-dos.
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  chipOn: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
  chipText: { ...typography.label, color: colors.ink },
  chipTextOn: { color: colors.blueDark },
  errorRow: { gap: space.xs, alignItems: "flex-start" }, error: { ...typography.caption, color: colors.red },
  empty: { paddingVertical: space.xxl, paddingHorizontal: space.lg, alignItems: "center", gap: space.sm }, emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" }, emptyText: { ...typography.body, color: colors.muted, maxWidth: 340, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowCopy: { flex: 1, minWidth: 0 },
  mainRow: { minHeight: 44, borderRadius: radius.sm },
  rowTop: { flexDirection: "row", gap: space.sm, alignItems: "baseline" },
  name: { ...typography.bodyStrong, color: colors.ink, flex: 1 },
  unread: { fontWeight: "700" },
  date: { ...typography.meta, color: colors.muted },
  subject: { ...typography.body, color: colors.ink },
  preview: { ...typography.caption, color: colors.muted, marginTop: 2 },
  rowMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs, marginTop: space.xxs },
  meta: { ...typography.meta, color: colors.muted, flexShrink: 1 },
  status: { ...typography.meta, color: colors.muted, backgroundColor: colors.surface, paddingHorizontal: space.xs, paddingVertical: 2, borderRadius: radius.sm },
  badge: { marginLeft: "auto", minWidth: 24, height: 24, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xs },
  badgeText: { ...typography.captionStrong, color: colors.onPrimary },
  nextAction: { marginTop: space.xs, paddingVertical: space.xs, paddingHorizontal: space.sm, minHeight: 44, justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.surface },
  nextText: { ...typography.captionStrong, color: colors.ink },
  overdue: { color: colors.red },
}));
