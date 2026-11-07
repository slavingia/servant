import { useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Switch, Text, View } from "react-native";
import { uploadRecording, RecordingError } from "../lib/recordings";
import { useRecordingEngine, type RecordingResult } from "../lib/recording-engine";
import { clockText } from "../lib/meetings";
import { uploadPost, type Account } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { Button } from "./Button";

type Phase = "ready" | "starting" | "recording" | "uploading" | "failed";

/**
 * Record a meeting that happens off the app: in the room, or on Zoom, Meet or Teams on this computer.
 * Tap Start, talk, tap Stop. The audio goes up in chunks and the notes are written on the server.
 * A recording is never lost: if the upload fails it stays on this device until Try again works.
 */
export function MeetingRecorder({ account, onMove, onSaved, onClose }: { account: Account; onMove?: (a: Account) => void; onSaved: () => void; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const engine = useRecordingEngine();
  const [phase, setPhase] = useState<Phase>("ready");
  const [systemAudio, setSystemAudio] = useState(engine.systemAudioOffered);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  // Kept across a failed upload so Try again carries on from where the server is.
  const pending = useRef<{ result: RecordingResult; id?: string } | null>(null);
  const working = useRef(false);

  const start = async () => {
    if (working.current) return;
    working.current = true; setError(null); setNote(null); setPhase("starting");
    try {
      const got = await engine.start({ systemAudio });
      setNote(got.note ?? (got.systemAudio ? "Recording the microphone and this computer's meeting audio" : engine.systemAudioOffered ? "Recording the microphone only" : null));
      setPhase("recording");
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't start recording"); setPhase("ready"); }
    finally { working.current = false; }
  };

  const send = async () => {
    const p = pending.current;
    if (!p) return;
    setPhase("uploading"); setProgress(0); setError(null);
    try {
      await uploadRecording({ ...p.result, resume: p.id, post: uploadPost(account, onMove), onProgress: setProgress });
      p.result.discard();
      pending.current = null;
      setPhase("ready");
      onSaved();
      onClose();
    } catch (e) {
      if (e instanceof RecordingError && e.recordingId) p.id = e.recordingId;
      setError(e instanceof Error ? e.message : "Couldn't send the recording");
      setPhase("failed");
    }
  };

  const stop = async () => {
    if (working.current) return;
    working.current = true;
    try {
      const result = await engine.stop();
      pending.current = { result };
      await send();
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save the recording. Try again"); setPhase("ready"); }
    finally { working.current = false; }
  };

  const discard = () => { pending.current?.result.discard(); pending.current = null; setError(null); setPhase("ready"); onClose(); };

  if (!engine.supported) {
    return <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>Record a meeting</Text>
      <Text style={styles.hint}>{Platform.OS === "web" ? "This browser can't record audio. Use a current Chrome, Edge or Safari, or the Servant app on your phone." : "This device can't record audio."}</Text>
      <Button label="Close" kind="secondary" onPress={onClose} />
    </View>;
  }

  if (phase === "recording") {
    return <View style={styles.card} testID="meeting-recorder">
      <View style={styles.liveRow}>
        <View style={styles.dot} />
        <Text accessibilityLiveRegion="polite" accessibilityLabel={`Recording, ${clockText(engine.elapsedMs)}`} style={styles.timer}>{clockText(engine.elapsedMs)}</Text>
        <Text style={styles.liveLabel}>Recording</Text>
      </View>
      {note ? <Text style={styles.hint}>{note}</Text> : null}
      <Text style={styles.hint}>{Platform.OS === "web" ? "Keep this window open until you stop." : "Put the phone where it can hear everyone."}</Text>
      <Button label="Stop and make notes" kind="danger" onPress={() => void stop()} />
    </View>;
  }

  if (phase === "uploading") {
    return <View style={styles.card} testID="meeting-recorder">
      <View style={styles.liveRow}><ActivityIndicator color={colors.blue} /><Text accessibilityLiveRegion="polite" style={styles.body}>Sending the recording… {Math.round(progress * 100)}%</Text></View>
      <Text style={styles.hint}>Keep the app open until it's sent.</Text>
    </View>;
  }

  if (phase === "failed") {
    return <View style={styles.card} testID="meeting-recorder">
      <Text accessibilityRole="header" style={styles.title}>The recording is safe on this device</Text>
      <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
      <View style={styles.actions}>
        <Button label="Try again" onPress={() => void send()} style={styles.grow} />
        <Button label="Delete recording" kind="danger" onPress={discard} />
      </View>
    </View>;
  }

  return <View style={styles.card} testID="meeting-recorder">
    <Text accessibilityRole="header" style={styles.title}>Record a meeting</Text>
    <Text style={styles.hint}>For a meeting in the room{engine.systemAudioOffered ? " or on Zoom, Meet or Teams on this computer" : ""}. You get notes and next steps when it ends.</Text>
    {engine.systemAudioOffered ? <View style={styles.option}>
      <View style={styles.grow}>
        <Text style={styles.body}>Include meeting audio from this computer</Text>
        <Text style={styles.hint}>{Platform.OS === "web" ? "You'll be asked what to share. Pick the meeting's tab or window and tick \"Share audio\". If it isn't offered, the microphone alone is recorded." : ""}</Text>
      </View>
      <Switch accessibilityLabel="Include meeting audio from this computer" value={systemAudio} onValueChange={setSystemAudio} trackColor={{ true: colors.primary, false: colors.borderStrong }} thumbColor="#FFFFFF" {...(Platform.OS === "web" ? { activeThumbColor: "#FFFFFF" } : {})} />
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <Text style={styles.consent}>Tell everyone you're recording.</Text>
    <View style={styles.actions}>
      <Button label="Start recording" busy={phase === "starting"} onPress={() => void start()} style={styles.grow} />
      <Button label="Cancel" kind="secondary" disabled={phase === "starting"} onPress={onClose} />
    </View>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  card: { padding: space.md, gap: space.sm, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  title: { ...typography.heading, color: colors.ink },
  body: { ...typography.body, color: colors.ink },
  hint: { ...typography.caption, color: colors.muted },
  consent: { ...typography.bodyStrong, color: colors.ink },
  option: { flexDirection: "row", alignItems: "center", gap: space.md },
  grow: { flex: 1, minWidth: 0 },
  actions: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  liveRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.red },
  timer: { ...typography.heading, color: colors.ink, fontVariant: ["tabular-nums"] },
  liveLabel: { ...typography.label, color: colors.red },
  error: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, padding: space.sm, borderRadius: radius.sm },
}));
