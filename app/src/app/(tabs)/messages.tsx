import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { PageTitle } from "../../components/Band";
import { ConversationRow } from "../../components/Messaging";
import { Button } from "../../components/Button";
import { useLive } from "../../lib/live";
import { useSession } from "../../lib/session";
import { colors, space, typography } from "../../lib/theme";

export default function Messages() {
  const { account } = useSession();
  const { conversations, error, refresh, connected } = useLive();
  const [refreshing, setRefreshing] = useState(false);
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  const reload = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };
  if (!account) return null;
  const list = (conversations ?? []).filter((c) => c.kind === "dm");
  return (
    <View style={styles.root}>
      <FlatList
        data={list}
        keyExtractor={(c) => c.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void reload()}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <PageTitle description="One-to-one and small group conversations." action={<Button label="New message" compact onPress={() => router.push("/new-message")} />}>Messages</PageTitle>
            {error && conversations ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {!connected && conversations ? <Text style={styles.note}>Reconnecting…</Text> : null}
          </View>
        }
        ListEmptyComponent={
          conversations === null ? (
            error ? <View style={styles.empty}><Text accessibilityRole="alert" style={styles.emptyBody}>{error}</Text><Button label="Try again" kind="secondary" busy={refreshing} onPress={() => void reload()} style={styles.emptyAction} /></View> : <ActivityIndicator accessibilityLabel="Loading messages" style={styles.loading} color={colors.blue} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No messages yet</Text>
              <Text style={styles.emptyBody}>Start a conversation with someone on your server.</Text>
              <Button label="Start a conversation" kind="secondary" onPress={() => router.push("/new-message")} style={styles.emptyAction} />
            </View>
          )
        }
        renderItem={({ item }) => <ConversationRow c={item} onPress={() => router.push({ pathname: "/c/[id]", params: { id: item.id } })} />}
        contentContainerStyle={styles.content}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  content: { paddingBottom: 120, flexGrow: 1 },
  header: { marginBottom: space.xs },
  loading: { marginTop: space.xxl },
  error: { ...typography.caption, marginTop: space.xs, marginHorizontal: space.side, color: colors.red },
  note: { ...typography.caption, marginTop: space.xs, marginHorizontal: space.side, color: colors.muted },
  empty: { marginTop: space.xxl, alignItems: "center", paddingHorizontal: space.lg },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, marginTop: space.xs, maxWidth: 320, color: colors.muted, textAlign: "center" },
  emptyAction: { marginTop: space.lg },
});
