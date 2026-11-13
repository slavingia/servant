import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { TodoList } from "../../components/TodoList";
import { callsSupported } from "../../lib/meeting-call";
import { durationText, meetingBusy, peopleText } from "../../lib/meetings";
import { forgetMeeting, refreshMeetings } from "../../lib/meetings-store";
import { accountId, api, ServerError, type Meeting, type MeetingKind, type Recording, type TodoItem } from "../../lib/server";
import { useSession } from "../../lib/session";
import { deleteDescription } from "../../lib/records-notice";
import { landingHref, useFeatures } from "../../lib/features";
import { shortTime } from "../../lib/time-label";
import { radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../../lib/theme";

// One shape for both kinds, so the screen below doesn't care where the meeting came from.
type Step = { n: number; text: string; owner: string | null; status: "open" | "accepted" | "skipped"; by: string | null };
type Detail = {
  kind: MeetingKind; id: string; title: string; startedAt: number; durationMs: number | null; status: Meeting["status"] | "uploading";
  summary: string | null; notes: string[]; steps: Step[]; transcript: string; people: { id: string; name: string }[]; error: string | null; conversationId: string | null;
  todos?: TodoItem[];
};
const fromCall = (m: Meeting): Detail => ({
  kind: "call", id: m.id, title: m.title || "Call", startedAt: m.startedAt, durationMs: m.durationMs ?? (m.endedAt ? m.endedAt - m.startedAt : null), status: m.status,
  summary: m.summary ?? null, notes: m.notes ?? [], transcript: m.transcript || "", people: m.people ?? [], error: m.error, conversationId: m.conversationId,
  steps: m.steps.map(s => ({ n: s.n, text: s.text, owner: s.owner, status: s.status, by: s.actedBy?.name ?? null })),
});
const fromRecording = (r: Recording): Detail => ({
  kind: "recording", id: r.id, title: r.title || "Recorded meeting", startedAt: r.createdAt, durationMs: r.durationMs, status: r.status,
  summary: r.summary, notes: r.notes, transcript: r.transcript, people: [], error: r.error, conversationId: null,
  steps: r.steps.map(s => ({ n: s.n, text: s.text, owner: s.owner, status: s.status, by: null })),
  todos: r.todos,
});

/** One meeting: what it was about, the notes, the next steps (Do it hands one to the agent) and the transcript. */
export default function MeetingDetail() {
  const { account } = useSession();
  const { id, kind } = useLocalSearchParams<{ id: string; kind?: string }>();
  return account ? <MeetingDetailContent key={`${accountId(account)}:${account.token}:${id}:${kind ?? ""}`} /> : null;
}

function MeetingDetailContent() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const { id, kind: kindParam } = useLocalSearchParams<{ id: string; kind?: string }>();
  const kind: MeetingKind = kindParam === "recording" || (!kindParam && String(id).startsWith("rec_")) ? "recording" : "call";
  const [meeting, setMeeting] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const features = useFeatures();
  const version = useRef(0);
  const loading = useRef(false);
  const mutating = useRef(false);
  const focused = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fail = useCallback((e: unknown, fallback: string) => {
    setError(e instanceof ServerError ? e.message : fallback);
    if (e instanceof ServerError && [401, 403, 404].includes(e.status)) {
      setMeeting(null); setShowTranscript(false); setConfirming(false);
    }
  }, []);

  const load = useCallback(async () => {
    if (!account || !id || mutating.current) return;
    const request = ++version.current;
    loading.current = true;
    try {
      const next = kind === "recording" ? fromRecording(await api.recording(account, String(id))) : fromCall(await api.meeting(account, String(id)));
      if (request === version.current) { setMeeting(next); setError(null); }
    } catch (e) { if (request === version.current) fail(e, "Couldn't open this meeting"); }
    finally { if (request === version.current) loading.current = false; }
  }, [account, id, kind, fail]);
  // The notes may still be being written while this is open.
  const working = !!meeting && meetingBusy(meeting);
  const tracking = working || !!meeting?.todos?.some(todo => todo.withAgent);
  useFocusEffect(useCallback(() => {
    focused.current = true; void load();
    return () => { focused.current = false; version.current++; loading.current = false; };
  }, [load]));
  useEffect(() => {
    if (!tracking) return;
    const timer = setInterval(() => { if (focused.current && AppState.currentState === "active" && !loading.current && !mutating.current) void load(); }, 5000);
    return () => clearInterval(timer);
  }, [tracking, load]);
  const onBusyChange = useCallback((value: boolean) => {
    mutating.current = value;
    version.current++; loading.current = false;
    if (!value && focused.current) void load();
  }, [load]);

  if (!account) return null;
  if (!features.meetings) return <Redirect href={landingHref(features)} />;
  if (!meeting) {
    return <View style={styles.root}><Stack.Screen options={{ title: "Meeting" }} />
      {error ? <View style={styles.content}><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Button label="Try again" kind="secondary" onPress={() => void load()} /></View> : <ActivityIndicator style={{ marginTop: space.xxl }} color={colors.blue} />}
    </View>;
  }

  const act = async (n: number, action: "accept" | "skip") => {
    if (mutating.current) return;
    setBusy(`${n}:${action}`); setError(null); onBusyChange(true);
    try {
      const next = meeting.kind === "call" ? fromCall(await api.meetingStep(account, meeting.id, n, action))
        : fromRecording(await api.recordingStep(account, meeting.id, n, action === "accept" ? "send" : "skip"));
      if (!mounted.current) return;
      setMeeting(next);
      void refreshMeetings(account, setAccount);
    } catch (e) { if (mounted.current) fail(e, "Couldn't update that step"); }
    finally { if (mounted.current) { setBusy(null); onBusyChange(false); } }
  };
  const retry = async () => {
    if (mutating.current) return;
    setBusy("retry"); onBusyChange(true);
    try { const next = fromRecording(await api.retryRecording(account, meeting.id)); if (mounted.current) setMeeting(next); }
    catch (e) { if (mounted.current) fail(e, "Couldn't try again"); }
    finally { if (mounted.current) { setBusy(null); onBusyChange(false); } }
  };
  const remove = async () => {
    if (mutating.current) return;
    setBusy("delete"); onBusyChange(true);
    try {
      await api.deleteRecording(account, meeting.id);
      forgetMeeting(meeting.id, account);
      if (mounted.current) { if (router.canGoBack()) router.back(); else router.replace("/meetings"); }
    } catch (e) { if (mounted.current) { fail(e, "Couldn't delete this meeting"); setConfirming(false); } }
    finally { if (mounted.current) { setBusy(null); onBusyChange(false); } }
  };

  const live = meeting.status === "live";
  const who = peopleText(meeting.people, account.user.id);
  const meta = [shortTime(meeting.startedAt), durationText(meeting.durationMs), who].filter(Boolean).join(" · ");
  const ready = meeting.status === "done";
  return <ScrollView style={styles.root} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.blue} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
    <Stack.Screen options={{ title: meeting.title }} />
    <Text accessibilityRole="header" style={styles.title}>{meeting.title}</Text>
    <Text style={styles.meta}>{meta}</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

    {live ? <View style={styles.card}>
      <Text style={styles.body}>In progress</Text>
      {callsSupported() ? <Button label="Join" onPress={() => router.push({ pathname: "/meeting/[id]", params: { id: meeting.id } })} /> : null}
    </View> : working ? <View style={styles.card}>
      <ActivityIndicator color={colors.blue} />
      <Text accessibilityLiveRegion="polite" style={styles.body}>{meeting.status === "uploading" ? "Sending recording…" : "Writing notes…"}</Text>
    </View> : meeting.status === "failed" ? <View style={styles.card}>
      <Text accessibilityRole="alert" style={styles.body}>{meeting.error || "The notes couldn't be written."}</Text>
      {meeting.kind === "recording" ? <Button label="Try again" disabled={!!busy} onPress={() => void retry()} /> : null}
    </View> : null}

    {ready ? <>
      {meeting.summary ? <Text style={styles.summary}>{meeting.summary}</Text> : null}
      {meeting.notes.length ? <>
        <Text accessibilityRole="header" style={styles.section}>Notes</Text>
        {meeting.notes.map((n, i) => <View key={i} style={styles.bullet}><Text style={styles.bulletDot}>•</Text><Text style={styles.body}>{n}</Text></View>)}
      </> : null}
      {!meeting.summary && !meeting.notes.length && meeting.kind === "call" ? <Text style={styles.hint}>Notes are in the conversation.</Text> : null}
      {meeting.todos ? <>
        <Text accessibilityRole="header" style={styles.section}>To-dos</Text>
        <TodoList account={account} todos={meeting.todos} allowAdd={false} onReload={() => void load()} onBusyChange={onBusyChange}
          onChange={change => setMeeting(current => current ? { ...current, todos: change(current.todos ?? []) } : current)} />
      </> : meeting.steps.length ? <>
      <Text accessibilityRole="header" style={styles.section}>Next steps</Text>
      {meeting.steps.map(step => <View key={step.n} style={styles.step}>
        <Text style={[styles.body, step.status === "skipped" && styles.skipped]}>{step.text}</Text>
        {step.owner ? <Text style={styles.hint}>Owner: {step.owner}</Text> : null}
        {step.status === "open" ? <View style={styles.actions}>
          <Button label="Skip" kind="secondary" compact disabled={!!busy} onPress={() => void act(step.n, "skip")} />
          <Button label="Do it" compact busy={busy === `${step.n}:accept`} disabled={!!busy} onPress={() => void act(step.n, "accept")} />
        </View> : <Text style={styles.hint}>{step.status === "accepted" ? `Started${step.by ? ` by ${step.by}` : ""}` : "Skipped"}</Text>}
      </View>)}
      </> : null}
      {meeting.transcript ? <>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTranscript }} aria-expanded={showTranscript} onPress={() => setShowTranscript(s => !s)} style={styles.toggle}><Text style={styles.link}>{showTranscript ? "Hide transcript" : "Show transcript"}</Text></Pressable>
        {showTranscript ? <Text selectable style={styles.transcript}>{meeting.transcript}</Text> : null}
      </> : null}
    </> : null}

    {meeting.conversationId ? <Button label="Open the conversation" kind="link" onPress={() => router.push({ pathname: "/c/[id]", params: { id: meeting.conversationId! } })} style={styles.footerAction} /> : null}
    {meeting.kind === "recording" && !working ? <>
      <Button label="Delete this meeting" kind="danger" disabled={!!busy} onPress={() => setConfirming(true)} style={styles.footerAction} />
      <ConfirmDialog visible={confirming} title="Delete this meeting?" description={deleteDescription("meeting", account?.recordsKept === true)} confirmLabel="Delete" onConfirm={() => void remove()} onCancel={() => setConfirming(false)} />
    </> : null}
  </ScrollView>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, paddingBottom: space.xxl, maxWidth: 720, width: "100%", alignSelf: "center" },
  title: { ...typography.title, color: colors.ink },
  meta: { ...typography.caption, color: colors.muted, marginTop: space.xxs, marginBottom: space.sm },
  summary: { ...typography.body, color: colors.ink, marginVertical: space.sm },
  section: { ...typography.label, color: colors.muted, marginTop: space.lg, marginBottom: space.xs },
  card: { padding: space.md, gap: space.sm, borderRadius: radius.lg, backgroundColor: colors.surface, alignItems: "flex-start" },
  body: { ...typography.body, color: colors.ink, flexShrink: 1 },
  hint: { ...typography.caption, color: colors.muted },
  bullet: { flexDirection: "row", gap: space.xs, paddingVertical: 2 },
  bulletDot: { ...typography.body, color: colors.muted },
  step: { gap: space.xxs, paddingVertical: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  skipped: { color: colors.muted, textDecorationLine: "line-through" },
  actions: { flexDirection: "row", gap: space.xs },
  toggle: { minHeight: 44, justifyContent: "center", marginTop: space.md },
  link: { ...typography.label, color: colors.blue, ...linkUnderline },
  transcript: { ...typography.caption, color: colors.ink, lineHeight: 20 },
  footerAction: { marginTop: space.lg, alignSelf: "flex-start" },
  error: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, padding: space.sm, borderRadius: radius.sm, marginVertical: space.xs },
}));
