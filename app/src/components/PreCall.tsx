import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CallVideo } from "./CallVideo";
import { CALL_DARK, CALL_MUTED_TEXT, CALL_PANEL, CallControl, CallPrimaryButton, CallTextButton } from "./CallControls";
import { NoiseToggle } from "./NoiseToggle";
import { openPreview, type CallPreset } from "../lib/meeting-call";
import { radius, space, typography } from "../lib/theme";

/** Shown before you join a call: see yourself, turn camera or mic off, then join. */
export function PreCall({ onJoin, onCancel }: { onJoin: (p: CallPreset) => void; onCancel: () => void }) {
  const insets = useSafeAreaInsets();
  const [stream, setStream] = useState<any>(null);
  const [hasCamera, setHasCamera] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The stream is handed to the call when you join; otherwise it's stopped when you leave.
  const handedOff = useRef(false);
  const current = useRef<any>(null);

  useEffect(() => {
    let gone = false;
    openPreview().then(r => {
      if (gone) { r.stream?.getTracks?.().forEach((t: any) => t.stop()); return; }
      current.current = r.stream; setStream(r.stream); setHasCamera(r.hasCamera); setError(r.error); setLoading(false);
    });
    return () => { gone = true; if (!handedOff.current) current.current?.getTracks?.().forEach((t: any) => t.stop()); };
  }, [attempt]);

  const toggleMute = () => { const next = !muted; setMuted(next); stream?.getAudioTracks?.().forEach((t: any) => { t.enabled = !next; }); };
  const toggleCamera = () => { const next = !cameraOff; setCameraOff(next); stream?.getVideoTracks?.().forEach((t: any) => { t.enabled = !next; }); };
  const retry = () => { current.current?.getTracks?.().forEach((t: any) => t.stop()); current.current = null; setStream(null); setError(null); setLoading(true); setAttempt(a => a + 1); };
  const join = () => { if (!stream) return; handedOff.current = true; onJoin({ stream, muted, cameraOff: cameraOff || !hasCamera }); };
  const showVideo = !!stream && hasCamera && !cameraOff;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.md }]}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>Camera</Text>
        <View testID="precall-preview" accessible accessibilityLabel={showVideo ? "Your camera" : "Your camera is off"} style={styles.preview}>
          {showVideo ? <CallVideo stream={stream} mirror muted style={StyleSheet.absoluteFill} />
            : <View style={styles.off}><Text style={styles.offText}>{loading ? "Starting your camera…" : "Camera off"}</Text></View>}
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <View style={styles.row}>
          <CallControl icon={muted ? "micOff" : "mic"} label={muted ? "Unmute" : "Mute"} active={muted} disabled={!stream} onPress={toggleMute} />
          {hasCamera ? <CallControl icon={cameraOff ? "cameraOff" : "meetings"} label={cameraOff ? "Camera on" : "Camera off"} active={cameraOff} onPress={toggleCamera} /> : null}
        </View>
        <NoiseToggle precall />
        <View style={{ flex: 1 }} />
        {!stream && !loading ? <CallPrimaryButton label="Try again" onPress={retry} /> : null}
        <CallPrimaryButton label="Join call" disabled={!stream} onPress={join} />
        <CallTextButton label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: CALL_DARK },
  // One column, no wider than a phone and a half, so the preview and buttons stay in reach on a Mac.
  content: { flex: 1, width: "100%", maxWidth: 560, alignSelf: "center", paddingHorizontal: 20, gap: space.sm },
  title: { ...typography.title, color: "#FFFFFF" },
  // The preview gives way (down to 160) before Join and Cancel do, so both stay on a phone's screen under the noise switch.
  preview: { width: "100%", aspectRatio: 3 / 4, maxHeight: 460, minHeight: 160, flexShrink: 1, alignSelf: "center", borderRadius: radius.lg, overflow: "hidden", backgroundColor: CALL_PANEL },
  off: { flex: 1, alignItems: "center", justifyContent: "center" },
  offText: { ...typography.body, color: CALL_MUTED_TEXT },
  error: { ...typography.body, color: "#FFB4C0" },
  row: { flexDirection: "row", gap: space.xs, width: "100%", maxWidth: 320, alignSelf: "center" },
});
