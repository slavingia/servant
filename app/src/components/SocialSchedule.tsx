import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Button, ButtonGroup } from "./Button";
import type { Account } from "../lib/server";
import { cellLabel, monthGrid, monthTitle, replyBadge, replyLine, replyTarget, replyTime, scheduleDays, socialDayLabel, stepMonth, type CalendarCell, type SocialReply } from "../lib/social";
import { socialApi } from "../lib/social-api";
import { localFormat } from "../lib/local-format";
import { createThemedStyles, radius, space, typography } from "../lib/theme";

const said = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** List or Calendar: two tabs that sit at the top right of a wide window, and above the schedule on a phone. */
export function ScheduleViewToggle({ view, onChange }: { view: "list" | "calendar"; onChange: (view: "list" | "calendar") => void }) {
  const styles = useStyles();
  return <View accessibilityRole="tablist" accessibilityLabel="Show the schedule as" style={styles.toggle}>
    {(["list", "calendar"] as const).map(value => <Pressable key={value} testID={`social-view-${value}`} accessibilityRole="tab" accessibilityLabel={value === "list" ? "List" : "Calendar"} accessibilityState={{ selected: view === value }} aria-selected={view === value}
      onPress={() => onChange(value)} style={[styles.toggleTab, view === value && styles.toggleOn]}>
      <Text style={[styles.toggleText, view === value && styles.toggleTextOn]}>{value === "list" ? "List" : "Calendar"}</Text>
    </Pressable>)}
  </View>;
}

// One approved reply: when it goes out, what it says, what it answers, and the one thing that can still be done
// with it. Cancelling sends it back to the posts to answer, as a draft; a reply that was not posted can be sent again.
function Entry({ account, reply, canApprove, onChanged }: { account: Account; reply: SocialReply; canApprove: boolean; onChanged: () => void }) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (work: () => Promise<unknown>, failed: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await work(); onChanged(); } catch (reason) { setError(said(reason, failed)); } finally { setBusy(false); }
  };
  const target = replyTarget(reply);
  return <View testID={`social-entry-${reply.id}`} style={styles.entry}>
    <Text style={styles.time}>{localFormat("time", new Date(replyTime(reply)))}</Text>
    <View style={styles.entryCopy}>
      <Text style={styles.target}>{target}<Text style={[styles.badge, reply.status === "failed" && styles.failed]}>{`  ${replyBadge(reply)}`}</Text></Text>
      {reply.post ? <Text style={styles.quote}>{reply.post.text}</Text> : null}
      <Text selectable style={styles.words}>{reply.text}</Text>
      <Text style={[styles.meta, reply.status === "failed" && styles.failed]}>{replyLine(reply)}</Text>
      {reply.lesson ? <Text testID={`social-lesson-${reply.id}`} style={styles.meta}>{`The guide learned from the edit: ${reply.lesson}`}</Text> : null}
      <ButtonGroup>
        {reply.status === "scheduled" && canApprove ? <Button testID={`social-cancel-${reply.id}`} label="Cancel" accessibilityLabel={`Cancel: ${target}`} kind="secondary" compact busy={busy} onPress={() => void act(() => socialApi.cancel(account, reply.id), "Couldn't cancel this. Try again.")} /> : null}
        {reply.status === "failed" && canApprove ? <Button testID={`social-retry-${reply.id}`} label="Post again" accessibilityLabel={`Post again: ${target}`} kind="secondary" compact busy={busy} onPress={() => void act(() => socialApi.approve(account, reply.id), "Couldn't send this again. Try again.")} /> : null}
        {reply.url ? <Button label="Open on X" accessibilityLabel={`Open on X: ${target}`} kind="link" compact icon="external" onPress={() => void Linking.openURL(reply.url!)} /> : null}
      </ButtonGroup>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  </View>;
}

/** The schedule as a list: a heading for each day, then that day's replies in time order. */
export function ScheduleList({ account, replies, canApprove, onChanged }: { account: Account; replies: readonly SocialReply[]; canApprove: boolean; onChanged: () => void }) {
  const styles = useStyles();
  const days = scheduleDays(replies);
  if (!days.length) return <Text testID="social-schedule-empty" style={styles.empty}>Nothing is scheduled. Replies appear here once they are approved.</Text>;
  return <View testID="social-schedule-list">
    {days.map(day => <View key={day.key} style={styles.day}>
      <Text accessibilityRole="header" style={styles.dayTitle}>{`${day.label} · ${day.replies.length} ${day.replies.length === 1 ? "reply" : "replies"}`}</Text>
      {day.replies.map(reply => <Entry key={reply.id} account={account} reply={reply} canApprove={canApprove} onChanged={onChanged} />)}
    </View>)}
  </View>;
}

/**
 * The schedule as a month: each day says how many replies go out, with the first few times on a wide window.
 * Choosing a day lists what is on it underneath.
 */
