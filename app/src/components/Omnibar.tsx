import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { router, type Href } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, ServerError, type Account, type Chat, type Conversation, type Person, type SearchResults } from "../lib/server";
import { useSession } from "../lib/session";
import { matchesQuery, omnibarShortcuts, searchExcerpt } from "../lib/omnibar";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { Button } from "./Button";
import { AppIcon, type AppIconName } from "./AppIcon";

type Result = { id: string; title: string; detail: string; glyph: string; href?: Href; person?: Person; archived?: boolean };
type Group = { title: string; items: Result[] };
type Row = { kind: "heading"; id: string; title: string } | { kind: "result"; id: string; result: Result; index: number };
type Response = { query: string; attempt: number; data?: SearchResults; error?: string };

function resultIcon(glyph: string): AppIconName {
  return glyph === "#" ? "hash" : glyph === "@" ? "user" : glyph === "✦" ? "sparkles" : glyph === "↳" ? "chat" : "compose";
}

// "bar" is the phone header; "sidebar" is the compact trigger in the wide layout.
export function Omnibar({ variant = "bar" }: { variant?: "bar" | "sidebar" }) {
  const { account } = useSession();
  return account ? <SearchBar account={account} variant={variant} /> : null;
}

function SearchBar({ account, variant }: { account: Account; variant: "bar" | "sidebar" }) {
  const styles = useStyles();
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const mobile = width < 600;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationError, setConversationError] = useState(false);
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [response, setResponse] = useState<Response | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatError, setChatError] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const trigger = useRef<ComponentRef<typeof View>>(null);
  const list = useRef<FlatList<Row>>(null);
  const session = useRef(0);
  const operation = useRef(false);
  const searchQuery = query.trim().replace(/^[#@]/, "").trim();
  const currentResponse = response?.query === searchQuery && response.attempt === attempt ? response : null;
  const searching = searchQuery.length >= 2 && !currentResponse;

  useEffect(() => () => { session.current++; operation.current = false; }, []);

  const open = useCallback(() => {
    session.current++;
    operation.current = false;
    setQuery("");
    setActive(0);
    setResponse(null);
    setOpening(null);
    setActionError(null);
    setVisible(true);
  }, []);
  const close = useCallback(() => {
    session.current++;
    operation.current = false;
    setVisible(false);
    setOpening(null);
    Keyboard.dismiss();
    if (Platform.OS === "web") trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (visible) input.current?.focus(); else open();
      } else if (visible && event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [close, open, visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    // Keep this cache scoped to the keyed account, including during sign-in
    // transitions. Load only when the search panel is used.
    api.conversations(account).then(
      value => { if (!cancelled) { setConversations(value); setConversationError(false); } },
      () => { if (!cancelled) setConversationError(true); },
    );
    api.chats(account).then(
      value => { if (!cancelled) { setChats(value); setChatError(false); } },
      () => { if (!cancelled) setChatError(true); },
    );
    return () => { cancelled = true; };
  }, [account, attempt, visible]);

  useEffect(() => {
    if (!visible || searchQuery.length < 2) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      api.search(account, searchQuery, controller.signal).then(
        data => { if (!controller.signal.aborted) setResponse({ query: searchQuery, attempt, data }); },
        error => {
          if (controller.signal.aborted) return;
          setResponse({ query: searchQuery, attempt, error: error instanceof ServerError && error.status === 404
            ? "Message and people search needs an updated server. You can still jump to your conversations."
            : "Couldn't search the server. You can still open your conversations below." });
        },
      );
    }, 250);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [account, attempt, searchQuery, visible]);

  const groups = useMemo((): Group[] => {
    const existing = conversations ?? [];
    const matches = existing.filter(c => (searchQuery || !c.archived) && matchesQuery(searchQuery, c.title))
      .sort((a, b) => Number(a.archived) - Number(b.archived) || b.updatedAt - a.updatedAt);
    const conversationResult = (c: (typeof existing)[number]): Result => ({
      id: `conversation:${c.id}`, title: c.kind === "channel" ? `#${c.title}` : c.title,
      detail: c.archived ? "Archived channel" : c.kind === "channel" ? (c.private ? "Private channel" : "Channel") : "Direct message",
      glyph: c.kind === "channel" ? "#" : "@", archived: c.archived,
      href: { pathname: "/c/[id]", params: { id: c.id } },
    });
    const actions: Result[] = omnibarShortcuts(searchQuery, account.user.role === "owner").map(action => ({
      id: `action:${action.id}`, title: action.title, detail: action.detail, glyph: "↗", href: action.path,
    }));
    if (!searchQuery) return [
      { title: "Recent conversations", items: matches.slice(0, 6).map(conversationResult) },
      { title: "Quick actions", items: actions.slice(0, 4) },
    ];
    const known = new Set(existing.map(c => c.id));
    const discovered: Result[] = (currentResponse?.data?.channels ?? []).filter(c => !known.has(c.id)).map(c => ({
      id: `channel:${c.id}`, title: `#${c.name}`, detail: c.archived ? "Archived channel" : (c.joined ? "Channel" : "Public channel · Preview before joining"),
      glyph: "#", archived: c.archived, href: { pathname: "/c/[id]", params: { id: c.id } },
    }));
    return [
      { title: "Channels", items: [...matches.filter(c => c.kind === "channel").slice(0, 8).map(conversationResult), ...discovered] },
      { title: "Direct messages", items: matches.filter(c => c.kind === "dm").slice(0, 6).map(conversationResult) },
      { title: "People", items: (currentResponse?.data?.people ?? []).map(person => ({ id: `person:${person.id}`, title: person.name, detail: "Open a direct message", glyph: "@", person })) },
      { title: "Agent chats", items: chats.filter(c => matchesQuery(searchQuery, c.title)).slice(0, 6).map(chat => ({ id: `chat:${chat.id}`, title: chat.title, detail: "Private agent chat", glyph: "✦", href: { pathname: "/chat/[id]", params: { id: chat.id, title: chat.title } } })) },
      { title: "Messages", items: (currentResponse?.data?.messages ?? []).map(message => ({
        id: `message:${message.id}`, title: `${message.user.name} · ${message.conversationKind === "channel" ? "#" : ""}${message.conversationTitle}`,
        detail: searchExcerpt(message.text, searchQuery), glyph: "↳",
        href: { pathname: "/thread", params: { conv: message.conversationId, root: message.threadRoot ?? message.id, focus: message.id, title: `${message.conversationKind === "channel" ? "#" : ""}${message.conversationTitle}` } },
      })) },
      { title: "Quick actions", items: actions },
    ];
  }, [account.user.role, chats, conversations, currentResponse?.data, searchQuery]);
  const results = groups.flatMap(group => group.items);
  const selected = Math.min(active, Math.max(0, results.length - 1));
  let index = 0;
  const rows: Row[] = groups.flatMap(group => group.items.length ? [
    { kind: "heading" as const, id: `heading:${group.title}`, title: group.title },
    ...group.items.map(result => ({ kind: "result" as const, id: result.id, result, index: index++ })),
  ] : []);

  const activate = async (result: Result) => {
    if (operation.current) return;
    setActionError(null);
    if (result.person) {
      operation.current = true;
      setOpening(result.id);
      const currentSession = session.current;
      try {
        const conversation = await api.openDm(account, [result.person.id]);
        if (session.current !== currentSession) return;
        close();
        router.push({ pathname: "/c/[id]", params: { id: conversation.id, compose: "1" } });
      } catch (error) {
        if (session.current === currentSession) setActionError(error instanceof ServerError ? error.message : "Couldn't open this conversation. Try again.");
      } finally {
        if (session.current === currentSession) { operation.current = false; setOpening(null); }
      }
    } else if (result.href) {
      close();
      router.push(result.href);
    }
  };
  const move = (delta: number) => {
    if (!results.length) return;
    const next = (selected + delta + results.length) % results.length;
    setActive(next);
    const rowIndex = rows.findIndex(row => row.kind === "result" && row.index === next);
    list.current?.scrollToIndex({ index: rowIndex, viewPosition: 0.5, animated: false });
  };

  return <>
    {variant === "sidebar" ? <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel="Search Servant" accessibilityHint="Find channels, people, messages, and quick actions" accessibilityState={{ expanded: visible }} onPress={open}
      style={state => [styles.sidebarTrigger, ((state as { hovered?: boolean }).hovered || state.pressed) && styles.sidebarTriggerHovered]}>
      <AppIcon name="search" color={colors.onBrand} size={16} />
      <Text numberOfLines={1} style={styles.sidebarPlaceholder}>Search</Text>
      <Text style={styles.sidebarShortcut}>⌘K</Text>
    </Pressable> : <View style={[styles.header, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={styles.headerRow}>
        <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel="Search Servant" accessibilityHint="Find channels, people, messages, and quick actions" accessibilityState={{ expanded: visible }} onPress={open} style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}>
          <AppIcon name="search" color={colors.onBrand} size={18} />
          <Text numberOfLines={1} style={styles.placeholder}>Search</Text>
          {Platform.OS === "web" && width >= 600 ? <Text style={styles.shortcut}>⌘ / Ctrl K</Text> : null}
        </Pressable>
      </View>
    </View>}
    <Modal transparent visible={visible} animationType="fade" onRequestClose={close} onShow={() => input.current?.focus()}>
      {visible && mobile ? <StatusBar style={scheme === "dark" ? "light" : "dark"} /> : null}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalRoot}>
        <View style={[styles.overlay, mobile && styles.mobileOverlay, { paddingTop: insets.top + (mobile ? 0 : variant === "sidebar" ? 96 : space.sm), paddingBottom: mobile ? 0 : Math.max(insets.bottom, space.sm) }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close search" onPress={close} style={StyleSheet.absoluteFill} />
          <View style={[styles.panel, mobile && styles.mobilePanel]} accessibilityViewIsModal>
            <View style={styles.searchRow}>
              <AppIcon name="search" color={colors.muted} size={20} />
              <TextInput ref={input} accessibilityLabel="Search channels, people, and messages" placeholder="Search" placeholderTextColor={colors.muted} value={query} maxLength={100} autoFocus autoCapitalize="none" autoCorrect={false} returnKeyType="search" blurOnSubmit={false}
                {...(Platform.OS === "web" ? { role: "combobox" as const, "aria-controls": "servant-search-results", "aria-expanded": true, "aria-autocomplete": "list", "aria-activedescendant": results[selected] ? `omnibar-${results[selected].id}` : undefined } : {})}
                onChangeText={value => { setQuery(value); setActive(0); setActionError(null); }}
                onKeyPress={event => {
                  if (event.nativeEvent.key === "ArrowDown") { event.preventDefault(); move(1); }
                  if (event.nativeEvent.key === "ArrowUp") { event.preventDefault(); move(-1); }
                }}
                onSubmitEditing={() => { if (results[selected]) void activate(results[selected]); }}
                style={styles.input} />
              <Pressable accessibilityRole="button" onPress={close} style={styles.cancel}><Text style={styles.cancelText}>Cancel</Text></Pressable>
            </View>
            <View style={styles.context}>
              <Text numberOfLines={1} style={styles.contextText}>{searchQuery ? `Top matches in ${account.serverName}` : account.serverName}</Text>
              {searching ? <ActivityIndicator accessibilityLabel="Searching" size="small" color={colors.blue} /> : null}
            </View>
            {searchQuery.length === 1 ? <Text style={styles.hint}>Type one more character to search people and messages.</Text> : null}
            {currentResponse?.error ? <View style={styles.notice}><Text accessibilityRole="alert" style={styles.error}>{currentResponse.error}</Text><Button label="Retry search" compact kind="link" onPress={() => setAttempt(n => n + 1)} /></View> : null}
            {actionError ? <Text accessibilityRole="alert" style={styles.actionError}>{actionError}</Text> : null}
            <FlatList ref={list} nativeID="servant-search-results" accessibilityRole={Platform.OS === "web" ? "listbox" : undefined} accessibilityLabel="Search results" data={rows} keyExtractor={row => row.id} extraData={{ selected, opening }} keyboardShouldPersistTaps="handled" style={[styles.results, mobile && styles.mobileResults]} contentContainerStyle={styles.resultContent}
              onScrollToIndexFailed={info => list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })}
              ListEmptyComponent={<View style={styles.empty}><Text accessibilityRole="header" style={styles.emptyTitle}>{searching ? "Searching Servant…" : currentResponse?.error ? "Search unavailable" : "No matches"}</Text><Text style={styles.emptyBody}>{searching ? "Looking through conversations you can access." : currentResponse?.error ? "Retry the search, or try a conversation name." : "Try a different name, topic, or phrase."}</Text></View>}
              renderItem={({ item }) => item.kind === "heading" ? <Text accessibilityRole="header" style={styles.groupTitle}>{item.title}</Text> :
                <Pressable nativeID={`omnibar-${item.result.id}`} accessibilityRole={Platform.OS === "web" ? "option" : "button"} accessibilityLabel={`${item.result.title}. ${item.result.detail}`} accessibilityHint={item.result.id.startsWith("message:") ? "Open the thread containing this message" : undefined} accessibilityState={{ selected: item.index === selected, busy: opening === item.id, disabled: !!opening }} disabled={!!opening}
                  onPress={() => { void activate(item.result); }} onHoverIn={() => setActive(item.index)}
                  style={({ pressed }) => [styles.result, item.index === selected && styles.resultSelected, pressed && styles.resultPressed]}>
                  <View style={[styles.glyph, item.result.archived && styles.glyphArchived]}><AppIcon name={resultIcon(item.result.glyph)} size={20} color={colors.muted} /></View>
                  <View style={styles.resultCopy}><Text numberOfLines={1} style={styles.resultTitle}>{item.result.title}</Text><Text numberOfLines={2} style={styles.resultDetail}>{item.result.detail}</Text></View>
                  {opening === item.id ? <ActivityIndicator color={colors.blue} /> : <AppIcon name="chevronRight" size={16} color={colors.muted} />}
                </Pressable>}
              ListFooterComponent={conversationError || (searchQuery && chatError) ? <View><Text style={styles.hint}>{conversationError ? "Recent conversations couldn't be refreshed." : "Agent chat titles couldn't be loaded."}</Text><Button label="Try again" kind="link" compact onPress={() => setAttempt(n => n + 1)} /></View> : undefined} />
            {Platform.OS === "web" ? <Text style={styles.keyboardHint}>↑ ↓ to navigate · Enter to open · Esc to close</Text> : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  header: { backgroundColor: colors.navy },
  headerRow: { paddingHorizontal: space.side, paddingTop: space.xs, paddingBottom: space.sm },
  trigger: { minWidth: 0, minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.xs, borderRadius: radius.pill, backgroundColor: "rgba(255,255,255,0.18)" },
  triggerPressed: { backgroundColor: "rgba(255,255,255,0.26)" },
  placeholder: { ...typography.body, color: colors.onBrand, flex: 1 },
  shortcut: { ...typography.caption, color: colors.onBrand },
  sidebarTrigger: { minHeight: 34, paddingLeft: space.sm, paddingRight: 6, flexDirection: "row", alignItems: "center", gap: space.xs, borderRadius: radius.pill, backgroundColor: "rgba(255,255,255,0.18)" },
  sidebarTriggerHovered: { backgroundColor: "rgba(255,255,255,0.26)" },
  sidebarPlaceholder: { ...typography.caption, color: colors.onBrand, flex: 1 },
  sidebarShortcut: { ...typography.meta, color: colors.onBrand, paddingHorizontal: 7, paddingVertical: 1, borderRadius: radius.pill, backgroundColor: "rgba(255,255,255,0.24)", overflow: "hidden" },
  modalRoot: { flex: 1 },
  overlay: { flex: 1, paddingHorizontal: space.sm, alignItems: "center", backgroundColor: "rgba(20,30,45,0.45)" },
  mobileOverlay: { paddingHorizontal: 0, backgroundColor: colors.background },
  mobilePanel: { flex: 1, borderRadius: 0 },
  mobileResults: { flex: 1 },
  panel: { width: "100%", maxWidth: 760, maxHeight: "100%", flexShrink: 1, borderRadius: radius.lg, backgroundColor: colors.background, overflow: "hidden" },
  searchRow: { minHeight: 56, paddingLeft: space.md, paddingRight: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  input: { ...typography.body, color: colors.ink, flex: 1, minWidth: 0, minHeight: 48, paddingVertical: space.xs },
  cancel: { minHeight: 44, paddingHorizontal: space.sm, justifyContent: "center" },
  cancelText: { ...typography.label, color: colors.blue },
  context: { paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", gap: space.sm, alignItems: "center", backgroundColor: colors.surface },
  contextText: { ...typography.caption, color: colors.muted, flex: 1 },
  hint: { ...typography.caption, paddingHorizontal: space.md, paddingVertical: space.sm, color: colors.muted },
  notice: { paddingHorizontal: space.md, paddingTop: space.sm },
  error: { ...typography.caption, color: colors.red },
  actionError: { ...typography.caption, color: colors.red, padding: space.md },
  results: { flexShrink: 1 },
  resultContent: { paddingBottom: space.sm },
  groupTitle: { ...typography.label, color: colors.muted, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.xs },
  result: { minHeight: 56, paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm },
  resultSelected: { backgroundColor: colors.blueSoft },
  resultPressed: { backgroundColor: colors.subtle },
  glyph: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  glyphArchived: { opacity: 0.65 },
  glyphText: { ...typography.heading, color: colors.muted },
  resultCopy: { flex: 1, minWidth: 0 },
  resultTitle: { ...typography.bodyStrong, color: colors.ink },
  resultDetail: { ...typography.caption, color: colors.muted, marginTop: 2 },
  arrow: { ...typography.heading, color: colors.muted },
  empty: { padding: space.xl, alignItems: "center", gap: space.xs },
  emptyTitle: { ...typography.heading, color: colors.ink },
  emptyBody: { ...typography.body, color: colors.muted, textAlign: "center" },
  keyboardHint: { ...typography.caption, color: colors.muted, padding: space.sm, textAlign: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
}));
