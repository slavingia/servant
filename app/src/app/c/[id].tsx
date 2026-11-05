import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConversationKeyboardView } from "../../components/ConversationKeyboardView";
import { Button } from "../../components/Button";
import { Composer, MessageDate, PostRow } from "../../components/Messaging";
import { MediaGalleryProvider } from "../../components/MediaGallery";
import { mediaFromPosts } from "../../lib/media";
import { PresenceLine, usePresentPeers } from "../../components/Presence";
import { useReadReceipts } from "../../lib/use-read-receipts";
import { mergeReadEvent } from "../../lib/read-receipts";
import { latestMessageReceipts } from "../../lib/message-status";
import { canCompactPost } from "../../lib/message-device";
import { TypingLine, useTyping, useTypingPing } from "../../lib/typing";
import { useActiveCall } from "../../lib/active-call";
import { callErrorText, callsSupported } from "../../lib/meeting-call";
import { api, ServerError, type Conversation, type Upload, type Post, type LiveEvent } from "../../lib/server";
import { useLive } from "../../lib/live";
import { useSession } from "../../lib/session";
import { askAgentAbout } from "../../lib/ask-agent";
import { parseSlash, resolvePeople, splitDm } from "../../lib/slash-commands";
import { ChannelDetails } from "../channel-info";
import { useWideLayout } from "../../lib/layout";
import { useDetailsPanelOpen } from "../../lib/details-panel";
import { space, typography, useTheme, createThemedStyles } from "../../lib/theme";
import { groupActivity } from "../../lib/activity-groups";

const errorText = (e: unknown, fallback: string) => (e instanceof ServerError ? e.message : fallback);