export function ScheduleCalendar({ account, replies, year, month, wide, canApprove, onMonth, onChanged }: {
  account: Account; replies: readonly SocialReply[]; year: number; month: number; wide: boolean; canApprove: boolean;
  onMonth: (to: { year: number; month: number }) => void; onChanged: () => void;
}) {
  const styles = useStyles();
  const grid = monthGrid(year, month, replies);
  const cells = grid.flat();
  const [picked, setPicked] = useState<string | null>(null);
  // The day whose replies are listed: the one chosen, else today when it is on this page, else the first with any.
  const chosen = cells.find(cell => cell.key === picked) ?? cells.find(cell => cell.today) ?? cells.find(cell => cell.replies.length > 0) ?? null;
  const now = new Date();
  return <View testID="social-calendar">
    <View style={styles.monthBar}>
      <Text accessibilityRole="header" testID="social-month" style={styles.monthTitle}>{monthTitle(year, month)}</Text>
      <ButtonGroup>
        <Button testID="social-month-prev" label="Earlier" accessibilityLabel="Earlier month" kind="secondary" compact onPress={() => { setPicked(null); onMonth(stepMonth(year, month, -1)); }} />
        <Button label="Today" kind="secondary" compact disabled={year === now.getFullYear() && month === now.getMonth()} onPress={() => { setPicked(null); onMonth({ year: now.getFullYear(), month: now.getMonth() }); }} />
        <Button testID="social-month-next" label="Later" accessibilityLabel="Later month" kind="secondary" compact onPress={() => { setPicked(null); onMonth(stepMonth(year, month, 1)); }} />
      </ButtonGroup>
    </View>
    <View style={styles.week}>{WEEKDAYS.map(name => <Text key={name} style={styles.weekday}>{wide ? name : name.slice(0, 1)}</Text>)}</View>
    {grid.map(week => <View key={week[0]!.key} style={styles.week}>
      {week.map(cell => <Day key={cell.key} cell={cell} wide={wide} chosen={chosen?.key === cell.key} onPress={() => setPicked(cell.key)} />)}
    </View>)}
    {chosen ? <View style={styles.day}>
      <Text accessibilityRole="header" testID="social-day-title" style={styles.dayTitle}>{`${socialDayLabel(chosen.at)} · ${chosen.replies.length ? `${chosen.replies.length} ${chosen.replies.length === 1 ? "reply" : "replies"}` : "nothing scheduled"}`}</Text>
      {chosen.replies.map(reply => <Entry key={reply.id} account={account} reply={reply} canApprove={canApprove} onChanged={onChanged} />)}
    </View> : null}
  </View>;
}

function Day({ cell, wide, chosen, onPress }: { cell: CalendarCell; wide: boolean; chosen: boolean; onPress: () => void }) {
  const styles = useStyles();
  const shown = wide ? cell.replies.slice(0, 2) : [];
  return <Pressable testID={`social-day-${cell.key}`} accessibilityRole="button" accessibilityLabel={cellLabel(cell)} accessibilityState={{ selected: chosen }} aria-pressed={chosen} onPress={onPress}
    style={({ pressed }) => [styles.cell, wide && styles.cellWide, !cell.inMonth && styles.cellOut, chosen && styles.cellChosen, pressed && styles.pressed]}>
    <Text style={[styles.cellDay, cell.today && styles.cellToday, !cell.inMonth && styles.cellDayOut]}>{cell.day}</Text>
    {cell.replies.length ? <Text style={styles.cellCount}>{wide ? `${cell.replies.length} ${cell.replies.length === 1 ? "reply" : "replies"}` : cell.replies.length}</Text> : null}
    {shown.map(reply => <Text key={reply.id} style={[styles.cellLine, reply.status === "failed" && styles.failed]}>{`${localFormat("time", new Date(replyTime(reply)))} ${reply.post ? `@${reply.post.author.handle || reply.post.author.name}` : "Post"}`}</Text>)}
    {wide && cell.replies.length > shown.length ? <Text style={styles.cellLine}>{`and ${cell.replies.length - shown.length} more`}</Text> : null}
  </Pressable>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  toggle: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.pill, padding: space.xxs },
  toggleTab: { minHeight: 44, minWidth: 88, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, paddingHorizontal: space.sm },
  toggleOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  toggleText: { ...typography.captionStrong, color: colors.muted },
  toggleTextOn: { color: colors.ink },
  empty: { ...typography.body, color: colors.muted, paddingVertical: space.lg },
  day: { marginTop: space.md },
  dayTitle: { ...typography.label, color: colors.muted, paddingBottom: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  entry: { flexDirection: "row", gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  time: { ...typography.captionStrong, color: colors.ink, width: 72 },
  entryCopy: { flex: 1, minWidth: 0, gap: space.xxs },
  target: { ...typography.bodyStrong, color: colors.ink },
  badge: { ...typography.caption, color: colors.muted },
  quote: { ...typography.caption, color: colors.muted, paddingLeft: space.xs, borderLeftWidth: 2, borderLeftColor: colors.line },
  words: { ...typography.body, color: colors.ink },
  meta: { ...typography.caption, color: colors.muted },
  failed: { color: colors.red },
  error: { ...typography.caption, color: colors.red },
  monthBar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.xs, paddingBottom: space.xs },
  monthTitle: { ...typography.heading, color: colors.ink },
  week: { flexDirection: "row" },
  weekday: { ...typography.meta, color: colors.muted, flex: 1, textAlign: "center", paddingVertical: space.xxs },
  cell: { flex: 1, minWidth: 0, minHeight: 56, padding: space.xxs, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, alignItems: "center", gap: space.xxs },
  cellWide: { minHeight: 104, alignItems: "stretch" },
  cellOut: { backgroundColor: colors.surface },
  cellChosen: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
  pressed: { opacity: 0.6 },
  cellDay: { ...typography.captionStrong, color: colors.ink },
  cellDayOut: { color: colors.muted },
  cellToday: { color: colors.blueDark, textDecorationLine: "underline" },
  cellCount: { ...typography.captionStrong, color: colors.ink },
  cellLine: { ...typography.meta, color: colors.muted },
}));
