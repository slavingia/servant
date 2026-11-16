import { useCallback, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api, ServerError, type FeedItem } from "../lib/server";
import { useSession } from "../lib/session";
import { feedMeta, groupFeed, type FeedRow } from "../lib/feed-format";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// What the agent did lately: messages it sent, things it shipped, scheduled checks. Grouped by day, like Loops.
export default function FeedScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!account) return;
    try { const r = await api.feed(account); setItems(r.items); setNow(Date.now()); setError(null); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't load the feed"); }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;

  const dot = (k: FeedRow["kind"]) => k === "shipped" ? colors.green : k === "sent" ? colors.blue : colors.muted;

  return <ScrollView style={styles.root} contentContainerStyle={styles.content}
    refreshControl={<RefreshControl tintColor={colors.blue} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }} />}>
    <Text style={styles.intro}>What the agent did lately.</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!items && !error ? <ActivityIndicator color={colors.blue} style={styles.spinner} /> : null}
    {items && items.length === 0 ? <Text style={styles.empty}>Nothing yet. What the agent does will show up here.</Text> : null}
    {items ? groupFeed(items, now).map(group => <View key={group.key}>
      <Text accessibilityRole="header" style={styles.section}>{group.title}</Text>
      <View style={styles.list}>
        {group.items.map(it => {
          const row = <>
            <View style={[styles.dot, { backgroundColor: dot(it.kind) }]} />
            <View style={styles.rowCopy}>
              <Text style={it.kind === "ran" ? styles.plain : styles.name}>{it.text}</Text>
              <Text style={styles.meta}>{feedMeta(it)}</Text>
            </View>
          </>;
          return it.url
            ? <Pressable key={it.id} accessibilityRole="link" accessibilityLabel={`${it.text}. ${feedMeta(it)}`} onPress={() => void Linking.openURL(it.url!)} style={styles.row}>{row}</Pressable>
            : <View key={it.id} accessible accessibilityLabel={`${it.text}. ${feedMeta(it)}`} style={styles.row}>{row}</View>;
        })}
      </View>
    </View>) : null}
  </ScrollView>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 720, alignSelf: "center" },
  intro: { ...typography.body, color: colors.muted, marginBottom: space.sm },
  error: { ...typography.caption, color: colors.red, marginBottom: space.sm },
  spinner: { marginVertical: space.lg },
  empty: { ...typography.body, color: colors.muted, marginVertical: space.md },
  section: { ...typography.label, color: colors.muted, marginTop: space.md, marginBottom: space.xs },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  row: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: space.sm, paddingHorizontal: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  dot: { width: space.xs, height: space.xs, borderRadius: radius.pill, marginTop: space.xs },
  rowCopy: { flex: 1, minWidth: 0 },
  name: { ...typography.bodyStrong, color: colors.ink },
  plain: { ...typography.body, color: colors.ink },
  meta: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
}));
