import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { ConversationKeyboardView } from "../components/ConversationKeyboardView";
import { Composer, MessageDate, PostRow } from "../components/Messaging";
import { MediaGalleryProvider } from "../components/MediaGallery";
import { mediaFromPosts } from "../lib/media";
import { TypingLine, useTyping, useTypingPing } from "../lib/typing";
import { api, ServerError, type Upload, type Post, type Conversation, type LiveEvent } from "../lib/server";
import { useReadReceipts } from "../lib/use-read-receipts";
import { mergeReadEvent } from "../lib/read-receipts";
import { latestMessageReceipts } from "../lib/message-status";
import { canCompactPost } from "../lib/message-device";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";

export default function ThreadScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { conv, root, title, focus } = useLocalSearchParams<{ conv: string; root: string; title?: string; focus?: string }>();
  const { account } = useSession();
  const focused = useIsFocused();
  const { subscribe } = useLive();
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
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [head, setHead] = useState<Post | null>(null);
  const [replies, setReplies] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [joined, setJoined] = useState(false);
  const needsSnapshot = useRef(false);
  const accessDenied = useRef(false);
  const snapshot = useRef<{ updates: Map<string, Post>; reads: Extract<LiveEvent, { event: "messages.read" }>["data"][] } | null>(null);
  const typingNames = useTyping(conv, root, account?.user.id ?? "");
  const ping = useTypingPing(account, conv, root);
  const rows = useMemo(() => head ? [head, ...(replies ?? [])] : replies ?? [], [head, replies]);
  const receipts = useMemo(() => conversation?.id === conv && conversation.kind === "dm"
    ? latestMessageReceipts(rows, account?.user.id ?? "", conversation.members)
    : undefined, [rows, account?.user.id, conversation, conv]);
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

  const load = useCallback(async () => {
    if (!account) return;
    const current = { updates: new Map<string, Post>(), reads: [] as Extract<LiveEvent, { event: "messages.read" }>["data"][] };
    snapshot.current = current;
    try {
      const [t, c] = await Promise.all([api.thread(account, conv, root), api.conversation(account, conv)]);
      if (snapshot.current !== current) return;
      needsSnapshot.current = false;
      accessDenied.current = false;
      setConversation(c.conversation);
      setJoined(c.joined);
      setHead(current.reads.reduce(mergeReadEvent, current.updates.get(root) ?? t.root));
      const recovered = new Map(t.replies.map(p => [p.id, p]));
      for (const post of current.updates.values()) if (post.id !== root) recovered.set(post.id, post);
      setReplies([...recovered.values()].map(post => current.reads.reduce(mergeReadEvent, post)).sort((a, b) => Number(a.id) - Number(b.id)));
      setUnavailable(false);
      setError(null);
    } catch (e) {
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
    } finally {
      if (snapshot.current === current) snapshot.current = null;
    }
  }, [account, conv, root]);

  useEffect(() => {
    load();
    return () => { snapshot.current = null; };
  }, [load]);

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
        if (p.conversationId === conv && (p.id === root || p.threadRoot === root)) upsert(p);
      }),
    [subscribe, root, conv, account, upsert, load],
  );

  const media = useMemo(() => mediaFromPosts(rows), [rows]);
  if (!account) return null;
  const me = account.user.id;

  const send = async (text: string, attachments: Upload[] = []) => {
    try {
      const post = await api.post(account, conv, text, root, attachments);
      releaseSearchFocus();
      upsert(post);
      setError(null);
      return true;
    } catch (e) {
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
  const react = async (post: Post, emoji: string, active: boolean) => {
    try {
      const p = await api.reactToPost(account, post.id, emoji, active);
      upsert(p);
      setError(null);
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't save the reaction. Try again");
    }
  };

  const remove = async (p: Post) => {
    try {
      await api.deletePost(account, p.id);
      upsert({ ...p, deleted: true, text: "", attachments: [], reactions: [] });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't delete the message");
    }
  };

  return (
    <MediaGalleryProvider key={`${conv}:${unavailable}`} scope={{ kind: "conversation", id: conv }} items={media}>
    <View style={styles.root}>
      <Stack.Screen options={{ title: "Thread" }} />
      <ConversationKeyboardView>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {replies === null ? (
          <ActivityIndicator style={{ flex: 1 }} color={colors.blue} />
        ) : (
          <FlatList
            {...readTracking}
            ref={list}
            data={rows}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            // A search hit stays in view through initial measurements. Normal
            // thread entry and composition continue to follow the latest reply.
            onContentSizeChange={() => maintainPosition(true)}
            onLayout={() => maintainPosition(false)}
            onScrollBeginDrag={releaseSearchFocus}
            onScrollToIndexFailed={onFocusScrollFailed}
            keyExtractor={(p) => p.id}
            contentContainerStyle={{ paddingBottom: space.side }}
            renderItem={({ item, index }) => {
              if (item.id === root) return <View style={[styles.head, item.id === focus && styles.searchMatch]}>
                {item.id === focus ? <Text style={styles.searchLabel}>Search match</Text> : null}
                {title ? <Text style={styles.where}>In {title}</Text> : null}
                <PostRow post={item} receipt={receipts?.get(item.id)} onReact={(emoji, active) => react(item, emoji, active)} me={me} onEdit={() => setEditing(item)} onDelete={() => remove(item)} />
                <Text accessibilityRole="header" style={styles.count}>
                  {!replies?.length ? "No replies yet" : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
                </Text>
              </View>;
              const above = rows[index - 1];
              const newDay = !!above && new Date(item.createdAt).toDateString() !== new Date(above.createdAt).toDateString();
              const compact = above?.id !== root && canCompactPost(above, item, account.user.role);
              return <View style={item.id === focus ? styles.searchMatch : undefined}>
                {newDay ? <MessageDate at={item.createdAt} /> : null}
                {item.id === focus ? <Text style={styles.searchLabel}>Search match</Text> : null}
                <PostRow post={item} receipt={receipts?.get(item.id)} onReact={(emoji, active) => react(item, emoji, active)} me={me} compact={compact && item.id !== focus} onEdit={() => setEditing(item)} onDelete={() => remove(item)} />
              </View>;
            }}
          />
        )}
        {!unavailable ? <TypingLine names={typingNames} /> : null}
        {unavailable ? null : editing ? (
          <Composer members={conversation?.members} mentionAgent me={me} key={`edit-${editing.id}`} placeholder="Edit message" initial={editing.text} sendLabel="Save" onSend={saveEdit} onCancel={() => setEditing(null)} />
        ) : (
          <Composer members={conversation?.members} mentionAgent me={me} key="reply" placeholder="Reply" onSend={send} onTyping={ping} />
        )}
      </ConversationKeyboardView>
    </View>
    </MediaGalleryProvider>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  error: { ...typography.caption, paddingHorizontal: space.side, paddingVertical: space.sm, color: colors.red, backgroundColor: colors.redSoft },
  head: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingBottom: space.sm, marginBottom: space.xxs, backgroundColor: colors.background },
  where: { ...typography.captionStrong, marginHorizontal: space.side, marginTop: space.sm, color: colors.muted },
  count: { ...typography.captionStrong, marginHorizontal: space.side, marginTop: space.sm, color: colors.muted },
  searchMatch: { backgroundColor: colors.blueSoft },
  searchLabel: { ...typography.captionStrong, color: colors.blueDark, paddingHorizontal: space.side, paddingTop: space.sm },
}));
