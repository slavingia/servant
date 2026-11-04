import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { CallPulse } from "../../components/CallPulse";
import { startRingSound } from "../../lib/ring-sound";
import { CallVideo } from "../../components/CallVideo";
import { useSession } from "../../lib/session";
import { systemCalls } from "../../lib/servant-call";
import { callsSupported, createCall, screenShareSupported, type CallState } from "../../lib/meeting-call";
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
  const [state, setState] = useState<CallState>({ status: "starting", error: null, local: null, remotes: [], muted: false, cameraOff: false, sharing: false });
  const [ending, setEnding] = useState(false);
  const call = useRef<ReturnType<typeof createCall> | null>(null);

  useEffect(() => {
    if (!account || !id) return;
    if (!callsSupported()) { setState(s => ({ ...s, status: "failed", error: "This device or browser can't make calls. Use the Servant app or a current Chrome, Safari or Edge" })); return; }
    systemCalls.end(id);
    const c = createCall(account, id, setState);
    call.current = c;
    void c.start();
    return () => { void c.leave(); call.current = null; };
  }, [account, id]);

  // "Calling…" rings back until someone joins, so you know it's ringing on their end.
  const waiting = state.status === "live" && state.remotes.length === 0;
  useEffect(() => (waiting ? startRingSound("outgoing") : undefined), [waiting]);

  const close = () => { if (router.canGoBack()) router.back(); else router.replace("/"); };
  const leave = async () => { await call.current?.leave(); close(); };
  const end = async () => {
    setEnding(true);
    try { await call.current?.end(); } catch { /* the meeting may already be over */ }
    close();
  };

  // A shared screen takes the stage (it has to be readable); people sit in a row above your controls.
  const stage = state.remotes.find(r => r.screen) ?? null;
  const tiles = state.remotes.filter(r => r !== stage);
  const anyone = state.remotes.length > 0;
  // Joined without a camera (none, or refused): there is nothing to turn on.
  const hasCamera = !!state.local?.getVideoTracks?.().length;
  const columns = stage ? Math.min(4, Math.max(1, tiles.length)) : tiles.length <= 1 ? 1 : width > 700 ? 3 : 2;
  const done = state.status === "ended" || state.status === "failed";
  const statusLine = state.status === "starting" ? "Starting your camera…"
    : state.status === "connecting" ? "Connecting…"
    : state.status === "ended" ? "This meeting has ended. Notes will appear in the conversation"
    : state.status === "failed" ? state.error || "Couldn't join the meeting"
    : state.sharing ? "You're sharing your screen · Recording for notes"
    : stage ? `${stage.name} · Recording for notes`
    : anyone ? "Recording for notes" : "Waiting for others · Recording for notes";

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.sm, paddingBottom: insets.bottom + space.md }]}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <View style={styles.top}>
        <View accessible accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.status}>
          {state.status === "live" ? <View style={styles.recDot} /> : null}
          <Text style={styles.statusText}>{statusLine}</Text>
        </View>
      </View>
      {state.status === "live" && !anyone ? (
        <View style={styles.calling}><CallPulse initial="…" /><Text style={styles.callingText}>Calling…</Text></View>
      ) : null}
      {stage ? (
        <View testID="screen-stage" accessible accessibilityLabel={stage.name} style={styles.stage}>
          {stage.stream ? <CallVideo stream={stage.stream} fit="contain" style={StyleSheet.absoluteFill} /> : null}
          <Text style={styles.name}>{stage.name}</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.grid} style={stage ? styles.strip : state.status === "live" && !anyone ? { flex: 0 } : undefined} horizontal={false}>
        {tiles.map(r => (
          <View key={r.participantId} style={[styles.tile, stage ? styles.tileSmall : { width: `${100 / columns - 2}%` as const }]}>
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
            {screenShareSupported() && state.status === "live" ? <Control label={state.sharing ? "Stop sharing" : "Share screen"} active={state.sharing} onPress={() => void call.current?.toggleScreen()} /> : null}
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
  calling: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm },
  callingText: { ...typography.bodyStrong, color: "#FFFFFF" },
  top: { paddingHorizontal: 20, paddingBottom: space.sm },
  status: { flexDirection: "row", alignItems: "center", gap: space.xs },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#E5484D" },
  statusText: { ...typography.label, color: "#C9D3E0" },
  grid: { flexGrow: 1, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignContent: "center", gap: space.xs, padding: space.xs },
  stage: { flex: 1, minHeight: 200, marginHorizontal: space.xs, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "#000" },
  strip: { flexGrow: 0, maxHeight: 112 },
  tileSmall: { width: 128, height: 96 },
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
