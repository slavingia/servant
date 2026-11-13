import { Radio } from "../components/Radio";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { AppIcon } from "../components/AppIcon";
import { Button } from "../components/Button";
import { SavedTaskRow } from "../components/SavedTaskRow";
import { useFeatures } from "../lib/features";
import { useLive } from "../lib/live";
import { durationText } from "../lib/meetings";
import { applySavedCompletion, savedMessagePreview, savedMessagesFor, visibleSavedMessages } from "../lib/saved-messages";
import { buildWorkLogReport, filterWorkLog, savedWorkLabel, type SavedReportPeriod } from "../lib/saved-report";
import { visibleWorkLog, workLogActor, workLogChanged, workLogHref, workLogLabel, workLogPreview } from "../lib/work-log";
import { accountId, api, ServerError, type Account, type SavedCompletion, type SavedMessage, type WorkLogEntry } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

type Snapshot = { items: SavedMessage[]; history: SavedCompletion[]; workLog: WorkLogEntry[] };
type ListRow = { kind: "task"; item: SavedMessage } | { kind: "history"; item: WorkLogEntry };

export default function SavedMessagesScreen() {
  const { account } = useSession();
  return account ? <SavedTasks key={`${accountId(account)}:${account.token}:${account.serverKey}`} account={account} /> : null;
}

