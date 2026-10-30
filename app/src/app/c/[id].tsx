import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Button } from "../../components/Button";
import { Composer, PostRow } from "../../components/Messaging";
import { api, HubError, type Conversation, type Post } from "../../lib/hub";
import { useLive } from "../../lib/live";
import { useSession } from "../../lib/session";
import { colors } from "../../lib/theme";

const errorText = (e: unknown, fallback: string) => (e instanceof HubError ? e.message : fallback);

// Merge posts by id, keeping order by id (ids are increasing numbers).
function merge(list: Post[], incoming: Post[]) {
  const map = new Map(list.map((p) => [p.id, p]));
  for (const p of incoming) map.set(p.id, p);
  return [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { account } = useSession();
  const focused = useIsFocused();
  const visible = useRef(focused);
  useEffect(() => { visible.current = focused; }, [focused]);
  const { subscribe, setOpen, refresh } = useLive();
  const headerHeight = useHeaderHeight();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [joined, setJoined] = useState(true);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [joining, setJoining] = useState(false);
  const loadingOlder = useRef(false);

  const load = useCallback(async () => {
    if (!account || !id) return;
    try {
      const [c, p] = await Promise.all([api.conversation(account, id), api.posts(account, id)]);
      setConv(c.conversation);
      setJoined(c.joined);
      setPosts((old) => merge(old ?? [], p.messages));
      setMore(p.more);
      setError(null);
      if (c.joined && visible.current && AppState.currentState === "active") void api.markRead(account, id).catch(() => {});
    } catch (e) {
      setError(errorText(e, "Couldn't load this conversation"));
      setPosts((old) => old ?? []);
    }
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
        if (e.event === "message.created" || e.event === "message.updated") {
          const p = e.data;
          if (p.conversationId !== id || p.threadRoot) return;
          setPosts((old) => (old ? merge(old, [p]) : old));
          if (e.event === "message.created" && p.user.id !== account.user.id && visible.current && AppState.currentState === "active") void api.markRead(account, id, p.id).catch(() => {});
        } else if (e.event === "conversation.updated" && e.data.id === id) {
          api.conversation(account, id).then((c) => {
            setConv(c.conversation);
            setJoined(c.joined);
          }, () => undefined);
        }
      }),
    [subscribe, account, id],
  );

  if (!account) return null;
  const me = account.user.id;
  const isChannel = conv?.kind === "channel";
  const title = conv ? (isChannel ? `#${conv.title}` : conv.title) : "";

  const older = async () => {
    if (!more || loadingOlder.current || !posts?.length) return;
    loadingOlder.current = true;
    try {
      const p = await api.posts(account, id, posts[0]!.id);
      setPosts((old) => merge(old ?? [], p.messages));
      setMore(p.more);
    } catch {
      /* try again on next scroll */
    }
    loadingOlder.current = false;
  };

  const send = async (text: string) => {
    try {
      const p = await api.post(account, id, text);
      setPosts((old) => merge(old ?? [], [p]));
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
      setPosts((old) => merge(old ?? [], [p]));
      setEditing(null);
      return true;
    } catch (e) {
      setError(errorText(e, "Couldn't save the change"));
      return false;
    }
  };

  const remove = async (p: Post) => {
    try {
      await api.deletePost(account, p.id);
      setPosts((old) => (old ?? []).map((x) => (x.id === p.id ? { ...x, deleted: true, text: "" } : x)));
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
  const data = [...(posts ?? [])].reverse();

  const openDetails = () => router.push({ pathname: "/channel-info", params: { id } });

  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
          title,
          // iOS: a native bar button with no glass pill: plain white text on the navy band.
          unstable_headerRightItems:
            isChannel && Platform.OS === "ios"
              ? () => [{ type: "button", label: "Details", tintColor: colors.white, labelStyle: { color: colors.white, fontWeight: "600" }, hidesSharedBackground: true, onPress: openDetails }]
              : undefined,
          headerRight:
            isChannel && Platform.OS !== "ios"
              ? () => (
                  <Pressable accessibilityRole="button" onPress={openDetails} hitSlop={12}>
                    <Text style={styles.headerLink}>Details</Text>
                  </Pressable>
                )
              : undefined,
        }}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {posts === null ? (
          <ActivityIndicator style={{ flex: 1 }} color={colors.blue} />
        ) : (
          <FlatList
            inverted
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            data={data}
            keyExtractor={(p) => p.id}
            onEndReached={older}
            onEndReachedThreshold={0.3}
            contentContainerStyle={{ paddingVertical: 12 }}
            ListFooterComponent={
              conv && !more ? (
                <View style={styles.intro}>
                  <Text style={styles.introTitle}>{title}</Text>
                  <Text style={styles.introBody}>
                    {isChannel
                      ? conv.topic || `This is the start of ${title}`
                      : `This is the start of your conversation with ${conv.title}`}
                  </Text>
                  <Text style={styles.introBody}>Type @agent to ask the agent. Everyone here sees its answer</Text>
                </View>
              ) : undefined
            }
            renderItem={({ item, index }) => {
              const above = data[index + 1];
              const compact = !!above && above.user.id === item.user.id && item.createdAt - above.createdAt < 5 * 60 * 1000 && !above.replyCount;
              return (
                <PostRow
                  post={item}
                  me={me}
                  compact={compact}
                  onOpenThread={() => openThread(item)}
                  onEdit={() => setEditing(item)}
                  onDelete={() => remove(item)}
                />
              );
            }}
          />
        )}
        {!joined ? (
          <View style={styles.joinBar}>
            <Text style={styles.joinText}>You're previewing {title}</Text>
            <Button label={`Join ${title}`} onPress={join} busy={joining} />
          </View>
        ) : editing ? (
          <Composer key={`edit-${editing.id}`} placeholder="Edit message" initial={editing.text} sendLabel="Save" onSend={saveEdit} onCancel={() => setEditing(null)} />
        ) : (
          <Composer key="new" placeholder={conv ? `Message ${title}` : "Message"} onSend={send} />
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  headerLink: { color: colors.white, fontSize: 16, fontWeight: "600" },
  error: { paddingHorizontal: 20, paddingVertical: 8, color: colors.red, fontSize: 15, backgroundColor: "#FDECEF" },
  intro: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 12 },
  introTitle: { fontSize: 24, fontWeight: "700", color: colors.ink },
  introBody: { marginTop: 6, fontSize: 16, color: colors.muted },
  joinBar: { padding: 20, paddingBottom: 32, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  joinText: { textAlign: "center", color: colors.muted, fontSize: 15, marginBottom: 12 },
});
