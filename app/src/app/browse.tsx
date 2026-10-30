import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { api, ServerError, type BrowseChannel } from "../lib/server";
import { useSession } from "../lib/session";
import { colors } from "../lib/theme";

export default function Browse() {
  const { account } = useSession();
  const [channels, setChannels] = useState<BrowseChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!account) return;
    api.browse(account).then(setChannels, (e) => {
      setChannels([]);
      setError(e instanceof ServerError ? e.message : "Couldn't load channels");
    });
  }, [account]);
  return (
    <FlatList
      style={styles.root}
      data={channels ?? []}
      keyExtractor={(c) => c.id}
      ListEmptyComponent={
        channels === null ? <ActivityIndicator style={{ marginTop: 40 }} color={colors.blue} /> : <Text style={styles.empty}>{error ?? "You're in every channel"}</Text>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Opens a preview. You can join from there"
          onPress={() => router.replace({ pathname: "/c/[id]", params: { id: item.id } })}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>#{item.name}</Text>
            {item.topic ? <Text style={styles.topic} numberOfLines={1}>{item.topic}</Text> : null}
          </View>
          <Text style={styles.count}>{item.memberCount} {item.memberCount === 1 ? "member" : "members"}</Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  row: { minHeight: 64, paddingHorizontal: 20, paddingVertical: 10, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  name: { fontSize: 17, fontWeight: "600", color: colors.ink },
  topic: { marginTop: 2, fontSize: 15, color: colors.muted },
  count: { marginLeft: 12, fontSize: 14, color: colors.muted },
  empty: { marginTop: 40, textAlign: "center", color: colors.muted, fontSize: 16 },
});