function SavedTasks({ account }: { account: Account }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const features = useFeatures();
  const { subscribe } = useLive();
  const [data, setData] = useState<Snapshot | null>(null);
  const [view, setView] = useState<"open" | "completed" | "history">("open");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; undo?: SavedMessage } | null>(null);
  const [periodName, setPeriodName] = useState<"today" | "week" | "all" | "custom">("week");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const [asOf, setAsOf] = useState(Date.now);
  const active = useRef(false);
  const changing = useRef(false);
  const copying = useRef(false);
  const loading = useRef(0);
  const requestVersion = useRef(0);
  const attempts = useRef(new Map<string, { note: string; requestId: string }>());
  const currentData = useRef(data);
  useLayoutEffect(() => { currentData.current = data; }, [data]);

  const load = useCallback(async (clear = false, quiet = false) => {
    const version = ++requestVersion.current;
    loading.current++;
    if (clear) setData(null);
    if (!quiet) { setRefreshing(true); setError(null); setCopyState("idle"); }
    try {
      const [result, workLog] = await Promise.all([api.savedMessages(account), api.workLog(account)]);
      if (active.current && version === requestVersion.current) {
        setData({ items: result.items, history: result.history ?? [], workLog: workLog.items });
        setAsOf(Date.now());
        setError(null);
      }
    } catch (e) {
      if (!active.current || version !== requestVersion.current) return;
      setError(e instanceof ServerError ? e.message : "Couldn't load your tasks and work log. Try again.");
      if (e instanceof ServerError && [401, 403, 404].includes(e.status)) setData(null);
    } finally {
      loading.current--;
      if (active.current && version === requestVersion.current) setRefreshing(false);
    }
  }, [account]);

  useFocusEffect(useCallback(() => {
    active.current = true;
    if (!changing.current) setBusy(null);
    void load(true);
    const unsubscribe = subscribe(event => {
      const snapshot = currentData.current;
      const records = snapshot ? [...snapshot.items, ...snapshot.history] : null;
      const relevant = workLogChanged(snapshot?.workLog ?? null, event)
        || (event.event === "message.updated" && (!records || records.some(item => item.messageId === event.data.id)))
        || (event.event === "conversation.updated" && (!records || records.some(item => item.conversation?.id === event.data.id)));
      if (relevant) {
        // Immediately conceal stale source content, but let an in-flight mutation finish
        // before starting the replacement read. Its completion path reloads both lists.
        if (changing.current) { requestVersion.current++; setData(null); }
        else void load(true);
      }
    });
    const poll = () => {
      if (AppState.currentState === "active" && !changing.current && !copying.current && !loading.current) void load(false, true);
    };
    const timer = setInterval(poll, 5000);
    const appState = AppState.addEventListener("change", state => { if (state === "active") poll(); });
    return () => { active.current = false; requestVersion.current++; clearInterval(timer); appState.remove(); unsubscribe(); };
  }, [load, subscribe]));

  const shown = useMemo(() => visibleSavedMessages(data?.items ?? [], features), [data, features]);
  const history = useMemo(() => (data?.history ?? []).map(item => ({ ...item, ...visibleSavedMessages([item], features)[0] })) as SavedCompletion[], [data, features]);
  const workLog = useMemo(() => visibleWorkLog(data?.workLog ?? [], features), [data, features]);
  const open = useMemo(() => savedMessagesFor(shown, "open"), [shown]);
  const completed = useMemo(() => savedMessagesFor(shown, "completed"), [shown]);
  const report = useMemo(() => {
    const period: SavedReportPeriod = periodName === "custom" ? { from, to } : periodName;
    try {
      return { ...buildWorkLogReport(workLog, { period, generatedAt: asOf, serverName: account.serverName, personName: account.user.name }),
        rows: filterWorkLog(workLog, period, { now: asOf }), error: null };
    } catch (e) {
      return { markdown: "", rows: [] as WorkLogEntry[], entryCount: 0, completionCount: 0, taskCount: 0, meetingCount: 0, attendedMeetingCount: 0, recordingCount: 0, agentCompletionCount: 0, periodLabel: "Custom dates", error: e instanceof Error ? e.message : "Enter dates as YYYY-MM-DD." };
    }
  }, [workLog, periodName, from, to, asOf, account.serverName, account.user.name]);
  const rows: ListRow[] = view === "history" ? report.rows.map(item => ({ kind: "history", item }))
    : (view === "open" ? open : completed).map(item => ({ kind: "task", item }));

  const change = async (item: SavedMessage, remove = false) => {
    if (changing.current) return;
    changing.current = true; requestVersion.current++;
    setBusy(item.messageId); setError(null); setNotice(null); setCopyState("idle");
    try {
      if (remove) {
        await api.removeSavedMessage(account, item.messageId);
        attempts.current.delete(item.messageId);
        if (active.current) {
          setData(old => old ? { ...old, items: old.items.filter(row => row.messageId !== item.messageId) } : null);
          setNotice({ text: "Removed from Saved. Your work log is kept." });
        }
      } else {
        const done = item.completedAt === null;
        let attempt;
        if (done) {
          const note = notes[item.messageId] ?? "";
          attempt = attempts.current.get(item.messageId);
          if (!attempt || attempt.note !== note) {
            attempt = { note, requestId: Crypto.randomUUID() };
            attempts.current.set(item.messageId, attempt);
          }
        }
        const result = await api.completeSavedMessage(account, item.messageId, done, attempt);
        attempts.current.delete(item.messageId);
        if (active.current) {
          const updated = result.item;
          if (updated) setData(old => old ? { ...old, items: applySavedCompletion(old.items, updated) } : null);
          setExpanded(null);
          if (updated && done && updated.completedAt !== null) {
            setNotes(old => { const next = { ...old }; delete next[item.messageId]; return next; });
            setNotice({ text: "Done. Your work is saved in the work log.", undo: updated });
            if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          } else setNotice({ text: updated && !done ? "Task reopened. Its earlier completion stays in your work log." : "This task changed on another device. Your list is refreshed." });
        }
      }
      if (active.current) await load();
    } catch (e) {
      // Show the newer completed task so the person can reopen it; keep their unsaved draft.
      if (active.current && e instanceof ServerError && e.code === "already_completed") await load();
      if (active.current) setError(e instanceof ServerError ? e.message : `Couldn't ${remove ? "remove" : "update"} this task. Your note is still here. Try again.`);
    } finally {
      changing.current = false;
      if (active.current) { setBusy(null); setRefreshing(false); }
    }
  };

  const copyReport = async () => {
    if (copying.current || !data || refreshing || error || report.error || !report.rows.length) return;
    const generatedAt = Date.now();
    const period: SavedReportPeriod = periodName === "custom" ? { from, to } : periodName;
    const freshReport = buildWorkLogReport(workLog, { period, generatedAt, serverName: account.serverName, personName: account.user.name });
    setAsOf(generatedAt);
    if (!freshReport.entryCount) { setCopyState("idle"); return; }
    copying.current = true; setCopyState("copying");
    try {
      // Invoke directly from the tap so WebKit keeps its user gesture. Expo's web
      // legacy fallback ignores execCommand's false return; use the browser's confirmed write.
      let copied: boolean;
      if (Platform.OS === "web") {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(freshReport.markdown);
        copied = true;
      } else copied = await Clipboard.setStringAsync(freshReport.markdown);
      if (active.current) setCopyState(copied ? "copied" : "failed");
    } catch { if (active.current) setCopyState("failed"); }
    finally { copying.current = false; }
  };

  return <View style={styles.screen}>
    <FlatList<ListRow> style={styles.list} contentContainerStyle={styles.content} data={rows}
      keyExtractor={row => row.kind === "history" ? `history:${row.item.id}` : row.item.messageId}
      refreshing={refreshing && data !== null} onRefresh={() => { if (!changing.current) void load(true); }} keyboardShouldPersistTaps="handled"
      ListHeaderComponent={<>
        {/* The header says where this is. The sections are the section tabs of Project and Files. */}
        <View style={styles.tabBar}><View accessibilityRole="tablist" style={styles.tabs}>{([["open", "In progress", open.length], ["completed", "Completed", completed.length], ["history", "Work log", workLog.length]] as const).map(([value, label, count]) =>
          <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: view === value }} aria-selected={view === value} onPress={() => { setView(value); setCopyState("idle"); }}
            style={[styles.tab, view === value && styles.tabOn]}><Text style={[styles.tabText, view === value && styles.tabTextOn]}>{label}{data ? ` · ${count}` : ""}</Text></Pressable>)}</View></View>
        {notice ? <View style={styles.notice}><AppIcon name="check" size={18} color={colors.greenDark} />
          <Text accessibilityLiveRegion="polite" style={styles.noticeText}>{notice.text}</Text>
          {notice.undo ? <Button label="Undo" kind="link" compact disabled={!!busy} onPress={() => void change(notice.undo!)} /> : null}
        </View> : null}
        {error ? <View style={styles.error}><Text accessibilityRole="alert" style={styles.errorText}>{error}</Text><Button label="Try again" kind="link" compact disabled={!!busy} onPress={() => void load(true)} /></View> : null}
        {view === "history" ? <View style={styles.reportTools}>
          <Text style={styles.caption}>Meetings you attended or recorded, completed to-dos, and saved tasks appear here automatically. Agent completions are labeled.</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="Period" style={styles.periods}>{([["today", "Today"], ["week", "Past 7 days"], ["all", "All time"], ["custom", "Custom"]] as const).map(([value, label]) =>
            <Radio key={value} accessibilityState={{ checked: periodName === value }} aria-checked={periodName === value} onPress={() => { setPeriodName(value); setAsOf(Date.now()); setCopyState("idle"); }}
              style={[styles.period, periodName === value && styles.selectedPeriod]}><Text style={[styles.periodText, periodName === value && styles.tabTextOn]}>{label}</Text></Radio>)}</View>
          {periodName === "custom" ? <View style={styles.dateRow}>
            <View style={styles.dateField}><Text style={styles.caption}>From</Text><TextInput accessibilityLabel="From date" placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} value={from} onChangeText={value => { setFrom(value); setCopyState("idle"); }} autoCapitalize="none" style={styles.dateInput} /></View>
            <View style={styles.dateField}><Text style={styles.caption}>To</Text><TextInput accessibilityLabel="To date" placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} value={to} onChangeText={value => { setTo(value); setCopyState("idle"); }} autoCapitalize="none" style={styles.dateInput} /></View>
          </View> : null}
          {report.error ? <Text accessibilityRole="alert" style={styles.errorText}>{report.error}</Text> : null}
          <View style={styles.reportSummary}><Text style={styles.caption}>{report.completionCount} {report.completionCount === 1 ? "completion" : "completions"} · {report.meetingCount} {report.meetingCount === 1 ? "meeting" : "meetings"}{report.agentCompletionCount ? ` · ${report.agentCompletionCount} by Agent` : ""}</Text>
            <Button label="Copy to clipboard" kind="secondary" compact busy={copyState === "copying"} disabled={!data || refreshing || !!error || !!report.error || !report.rows.length} onPress={() => void copyReport()} /></View>
          {copyState === "copied" ? <Text accessibilityLiveRegion="polite" style={styles.copied}>Report copied</Text> : null}
          {copyState === "failed" ? <><Text accessibilityRole="alert" style={styles.errorText}>Couldn't copy the report. Try Copy to clipboard again, or select the report below.</Text><Text testID="saved-report-fallback" selectable style={styles.reportFallback}>{report.markdown}</Text></> : null}
        </View> : null}
      </>}
      ListEmptyComponent={data === null ? refreshing ? <ActivityIndicator accessibilityLabel="Loading saved tasks" color={colors.blue} style={styles.loading} /> : undefined
        : <View style={styles.empty}><View style={styles.emptyIcon}><AppIcon name={view === "history" ? "clock" : "check"} size={28} color={colors.greenDark} /></View>
          <Text style={styles.emptyTitle}>{view === "history" ? "No work in this period" : view === "completed" ? "Nothing completed yet" : "Nothing to follow up"}</Text>
          <Text style={styles.emptyText}>{view === "history" ? "Attend a meeting or finish a task to start your work log, or choose another date range." : view === "completed" ? "Check off a task when you're done. Add a work note first if there's a result you want to remember." : "Open a message's actions and choose Save for later. On your phone, touch and hold the message."}</Text>
        </View>}
      renderItem={({ item: row }) => row.kind === "task" ? <SavedTaskRow item={row.item}
        completion={history.find(entry => entry.messageId === row.item.messageId && entry.completedAt === row.item.completedAt)}
        note={notes[row.item.messageId] ?? ""} expanded={expanded === row.item.messageId} disabled={!!busy} busy={busy === row.item.messageId}
        onExpand={() => setExpanded(old => old === row.item.messageId ? null : row.item.messageId)}
        onNote={text => setNotes(old => ({ ...old, [row.item.messageId]: text }))} onTick={() => void change(row.item)} onRemove={() => void change(row.item, true)} />
        : <WorkLogRow item={row.item} />}
    />
  </View>;
}

