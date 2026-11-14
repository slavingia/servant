import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Avatar } from "../components/Messaging";
import { api, ServerError, type Leaderboard, type LeaderboardPeriod, type TopicRow } from "../lib/server";
import { useSession } from "../lib/session";
import { estimateCost, formatCost, formatTokens, sharePercent } from "../lib/token-format";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

const periods: { key: LeaderboardPeriod; label: string; caption: string }[] = [
  { key: "day", label: "Today", caption: "the last 24 hours" },
  { key: "week", label: "Week", caption: "the last 7 days" },
  { key: "month", label: "Month", caption: "the last 30 days" },
  { key: "all", label: "All time", caption: "all time" },
];

// Built-in usage report: agent tokens used across the server and by person.
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
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't load the usage report"); }
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

    <Text style={styles.goal}>The goal is productivity: pull requests merged per million tokens, not tokens used. Tokens only show how much the agent is used.</Text>

    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!board ? <ActivityIndicator accessibilityLabel="Loading usage report" style={{ marginTop: space.xl }} color={colors.blue} /> : <>
      <View accessible accessibilityLabel={`${formatTokens(board.totals.total)} tokens used on ${account.serverName} in ${current.caption}, across ${board.totals.turns} agent replies, about ${formatCost(estimateCost(board.totals.input, board.totals.output))} estimated`} style={styles.total}>
        <Text style={styles.totalLabel}>{account.serverName} · {current.caption}</Text>
        <Text style={styles.totalValue}>{formatTokens(board.totals.total)}</Text>
        <Text style={styles.totalDetail}>tokens · about {formatCost(estimateCost(board.totals.input, board.totals.output))} estimated · {board.totals.turns.toLocaleString("en-US")} agent {board.totals.turns === 1 ? "reply" : "replies"}</Text>
        {board.totals.total ? <View style={styles.split}>
          <Text style={styles.splitText}>In {formatTokens(board.totals.input)}</Text>
          <Text style={styles.splitText}>Out {formatTokens(board.totals.output)}</Text>
        </View> : null}
      </View>

      {mine ? <Text style={styles.you}>You're #{mine.rank} with {formatTokens(mine.total)} tokens, about {formatCost(estimateCost(mine.input, mine.output))} estimated ({sharePercent(mine.total, board.totals.total)} of the total).</Text> : null}

      <Text accessibilityRole="header" style={styles.section}>By person</Text>
      {board.people.length === 0 ? <Text style={styles.empty}>No agent use in {current.caption} yet. Ask the agent something and it shows up here.</Text> : null}
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
                <Text numberOfLines={1} style={styles.name}>{row.user.name}{me ? " (you)" : ""}</Text>
                <Text style={styles.value}>{formatTokens(row.total)} · ~{formatCost(estimateCost(row.input, row.output))}</Text>
              </View>
              <View style={styles.track}><View style={[styles.bar, { width: `${board.totals.total ? Math.max(2, (row.total / board.totals.total) * 100) : 0}%` }]} /></View>
              <Text style={styles.meta}>{sharePercent(row.total, board.totals.total)} · {row.turns} {row.turns === 1 ? "reply" : "replies"}{row.channel ? ` · ${formatTokens(row.channel)} in channels` : ""}</Text>
            </View>
          </View>;
        })}
      </View>
      {board.topics ? <Topics report={board.topics} styles={styles} /> : null}
      <Text style={styles.footnote}>Tokens the agent reported for each reply, credited to the person who asked: their agent chats plus @s replies in channels.{board.people.length ? " Bars show each person's share of the total." : ""} Dollar figures are estimates at list prices ($3 per million tokens in, $15 per million out), not a bill. Prompts are not shown here.</Text>
    </>}
  </ScrollView>;
}

// Tokens spent per survey-feedback theme, next to how much real users said about it.
function Topics({ report, styles }: { report: NonNullable<Leaderboard["topics"]>; styles: ReturnType<typeof useStyles> }) {
  const all = report.irsAppTokens + report.otherTokens;
  const max = Math.max(1, ...report.themes.map(t => Math.max(t.share, t.feedbackShare)));
  // "Setup, application, or availability" reads as "Setup, application / availability" (no comma before the slash).
  const label = (t: TopicRow) => t.name.replace(/,? or /g, " / ");
  return <>
    <Text accessibilityRole="header" style={styles.section}>By what users are struggling with</Text>
    <Text style={styles.meta}>Real-user survey comments ({report.source.comments.toLocaleString("en-US")}) set against agent tokens on the same payment plan topics. {all ? `${sharePercent(report.irsAppTokens, all)} of tokens went to IRS app work; the rest was Servant and tooling.` : ""}</Text>
    <View style={styles.list}>
      {report.themes.map(t => <View key={t.id} accessible
        accessibilityLabel={`${label(t)}: ${formatTokens(t.tokens)} tokens, ${sharePercent(t.tokens, report.irsAppTokens)} of IRS app tokens, against ${sharePercent(t.comments, report.source.comments)} of survey comments, ${t.turns} replies`}
        style={styles.topic}>
        <View style={styles.rowHead}>
          <Text numberOfLines={1} style={styles.name}>{label(t)}</Text>
          <Text style={styles.value}>{formatTokens(t.tokens)}</Text>
        </View>
        <View style={styles.track}><View style={[styles.bar, { width: `${t.share ? Math.max(2, (t.share / max) * 100) : 0}%` }]} /></View>
        <View style={[styles.track, { marginTop: 3 }]}><View style={[styles.bar, styles.barUsers, { width: `${Math.max(2, (t.feedbackShare / max) * 100)}%` }]} /></View>
        <Text style={styles.meta}>Tokens {sharePercent(t.tokens, report.irsAppTokens)} · Users {sharePercent(t.comments, report.source.comments)} ({t.comments.toLocaleString("en-US")} comments, {t.bugSignals.toLocaleString("en-US")} bug reports){t.turns ? ` · ${t.turns} ${t.turns === 1 ? "reply" : "replies"}` : " · no agent work yet"}</Text>
      </View>)}
    </View>
    <Text style={styles.meta}>Blue is agent tokens, orange is survey comments, each as a share of its own total. Where users say a lot and tokens are low, that's where the agent has the most room to help.</Text>
  </>;
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
  totalValue: { ...typography.title, fontSize: 40, lineHeight: 46, color: colors.ink, marginTop: space.xs },
  totalDetail: { ...typography.caption, color: colors.muted },
  split: { flexDirection: "row", gap: space.md, marginTop: space.sm },
  splitText: { ...typography.captionStrong, color: colors.brandText },
  you: { ...typography.caption, color: colors.ink, marginBottom: space.sm },
  section: { ...typography.label, color: colors.muted, marginTop: space.sm, marginBottom: space.xs },
  empty: { ...typography.body, color: colors.muted, marginVertical: space.md },
  goal: { ...typography.label, color: colors.muted, marginTop: space.md },
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
  topic: { paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  barUsers: { backgroundColor: "#C2571A" },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.blue },
  meta: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  footnote: { ...typography.meta, color: colors.muted, marginTop: space.md },
}));
