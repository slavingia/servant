import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Avatar } from "../components/Messaging";
import { api, ServerError, type Leaderboard, type LeaderboardPeriod } from "../lib/server";
import { useSession } from "../lib/session";
import { formatTokens, sharePercent } from "../lib/token-format";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

const periods: { key: LeaderboardPeriod; label: string; caption: string }[] = [
  { key: "day", label: "Today", caption: "the last 24 hours" },
  { key: "week", label: "Week", caption: "the last 7 days" },
  { key: "month", label: "Month", caption: "the last 30 days" },
  { key: "all", label: "All time", caption: "all time" },
];

// Built-in leaderboard: agent tokens used across the server and by person.
export default function LeaderboardScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [period, setPeriod] = useState<LeaderboardPeriod>("week");
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (which: LeaderboardPeriod) => {
    if (!account) return;
    try { setBoard(await api.leaderboard(account, which)); setError(null); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't load the leaderboard"); }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(period); }, [load, period]));
  if (!account) return null;

  const current = periods.find(p => p.key === period)!;
  const mine = board?.people.find(p => p.user.id === account.user.id);

  return <ScrollView style={styles.root} contentContainerStyle={styles.content}
    refreshControl={<RefreshControl tintColor={colors.blue} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); try { await load(period); } finally { setRefreshing(false); } }} />}>
    <View accessibilityRole="tablist" style={styles.periods}>
      {periods.map(p => <Pressable key={p.key} accessibilityRole="tab" accessibilityState={{ selected: p.key === period }}
        onPress={() => { setBoard(null); setPeriod(p.key); }} style={[styles.period, p.key === period && styles.periodOn]}>
        <Text style={[styles.periodText, p.key === period && styles.periodTextOn]}>{p.label}</Text>
      </Pressable>)}
    </View>

    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!board ? <ActivityIndicator accessibilityLabel="Loading leaderboard" style={{ marginTop: space.xl }} color={colors.blue} /> : <>
      <View accessible accessibilityLabel={`${formatTokens(board.totals.total)} tokens used on ${account.serverName} in ${current.caption}, across ${board.totals.turns} agent replies`} style={styles.total}>
        <Text style={styles.totalLabel}>{account.serverName} · {current.caption}</Text>
        <Text style={styles.totalValue}>{formatTokens(board.totals.total)}</Text>
        <Text style={styles.totalDetail}>tokens · {board.totals.turns.toLocaleString("en-US")} agent {board.totals.turns === 1 ? "reply" : "replies"}</Text>
        {board.totals.total ? <View style={styles.split}>
          <Text style={styles.splitText}>In {formatTokens(board.totals.input)}</Text>
          <Text style={styles.splitText}>Out {formatTokens(board.totals.output)}</Text>
        </View> : null}
      </View>

      {mine ? <Text style={styles.you}>You're #{mine.rank} with {formatTokens(mine.total)} tokens ({sharePercent(mine.total, board.totals.total)} of the total).</Text> : null}

      <Text accessibilityRole="header" style={styles.section}>By person</Text>
      {board.people.length === 0 ? <Text style={styles.empty}>No agent use in {current.caption} yet. Ask the agent something and it shows up here.</Text> : null}
      <View style={styles.list}>
        {board.people.map(row => {
          const me = row.user.id === account.user.id;
          return <View key={row.user.id} accessible
            accessibilityLabel={`Number ${row.rank}, ${me ? "you" : row.user.name}, ${formatTokens(row.total)} tokens, ${sharePercent(row.total, board.totals.total)} of the total, ${row.turns} replies`}
            style={[styles.row, me && styles.rowMe]}>
            <Text style={[styles.rank, row.rank <= 3 && styles.rankTop]}>{row.rank}</Text>
            <Avatar name={row.user.name} userId={row.user.id} size={32} tapToMessage />
            <View style={styles.rowCopy}>
              <View style={styles.rowHead}>
                <Text numberOfLines={1} style={styles.name}>{row.user.name}{me ? " (you)" : ""}</Text>
                <Text style={styles.value}>{formatTokens(row.total)}</Text>
              </View>
              <View style={styles.track}><View style={[styles.bar, { width: `${board.totals.total ? Math.max(2, (row.total / board.totals.total) * 100) : 0}%` }]} /></View>
              <Text style={styles.meta}>{sharePercent(row.total, board.totals.total)} · {row.turns} {row.turns === 1 ? "reply" : "replies"}{row.channel ? ` · ${formatTokens(row.channel)} in channels` : ""}</Text>
            </View>
          </View>;
        })}
      </View>
      <Text style={styles.footnote}>Tokens the agent reported for each reply, credited to the person who asked: their agent chats plus @s replies in channels.{board.people.length ? " Bars show each person's share of the total." : ""} Prompts are not shown here.</Text>
    </>}
  </ScrollView>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 720, alignSelf: "center" },
  periods: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.md, padding: 3, marginBottom: space.md },
  period: { flex: 1, minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  periodOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  periodText: { ...typography.captionStrong, color: colors.muted },
  periodTextOn: { color: colors.ink },
  error: { ...typography.caption, color: colors.red, marginBottom: space.sm },
  total: { padding: space.md, borderRadius: radius.lg, backgroundColor: colors.blueSoft, marginBottom: space.sm },
  totalLabel: { ...typography.label, color: colors.brandText },
  totalValue: { ...typography.title, fontSize: 40, lineHeight: 46, color: colors.ink, marginTop: space.xs },
  totalDetail: { ...typography.caption, color: colors.muted },
  split: { flexDirection: "row", gap: space.md, marginTop: space.sm },
  splitText: { ...typography.captionStrong, color: colors.brandText },
  you: { ...typography.caption, color: colors.ink, marginBottom: space.sm },
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
  track: { height: 6, borderRadius: 3, backgroundColor: colors.line, marginTop: space.xxs, overflow: "hidden" },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.blue },
  meta: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  footnote: { ...typography.meta, color: colors.muted, marginTop: space.md },
}));
