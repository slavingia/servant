import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Band, PageTitle } from "../../components/Band";
import { api, ServerError, type Chat } from "../../lib/server";
import { useSession } from "../../lib/session";
import { colors } from "../../lib/theme";

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
      <Band
        right={
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: starting }} disabled={starting} onPress={start} hitSlop={12}>
            <Text style={[styles.bandLink, starting && { opacity: 0.5 }]}>New chat</Text>
          </Pressable>
        }
      />
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
            <PageTitle>Agent</PageTitle>
            <Text style={styles.sub}>Private chats with the agent on {account.serverName}. Only you can see them</Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          chats === null ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.blue} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No chats yet</Text>
              <Text style={styles.emptyBody}>Tap New chat to ask the agent anything</Text>
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
        contentContainerStyle={{ paddingBottom: 40 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  bandLink: { color: colors.white, fontSize: 16, fontWeight: "600" },
  sub: { marginTop: 4, marginHorizontal: 20, fontSize: 15, color: colors.muted },
  error: { marginTop: 12, marginHorizontal: 20, fontSize: 15, color: colors.red },
  row: {
    minHeight: 60,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowTitle: { flex: 1, fontSize: 17, color: colors.ink, marginRight: 12 },
  rowWhen: { fontSize: 14, color: colors.muted },
  empty: { marginTop: 48, alignItems: "center", paddingHorizontal: 20 },
  emptyTitle: { fontSize: 20, fontWeight: "600", color: colors.ink },
  emptyBody: { marginTop: 6, fontSize: 16, color: colors.muted, textAlign: "center" },
});
