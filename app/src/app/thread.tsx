import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Composer, PostRow } from "../components/Messaging";
import { api, HubError, type Post } from "../lib/hub";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { colors } from "../lib/theme";

export default function ThreadScreen() {
  const { conv, root, title } = useLocalSearchParams<{ conv: string; root: string; title?: string }>();
  const { account } = useSession();
  const { subscribe } = useLive();
  const headerHeight = useHeaderHeight();
  const list = useRef<FlatList<Post>>(null);
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => list.current?.scrollToEnd({ animated: true }));
    return () => sub.remove();
  }, []);
  const [head, setHead] = useState<Post | null>(null);
  const [replies, setReplies] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);

  const upsert = (p: Post) =>
    setReplies((old) => {
      const list = old ?? [];
      const i = list.findIndex((x) => x.id === p.id);
      if (i < 0) return [...list, p].sort((a, b) => Number(a.id) - Number(b.id));
      const copy = list.slice();
      copy[i] = p;
      return copy;
    });

  const load = useCallback(async () => {
    if (!account) return;
    try {
      const t = await api.thread(account, conv, root);
      setHead(t.root);
      setReplies(t.replies);
      setError(null);
    } catch (e) {
      setError(e instanceof HubError ? e.message : "Couldn't load this thread");
      setReplies((r) => r ?? []);
    }
  }, [account, conv, root]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.event !== "message.created" && e.event !== "message.updated") return;
        const p = e.data;
        if (p.id === root) setHead(p);
        else if (p.threadRoot === root) upsert(p);
      }),
    [subscribe, root],
  );

  if (!account) return null;
  const me = account.user.id;

  const send = async (text: string) => {
    try {
      upsert(await api.post(account, conv, text, root));
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof HubError ? e.message : "Couldn't send. Check your connection");
      return false;
    }
  };
  const saveEdit = async (text: string) => {
    if (!editing) return true;
    try {
      const p = await api.editPost(account, editing.id, text);
      if (p.id === root) setHead(p);
      else upsert(p);
      setEditing(null);
      return true;
    } catch (e) {
      setError(e instanceof HubError ? e.message : "Couldn't save the change");
      return false;
    }
  };
  const remove = async (p: Post) => {
    try {
      await api.deletePost(account, p.id);
      const gone = { ...p, deleted: true, text: "" };
      if (p.id === root) setHead(gone);
      else upsert(gone);
    } catch (e) {
      setError(e instanceof HubError ? e.message : "Couldn't delete the message");
    }
  };

  const rows = replies ?? [];
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: "Thread" }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {replies === null ? (
          <ActivityIndicator style={{ flex: 1 }} color={colors.blue} />
        ) : (
          <FlatList
            ref={list}
            data={rows}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            // Keep the newest reply in view: after a send, a live reply, or the keyboard opening.
            onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
            onLayout={() => list.current?.scrollToEnd({ animated: false })}
            keyExtractor={(p) => p.id}
            contentContainerStyle={{ paddingBottom: 20 }}
            ListHeaderComponent={
              head ? (
                <View style={styles.head}>
                  {title ? <Text style={styles.where}>{title}</Text> : null}
                  <PostRow post={head} me={me} onEdit={() => setEditing(head)} onDelete={() => remove(head)} />
                  <Text style={styles.count}>
                    {rows.length === 0 ? "No replies yet" : `${rows.length} ${rows.length === 1 ? "reply" : "replies"}`}
                  </Text>
                </View>
              ) : undefined
            }
            renderItem={({ item, index }) => {
              const above = rows[index - 1];
              const compact = !!above && above.user.id === item.user.id && item.createdAt - above.createdAt < 5 * 60 * 1000;
              return <PostRow post={item} me={me} compact={compact} onEdit={() => setEditing(item)} onDelete={() => remove(item)} />;
            }}
          />
        )}
        {editing ? (
          <Composer key={`edit-${editing.id}`} placeholder="Edit message" initial={editing.text} sendLabel="Save" onSend={saveEdit} onCancel={() => setEditing(null)} />
        ) : (
          <Composer key="reply" placeholder="Reply" onSend={send} />
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  error: { paddingHorizontal: 20, paddingVertical: 8, color: colors.red, fontSize: 15, backgroundColor: "#FDECEF" },
  head: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingBottom: 10, marginBottom: 4 },
  where: { marginHorizontal: 20, marginTop: 12, fontSize: 14, color: colors.muted, fontWeight: "600" },
  count: { marginHorizontal: 20, marginTop: 10, fontSize: 14, color: colors.muted },
});
