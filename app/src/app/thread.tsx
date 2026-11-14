import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, StyleSheet, Text, View } from "react-native";
import { Redirect, router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ConversationKeyboardView } from "../components/ConversationKeyboardView";
import { Composer, MessageDate, PostRow } from "../components/Messaging";
import { MediaGalleryProvider } from "../components/MediaGallery";
import { mediaFromPosts } from "../lib/media";
import { TypingLine, useTyping, useTypingPing } from "../lib/typing";
import { PiiDeclined, withPiiConfirm } from "../lib/pii-warning";
import { usePiiConfirm } from "../components/PiiConfirm";
import { api, ServerError, type Account, type Upload, type Post, type Conversation, type LiveEvent } from "../lib/server";
import { useStableCallback } from "../lib/stable-callback";
import { useReadReceipts } from "../lib/use-read-receipts";
import { mergeReadEvent } from "../lib/read-receipts";
import { latestMessageReceipts } from "../lib/message-status";
import { canCompactPost, sourceDeviceOf } from "../lib/message-device";
import { createOutbox } from "../lib/outbox";
import { asDeleted, showChange, undoChange, withReaction } from "../lib/post-changes";
import { isDesktop } from "../lib/desktop";
import { lastEditableMessage } from "../lib/edit-last-message";
import { liveEventCount, useLiveActions } from "../lib/live";
import { earlyThread, fetchThread, forgetThread, keepThread, keptThread } from "../lib/thread-cache";
import { shownReplyCount } from "../lib/thread-start";
import { useSession } from "../lib/session";
import { conversationHidden, landingHref, useFeatures } from "../lib/features";
import { askAgentAbout } from "../lib/ask-agent";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";

export default function ThreadScreen() {
  const { conv, root, title, focus, from } = useLocalSearchParams<{ conv: string; root: string; title?: string; focus?: string; from?: string }>();
  const { account } = useSession();
  const features = useFeatures();
  if (!account) return null;
  // A thread in a kind of conversation this server has turned off (features.ts).
  if (conversationHidden(conv, features)) return <Redirect href={landingHref(features)} />;
  // A different thread starts with its own replies, draft and send state.
  return <OpenThread key={`${conv}:${root}`} account={account} conv={conv} root={root} title={title} focus={focus} from={from} />;
}

