import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { RECYCLING_CONVERSATION_LIST, isNewest, listOrder, olderNeighbour } from "../../lib/conversation-list";
import { showsInConversation, threadOf } from "../../lib/also-in-channel";
import { Activity, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConversationKeyboardView } from "../../components/ConversationKeyboardView";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Composer, MessageDate, PostRow, UnreadLine } from "../../components/Messaging";
import { MediaGalleryProvider } from "../../components/MediaGallery";
import { mediaFromPosts } from "../../lib/media";
import { PresenceLine, usePresentPeers } from "../../components/Presence";
import { useReadReceipts } from "../../lib/use-read-receipts";
import { mergeReadEvent } from "../../lib/read-receipts";
import { notedPlace, readNotes } from "../../lib/read-cache";
import { createUnreadVisits, readPlace } from "../../lib/unread-line";
import { useListOpening } from "../../lib/use-list-opening";
import { latestMessageReceipts } from "../../lib/message-status";
import { canCompactPost, sourceDeviceOf } from "../../lib/message-device";
import { createOutbox } from "../../lib/outbox";
import { createSendQueue } from "../../lib/send-queue";
import { earlyConversation, fetchConversation, forgetConversation, keepConversation, keptConversation } from "../../lib/conversation-cache";
import { openingThread } from "../../lib/thread-cache";
import { asDeleted, showChange, undoChange, withReaction } from "../../lib/post-changes";
import { isDesktop } from "../../lib/desktop";
import { lastEditableMessage } from "../../lib/edit-last-message";
import { TypingLine, useTyping, useTypingPing } from "../../lib/typing";
import { PiiDeclined, withPiiConfirm } from "../../lib/pii-warning";
import { usePiiConfirm } from "../../components/PiiConfirm";
import { api, ServerError, type Account, type Conversation, type Person, type Upload, type Post, type LiveEvent } from "../../lib/server";
import { useStableCallback } from "../../lib/stable-callback";
import { useLiveActions } from "../../lib/live";
import { liveEventCount } from "../../lib/live-counts";
import { mergePosts as merge } from "../../lib/post-list";
import { reuseEqual } from "../../lib/reuse-equal";
import { useSession } from "../../lib/session";
import { askAgentAbout } from "../../lib/ask-agent";
import { helpText, parseSlash, resolvePeople, splitDm } from "../../lib/slash-commands";
import { sendSlashFeedback } from "../../lib/slash-feedback";
import { conversationHidden, landingHref, useFeatures } from "../../lib/features";
import { ChannelDetails } from "../channel-info";
import { useWideLayout } from "../../lib/layout";
import { useDetailsPanelOpen } from "../../lib/details-panel";
import { radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../../lib/theme";
import { AppIcon } from "../../components/AppIcon";
import { channelVisibility } from "../../lib/channel-visibility";
import { groupActivity } from "../../lib/activity-groups";
import { ServeLoader } from "../../components/ServeLoader";

const errorText = (e: unknown, fallback: string) => (e instanceof ServerError ? e.message : fallback);

export default function ConversationScreen() {
  const { id, compose } = useLocalSearchParams<{ id: string; compose?: string }>();
  const { account } = useSession();
  const features = useFeatures();
  if (!account) return null;
  // A channel on a server without channels, or a DM without DMs: the server refuses it too (features.ts).
  if (conversationHidden(id, features)) return <Redirect href={landingHref(features)} />;
  // A different conversation starts with its own messages, draft and send state.
  return <OpenConversation key={id} account={account} id={id} compose={compose} />;
}

// The other people in a direct conversation and what they are doing. On its own so a change in someone's
// presence draws this bar again and nothing else.
function PeerPresence({ peers }: { peers: Person[] }) {
  const styles = useStyles();
  const shownPeers = usePresentPeers(peers);
  if (!shownPeers.length) return null;
  return <View style={styles.presence}>
    {shownPeers.map(person => <View key={person.id} style={styles.peer}>
      {peers.length > 1 ? <Text style={styles.peerName}>{person.name}</Text> : null}
      <PresenceLine person={person} />
    </View>)}
  </View>;
}

function OpenConversation({ account, id, compose }: { account: Account; id: string; compose?: string }) {
  const { ask: askPii, dialog: piiDialog } = usePiiConfirm();
  const styles = useStyles();
  const { colors } = useTheme();
  const focused = useIsFocused();
  const visible = useRef(focused);
  useEffect(() => { visible.current = focused; }, [focused]);
  const { subscribe, setOpen, refresh, peek } = useLiveActions();
  // What this conversation showed the last time it was open (lib/conversation-cache.ts): it is on screen at
  // once and a fresh copy loads behind it. On a first visit the list already knows the title and the people.
  const [kept] = useState(() => keptConversation(account, id));
  const [conv, setConv] = useState<Conversation | null>(() => kept?.conversation ?? peek(id) ?? null);
  const [joined, setJoined] = useState(kept?.joined ?? true);
  const [posts, setPosts] = useState<Post[] | null>(kept?.posts ?? null);
  // Messages shown the moment Send is pressed, under the ones the server has (lib/outbox.ts).
  const [outbox] = useState(createOutbox);
  // They go to the server one at a time, in the order written, however fast they are typed (lib/send-queue.ts).
  const [turns] = useState(createSendQueue);
  const [sending, setSending] = useState<Post[]>([]);
  const postKey = outbox.key;
  const [more, setMore] = useState(kept?.more ?? false);
  const [error, setError] = useState<string | null>(null);
  // The answer to a command like /help: shown plainly, not as an error. Tap it to dismiss.
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Post | null>(null);
  const [joining, setJoining] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const loadingOlder = useRef(false);
  const loadSequence = useRef(0);
  // The first fresh copy replaces what was kept, so the list is what a fresh open would show.
  const showingKept = useRef(!!kept);
  // Only a conversation that has loaded is worth keeping: never an empty list left by a failed load.
  const loaded = useRef(!!kept);
  const reload = useRef<() => void>(() => {});
  const needsSnapshot = useRef(false);
  const accessDenied = useRef(false);
  const snapshot = useRef<{ sequence: number; replace: boolean; updates: Map<string, Post>; reads: Extract<LiveEvent, { event: "messages.read" }>["data"][] } | null>(null);
  const typingNames = useTyping(id, null, account?.user.id ?? "");
  const ping = useTypingPing(account, id);
  // The "New" line (lib/unread-line.ts): above the first message that came since this person last read here.
  // It is placed as the screen opens, from the place the list says they had read to and the messages kept from
  // before, so it is in the first frame and not put in later. It stays there for the visit: a thread, Details
  // or Files over this screen is the same visit, and only a long time away from the app starts another.
  const [visits] = useState(() => createUnreadVisits(account.user.id));
  const [unreadMark, setUnreadMark] = useState<number | null>(() => visits.open(readPlace(peek(id)?.readThrough), kept?.posts ?? null, notedPlace(readNotes, id)));
  const shownPosts = useRef(posts);
  useEffect(() => { shownPosts.current = posts; }, [posts]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", state => {
      if (state === "active") setUnreadMark(visits.back(shownPosts.current));
      else visits.away();
    });
    return () => sub.remove();
  }, [visits]);
  const readTracking = useReadReceipts(account, id, focused, joined && posts !== null && !unavailable, undefined, posts ?? undefined, ids => visits.read(ids));
  // The recycling list builds its first screen in several passes. It is held undrawn, at its end, until that
  // screen has settled, and shown once: the conversation opens in one step, at its newest message (lib/list-opening.ts).
  const list = useRef<FlashListRef<Post>>(null);
  const opening = useListOpening(list, RECYCLING_CONVERSATION_LIST && posts !== null, focused);

  const applyPosts = useCallback((incoming: Post[]) => {
    for (const post of incoming) snapshot.current?.updates.set(post.id, post);
    if (accessDenied.current) return;
    setPosts((old) => merge(old ?? [], incoming));
  }, []);

  const load = useCallback((reset = false): Promise<void> => {
    if (!account || !id) return Promise.resolve();
    const current = { sequence: ++loadSequence.current, replace: reset || needsSnapshot.current || showingKept.current || !!snapshot.current?.replace, updates: new Map<string, Post>(), reads: [] as Extract<LiveEvent, { event: "messages.read" }>["data"][] };
    snapshot.current = current;
    // The row that opened this screen started the request when it was pressed; take that one instead of asking again.
    const early = reset ? null : earlyConversation(account, id);
    return (early?.result ?? fetchConversation(account, id)).then(([c, p]) => {
      if (snapshot.current !== current) return;
      needsSnapshot.current = false;
      showingKept.current = false;
      loaded.current = true;
      accessDenied.current = false;
      // That request left before this screen was listening. If anything arrived for the conversation since, look again.
      if (early && liveEventCount(id) !== early.mark) reload.current();
      // A fresh copy that says what is already on screen keeps what is on screen: only a message that changed
      // is drawn again (coming back from a thread, or the copy that follows a conversation opened from memory).
      setConv(shown => reuseEqual(shown, c.conversation));
      setJoined(c.joined);
      const recovered = merge(p.messages, [...current.updates.values()]).map(post => current.reads.reduce(mergeReadEvent, post));
      setUnreadMark(visits.loaded(readPlace(c.conversation.readThrough), recovered));
      setPosts((old) => reuseEqual(old, current.replace ? recovered : merge(old ?? [], recovered)));
      setMore(p.more);
      setUnavailable(false);
      setError(null);
    }).catch((e: unknown) => {
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
    }).finally(() => {
      if (snapshot.current === current) snapshot.current = null;
    });
  }, [account, id, visits]);

  useEffect(() => () => {
    loadSequence.current++;
    snapshot.current = null;
  }, [account, id]);
  useEffect(() => { reload.current = () => { void load(); }; }, [load]);
  // Keep what is on screen for the next visit; a conversation that is gone or closed to you is not kept.
  useEffect(() => {
    if (unavailable) forgetConversation(account, id);
    else if (posts !== null && loaded.current) keepConversation(account, id, { conversation: conv, joined, posts, more });
  }, [account, id, conv, joined, posts, more, unavailable]);

  useEffect(() => {
    void load();
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
          if (p.conversationId !== id || !showsInConversation(p)) return;
          // My own message arriving while its send is still waiting for an answer: the answer brings it in.
          if (outbox.hold(e.event, p, account.user.id)) return;
          applyPosts([p]);
        } else if (e.event === "messages.read" && e.data.conversationId === id) {
          snapshot.current?.reads.push(e.data);
          setPosts(old => old?.map(post => mergeReadEvent(post, e.data)) ?? null);
        } else if (e.event === "conversation.updated" && e.data.id === id) {
          void load();
        }
      }),
    [subscribe, account, id, applyPosts, load, outbox],
  );

  const media = useMemo(() => mediaFromPosts(posts ?? []), [posts]);
  const receipts = useMemo(() => conv && conv.id === id && conv.kind === "dm"
    ? latestMessageReceipts(posts ?? [], account.user.id, conv.members)
    : undefined, [posts, account.user.id, conv, id]);
  const members = conv?.kind === "dm" ? conv.members : undefined;
  const peers = useMemo(() => members?.filter(person => person.id !== account.user.id && !person.agent) ?? [], [members, account.user.id]);
  const wide = useWideLayout();
  const insets = useSafeAreaInsets();
  const [detailsOpen, setDetailsOpen] = useDetailsPanelOpen();
  const features = useFeatures();
  const me = account.user.id;
  const editLast = lastEditableMessage(posts ?? [], me);
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
    const cmd = parseSlash(text, isChannel, false, features);
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
        case "mute": { const next = !conv?.muted; await api.muteConversation(account, id, next); setConv(c => c ? { ...c, muted: next } : c); setError(null); return true; }
        case "archive": await (conv?.archived ? api.restoreChannel(account, id) : api.archiveChannel(account, id)); setError(null); router.replace("/"); return true;
        case "new": router.push("/new-message"); return true;
        case "browse": router.push("/browse"); return true;
        case "people": router.push("/members"); return true;
        case "help": setError(null); setNote(helpText(isChannel, false, features)); return true;
        case "feedback":
          if (!cmd.args) { router.push("/feedback"); return true; }
          setError(null); setNote(await sendSlashFeedback(account, cmd.args, isChannel ? "channel" : "direct message")); return true;
        case "files": openFiles(); return true;
        case "agent": return cmd.args ? send(`@agent ${cmd.args}`) : need("a question");
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
    // A text message is in the conversation the moment it is sent; one with files shows when they have gone up.
    const local = attachments.length ? null : outbox.add({ conversationId: id, threadRoot: null, text, user: { id: me, name: account.user.name }, after: posts?.at(-1),
      sourceDevice: account.user.role === "owner" ? sourceDeviceOf(isDesktop() ? "computer" : Platform.OS === "web" ? "web" : "mobile") : undefined });
    if (local) setSending(outbox.sending());
    // The server's copy takes the row's place; on a failure the row goes and the composer puts the text back.
    const settle = (sent: Post | null) => {
      const arrived = local ? outbox.settle(local.id, sent) : sent ? [sent] : [];
      if (local) setSending(outbox.sending());
      if (arrived.length) applyPosts(arrived);
    };
    try {
      const p = await turns.inTurn(() => withPiiConfirm(askPii, confirmPii => api.post(account, id, text, undefined, attachments, confirmPii)));
      settle(p);
      setError(null);
      return true;
    } catch (e) {
      settle(null);
      if (e instanceof PiiDeclined) return false;
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
    // The reaction shows at once. The server's copy confirms it; a refusal takes it back.
    const shown = withReaction(post, emoji, me, active);
    setPosts(old => showChange(old, shown));
    try {
      const p = await api.reactToPost(account, post.id, emoji, active);
      applyPosts([p]);
      setError(null);
    } catch (e) {
      setPosts(old => undoChange(old, shown, post));
      setError(e instanceof ServerError ? e.message : "Couldn't save the reaction. Try again");
    }
  };

  const remove = async (p: Post) => {
    // Gone at once. The server deletes it the way it always has (where records are kept, it saves its copy
    // first); if it cannot, the message comes back as it was and the error says why.
    const shown = asDeleted(p);
    setPosts(old => showChange(old, shown));
    try {
      await api.deletePost(account, p.id);
      applyPosts([shown]);
    } catch (e) {
      setPosts(old => undoChange(old, shown, p));
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

  // A reply also sent here opens the thread it belongs to, not one of its own.
  const openThread = (p: Post) => { if (!p.threadRoot) openingThread(account, id, p, { conversation: conv, joined }); router.push({ pathname: "/thread", params: { conv: id, root: threadOf(p), title } }); };
  const askAgent = (p: Post) => { askAgentAbout(account, p, conv).catch(e => setError(errorText(e, "Couldn't start a chat with the agent"))); };
  // Joins and leaves close together read as one line ("Ann and Bo joined the channel").
  const data = useMemo(() => listOrder(groupActivity([...(posts ?? []), ...sending].reverse()), RECYCLING_CONVERSATION_LIST), [posts, sending]);
  // Every row gets the same handlers for as long as the screen is open, and the list gets the same
  // rows until the messages change: typing, a presence change or an error line draw no message again.
  const onReact = useStableCallback(react);
  const onOpenThread = useStableCallback(openThread);
  const onAskAgent = useStableCallback(askAgent);
  // "Quote" on a message: its words go into the reply field.
  const [quote, setQuote] = useState<{ text: string; at: number } | null>(null);
  const quoteTaken = useStableCallback(() => setQuote(null));
  const onQuote = useStableCallback((p: Post) => { setEditing(null); setQuote({ text: p.text, at: Date.now() }); });
  const onDelete = useStableCallback((p: Post) => { void remove(p); });
  const onSuggest = useStableCallback((text: string) => { void send(text); });
  const onEndReached = useStableCallback(() => { void older(); });
  const role = account.user.role;
  // What a channel says about itself above its first message, once all of them are loaded.
  const intro = conv && !more && isChannel ? (
    <View style={styles.intro}>
      <View style={[styles.visibility, conv.private && styles.visibilityPrivate]}>
        <View style={styles.visibilityHeading}>
          {conv.private ? <AppIcon name="lock" size={16} color={colors.ink} /> : null}
          <Text style={styles.visibilityLabel}>{channelVisibility(conv.private, account.serverName).label}</Text>
        </View>
        <Text style={styles.visibilityBody}>{channelVisibility(conv.private, account.serverName).body}</Text>
      </View>
    </View>
  ) : undefined;
  const newAbove = useMemo(() => visits.lineAbove(posts ?? [], unreadMark, more), [visits, posts, unreadMark, more]);
  const renderItem = useCallback(({ item, index }: { item: Post; index: number }) => {
    const above = olderNeighbour(data, index, RECYCLING_CONVERSATION_LIST);
    const newDay = !above || new Date(item.createdAt).toDateString() !== new Date(above.createdAt).toDateString();
    const isNew = item.id === newAbove;
    const compact = !isNew && canCompactPost(above, item, role);
    return (
      // The recycling list reuses a row's place for another message; the key gives each message its own row,
      // so what a row remembers (an open menu, a player that was started) never moves to a different message.
      <View key={item.id}>
      {isNew ? <UnreadLine /> : null}
      {newDay ? <MessageDate at={item.createdAt} /> : null}
      <PostRow
        post={item} onReact={joined ? onReact : undefined}
        me={me}
        receipt={receipts?.get(item.id)}
        compact={compact}
        onOpenThread={onOpenThread}
        onAskAgent={onAskAgent}
        onQuote={joined ? onQuote : undefined}
        onSuggest={joined && isNewest(data.length, index, RECYCLING_CONVERSATION_LIST) ? onSuggest : undefined}
        onEdit={setEditing}
        onDelete={onDelete}
      />
      </View>
    );
  }, [data, joined, me, receipts, role, newAbove, onReact, onOpenThread, onAskAgent, onQuote, onSuggest, onDelete]);

  // Wide screens (browser, Mac app) show Details beside the channel, open by default; Details
  // toggles it. Phones open the Details page.
  // Before the conversation is known its id says whether it is a channel (ch_…), so the panel is there, at
  // its width, from the first frame and the messages are laid out once.
  const sideDetails = wide && detailsOpen && (conv ? isChannel : id.startsWith("ch_"));
  const openDetails = () => wide ? setDetailsOpen(!detailsOpen) : router.push({ pathname: "/channel-info", params: { id } });
  const openFiles = () => router.push({ pathname: "/files", params: { kind: "conversation", id, title } });
  const onFiles = useStableCallback(openFiles);
  const onDetails = useStableCallback(openDetails);
  const loadedConversation = !!conv;
  // The header is told what to show only when that changes. Told again on every render, the whole navigator
  // re-rendered and the header's buttons were rebuilt each time a message arrived.
  const header = useMemo(() => {
    const headerButton = { type: "button" as const, tintColor: colors.blue, labelStyle: { fontFamily: typography.label.fontFamily, color: colors.blue, fontSize: typography.label.fontSize, fontWeight: "600" as const }, hidesSharedBackground: true };
    return {
      title,
      // Keep channel management quiet beside the conversation title.
      unstable_headerRightItems:
        loadedConversation && Platform.OS === "ios"
          ? () => [{ ...headerButton, label: "Files", onPress: onFiles }, ...(isChannel ? [{ ...headerButton, label: "Details", onPress: onDetails }] : [])]
          : undefined,
      headerRight:
        loadedConversation && Platform.OS !== "ios"
          ? () => (
              <View style={styles.headerActions}>
                <Pressable testID="open-files" accessibilityRole="button" onPress={onFiles} style={styles.headerAction}>
                  <Text style={styles.headerLink}>Files</Text>
                </Pressable>
                {isChannel ? <Pressable accessibilityRole="button" onPress={onDetails} style={styles.headerAction}>
                  <Text style={styles.headerLink}>Details</Text>
                </Pressable> : null}
              </View>
            )
          : undefined,
    };
  }, [title, loadedConversation, isChannel, colors.blue, styles, onFiles, onDetails]);

  return (
    <MediaGalleryProvider key={`${id}:${unavailable}`} scope={{ kind: "conversation", id }} items={media}>
    {piiDialog}
    <View style={[styles.root, wide && styles.row]}>
      <View style={styles.root}>
      <Stack.Screen options={header} />
      <PeerPresence peers={peers} />
      <ConversationKeyboardView>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {note ? <Text accessibilityLiveRegion="polite" selectable style={styles.note} onPress={() => setNote(null)}>{note}</Text> : null}
        {posts === null ? (
          <ServeLoader style={{ flex: 1 }} />
        ) : RECYCLING_CONVERSATION_LIST ? (
          // Under another screen (a thread, Details, Files) the page gives this list no size at all, and a
          // recycling list measured at nothing forgets the heights it knew: coming back, the same scroll
          // position showed messages a thousand points away from the ones that were being read. Set aside
          // while the screen is covered, it is not measured, and it is picked up again exactly as it was.
          <Activity mode={focused ? "visible" : "hidden"}>
          <FlashList
            ref={list}
            style={opening}
            {...readTracking}
            data={data as Post[]}
            keyExtractor={postKey}
            renderItem={renderItem}
            // Starts at the newest message, stays there as messages arrive while it is in view, and keeps its
            // place when older messages are added above.
            initialScrollIndex={data.length ? data.length - 1 : undefined}
            maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2, animateAutoScrollToBottom: false }}
            onStartReached={onEndReached}
            onStartReachedThreshold={0.3}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
            ListHeaderComponent={intro}
          />
          </Activity>
        ) : (
          <FlatList
            {...readTracking}
            inverted
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            data={data as Post[]}
            keyExtractor={postKey}
            onEndReached={onEndReached}
            onEndReachedThreshold={0.3}
            contentContainerStyle={styles.list}
            ListFooterComponent={intro}
            renderItem={renderItem}
          />
        )}
        {joined ? <TypingLine names={typingNames} /> : null}
        {unavailable ? null : !joined ? (
          <View style={[styles.joinBar, { paddingBottom: Math.max(insets.bottom + space.xs, space.xl) }]}>
            <Text style={styles.joinText}>You're previewing {title}</Text>
            <Button label={`Join ${title}`} onPress={join} busy={joining} />
          </View>
        ) : editing ? (
          <Composer members={conv?.members} mentionAgent me={me} key={`edit-${editing.id}`} placeholder="Edit message" autoFocus initial={editing.text} sendLabel="Save" onSend={saveEdit} onCancel={() => setEditing(null)} onDeleteEmpty={() => setConfirmDelete(editing)} />
        ) : (
          <Composer autoFocus={compose === "1"} members={conv?.members} mentionAgent me={me} key={`new-${id}`} draftKey={`c:${id}`} quote={quote} onQuoted={quoteTaken} placeholder={conv ? `Message ${title}` : "Message"} freeOnSend onSend={send} onTyping={ping} onEditLast={editLast ? () => setEditing(editLast) : undefined} commands={{ channel: isChannel }} />
        )}
      </ConversationKeyboardView>
      </View>
      <ConfirmDialog visible={!!confirmDelete} title="Delete message?" description="Your message will be removed for everyone in this conversation." confirmLabel="Delete" onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { const p = confirmDelete; setConfirmDelete(null); setEditing(null); if (p) void remove(p); }} />
      {sideDetails ? <ChannelDetails key={id} id={id} panel initial={conv} onClose={() => setDetailsOpen(false)} /> : null}
    </View>
    </MediaGalleryProvider>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  row: { flexDirection: "row" },
  list: { paddingVertical: space.sm },
  presence: { paddingHorizontal: space.side, paddingVertical: space.xs, backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  peer: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, alignItems: "center" },
  peerName: { ...typography.captionStrong, color: colors.ink },
  headerAction: { minHeight: 44, minWidth: 44, justifyContent: "center" },
  // The web header adds no inset on the right; match the back arrow's.
  headerActions: { flexDirection: "row", alignItems: "center", gap: space.md, paddingRight: Platform.OS === "web" ? space.side : 0 },
  headerLink: { ...typography.label, color: colors.blue, ...linkUnderline },
  error: { ...typography.caption, paddingHorizontal: space.side, paddingVertical: space.sm, color: colors.red, backgroundColor: colors.redSoft },
  note: { ...typography.caption, paddingHorizontal: space.side, paddingVertical: space.sm, color: colors.ink, backgroundColor: colors.surface },
  intro: { paddingHorizontal: space.side, paddingTop: space.md, paddingBottom: space.sm },
  // Who can read this channel, said once at the top so nobody has to guess before typing.
  visibility: { marginTop: space.sm, paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.sm, backgroundColor: colors.subtle, gap: 2 },
  visibilityPrivate: { backgroundColor: colors.blueSoft },
  visibilityHeading: { flexDirection: "row", alignItems: "center", gap: space.xs },
  visibilityLabel: { ...typography.captionStrong, color: colors.ink },
  visibilityBody: { ...typography.caption, color: colors.muted },
  joinBar: { padding: space.side, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.surface },
  joinText: { ...typography.body, textAlign: "center", color: colors.muted, marginBottom: space.sm },
}));
