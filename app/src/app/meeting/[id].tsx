import { useEffect, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useCallAwake } from "../../lib/call-awake";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { CallPulse } from "../../components/CallPulse";
import { startRingSound } from "../../lib/ring-sound";
import { CallVideo } from "../../components/CallVideo";
import { AppIcon } from "../../components/AppIcon";
import { PreCall } from "../../components/PreCall";
import { useSession } from "../../lib/session";
import { systemCalls } from "../../lib/servant-call";
import { callsSupported, screenShareSupported, type CallPreset, type CallState } from "../../lib/meeting-call";
import { endCall, joinCall, leaveCall, useActiveCall } from "../../lib/active-call";
import { useCallClock } from "../../lib/call-clock";
import { radius, space, typography } from "../../lib/theme";

const DARK = "#0B1220";

/** The full-screen call. The agent records it; leaving keeps the meeting going for others. */
export default function MeetingScreen() {
  // A full-screen modal can report zero safe-area insets, which put the status line under the clock
  // and the island. A provider of its own measures the modal itself.
  return <SafeAreaProvider><Gate /></SafeAreaProvider>;
}

/** Before you join, a check-your-camera screen. Coming back to a call you're already on skips it. */
function Gate() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const active = useActiveCall();
  const [preset, setPreset] = useState<CallPreset | null>(null);
  const [unsupported] = useState(() => !callsSupported());
  if (!unsupported && active?.id !== id && !preset) {
    return <PreCall onJoin={setPreset} onCancel={() => { if (router.canGoBack()) router.back(); else router.replace("/"); }} />;
  }
  return <Meeting preset={preset ?? undefined} />;
}

