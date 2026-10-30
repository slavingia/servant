import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Band, PageTitle } from "../../components/Band";
import { ConversationRow } from "../../components/Messaging";
import { useLive } from "../../lib/live";
import { useSession } from "../../lib/session";
import { colors } from "../../lib/theme";

export default function Messages() {
  const { account } = useSession();
  const { conversations, error, refresh, connected } = useLive();
  const [refreshing, setRefreshing] = useState(false);
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  if (!account) return null;
  const list = (conversations ?? []).filter((c) => c.kind === "dm");
  return (
    <View style={styles.root}>
      <Band
        right={
          <Pressable accessibilityRole="button" onPress={() => router.push("/new-message")} hitSlop={12}>
            <Text style={styles.bandLink}>New message</Text>
          </Pressable>
        }
      />
      <FlatList
        data={list}
        keyExtractor={(c) => c.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          />
        }
        ListHeaderComponent={
          <View style={{ marginBottom: 8 }}>
            <PageTitle>Messages</PageTitle>
            {error && conversations ? <Text style={styles.error}>{error}</Text> : null}
            {!connected && conversations ? <Text style={styles.note}>Reconnecting…</Text> : null}
          </View>
        }
        ListEmptyComponent={
          conversations === null ? (
            error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator style={{ marginTop: 40 }} color={colors.blue} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No messages yet</Text>
              <Text style={styles.emptyBody}>Message anyone on this hub, one to one or in a small group</Text>
            </View>
          )
        }
        renderItem={({ item }) => <ConversationRow c={item} onPress={() => router.push({ pathname: "/c/[id]", params: { id: item.id } })} />}
        ListFooterComponent={undefined}
        contentContainerStyle={{ paddingBottom: 120 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  bandLink: { color: colors.white, fontSize: 16, fontWeight: "600" },
  error: { marginTop: 8, marginHorizontal: 20, fontSize: 15, color: colors.red },
  note: { marginTop: 8, marginHorizontal: 20, fontSize: 15, color: colors.muted },
  empty: { marginTop: 48, alignItems: "center", paddingHorizontal: 20 },
  emptyTitle: { fontSize: 20, fontWeight: "600", color: colors.ink },
  emptyBody: { marginTop: 6, fontSize: 16, color: colors.muted, textAlign: "center" },
  footerLink: { minHeight: 52, paddingHorizontal: 20, justifyContent: "center" },
  footerText: { color: colors.blue, fontSize: 17, fontWeight: "600" },
});
