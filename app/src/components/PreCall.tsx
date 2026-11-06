import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CallVideo } from "./CallVideo";
import { openPreview, type CallPreset } from "../lib/meeting-call";
import { radius, space, typography } from "../lib/theme";

const DARK = "#0B1220";

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
      <Text accessibilityRole="header" style={styles.title}>Check your camera</Text>
      <Text style={styles.sub}>This is what others will see when you join</Text>
      <View testID="precall-preview" accessible accessibilityLabel={showVideo ? "Your camera" : "Your camera is off"} style={styles.preview}>
        {showVideo ? <CallVideo stream={stream} mirror muted style={StyleSheet.absoluteFill} />
          : <View style={styles.off}><Text style={styles.offText}>{loading ? "Starting your camera…" : "Camera off"}</Text></View>}
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <View style={styles.row}>
        <Btn label={muted ? "Unmute" : "Mute"} active={muted} disabled={!stream} onPress={toggleMute} />
        {hasCamera ? <Btn label={cameraOff ? "Camera on" : "Camera off"} active={cameraOff} onPress={toggleCamera} /> : null}
      </View>
      <View style={{ flex: 1 }} />
      {!stream && !loading ? <Btn label="Try again" onPress={retry} wide /> : null}
      <Btn label="Join call" primary disabled={!stream} onPress={join} wide />
      <Btn label="Cancel" onPress={onCancel} wide />
    </View>
  );
}

function Btn({ label, onPress, active, primary, disabled, wide }: { label: string; onPress: () => void; active?: boolean; primary?: boolean; disabled?: boolean; wide?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!active, disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.btn, wide && styles.wide, active && styles.active, primary && styles.primary, disabled && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}>
      <Text style={[styles.btnText, active && { color: DARK }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: DARK, paddingHorizontal: 20, gap: space.sm },
  title: { ...typography.title, color: "#FFFFFF" },
  sub: { ...typography.body, color: "#C9D3E0" },
  preview: { width: "100%", aspectRatio: 3 / 4, maxHeight: 460, alignSelf: "center", borderRadius: radius.lg, overflow: "hidden", backgroundColor: "#1B2433" },
  off: { flex: 1, alignItems: "center", justifyContent: "center" },
  offText: { ...typography.body, color: "#C9D3E0" },
  error: { ...typography.body, color: "#FFB4C0" },
  row: { flexDirection: "row", gap: space.xs },
  btn: { flex: 1, minHeight: 48, paddingHorizontal: space.md, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: "#243045" },
  wide: { alignSelf: "stretch", flex: 0 },
  active: { backgroundColor: "#FFFFFF" },
  primary: { backgroundColor: "#0071BC" },
  btnText: { ...typography.bodyStrong, color: "#FFFFFF" },
});