function Meeting({ preset }: { preset?: CallPreset }) {
  const { id } = useLocalSearchParams<{ id: string }>();
  // The screen stays on for the whole call; it sleeps normally again when you leave.
  useCallAwake();
  const { account } = useSession();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [unsupported] = useState(() => !callsSupported());
  const [ending, setEnding] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [showResearch, setShowResearch] = useState(false);
  // The call lives outside this screen: going back or switching tabs keeps you in it (a bar on
  // every screen brings you back). Only Leave or End takes you out.
  const active = useActiveCall();
  useEffect(() => {
    if (!account || !id || unsupported) return;
    systemCalls.end(id);
    joinCall(account, id, preset);
  }, [account, id, unsupported, preset]);
  const mine = active?.id === id ? active : null;
  const call = { current: mine?.call ?? null };
  const state: CallState = unsupported
    ? { status: "failed", error: "This device or browser can't make calls. Use the Servant app or a current Chrome, Safari or Edge", local: null, remotes: [], people: [], muted: false, cameraOff: false, sharing: false }
    : mine?.state ?? { status: "starting", error: null, local: null, remotes: [], people: [], muted: false, cameraOff: false, sharing: false };
  const clock = useCallClock(state.status === "live" ? state.startedAt : undefined);

  // "Calling…" rings back until someone joins, so you know it's ringing on their end.
  const waiting = state.status === "live" && state.remotes.length === 0;
  useEffect(() => (waiting ? startRingSound("outgoing") : undefined), [waiting]);

  const close = () => { if (router.canGoBack()) router.back(); else router.replace("/"); };
  const leave = async () => { await leaveCall(); close(); };
  // Ending drops everyone, so it asks first; "Leave" is the safe exit and is the default choice.
  const confirmEnd = () => {
    const title = "End the call for everyone?";
    const body = "Everyone is disconnected. To go and keep the call running, choose Leave instead.";
    if (Platform.OS === "web") { if (typeof window !== "undefined" && window.confirm(`${title}\n\n${body}`)) void end(); return; }
    Alert.alert(title, body, [
      { text: "Cancel", style: "cancel" },
      { text: "End for all", style: "destructive", onPress: () => void end() },
    ]);
  };
  // Research sends what is said on the call to the agent, so the host confirms and everyone is told.
  const researchPress = () => {
    if (state.research?.on) { setShowResearch(v => !v); return; }
    const title = "Turn on Research?";
    const body = "Say \"hey servant\" and a question, and the agent looks it up for everyone on the call. To do this, what is said on the call is sent to the agent. Everyone is told it's on, and it stays on until the call ends.";
    const go = () => { void call.current?.startResearch().then(() => setShowResearch(true)).catch(() => undefined); };
    if (Platform.OS === "web") { if (typeof window !== "undefined" && window.confirm(`${title}\n\n${body}`)) go(); return; }
    Alert.alert(title, body, [{ text: "Cancel", style: "cancel" }, { text: "Turn on", onPress: go }]);
  };
  const end = async () => {
    setEnding(true);
    try { await endCall(); } catch { /* the meeting may already be over */ }
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
          {clock ? <Text testID="call-clock" accessibilityLabel={`Call time ${clock}`} style={styles.clock}>{clock}</Text> : null}
        </View>
        {!done ? <Pressable accessibilityRole="button" accessibilityLabel="Back to the conversation; you stay on the call" onPress={close} hitSlop={10} style={styles.minimize}>
          <Text style={styles.minimizeText}>Minimize</Text>
        </Pressable> : null}
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
            <View style={styles.nameRow}>
              {r.muted ? <AppIcon name="micOff" size={12} color="#FFFFFF" /> : null}
              <Text style={styles.nameText}>{r.muted ? `${r.name} · Muted` : r.name}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
      {showResearch && state.research?.on && !done ? (
        <View testID="research-tray" accessibilityLabel="Research" style={styles.people}>
          <Text style={styles.peopleTitle}>Research</Text>
          <ScrollView style={{ maxHeight: 220 }}>
            {state.research.cards.length === 0 ? <Text style={styles.personMeta}>Say "hey servant" and a question</Text> : null}
            {[...state.research.cards].reverse().map(c => (
              <View key={c.n} accessible accessibilityLabel={`${c.askedBy} asked ${c.question}. ${c.status === "working" ? "Looking it up" : c.answer ?? ""}`} style={styles.card}>
                <Text style={styles.cardAsk}>{c.askedBy}: {c.question}</Text>
                <Text style={[styles.cardAnswer, c.status === "failed" && { color: "#E5484D" }]}>{c.status === "working" ? "Looking it up…" : c.answer}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
      {showPeople && !done ? (
        <View testID="people-list" accessibilityLabel="People on the call" style={styles.people}>
          <Text style={styles.peopleTitle}>{state.people.length === 1 ? "One person on the call" : `${state.people.length} people on the call`}</Text>
          <ScrollView style={{ maxHeight: 180 }}>
            {state.people.map(p => (
              <View key={p.id} accessible accessibilityLabel={`${p.name}${p.muted ? ", muted" : ""}`} style={styles.personRow}>
                <View style={styles.personDot}><Text style={styles.personInitial}>{p.name.slice(0, 1).toUpperCase()}</Text></View>
                <Text style={styles.personName} numberOfLines={1}>{p.name}</Text>
                <View accessible={false} style={styles.personMic}><AppIcon name={p.muted ? "micOff" : "mic"} size={18} color={p.muted ? "#E5484D" : "#C9D3E0"} /></View>
                {state.host && !p.you && !p.muted ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Mute ${p.name}`} hitSlop={8} onPress={() => void call.current?.muteOther(p.id)} style={styles.muteBtn}>
                    <Text style={styles.personMeta}>Mute</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
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
            {state.research?.on || (state.host && state.research?.available) ? <Control label={state.research?.on && state.research.cards.some(c => c.status === "working") ? "Research…" : "Research"} active={showResearch && !!state.research?.on} onPress={researchPress} /> : null}
            <Control label="People" active={showPeople} onPress={() => setShowPeople(v => !v)} />
            <Control label="Leave" onPress={leave} />
          </View>
          <Control label={ending ? "Ending…" : "End for all"} danger disabled={ending} onPress={confirmEnd} wide />
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
  people: { marginHorizontal: space.xs, marginBottom: space.xs, padding: space.sm, borderRadius: radius.lg, backgroundColor: "#1B2433" },
  peopleTitle: { ...typography.label, color: "#C9D3E0", marginBottom: space.xs },
  personRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
  personDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#0071BC", alignItems: "center", justifyContent: "center" },
  personInitial: { ...typography.bodyStrong, color: "#FFFFFF" },
  personName: { ...typography.body, color: "#FFFFFF", flex: 1 },
  personMic: { width: 24, alignItems: "center" },
  card: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#243045" },
  cardAsk: { ...typography.label, color: "#C9D3E0" },
  cardAnswer: { ...typography.body, color: "#FFFFFF", marginTop: 2 },
  muteBtn: { minHeight: 32, paddingHorizontal: space.sm, borderRadius: radius.pill, justifyContent: "center", backgroundColor: "#243045" },
  nameRow: { position: "absolute", left: space.xs, bottom: space.xs, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(0,0,0,0.45)", paddingHorizontal: space.xs, paddingVertical: 2, borderRadius: radius.sm },
  nameText: { ...typography.label, color: "#FFFFFF" },
  personMeta: { ...typography.label, color: "#C9D3E0" },
  calling: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm },
  callingText: { ...typography.bodyStrong, color: "#FFFFFF" },
  top: { paddingHorizontal: 20, paddingBottom: space.sm, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  clock: { ...typography.label, color: "#FFFFFF", fontVariant: ["tabular-nums"] },
  minimize: { minHeight: 32, paddingHorizontal: space.sm, borderRadius: radius.pill, justifyContent: "center", backgroundColor: "#243045" },
  minimizeText: { ...typography.label, color: "#FFFFFF" },
  status: { flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 1 },
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