function WorkLogRow({ item }: { item: WorkLogEntry }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const href = workLogHref(item);
  const completion = item.kind === "saved" ? item.completion : null;
  const icon = item.kind === "meeting" ? "meetings" : item.kind === "todo" && item.completedBy.kind === "agent" ? "sparkles" : "check";
  return <View testID={completion ? `saved-completion-${completion.id}` : `work-log-${item.id}`} style={styles.logRow}>
    <View style={styles.logMark}><AppIcon name={icon} size={16} color={colors.greenDark} /></View>
    <View style={styles.logBody}>
      <Text style={styles.logTime}>{workLogLabel(item)} · {savedWorkLabel(item.at)}</Text>
      {completion ? <>
        {completion.note ? <Text selectable style={styles.workNote}>{completion.note}</Text> : <Text style={styles.caption}>No work note added.</Text>}
        <Text selectable numberOfLines={4} style={styles.sourceText}>{savedMessagePreview(completion)}</Text>
        {completion.conversation && href ? <Text style={styles.caption}>{completion.conversation.kind === "channel" ? "#" : ""}{completion.conversation.name} · Current source message</Text> : null}
        <Text style={styles.logMeta}>Saved {savedWorkLabel(completion.savedAt)}</Text>
        {completion.reopenedAt !== null ? <Text style={styles.reopened}>Reopened {savedWorkLabel(completion.reopenedAt)}</Text> : null}
      </> : <>
        <Text selectable style={styles.workNote}>{workLogPreview(item)}</Text>
        {item.kind === "meeting" ? <>
          {item.source?.summary ? <Text selectable numberOfLines={5} style={styles.sourceText}>{item.source.summary}</Text> : null}
          {item.timeBasis === "recording-upload" ? <Text style={styles.logMeta}>Added {savedWorkLabel(item.at)}{item.durationMs !== null ? ` · Recording: ${durationText(item.durationMs)}` : ""}</Text>
            : <>{item.startedAt !== null ? <Text style={styles.logMeta}>Meeting started {savedWorkLabel(item.startedAt)}</Text> : null}
              {item.endedAt !== null ? <Text style={styles.logMeta}>Meeting ended {savedWorkLabel(item.endedAt)}</Text> : null}</>}
        </> : item.kind === "todo" ? <>
          {item.completedBy.kind !== "agent" ? <Text style={styles.caption}>Completed by {workLogActor(item)}</Text> : null}
          {item.source ? <Text style={styles.caption}>{[item.source.projectName, item.source.releaseName, item.source.channelName && `#${item.source.channelName}`].filter(Boolean).join(" · ")}</Text> : null}
          <Text style={styles.logMeta}>Created {savedWorkLabel(item.createdAt)}</Text>
          {item.reopenedAt !== null ? <Text style={styles.reopened}>Reopened {savedWorkLabel(item.reopenedAt)}</Text> : null}
        </> : null}
      </>}
      {href ? <View style={styles.sourceLink}><Button label={item.kind === "saved" ? "Open message" : item.kind === "meeting" ? "Open meeting" : "Open to-do"} kind="link" compact onPress={() => router.push(href)} /></View> : null}
    </View>
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  list: { flex: 1, width: "100%", maxWidth: 840, alignSelf: "center" },
  content: { paddingBottom: space.xxl },
  caption: { ...typography.caption, color: colors.muted },
  tabBar: { paddingHorizontal: space.side, paddingTop: space.md },
  tabs: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.md, padding: 3, width: "100%", maxWidth: 400, alignSelf: "center" },
  tab: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, paddingHorizontal: space.xs },
  tabOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  tabText: { ...typography.captionStrong, color: colors.muted },
  tabTextOn: { color: colors.ink },
  notice: { margin: space.side, paddingLeft: space.sm, paddingRight: space.xxs, paddingVertical: space.xs, backgroundColor: colors.greenSoft, borderRadius: radius.md, flexDirection: "row", alignItems: "center", gap: space.xs },
  noticeText: { ...typography.caption, color: colors.greenDark, flex: 1 },
  error: { margin: space.side, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.redSoft, flexDirection: "row", alignItems: "center", gap: space.xs },
  errorText: { ...typography.caption, color: colors.red, flexShrink: 1 },
  reportTools: { marginHorizontal: space.side, paddingVertical: space.md, gap: space.sm },
  periods: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  period: { paddingHorizontal: space.sm, minHeight: 44, justifyContent: "center", borderRadius: radius.sm },
  selectedPeriod: { backgroundColor: colors.surface },
  periodText: { ...typography.captionStrong, color: colors.muted },
  dateRow: { flexDirection: "row", gap: space.sm },
  dateField: { flex: 1, gap: space.xxs },
  dateInput: controls.input,
  reportSummary: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: space.sm },
  copied: { ...typography.captionStrong, color: colors.greenDark },
  reportFallback: { ...typography.caption, color: colors.ink, padding: space.sm, backgroundColor: colors.surface },
  loading: { marginTop: space.xl },
  empty: { paddingHorizontal: space.lg, paddingVertical: space.xl, alignItems: "center", gap: space.sm },
  emptyIcon: { width: 52, height: 52, borderRadius: radius.pill, backgroundColor: colors.greenSoft, justifyContent: "center", alignItems: "center" },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyText: { ...typography.body, color: colors.muted, maxWidth: 380, textAlign: "center" },
  logRow: { flexDirection: "row", gap: space.sm, marginHorizontal: space.side, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: colors.line },
  logMark: { width: 28, height: 28, borderRadius: radius.pill, backgroundColor: colors.greenSoft, justifyContent: "center", alignItems: "center" },
  logBody: { flex: 1, minWidth: 0, gap: space.xs },
  logTime: { ...typography.captionStrong, color: colors.greenDark, marginTop: space.xxs },
  workNote: { ...typography.bodyStrong, color: colors.ink },
  sourceText: { ...typography.body, color: colors.muted },
  logMeta: { ...typography.meta, color: colors.muted },
  reopened: { ...typography.caption, color: colors.muted, fontStyle: "italic" },
  sourceLink: { alignItems: "flex-start", marginLeft: -space.md },
}));