// Merge posts by id, keeping order by id (ids are increasing numbers).
function merge(list: Post[], incoming: Post[]) {
  const map = new Map(list.map((p) => [p.id, p]));
  for (const p of incoming) map.set(p.id, p);
  return [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export default function ConversationScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { id, compose } = useLocalSearchParams<{ id: string; compose?: string }>();
  const { account } = useSession();
  const focused = useIsFocused();
  const visible = useRef(focused);
  useEffect(() => { visible.current = focused; }, [focused]);
  const { subscribe, setOpen, refresh } = useLive();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [joined, setJoined] = useState(true);
  const [calling, setCalling] = useState(false);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [joining, setJoining] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const loadingOlder = useRef(false);
  const loadSequence = useRef(0);
  const needsSnapshot = useRef(false);
  const accessDenied = useRef(false);
  const snapshot = useRef<{ sequence: number; replace: boolean; updates: Map<string, Post>; reads: Extract<LiveEvent, { event: "messages.read" }>["data"][] } | null>(null);
  const typingNames = useTyping(id, null, account?.user.id ?? "");
  const ping = useTypingPing(account, id);
  const readTracking = useReadReceipts(account, id, focused, joined && posts !== null && !unavailable, undefined, posts ?? undefined);

  const applyPosts = useCallback((incoming: Post[]) => {
    for (const post of incoming) snapshot.current?.updates.set(post.id, post);
    if (accessDenied.current) return;
    setPosts((old) => merge(old ?? [], incoming));
  }, []);

  const load = useCallback(async (reset = false) => {
    if (!account || !id) return;
    const current = { sequence: ++loadSequence.current, replace: reset || needsSnapshot.current || !!snapshot.current?.replace, updates: new Map<string, Post>(), reads: [] as Extract<LiveEvent, { event: "messages.read" }>["data"][] };
    snapshot.current = current;
    try {
      const [c, p] = await Promise.all([api.conversation(account, id), api.posts(account, id)]);
      if (snapshot.current !== current) return;
      needsSnapshot.current = false;
      accessDenied.current = false;
      setConv(c.conversation);
      setJoined(c.joined);
      const recovered = merge(p.messages, [...current.updates.values()]).map(post => current.reads.reduce(mergeReadEvent, post));
      setPosts((old) => current.replace ? recovered : merge(old ?? [], recovered));
      setMore(p.more);
      setUnavailable(false);
      setError(null);
    } catch (e) {
      if (snapshot.current !== current) return;
      setError(errorText(e, "Couldn't load this conversation"));
      if (e instanceof ServerError && [401, 403, 404].includes(e.status)) {
        accessDenied.current = true;
        setConv(null);
        setJoined(false);
        setPosts([]);
        setMore(false);
        setEditing(null);
        setUnavailable(true);
      } else setPosts((old) => old ?? []);
    } finally {
      if (snapshot.current === current) snapshot.current = null;
    }
  }, [account, id]);

  useEffect(() => () => {
    loadSequence.current++;
    snapshot.current = null;
  }, [account, id]);

  useEffect(() => {
    load();
    setOpen(focused ? id : null);
    return () => {
      setOpen(null);
      refresh();
    };
  }, [load, id, setOpen, refresh, focused]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", state => {
      if (state === "active" && visible.current) void load();
    });
    return () => sub.remove();
  }, [load]);

  useEffect(
    () =>
      subscribe((e) => {
        if (!account) return;
        if (e.event === "ready" && (e.data.reset !== false || needsSnapshot.current)) {
          needsSnapshot.current = true;
          setPosts(null);
          setMore(false);
          void load(true);
        } else if (e.event === "message.created" || e.event === "message.updated") {
          const p = e.data;
          if (p.conversationId !== id || p.threadRoot) return;
          applyPosts([p]);
        } else if (e.event === "messages.read" && e.data.conversationId === id) {
          snapshot.current?.reads.push(e.data);
          setPosts(old => old?.map(post => mergeReadEvent(post, e.data)) ?? null);
        } else if (e.event === "conversation.updated" && e.data.id === id) {
          void load();
        }
      }),
    [subscribe, account, id, applyPosts, load],
  );

  const media = useMemo(() => mediaFromPosts(posts ?? []), [posts]);
  const receipts = useMemo(() => conv && conv.id === id && conv.kind === "dm"
    ? latestMessageReceipts(posts ?? [], account?.user.id ?? "", conv.members)
    : undefined, [posts, account?.user.id, conv, id]);
  const activeCall = useActiveCall();
  const peers = conv?.kind === "dm" ? conv.members?.filter(person => person.id !== account?.user.id && !person.agent) ?? [] : [];
  const shownPeers = usePresentPeers(peers);
  const wide = useWideLayout();
  const insets = useSafeAreaInsets();
  const [detailsOpen, setDetailsOpen] = useDetailsPanelOpen();
  if (!account) return null;
  const me = account.user.id;
  const isChannel = conv?.kind === "channel";
  const title = conv ? (isChannel ? `#${conv.title}` : conv.title) : "Conversation";

  const older = async () => {
    if (!more || loadingOlder.current || !posts?.length) return;
    loadingOlder.current = true;
    const sequence = loadSequence.current;
    try {
      const p = await api.posts(account, id, posts[0]!.id);
      if (sequence !== loadSequence.current) return;
      setPosts((old) => merge(old ?? [], p.messages));
      setMore(p.more);
    } catch {
      /* try again on next scroll */
    } finally { loadingOlder.current = false; }
  };

  // Slack-style commands. Returns true when handled (the box clears), false to keep the draft.
  const runCommand = async (text: string): Promise<boolean | null> => {
    const cmd = parseSlash(text, isChannel);
    if (!cmd) return null;
    const need = (what: string) => { setError(`Add ${what}: /${cmd.name} ${cmd.hint}`); return false; };
    try {
      switch (cmd.name) {
        case "invite": {
          if (!cmd.args) return need("who to invite");
          const { people } = await api.people(account);
          const { found, unknown } = resolvePeople(cmd.args, people.filter(p => !p.agent && p.id !== me));
          if (unknown.length) { setError(`Couldn't find ${unknown.join(", ")}. Use their @name`); return false; }
          await api.addMembers(account, id, found.map(p => p.id));
          setError(null); void load(); return true;
        }
        case "rename": {
          if (!cmd.args) return need("a new name");
          await api.updateChannel(account, id, { name: cmd.args }); setError(null); void load(); return true;
        }
        case "leave": await api.leave(account, id); router.replace("/"); return true;
        case "call": void startCall(); return true;
        case "files": openFiles(); return true;
        case "agent": return cmd.args ? send(`@s ${cmd.args}`) : need("a question");
        case "shrug": return send(`${cmd.args ? cmd.args + " " : ""}¯\\_(ツ)_/¯`);
        case "me": return cmd.args ? send(`_${account.user.name} ${cmd.args}_`) : need("what you're doing");
        case "dm": {
          const { who, message } = splitDm(cmd.args);
          if (!who) return need("who to message");
          const { people } = await api.people(account);
          const { found, unknown } = resolvePeople(who, people.filter(p => !p.agent && p.id !== me));
          if (unknown.length || !found.length) { setError(`Couldn't find ${unknown.join(", ") || who}. Use their @name`); return false; }
          const dm = await api.openDm(account, found.map(p => p.id));
          if (message) await api.post(account, dm.id, message);
          router.push({ pathname: "/c/[id]", params: { id: dm.id } });
          return true;
        }
      }
    } catch (e) { setError(errorText(e, `Couldn't run /${cmd.name}`)); return false; }
    return null;
  };

  const send = async (text: string, attachments: Upload[] = []): Promise<boolean> => {
    if (!attachments.length && text.startsWith("/")) {
      const handled = await runCommand(text);
      if (handled !== null) return handled;
    }
    try {
      const p = await api.post(account, id, text, undefined, attachments);
      applyPosts([p]);
      setError(null);
      return true;
    } catch (e) {
      setError(errorText(e, "Couldn't send. Check your connection"));
      return false;
    }
  };

  const saveEdit = async (text: string) => {
    if (!editing) return true;
    try {
      const p = await api.editPost(account, editing.id, text);
      applyPosts([p]);
      setEditing(null);
      return true;
    } catch (e) {
      setError(errorText(e, "Couldn't save the change"));
      return false;
    }
  };

  const react = async (post: Post, emoji: string, active: boolean) => {
    try {
      const p = await api.reactToPost(account, post.id, emoji, active);
      applyPosts([p]);
      setError(null);
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't save the reaction. Try again");
    }
  };

  const remove = async (p: Post) => {
    try {
      await api.deletePost(account, p.id);
      applyPosts([{ ...p, deleted: true, text: "", attachments: [], reactions: [] }]);
    } catch (e) {
      setError(errorText(e, "Couldn't delete the message"));
    }
  };

  const join = async () => {
    setJoining(true);
    try {
      await api.join(account, id);
      setJoined(true);
      refresh();
    } catch (e) {
      setError(errorText(e, "Couldn't join the channel"));
    }
    setJoining(false);
  };

  const openThread = (p: Post) => router.push({ pathname: "/thread", params: { conv: id, root: p.id, title } });
  const askAgent = (p: Post) => { askAgentAbout(account, p, conv).catch(e => setError(errorText(e, "Couldn't start a chat with the agent"))); };
  // Joins and leaves close together read as one line ("Ann and Bo joined the channel").
  const data = groupActivity([...(posts ?? [])].reverse());

  // Wide screens (browser, Mac app) show Details beside the channel, open by default; Details
  // toggles it. Phones open the Details page.
  const sideDetails = wide && isChannel && detailsOpen;
  const openDetails = () => wide ? setDetailsOpen(!detailsOpen) : router.push({ pathname: "/channel-info", params: { id } });
  const openFiles = () => router.push({ pathname: "/files", params: { kind: "conversation", id, title } });
  const canCall = !!conv && joined && callsSupported();
  const callLabel = activeCall?.state.conversationId === id ? "Return to call" : "Call";
  // One tap starts the meeting (or joins the one already running) and opens the call.
  const startCall = async () => {
    if (!account || calling) return;
    // Already on this conversation's call: go back to it.
    if (activeCall?.state.conversationId === id) { router.push({ pathname: "/meeting/[id]", params: { id: activeCall.id } }); return; }
    setCalling(true);
    try {
      const meeting = await api.startMeeting(account, id);
      router.push({ pathname: "/meeting/[id]", params: { id: meeting.id } });
    } catch (e) { setError(callErrorText(e, "start")); }
    finally { setCalling(false); }
  };
  const headerButton = { type: "button" as const, tintColor: colors.blue, labelStyle: { color: colors.blue, fontSize: typography.label.fontSize, fontWeight: "600" as const }, hidesSharedBackground: true };

  return (
    <MediaGalleryProvider key={`${id}:${unavailable}`} scope={{ kind: "conversation", id }} items={media}>
    <View style={[styles.root, wide && styles.row]}>
      <View style={styles.root}>
      <Stack.Screen
        options={{
          title,
          // Keep channel management quiet beside the conversation title.
          unstable_headerRightItems:
            conv && Platform.OS === "ios"
              ? () => [...(canCall ? [{ ...headerButton, label: callLabel, onPress: startCall }] : []), { ...headerButton, label: "Files", onPress: openFiles }, ...(isChannel ? [{ ...headerButton, label: "Details", onPress: openDetails }] : [])]
              : undefined,
          headerRight:
            conv && Platform.OS !== "ios"
              ? () => (
                  <View style={styles.headerActions}>
                    {canCall ? <Pressable testID="start-call" accessibilityRole="button" accessibilityLabel={callLabel === "Call" ? "Start a call" : callLabel} disabled={calling} onPress={startCall} style={styles.headerAction}>
                      <Text style={styles.headerLink}>{callLabel}</Text>
                    </Pressable> : null}
                    <Pressable testID="open-files" accessibilityRole="button" onPress={openFiles} style={styles.headerAction}>
                      <Text style={styles.headerLink}>Files</Text>
                    </Pressable>
                    {isChannel ? <Pressable accessibilityRole="button" onPress={openDetails} style={styles.headerAction}>
                      <Text style={styles.headerLink}>Details</Text>
                    </Pressable> : null}
                  </View>
                )
              : undefined,
        }}
      />
      {shownPeers.length ? <View style={styles.presence}>
        {shownPeers.map(person => <View key={person.id} style={styles.peer}>
          {peers.length > 1 ? <Text style={styles.peerName}>{person.name}</Text> : null}
          <PresenceLine person={person} />
        </View>)}
      </View> : null}
      <ConversationKeyboardView>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {posts === null ? (
          <ActivityIndicator style={{ flex: 1 }} color={colors.blue} />
        ) : (
          <FlatList
            {...readTracking}
            inverted
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            data={data}
            keyExtractor={(p) => p.id}
            onEndReached={older}
            onEndReachedThreshold={0.3}
            contentContainerStyle={{ paddingVertical: space.sm }}
            ListFooterComponent={
              conv && !more ? (
                <View style={styles.intro}>
                  <Text accessibilityRole="header" style={styles.introTitle}>{title}</Text>
                  <Text style={styles.introBody}>
                    {isChannel
                      ? `This is the start of ${title}`
                      : `This is the start of your conversation with ${conv.title}`}
                  </Text>
                </View>
              ) : undefined
            }
            renderItem={({ item, index }) => {
              const above = data[index + 1];
              const newDay = !above || new Date(item.createdAt).toDateString() !== new Date(above.createdAt).toDateString();
              const compact = canCompactPost(above, item, account.user.role);
              return (
                <View>
                {newDay ? <MessageDate at={item.createdAt} /> : null}
                <PostRow
                  post={item} onReact={joined ? (emoji, active) => react(item, emoji, active) : undefined}
                  me={me}
                  receipt={receipts?.get(item.id)}
                  compact={compact}
                  onOpenThread={() => openThread(item)}
                  onAskAgent={() => askAgent(item)}
                  onSuggest={joined && index === 0 ? (text) => { void send(text); } : undefined}
                  onEdit={() => setEditing(item)}
                  onDelete={() => remove(item)}
                />
                </View>
              );
            }}
          />
        )}
        {joined ? <TypingLine names={typingNames} /> : null}
        {unavailable ? null : !joined ? (
          <View style={[styles.joinBar, { paddingBottom: Math.max(insets.bottom + space.xs, space.xl) }]}>
            <Text style={styles.joinText}>You're previewing {title}</Text>
            <Button label={`Join ${title}`} onPress={join} busy={joining} />
          </View>
        ) : editing ? (
          <Composer members={conv?.members} mentionAgent me={me} key={`edit-${editing.id}`} placeholder="Edit message" initial={editing.text} sendLabel="Save" onSend={saveEdit} onCancel={() => setEditing(null)} />
        ) : (
          <Composer autoFocus={compose === "1"} members={conv?.members} mentionAgent me={me} key={`new-${id}`} placeholder={conv ? `Message ${title}` : "Message"} onSend={send} onTyping={ping} commands={{ channel: isChannel }} />
        )}
      </ConversationKeyboardView>
      </View>
      {sideDetails ? <ChannelDetails key={id} id={id} panel onClose={() => setDetailsOpen(false)} /> : null}
    </View>
    </MediaGalleryProvider>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  row: { flexDirection: "row" },
  presence: { paddingHorizontal: space.side, paddingBottom: space.xs, paddingTop: space.xxs, backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  peer: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, alignItems: "center" },
  peerName: { ...typography.captionStrong, color: colors.ink },
  headerAction: { minHeight: 44, minWidth: 44, justifyContent: "center" },
  // The web header adds no inset on the right; match the back arrow's.
  headerActions: { flexDirection: "row", alignItems: "center", gap: space.md, paddingRight: Platform.OS === "web" ? space.side : 0 },
  headerLink: { ...typography.label, color: colors.blue },
  error: { ...typography.caption, paddingHorizontal: space.side, paddingVertical: space.sm, color: colors.red, backgroundColor: colors.redSoft },
  intro: { paddingHorizontal: space.side, paddingTop: space.md, paddingBottom: space.sm },
  introTitle: { ...typography.heading, color: colors.ink },
  introBody: { ...typography.body, marginTop: space.xs, color: colors.muted },
  joinBar: { padding: space.side, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.surface },
  joinText: { ...typography.body, textAlign: "center", color: colors.muted, marginBottom: space.sm },
}));
