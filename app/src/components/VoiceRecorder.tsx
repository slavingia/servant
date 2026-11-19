import { useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { uploadRecording, RecordingError } from "../lib/recordings";
import { useRecordingEngine, type RecordingResult } from "../lib/recording-engine";
import { clockText } from "../lib/recording-labels";
import { uploadPost, type Account } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { Button } from "./Button";
import { Toggle } from "./Toggle";

type Phase = "ready" | "starting" | "recording" | "uploading" | "failed";

/**
 * Record a voice memo, a conversation in the room, or audio from this computer.
 * Tap Start, talk, tap Stop. The audio goes up in chunks and the notes are written on the server.
 * A recording is never lost: if the upload fails it stays on this device until Try again works.
 */
export function VoiceRecorder({ account, onMove, onSaved, onClose }: { account: Account; onMove?: (a: Account) => void; onSaved: () => void; onClose: () => void }) {
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
      setNote(got.note ?? (got.systemAudio ? "Recording the microphone and this computer's audio" : engine.systemAudioOffered ? "Recording the microphone only" : null));
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
      <Text accessibilityRole="header" style={styles.title}>Take notes</Text>
      <Text style={styles.hint}>{Platform.OS === "web" ? "Recording unavailable. Use Chrome, Edge, Safari or the mobile app." : "Recording unavailable on this device."}</Text>
      <Button label="Close" kind="secondary" onPress={onClose} />
    </View>;
  }

  if (phase === "recording") {
    return <View style={styles.card} testID="voice-recorder">
      <View style={styles.liveRow}>
        <View style={styles.dot} />
        <Text accessibilityLiveRegion="polite" accessibilityLabel={`Recording, ${clockText(engine.elapsedMs)}`} style={styles.timer}>{clockText(engine.elapsedMs)}</Text>
        <Text style={styles.liveLabel}>Recording</Text>
      </View>
      {note ? <Text style={styles.hint}>{note}</Text> : null}
      {Platform.OS === "web" ? <Text style={styles.hint}>Keep this window open while recording.</Text> : null}
      <Button label="Stop and make notes" kind="danger" onPress={() => void stop()} />
    </View>;
  }

  if (phase === "uploading") {
    return <View style={styles.card} testID="voice-recorder">
      <View style={styles.liveRow}><ActivityIndicator color={colors.blue} /><Text accessibilityLiveRegion="polite" style={styles.body}>Sending the recording… {Math.round(progress * 100)}%</Text></View>
      <Text style={styles.hint}>Keep the app open until it's sent.</Text>
    </View>;
  }

  if (phase === "failed") {
    return <View style={styles.card} testID="voice-recorder">
      <Text accessibilityRole="header" style={styles.title}>Recording saved on this device</Text>
      <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
      <View style={styles.actions}>
        <Button label="Try again" onPress={() => void send()} style={styles.grow} />
        <Button label="Delete recording" kind="danger" onPress={discard} />
      </View>
    </View>;
  }

  return <View style={styles.card} testID="voice-recorder">
    <Text accessibilityRole="header" style={styles.title}>Take notes</Text>
    {engine.systemAudioOffered ? <View style={styles.option}>
      <View style={styles.grow}>
        <Text style={styles.body}>Include audio from this computer</Text>
        <Text style={styles.hint}>{Platform.OS === "web" ? "Select Share audio when choosing a tab or window. Otherwise, only the microphone is recorded." : ""}</Text>
      </View>
      <Toggle label="Include audio from this computer" value={systemAudio} onValueChange={setSystemAudio} />
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <Text style={styles.consent}>Tell anyone else you're recording.</Text>
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
  dot: { width: 12, height: 12, borderRadius: radius.pill, backgroundColor: colors.red },
  timer: { ...typography.heading, color: colors.ink, fontVariant: ["tabular-nums"] },
  liveLabel: { ...typography.label, color: colors.red },
  error: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, padding: space.sm, borderRadius: radius.sm },
}));