function OpenThread({ account, conv, root, title, focus, from }: { account: Account; conv: string; root: string; title?: string; focus?: string; from?: string }) {
  const { ask: askPii, dialog: piiDialog } = usePiiConfirm();
  const styles = useStyles();
  const { colors } = useTheme();
  // A push lands on the notified reply: highlight it, but it is not a search match.
  const matchLabel = from === "push" ? null : from === "saved" ? "Saved message" : "Search match";
  const focused = useIsFocused();
  const { subscribe } = useLiveActions();
  const list = useRef<FlatList<Post>>(null);
  const searchFocus = useRef({ target: focus, pending: !!focus, holding: !!focus, retries: 0 });
  const focusRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearFocusRetry = useCallback(() => {
    if (focusRetry.current) clearTimeout(focusRetry.current);
    focusRetry.current = null;
  }, []);
  const releaseSearchFocus = useCallback(() => {
    clearFocusRetry();
    searchFocus.current.pending = false;
    searchFocus.current.holding = false;
  }, [clearFocusRetry]);
  useLayoutEffect(() => {
    clearFocusRetry();
    searchFocus.current = { target: focus, pending: !!focus, holding: !!focus, retries: 0 };
    return clearFocusRetry;
  }, [conv, root, focus, clearFocusRetry]);
  // What this thread showed the last time it was open, or the message it was opened from (lib/thread-cache.ts):
  // it is on screen at once and a fresh copy loads behind it.
  const [kept] = useState(() => keptThread(account, conv, root));
  const loaded = useRef(!!kept);
  const reload = useRef<() => void>(() => {});
  const [conversation, setConversation] = useState<Conversation | null>(kept?.conversation ?? null);
  const [head, setHead] = useState<Post | null>(kept?.head ?? null);
  const [replies, setReplies] = useState<Post[] | null>(kept?.replies ?? null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Post | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [joined, setJoined] = useState(kept?.joined ?? false);
  const needsSnapshot = useRef(false);
  const accessDenied = useRef(false);
  const snapshot = useRef<{ updates: Map<string, Post>; reads: Extract<LiveEvent, { event: "messages.read" }>["data"][] } | null>(null);
  const typingNames = useTyping(conv, root, account?.user.id ?? "");
  const ping = useTypingPing(account, conv, root);
  const rows = useMemo(() => head ? [head, ...(replies ?? [])] : replies ?? [], [head, replies]);
  // Replies shown the moment Send is pressed, under the ones the server has (lib/outbox.ts).
  const [outbox] = useState(createOutbox);
  const [sending, setSending] = useState<Post[]>([]);
  const postKey = outbox.key;
  const shown = useMemo(() => sending.length ? [...rows, ...sending] : rows, [rows, sending]);
  const receipts = useMemo(() => conversation && conversation.id === conv && conversation.kind === "dm"
    ? latestMessageReceipts(rows, account.user.id, conversation.members)
    : undefined, [rows, account.user.id, conversation, conv]);
  const readTracking = useReadReceipts(account, conv, focused, joined && replies !== null && !unavailable, root, rows);
  const scrollToSearchResult = useCallback(() => {
    const target = searchFocus.current;
    if (!target.pending || !list.current) return;
    const index = rows.findIndex(post => post.id === target.target);
    if (index < 0) return;
    // FlatList calls onScrollToIndexFailed synchronously for an unmeasured row.
    // That callback restores pending and retries after rendering the vicinity.
    target.pending = false;
    list.current.scrollToIndex({ index, viewPosition: 0.25, animated: false });
  }, [rows]);
  useEffect(() => { scrollToSearchResult(); }, [conv, root, focus, scrollToSearchResult]);
  const onFocusScrollFailed = useCallback((info: { index: number; averageItemLength: number }) => {
    const target = searchFocus.current;
    if (!target.holding || target.retries >= 8) return;
    target.pending = true;
    target.retries++;
    list.current?.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index), animated: false });
    clearFocusRetry();
    focusRetry.current = setTimeout(scrollToSearchResult, 100);
  }, [clearFocusRetry, scrollToSearchResult]);
  const maintainPosition = (animated: boolean) => {
    if (searchFocus.current.holding) scrollToSearchResult();
    else list.current?.scrollToEnd({ animated });
  };

  const upsert = useCallback((p: Post) => {
    snapshot.current?.updates.set(p.id, p);
    if (accessDenied.current) return;
    if (p.id === root) {
      setHead(p);
      return;
    }
    setReplies((old) => {
      const list = old ?? [];
      const i = list.findIndex((x) => x.id === p.id);
      if (i < 0) return [...list, p].sort((a, b) => Number(a.id) - Number(b.id));
      const copy = list.slice();
      copy[i] = p;
      return copy;
    });
  }, [root]);

  const load = useCallback(() => {
    if (!account) return Promise.resolve();
    const current = { updates: new Map<string, Post>(), reads: [] as Extract<LiveEvent, { event: "messages.read" }>["data"][] };
    snapshot.current = current;
    // Whatever opened this thread started the request when it was pressed; take that one instead of asking again.
    const early = earlyThread(account, conv, root);
    return (early?.result ?? fetchThread(account, conv, root))
      .then(([t, c]) => {
        if (snapshot.current !== current) return;
        needsSnapshot.current = false;
        loaded.current = true;
        accessDenied.current = false;
        // That request left before this screen was listening. If anything arrived for the conversation since, look again.
        if (early && liveEventCount(conv) !== early.mark) reload.current();
        setConversation(c.conversation);
        setJoined(c.joined);
        setHead(current.reads.reduce(mergeReadEvent, current.updates.get(root) ?? t.root));
        const recovered = new Map(t.replies.map(p => [p.id, p]));
        for (const post of current.updates.values()) if (post.id !== root) recovered.set(post.id, post);
        setReplies([...recovered.values()].map(post => current.reads.reduce(mergeReadEvent, post)).sort((a, b) => Number(a.id) - Number(b.id)));
        setUnavailable(false);
        setError(null);
      })
      .catch((e) => {
        if (snapshot.current !== current) return;
        setError(e instanceof ServerError ? e.message : "Couldn't load this thread");
        if (e instanceof ServerError && [401, 403, 404].includes(e.status)) {
          accessDenied.current = true;
          setHead(null);
          setReplies([]);
          setConversation(null);
          setEditing(null);
          setUnavailable(true);
          setJoined(false);
        } else setReplies((r) => r ?? []);
      })
      .finally(() => {
        if (snapshot.current === current) snapshot.current = null;
      });
  }, [account, conv, root]);

  useEffect(() => {
    reload.current = () => { void load(); };
    void load();
    return () => { snapshot.current = null; };
  }, [load]);
  // Keep what is on screen for the next visit; a thread that is gone or closed to you is not kept, nor is an
  // empty one left by a failed load.
  useEffect(() => {
    if (unavailable) forgetThread(account, conv, root);
    else if (replies !== null && loaded.current) keepThread(account, conv, root, { conversation, joined, head, replies });
  }, [account, conv, root, conversation, joined, head, replies, unavailable]);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.event === "ready" && (e.data.reset !== false || needsSnapshot.current)) {
          needsSnapshot.current = true;
          setHead(null);
          setReplies(null);
          setConversation(null);
          void load();
          return;
        }
        if (e.event === "conversation.updated" && e.data.id === conv && account) {
          void load();
        }
        if (e.event === "messages.read" && e.data.conversationId === conv) {
          snapshot.current?.reads.push(e.data);
          setHead(post => post ? mergeReadEvent(post, e.data) : null);
          setReplies(posts => posts?.map(post => mergeReadEvent(post, e.data)) ?? null);
        }
        if (e.event !== "message.created" && e.event !== "message.updated") return;
        const p = e.data;
        if (p.conversationId !== conv || (p.id !== root && p.threadRoot !== root)) return;
        // My own reply arriving while its send is still waiting for an answer: the answer brings it in.
        if (p.threadRoot === root && outbox.hold(e.event, p, account.user.id)) return;
        upsert(p);
      }),
    [subscribe, root, conv, account, upsert, load, outbox],
  );

  const media = useMemo(() => mediaFromPosts(rows), [rows]);
  const me = account.user.id;
  const editLast = lastEditableMessage(replies ?? [], me);

  const send = async (text: string, attachments: Upload[] = []) => {
    // A text reply is in the thread the moment it is sent; one with files shows when they have gone up.
    const local = attachments.length ? null : outbox.add({ conversationId: conv, threadRoot: root, text, user: { id: me, name: account.user.name }, after: rows.at(-1),
      sourceDevice: account.user.role === "owner" ? sourceDeviceOf(isDesktop() ? "computer" : Platform.OS === "web" ? "web" : "mobile") : undefined });
    if (local) { releaseSearchFocus(); setSending(outbox.sending()); }
    // The server's copy takes the row's place; on a failure the row goes and the composer puts the text back.
    const settle = (sent: Post | null) => {
      const arrived = local ? outbox.settle(local.id, sent) : sent ? [sent] : [];
      if (local) setSending(outbox.sending());
      arrived.forEach(upsert);
    };
    try {
      const post = await withPiiConfirm(askPii, confirmPii => api.post(account, conv, text, root, attachments, confirmPii));
      releaseSearchFocus();
      settle(post);
      setError(null);
      return true;
    } catch (e) {
      settle(null);
      if (e instanceof PiiDeclined) return false;
      setError(e instanceof ServerError ? e.message : "Couldn't send. Check your connection");
      return false;
    }
  };
  const saveEdit = async (text: string) => {
    if (!editing) return true;
    try {
      const p = await api.editPost(account, editing.id, text);
      upsert(p);
      setEditing(null);
      return true;
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't save the change");
      return false;
    }
  };
  // A reaction or a delete shows at once; the thread's first message and its replies are kept apart.
  const show = (shown: Post) => shown.id === root ? setHead(shown) : setReplies(list => showChange(list, shown));
  const undo = (shown: Post, original: Post) => shown.id === root ? setHead(current => current === shown ? original : current) : setReplies(list => undoChange(list, shown, original));
  const react = async (post: Post, emoji: string, active: boolean) => {
    // The server's copy confirms the reaction; a refusal takes it back.
    const shown = withReaction(post, emoji, me, active);
    show(shown);
    try {
      const p = await api.reactToPost(account, post.id, emoji, active);
      upsert(p);
      setError(null);
    } catch (e) {
      undo(shown, post);
      setError(e instanceof ServerError ? e.message : "Couldn't save the reaction. Try again");
    }
  };

  const askAgent = (p: Post) => { askAgentAbout(account, p, conversation).catch(e => setError(e instanceof ServerError ? e.message : "Couldn't start a chat with the agent")); };
  const remove = async (p: Post) => {
    // Gone at once. The server deletes it the way it always has (where records are kept, it saves its copy
    // first); if it cannot, the message comes back as it was and the error says why.
    const shown = asDeleted(p);
    show(shown);
    try {
      await api.deletePost(account, p.id);
      upsert(shown);
    } catch (e) {
      undo(shown, p);
      setError(e instanceof ServerError ? e.message : "Couldn't delete the message");
    }
  };

  // Every row gets the same handlers for as long as the thread is open, and the list gets the same
  // rows until the replies change: typing or an error line draw no message again.
  const onReact = useStableCallback(react);
  const onAskAgent = useStableCallback(askAgent);
  const onDelete = useStableCallback((p: Post) => { void remove(p); });
  const role = account.user.role;
  // Until the replies have loaded, the first message says how many there are.
  const replyCount = shownReplyCount(head, replies, sending.length);
  const renderItem = useCallback(({ item, index }: { item: Post; index: number }) => {
    if (item.id === root) return <View style={[styles.head, item.id === focus && styles.searchMatch]}>
      {item.id === focus && matchLabel ? <Text style={styles.searchLabel}>{matchLabel}</Text> : null}
      {title ? <Text style={styles.where}>In {title}</Text> : null}
      <PostRow post={item} receipt={receipts?.get(item.id)} onReact={onReact} onAskAgent={onAskAgent} me={me} onEdit={setEditing} onDelete={onDelete} />
      <Text accessibilityRole="header" style={styles.count}>
        {!replyCount ? "No replies yet" : `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`}
      </Text>
    </View>;
    const above = shown[index - 1];
    const newDay = !!above && new Date(item.createdAt).toDateString() !== new Date(above.createdAt).toDateString();
    const compact = above?.id !== root && canCompactPost(above, item, role);
    return <View style={item.id === focus ? styles.searchMatch : undefined}>
      {newDay ? <MessageDate at={item.createdAt} /> : null}
      {item.id === focus && matchLabel ? <Text style={styles.searchLabel}>{matchLabel}</Text> : null}
      <PostRow post={item} receipt={receipts?.get(item.id)} onReact={onReact} onAskAgent={onAskAgent} me={me} compact={compact && item.id !== focus} onEdit={setEditing} onDelete={onDelete} />
    </View>;
  }, [shown, root, focus, matchLabel, title, receipts, me, role, replyCount, styles, onReact, onAskAgent, onDelete]);

  return (
    <MediaGalleryProvider key={`${conv}:${unavailable}`} scope={{ kind: "conversation", id: conv }} items={media}>
    {piiDialog}
    <View style={styles.root}>
      <Stack.Screen options={{ title: title ? `Thread · ${title}` : "Thread" }} />
      <ConversationKeyboardView>
        {head === null && replies !== null && replies.length === 0 && error ? (
          // The thread itself is gone or out of reach: say so and offer a way out.
          <View style={styles.gone}>
            <Text accessibilityRole="header" style={styles.goneTitle}>{error}</Text>
            <Button label={title ? `Back to ${title}` : "Back"} kind="secondary" onPress={() => router.canGoBack() ? router.back() : router.replace({ pathname: "/c/[id]", params: { id: conv } })} style={{ marginTop: space.lg, alignSelf: "center", minWidth: 200 }} />
          </View>
        ) : error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {head === null && replies !== null && replies.length === 0 && error ? null : replies === null && !head ? (
          <ActivityIndicator style={{ flex: 1 }} color={colors.blue} />
        ) : (
          <FlatList
            {...readTracking}
            ref={list}
            data={shown}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            // A search hit stays in view through initial measurements. Normal
            // thread entry and composition continue to follow the latest reply.
            onContentSizeChange={() => maintainPosition(true)}
            onLayout={() => maintainPosition(false)}
            onScrollBeginDrag={releaseSearchFocus}
            onScrollToIndexFailed={onFocusScrollFailed}
            keyExtractor={postKey}
            contentContainerStyle={styles.list}
            // The first message is up; its replies are on their way.
            ListFooterComponent={replies === null ? <ActivityIndicator style={styles.loadingReplies} color={colors.blue} /> : undefined}
            renderItem={renderItem}
          />
        )}
        {!unavailable ? <TypingLine names={typingNames} /> : null}
        {unavailable ? null : editing ? (
          <Composer members={conversation?.members} mentionAgent me={me} key={`edit-${editing.id}`} placeholder="Edit message" autoFocus initial={editing.text} sendLabel="Save" onSend={saveEdit} onCancel={() => setEditing(null)} onDeleteEmpty={() => setConfirmDelete(editing)} />
        ) : (
          <Composer members={conversation?.members} mentionAgent me={me} key="reply" draftKey={`thread:${conv}:${root}`} placeholder="Reply" onSend={send} onTyping={ping} onEditLast={editLast ? () => setEditing(editLast) : undefined} />
        )}
      </ConversationKeyboardView>
      <ConfirmDialog visible={!!confirmDelete} title="Delete message?" description="Your message will be removed for everyone in this conversation." confirmLabel="Delete" onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { const p = confirmDelete; setConfirmDelete(null); setEditing(null); if (p) void remove(p); }} />
    </View>
    </MediaGalleryProvider>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  list: { paddingBottom: space.side },
  loadingReplies: { paddingVertical: space.lg },
  error: { ...typography.caption, paddingHorizontal: space.side, paddingVertical: space.sm, color: colors.red, backgroundColor: colors.redSoft },
  gone: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
  goneTitle: { ...typography.bodyStrong, color: colors.ink, textAlign: "center" },
  head: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingBottom: space.sm, marginBottom: space.xxs, backgroundColor: colors.background },
  where: { ...typography.captionStrong, marginHorizontal: space.side, marginTop: space.sm, color: colors.muted },
  count: { ...typography.captionStrong, marginHorizontal: space.side, marginTop: space.sm, color: colors.muted },
  searchMatch: { backgroundColor: colors.blueSoft },
  searchLabel: { ...typography.captionStrong, color: colors.blueDark, paddingHorizontal: space.side, paddingTop: space.sm },
}));
