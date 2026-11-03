import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { CallVideo } from "../../components/CallVideo";
import { useSession } from "../../lib/session";
import { callsSupported, createCall, type CallState } from "../../lib/meeting-call";
import { radius, space, typography } from "../../lib/theme";

const DARK = "#0B1220";

/** The full-screen call. The agent records it; leaving keeps the meeting going for others. */
export default function MeetingScreen() {
  // A full-screen modal can report zero safe-area insets, which put the status line under the clock
  // and the island. A provider of its own measures the modal itself.
  return <SafeAreaProvider><Meeting /></SafeAreaProvider>;
}

function Meeting() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { account } = useSession();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [state, setState] = useState<CallState>({ status: "starting", error: null, local: null, remotes: [], muted: false, cameraOff: false });
  const [ending, setEnding] = useState(false);
  const call = useRef<ReturnType<typeof createCall> | null>(null);

  useEffect(() => {
    if (!account || !id) return;
    if (!callsSupported()) { setState(s => ({ ...s, status: "failed", error: "This device or browser can't make calls. Use the Servant app or a current Chrome, Safari or Edge" })); return; }
    const c = createCall(account, id, setState);
    call.current = c;
    void c.start();
    return () => { void c.leave(); call.current = null; };
  }, [account, id]);

  const close = () => { if (router.canGoBack()) router.back(); else router.replace("/"); };
  const leave = async () => { await call.current?.leave(); close(); };
  const end = async () => {
    setEnding(true);
    try { await call.current?.end(); } catch { /* the meeting may already be over */ }
    close();
  };

  const tiles = state.remotes;
  // Joined without a camera (none, or refused): there is nothing to turn on.
  const hasCamera = !!state.local?.getVideoTracks?.().length;
  const columns = tiles.length <= 1 ? 1 : width > 700 ? 3 : 2;
  const done = state.status === "ended" || state.status === "failed";
  const statusLine = state.status === "starting" ? "Starting your camera…"
    : state.status === "connecting" ? "Connecting…"
    : state.status === "ended" ? "This meeting has ended. Notes will appear in the conversation"
    : state.status === "failed" ? state.error || "Couldn't join the meeting"
    : tiles.length ? "Recording for notes" : "Waiting for others · Recording for notes";

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.sm, paddingBottom: insets.bottom + space.md }]}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <View style={styles.top}>
        <View accessible accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.status}>
          {state.status === "live" ? <View style={styles.recDot} /> : null}
          <Text style={styles.statusText}>{statusLine}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.grid}>
        {tiles.map(r => (
          <View key={r.participantId} style={[styles.tile, { width: `${100 / columns - 2}%` as const }]}>
            {r.stream ? <CallVideo stream={r.stream} style={StyleSheet.absoluteFill} /> : null}
            {!r.hasVideo ? <View style={styles.noVideo}><Text style={styles.initial}>{r.name.slice(0, 1).toUpperCase()}</Text></View> : null}
            <Text style={styles.name}>{r.name}</Text>
          </View>
        ))}
      </ScrollView>
      {state.local && !done ? (
        <View style={styles.selfRow}>
          <View style={styles.self} accessibilityLabel={state.cameraOff ? "Your camera is off" : "Your camera"}>
            {state.cameraOff ? <View style={styles.noVideo}><Text style={styles.selfOff}>Camera off</Text></View>
              : <CallVideo stream={state.local} mirror muted style={StyleSheet.absoluteFill} />}
          </View>
        </View>
      ) : null}
      <View style={styles.controls}>
        {done ? <Control label="Back to the conversation" onPress={close} wide /> : <>
          <View style={styles.controlRow}>
            <Control label={state.muted ? "Unmute" : "Mute"} active={state.muted} onPress={() => call.current?.toggleMute()} />
            {hasCamera ? <Control label={state.cameraOff ? "Camera on" : "Camera off"} active={state.cameraOff} onPress={() => call.current?.toggleCamera()} /> : null}
            <Control label="Leave" onPress={leave} />
          </View>
          <Control label={ending ? "Ending…" : "End for all"} danger disabled={ending} onPress={end} wide />
        </>}
      </View>
    </View>
  );
}

function Control({ label, onPress, active, danger, disabled, wide }: { label: string; onPress: () => void; active?: boolean; danger?: boolean; disabled?: boolean; wide?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!active, disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.control, active && styles.controlActive, danger && styles.controlDanger, wide && styles.controlWide, pressed && { opacity: 0.8 }]}>
      <Text style={[styles.controlText, active && styles.controlTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: DARK },
  top: { paddingHorizontal: 20, paddingBottom: space.sm },
  status: { flexDirection: "row", alignItems: "center", gap: space.xs },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#E5484D" },
  statusText: { ...typography.label, color: "#C9D3E0" },
  grid: { flexGrow: 1, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignContent: "center", gap: space.xs, padding: space.xs },
  tile: { aspectRatio: 4 / 3, maxHeight: 560, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "#1B2433" },
  noVideo: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "#1B2433" },
  initial: { fontSize: 44, fontWeight: "700", color: "#FFFFFF" },
  name: { position: "absolute", left: space.xs, bottom: space.xs, ...typography.label, color: "#FFFFFF", backgroundColor: "rgba(0,0,0,0.45)", paddingHorizontal: space.xs, paddingVertical: 2, borderRadius: radius.sm, overflow: "hidden" },
  selfRow: { alignItems: "flex-end", paddingHorizontal: 20, paddingBottom: space.sm },
  self: { width: 160, height: 120, borderRadius: radius.md, overflow: "hidden", backgroundColor: "#1B2433", borderWidth: 1, borderColor: "rgba(255,255,255,0.25)" },
  selfOff: { ...typography.caption, color: "#C9D3E0" },
  controls: { gap: space.xs, paddingHorizontal: 20, paddingTop: space.xs },
  controlRow: { flexDirection: "row", gap: space.xs },
  control: { flex: 1, minHeight: 48, paddingHorizontal: space.md, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: "#243045" },
  controlWide: { alignSelf: "stretch" },
  controlActive: { backgroundColor: "#FFFFFF" },
  controlDanger: { backgroundColor: "#D11242" },
  controlText: { ...typography.bodyStrong, color: "#FFFFFF" },
  controlTextActive: { color: DARK },
});
