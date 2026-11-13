import { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api, ServerError, type Loop } from "../lib/server";
import { useSession } from "../lib/session";
import { groupLoops, loopDetail } from "../lib/loops-format";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// What the agent does on its own, on a schedule: releases, checks, reports. Grouped by how often.
export default function LoopsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [loops, setLoops] = useState<Loop[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!account) return;
    try { const r = await api.loops(account); setLoops(r.loops); setAvailable(r.available); setNow(Date.now()); setError(null); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't load loops"); }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;

  return <ScrollView style={styles.root} contentContainerStyle={styles.content}
    refreshControl={<RefreshControl tintColor={colors.blue} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }} />}>
    <Text style={styles.intro}>What the agent does on its own, on a schedule.</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!loops && !error ? <ActivityIndicator color={colors.blue} style={styles.spinner} /> : null}
    {loops && !available ? <Text style={styles.empty}>Loops aren't available right now. Pull down to try again.</Text> : null}
    {loops && available && loops.length === 0 ? <Text style={styles.empty}>Nothing runs on a schedule yet.</Text> : null}
    {loops ? groupLoops(loops).map(group => <View key={group.key}>
      <Text accessibilityRole="header" style={styles.section}>{group.title}</Text>
      <View style={styles.list}>
        {group.loops.map(loop => <View key={loop.id} accessible accessibilityLabel={`${loop.name}. ${loop.cadence}. ${loopDetail(loop, now)}`} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: !loop.on ? colors.muted : loop.lastOk === false ? colors.red : colors.green }]} />
          <View style={styles.rowCopy}>
            <Text style={styles.name}>{loop.name}</Text>
            <Text style={styles.meta}>{loop.cadence}</Text>
            <Text style={styles.meta}>{loopDetail(loop, now)}</Text>
          </View>
        </View>)}
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
  meta: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
}));
