import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { PageTitle } from "../../components/Band";
import { Button } from "../../components/Button";
import { api, ServerError, type Chat } from "../../lib/server";
import { useSession } from "../../lib/session";
import { colors, space, typography } from "../../lib/theme";

function when(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function Chats() {
  const { account, setAccount, signOut } = useSession();
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    if (!account) return;
    try {
      setChats(await api.chats(account, setAccount));
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
  }, [account, setAccount, signOut]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!account) return null;

  const start = async () => {
    setStarting(true);
    try {
      const chat = await api.newChat(account);
      router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't start a chat");
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={styles.root}>
      <FlatList
        data={chats ?? []}
        keyExtractor={(c) => c.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListHeaderComponent={
          <View>
            <PageTitle description={`Your private chats with the agent on ${account.serverName}.`} action={<Button label="New chat" kind="secondary" compact onPress={start} busy={starting} />}>Agent</PageTitle>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {chats?.length ? <Text accessibilityRole="header" style={styles.sectionTitle}>Recent chats</Text> : null}
          </View>
        }
        ListEmptyComponent={
          chats === null ? (
            error ? <Button label="Try again" kind="link" onPress={() => void load()} style={styles.retry} /> : <ActivityIndicator style={{ marginTop: space.xl }} color={colors.blue} />
          ) : (
            <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.emptyTitle}>Start with a question</Text>
              <Text style={styles.emptyBody}>Ask the agent for help, then return to your conversation here.</Text>
              <Button label="New chat" onPress={start} busy={starting} style={styles.emptyAction} />
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id, title: item.title } })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}
          >
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title.replace(/`/g, "")}
            </Text>
            <Text style={styles.rowWhen}>{when(item.updatedAt)}</Text>
          </Pressable>
        )}
        contentContainerStyle={{ paddingBottom: space.xxl }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  error: { ...typography.caption, marginBottom: space.sm, marginHorizontal: space.side, color: colors.red },
  sectionTitle: { ...typography.label, color: colors.muted, marginHorizontal: space.side, marginTop: space.xs, marginBottom: space.xs },
  retry: { marginHorizontal: space.side },
  row: {
    minHeight: 72,
    paddingVertical: space.md,
    paddingHorizontal: space.side,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowTitle: { ...typography.bodyStrong, flex: 1, color: colors.ink, marginRight: space.sm },
  rowWhen: { ...typography.caption, color: colors.muted },
  empty: { marginTop: space.xxl, alignItems: "center", paddingHorizontal: space.side },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, marginTop: space.xs, color: colors.muted, textAlign: "center", maxWidth: 360 },
  emptyAction: { marginTop: space.lg },
});
