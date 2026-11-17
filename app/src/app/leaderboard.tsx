import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BallRefreshControl } from "../components/BallRefreshControl";
import { useFocusEffect } from "expo-router";
import { Avatar } from "../components/Messaging";
import { api, ServerError, type Leaderboard, type LeaderboardPeriod } from "../lib/server";
import { useSession } from "../lib/session";
import { estimateCost, formatCost, formatTokens, sharePercent } from "../lib/token-format";
import { createThemedStyles, radius, space, typography } from "../lib/theme";
import { ServeLoader } from "../components/ServeLoader";

const periods: { key: LeaderboardPeriod; label: string; caption: string }[] = [
  { key: "day", label: "Today", caption: "the last 24 hours" },
  { key: "week", label: "Week", caption: "the last 7 days" },
  { key: "month", label: "Month", caption: "the last 30 days" },
  { key: "all", label: "All time", caption: "all time" },
];

// Built-in agent usage report: agent tokens used across the server and by person.
export default function LeaderboardScreen() {
  const styles = useStyles();
  const { account } = useSession();
  const [period, setPeriod] = useState<LeaderboardPeriod>("week");
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (which: LeaderboardPeriod) => {
    if (!account) return;
    try { setBoard(await api.leaderboard(account, which)); setError(null); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't load the agent usage report"); }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(period); }, [load, period]));
  if (!account) return null;

  const current = periods.find(p => p.key === period)!;

  return <ScrollView style={styles.root} contentContainerStyle={styles.content}
    refreshControl={<BallRefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); try { await load(period); } finally { setRefreshing(false); } }} />}>
    <View accessibilityRole="tablist" style={styles.periods}>
      {periods.map(p => <Pressable key={p.key} accessibilityRole="tab" accessibilityState={{ selected: p.key === period }} aria-selected={p.key === period}
        onPress={() => { setBoard(null); setPeriod(p.key); }} style={[styles.period, p.key === period && styles.periodOn]}>
        <Text style={[styles.periodText, p.key === period && styles.periodTextOn]}>{p.label}</Text>
      </Pressable>)}
    </View>


    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!board ? <ServeLoader accessibilityLabel="Loading agent usage report" style={{ marginTop: space.xl }} /> : <>
      <View accessible accessibilityLabel={`${formatTokens(board.totals.total)} tokens used on ${account.serverName} in ${current.caption}, across ${board.totals.turns} agent replies, about ${formatCost(estimateCost(board.totals.input, board.totals.output))} estimated`} style={styles.total}>
        <Text style={styles.totalLabel}>{account.serverName} · {current.caption}</Text>
        <Text style={styles.totalValue}>{formatTokens(board.totals.total)}</Text>
        <Text style={styles.totalDetail}>tokens · about {formatCost(estimateCost(board.totals.input, board.totals.output))} estimated · {board.totals.turns.toLocaleString("en-US")} agent {board.totals.turns === 1 ? "reply" : "replies"}</Text>
        {board.totals.total ? <View style={styles.split}>
          <Text style={styles.splitText}>In {formatTokens(board.totals.input)}</Text>
          <Text style={styles.splitText}>Out {formatTokens(board.totals.output)}</Text>
        </View> : null}
      </View>


      <Text accessibilityRole="header" style={styles.section}>By person</Text>
      {board.people.length === 0 ? <Text style={styles.empty}>No agent use in {current.caption}</Text> : null}
      <View style={styles.list}>
        {board.people.map(row => {
          const me = row.user.id === account.user.id;
          return <View key={row.user.id} accessible
            accessibilityLabel={`Number ${row.rank}, ${me ? "you" : row.user.name}, ${formatTokens(row.total)} tokens, about ${formatCost(estimateCost(row.input, row.output))} estimated, ${sharePercent(row.total, board.totals.total)} of the total, ${row.turns} replies`}
            style={[styles.row, me && styles.rowMe]}>
            <Text style={[styles.rank, row.rank <= 3 && styles.rankTop]}>{row.rank}</Text>
            <Avatar name={row.user.name} userId={row.user.id} size={32} tapToMessage />
            <View style={styles.rowCopy}>
              <View style={styles.rowHead}>
                <Text style={styles.name}>{row.user.name}{me ? " (you)" : ""}</Text>
                <Text style={styles.value}>{formatTokens(row.total)} · ~{formatCost(estimateCost(row.input, row.output))}</Text>
              </View>
              <View style={styles.track}><View style={[styles.bar, { width: `${board.totals.total ? Math.max(2, (row.total / board.totals.total) * 100) : 0}%` }]} /></View>
              <Text style={styles.meta}>{sharePercent(row.total, board.totals.total)} · {row.turns} {row.turns === 1 ? "reply" : "replies"}{row.channel ? ` · ${formatTokens(row.channel)} in channels` : ""}</Text>
            </View>
          </View>;
        })}
      </View>
      <Text style={styles.footnote}>Estimated at $3 per million input tokens and $15 per million output tokens. Not a bill.</Text>
    </>}
  </ScrollView>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 720, alignSelf: "center" },
  periods: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.md, padding: 3, marginBottom: space.md },
  period: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  periodOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  periodText: { ...typography.captionStrong, color: colors.muted },
  periodTextOn: { color: colors.ink },
  error: { ...typography.caption, color: colors.red, marginBottom: space.sm },
  total: { padding: space.md, borderRadius: radius.lg, backgroundColor: colors.blueSoft, marginBottom: space.sm },
  totalLabel: { ...typography.label, color: colors.brandText },
  totalValue: { ...typography.display, color: colors.ink, marginTop: space.xs },
  totalDetail: { ...typography.caption, color: colors.muted },
  split: { flexDirection: "row", gap: space.md, marginTop: space.sm },
  splitText: { ...typography.captionStrong, color: colors.brandText },
  section: { ...typography.label, color: colors.muted, marginTop: space.sm, marginBottom: space.xs },
  empty: { ...typography.body, color: colors.muted, marginVertical: space.md },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, paddingHorizontal: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowMe: { backgroundColor: colors.surface },
  rank: { ...typography.bodyStrong, width: 24, textAlign: "center", color: colors.muted },
  rankTop: { color: colors.blue },
  rowCopy: { flex: 1, minWidth: 0 },
  rowHead: { flexDirection: "row", alignItems: "baseline", gap: space.xs },
  name: { ...typography.bodyStrong, color: colors.ink, flex: 1 },
  value: { ...typography.bodyStrong, color: colors.ink },
  track: { height: 6, borderRadius: radius.pill, backgroundColor: colors.line, marginTop: space.xxs, overflow: "hidden" },
  bar: { height: 6, borderRadius: radius.pill, backgroundColor: colors.blue },
  meta: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  footnote: { ...typography.meta, color: colors.muted, marginTop: space.md },
}));
