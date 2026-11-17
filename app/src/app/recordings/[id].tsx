import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BallRefreshControl } from "../../components/BallRefreshControl";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { TodoList } from "../../components/TodoList";
import { durationText, recordingBusy } from "../../lib/recording-labels";
import { forgetRecording, refreshRecordings } from "../../lib/recordings-store";
import { accountId, api, ServerError, type Recording } from "../../lib/server";
import { useSession } from "../../lib/session";
import { deleteDescription } from "../../lib/records-notice";
import { shortTime } from "../../lib/time-label";
import { radius, space, typography, createThemedStyles, linkUnderline } from "../../lib/theme";
import { ServeLoader } from "../../components/ServeLoader";

/** One voice memo: what it was about, the notes, to-dos and the transcript. */
export default function RecordingDetail() {
  const { account } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  return account ? <RecordingDetailContent key={`${accountId(account)}:${account.token}:${id}`} /> : null;
}

function RecordingDetailContent() {
  const styles = useStyles();
  const { account, setAccount } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const version = useRef(0);
  const loading = useRef(false);
  const mutating = useRef(false);
  const focused = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fail = useCallback((e: unknown, fallback: string) => {
    setError(e instanceof ServerError ? e.message : fallback);
    if (e instanceof ServerError && [401, 403, 404].includes(e.status)) {
      setRecording(null); setShowTranscript(false); setConfirming(false);
    }
  }, []);

  const load = useCallback(async () => {
    if (!account || !id || mutating.current) return;
    const request = ++version.current;
    loading.current = true;
    try {
      const next = await api.recording(account, String(id));
      if (request === version.current) { setRecording(next); setError(null); }
    } catch (e) { if (request === version.current) fail(e, "Couldn't open this recording"); }
    finally { if (request === version.current) loading.current = false; }
  }, [account, id, fail]);
  // The notes may still be being written while this is open.
  const working = !!recording && recordingBusy(recording);
  const tracking = working || !!recording?.todos?.some(todo => todo.withAgent);
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
  if (!recording) {
    return <View style={styles.root}><Stack.Screen options={{ title: "Recording" }} />
      {error ? <View style={styles.content}><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Button label="Try again" kind="secondary" onPress={() => void load()} /></View> : <ServeLoader style={{ marginTop: space.xxl }} />}
    </View>;
  }

  const act = async (n: number, action: "accept" | "skip") => {
    if (mutating.current) return;
    setBusy(`${n}:${action}`); setError(null); onBusyChange(true);
    try {
      const next = await api.recordingStep(account, recording.id, n, action === "accept" ? "send" : "skip");
      if (!mounted.current) return;
      setRecording(next);
      void refreshRecordings(account, setAccount);
    } catch (e) { if (mounted.current) fail(e, "Couldn't update that step"); }
    finally { if (mounted.current) { setBusy(null); onBusyChange(false); } }
  };
  const retry = async () => {
    if (mutating.current) return;
    setBusy("retry"); onBusyChange(true);
    try { const next = await api.retryRecording(account, recording.id); if (mounted.current) setRecording(next); }
    catch (e) { if (mounted.current) fail(e, "Couldn't try again"); }
    finally { if (mounted.current) { setBusy(null); onBusyChange(false); } }
  };
  const remove = async () => {
    if (mutating.current) return;
    setBusy("delete"); onBusyChange(true);
    try {
      await api.deleteRecording(account, recording.id);
      forgetRecording(recording.id, account);
      if (mounted.current) { if (router.canGoBack()) router.back(); else router.replace("/recordings"); }
    } catch (e) { if (mounted.current) { fail(e, "Couldn't delete this recording"); setConfirming(false); } }
    finally { if (mounted.current) { setBusy(null); onBusyChange(false); } }
  };

  const title = recording.title && recording.title !== "Meeting" ? recording.title : "Voice memo";
  const meta = [shortTime(recording.createdAt), durationText(recording.durationMs)].filter(Boolean).join(" · ");
  const ready = recording.status === "done";
  return <ScrollView style={styles.root} contentContainerStyle={styles.content} refreshControl={<BallRefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
    <Stack.Screen options={{ title }} />
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    <Text style={styles.meta}>{meta}</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

    {working ? <View style={styles.card}>
      <ServeLoader />
      <Text accessibilityLiveRegion="polite" style={styles.body}>{recording.status === "uploading" ? "Sending recording…" : "Writing notes…"}</Text>
    </View> : recording.status === "failed" ? <View style={styles.card}>
      <Text accessibilityRole="alert" style={styles.body}>{recording.error || "The notes couldn't be written."}</Text>
      <Button label="Try again" disabled={!!busy} onPress={() => void retry()} />
    </View> : null}

    {ready ? <>
      {recording.summary ? <Text style={styles.summary}>{recording.summary}</Text> : null}
      {recording.notes.length ? <>
        <Text accessibilityRole="header" style={styles.section}>Notes</Text>
        {recording.notes.map((n, i) => <View key={i} style={styles.bullet}><Text style={styles.bulletDot}>•</Text><Text style={styles.body}>{n}</Text></View>)}
      </> : null}
      {recording.todos ? <>
        <Text accessibilityRole="header" style={styles.section}>To-dos</Text>
        <TodoList account={account} todos={recording.todos} allowAdd={false} onReload={() => void load()} onBusyChange={onBusyChange}
          onChange={change => setRecording(current => current ? { ...current, todos: change(current.todos ?? []) } : current)} />
      </> : recording.steps.length ? <>
      <Text accessibilityRole="header" style={styles.section}>Next steps</Text>
      {recording.steps.map(step => <View key={step.n} style={styles.step}>
        <Text style={[styles.body, step.status === "skipped" && styles.skipped]}>{step.text}</Text>
        {step.owner ? <Text style={styles.hint}>Owner: {step.owner}</Text> : null}
        {step.status === "open" ? <View style={styles.actions}>
          <Button label="Skip" kind="secondary" compact disabled={!!busy} onPress={() => void act(step.n, "skip")} />
          <Button label="Do it" compact busy={busy === `${step.n}:accept`} disabled={!!busy} onPress={() => void act(step.n, "accept")} />
        </View> : <Text style={styles.hint}>{step.status === "accepted" ? "Started" : "Skipped"}</Text>}
      </View>)}
      </> : null}
      {recording.transcript ? <>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTranscript }} aria-expanded={showTranscript} onPress={() => setShowTranscript(s => !s)} style={styles.toggle}><Text style={styles.link}>{showTranscript ? "Hide transcript" : "Show transcript"}</Text></Pressable>
        {showTranscript ? <Text selectable style={styles.transcript}>{recording.transcript}</Text> : null}
      </> : null}
    </> : null}

    {!working ? <>
      <Button label="Delete this recording" kind="danger" disabled={!!busy} onPress={() => setConfirming(true)} style={styles.footerAction} />
      <ConfirmDialog visible={confirming} title="Delete this recording?" description={deleteDescription("recording", account?.recordsKept === true)} confirmLabel="Delete" onConfirm={() => void remove()} onCancel={() => setConfirming(false)} />
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
