import { useEffect, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useCallAwake } from "../../lib/call-awake";
import { Redirect, Stack, router, useLocalSearchParams } from "expo-router";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { CallPulse } from "../../components/CallPulse";
import { startRingSound } from "../../lib/ring-sound";
import { CallVideo } from "../../components/CallVideo";
import { AppIcon } from "../../components/AppIcon";
import { CALL_DARK, CALL_MUTED_TEXT, CALL_PANEL, CALL_CONTROL, CallChip, CallControl, CallPrimaryButton, CallTextButton } from "../../components/CallControls";
import { PreCall } from "../../components/PreCall";
import { useLiveList } from "../../lib/live";
import { NoiseToggle } from "../../components/NoiseToggle";
import { OtherDeviceNote } from "../../components/OtherDeviceNote";
import { GuestInvite } from "../../components/GuestInvite";
import { useSession } from "../../lib/session";
import { landingHref, useFeatures } from "../../lib/features";
import { systemCalls } from "../../lib/servant-call";
import { callsSupported, screenShareSupported, type CallPreset, type CallState } from "../../lib/meeting-call";
import { endCall, joinCall, leaveCall, useActiveCall } from "../../lib/active-call";
import { speakerSupported } from "../../lib/call-speaker";
import { useCallClock } from "../../lib/call-clock";
import { radius, space, typography, useTheme } from "../../lib/theme";

const DARK = CALL_DARK;

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
  const features = useFeatures();
  // A server without meetings has no calls to join (the server refuses them too).
  if (!features.meetings) return <Redirect href={landingHref(features)} />;
  if (!unsupported && active?.id !== id && !preset) {
    return <PreCall onJoin={setPreset} onCancel={() => { if (router.canGoBack()) router.back(); else router.replace("/"); }} />;
  }
  return <Meeting preset={preset ?? undefined} />;
}

function Meeting({ preset }: { preset?: CallPreset }) {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  // The screen stays on for the whole call; it sleeps normally again when you leave.
  useCallAwake();
  const { account } = useSession();
  const { conversations } = useLiveList();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  // Measured size of the tile area, so every tile fits on screen without relying on the ScrollView re-measuring (it didn't on Android until you minimized and came back).
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  // Height of the "Calling…" block, so the pulse shrinks instead of running into the self-view when the screen is short.
  const [callingH, setCallingH] = useState(0);
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

  // "Calling…" rings back until someone joins, so you know it's ringing on their end. Once they are
  // on the call (listed, video still on its way) it says who is joining instead.
  const joining = state.people.find(p => !p.you)?.name ?? null;
  const waiting = state.status === "live" && state.remotes.length === 0 && !joining;
  useEffect(() => (waiting ? startRingSound("outgoing") : undefined), [waiting]);
  // The room's name, for "Calling #refund-desk…" and the letter in the pulse.
  const conv = conversations?.find(c => c.id === state.conversationId);
  const room = conv ? (conv.kind === "channel" ? `#${conv.name ?? conv.title}` : conv.title) : null;

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
  const gap = space.xs;
  const areaW = area?.w ?? width;
  let columns = stage ? Math.min(4, Math.max(1, tiles.length)) : tiles.length <= 1 ? 1 : width > 700 ? 3 : 2;
  const widthFor = (c: number) => Math.floor((areaW - gap * 2 - gap * (c - 1)) / c) - 1;
  if (!stage && area && area.h > 0 && tiles.length > 1) {
    // Pick the fewest columns whose rows all fit in the visible height (tiles shrink as people join); never narrower than 80.
    const fits = (c: number) => { const w = widthFor(c); const rows = Math.ceil(tiles.length / c); return rows * Math.round(w * 3 / 4) + (rows - 1) * gap + gap * 2 <= area.h; };
    const max = width > 700 ? 6 : 4;
    let best = columns;
    for (let c = 1; c <= max; c++) { if (widthFor(c) < 80) break; best = c; if (fits(c)) break; }
    columns = best;
  }
  // One person: keep the tile at 4:3 under its max height (a wide screen) and under the measured area (a phone, where the
  // controls, the noise switch and the guest row leave less room), so the name bar isn't cut off.
  const heightCap = !stage && tiles.length <= 1 && area && area.h > 0 ? Math.floor((area.h - gap * 2) * 4 / 3) : Infinity;
  const tileWidth = Math.max(80, Math.min(Math.floor(560 * 4 / 3), heightCap, widthFor(columns)));
  const pulseSize = callingH > 0 ? Math.max(56, Math.min(112, Math.floor((callingH - 44) / 2.4))) : 112;
  const done = state.status === "ended" || state.status === "failed";
  const others = state.people.filter(p => !p.you).length;
  const peopleLabel = others > 0 ? `${others + 1} people` : "People";
  const statusLine = state.status === "starting" ? "Starting your camera…"
    : state.status === "connecting" ? "Connecting…"
    : state.status === "ended" ? "Meeting ended"
    : state.status === "failed" ? state.error || "Couldn't join the meeting"
    : state.sharing ? "You're sharing your screen · Recording for notes"
    : stage ? `${stage.name} · Recording for notes`
    : anyone ? "Recording for notes" : "Waiting for others · Recording for notes";

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.sm, paddingBottom: insets.bottom + space.md }]}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <View style={styles.top}>
        {!done ? <View accessible accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.status}>
          {state.status === "live" ? <View style={styles.recDot} /> : null}
          <Text style={styles.statusText}>{statusLine}</Text>
          {clock ? <Text testID="call-clock" accessibilityLabel={`Call time ${clock}`} style={styles.clock}>{clock}</Text> : null}
        </View> : null}
        {!done ? <Pressable accessibilityRole="button" accessibilityLabel="Back to the conversation; you stay on the call" onPress={close} style={styles.minimize}>
          <Text style={styles.minimizeText}>Minimize</Text>
        </Pressable> : null}
      </View>
      {done ? (
        <View accessible accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.calling}>
          <Text style={styles.endedTitle}>{state.status === "ended" ? "Meeting ended" : "Couldn't join the meeting"}</Text>
          {state.error ? <Text style={styles.endedBody}>{state.error}</Text> : null}
        </View>
      ) : null}
      <OtherDeviceNote />
      <GuestInvite />
      {state.status === "live" && !anyone ? (
        <View onLayout={e => setCallingH(Math.round(e.nativeEvent.layout.height))} style={styles.calling}>
          <CallPulse size={pulseSize} initial={(joining ?? room?.replace(/^#/, "") ?? "").slice(0, 1) || "…"} />
          <Text style={styles.callingText}>{joining ? `${joining} is joining…` : room ? `Calling ${room}…` : "Calling…"}</Text>
        </View>
      ) : null}
      {stage ? (
        <View testID="screen-stage" accessible accessibilityLabel={stage.name} style={styles.stage}>
          {stage.stream ? <CallVideo stream={stage.stream} fit="contain" style={StyleSheet.absoluteFill} /> : null}
          <Text style={styles.name}>{stage.name}</Text>
        </View>
      ) : null}
      <View onLayout={e => { const { width: w, height: h } = e.nativeEvent.layout; setArea(a => a && Math.abs(a.w - w) < 1 && Math.abs(a.h - h) < 1 ? a : { w, h }); }} style={stage ? styles.strip : done || (state.status === "live" && !anyone) ? { flex: 0 } : { flex: 1 }}>
      <ScrollView key={tiles.length} contentContainerStyle={styles.grid} style={{ flex: 1 }} horizontal={false}>
        {tiles.map(r => (
          <View key={r.participantId} style={[styles.tile, stage ? styles.tileSmall : { width: tileWidth, height: Math.round(tileWidth * 3 / 4) }]}>
            {r.stream ? <CallVideo stream={r.stream} style={StyleSheet.absoluteFill} /> : null}
            {!r.hasVideo ? <View style={styles.noVideo}><Text style={styles.initial}>{r.name.slice(0, 1).toUpperCase()}</Text></View> : null}
            <View style={styles.nameRow}>
              {r.muted ? <AppIcon name="micOff" size={12} color="#FFFFFF" /> : null}
              <Text style={styles.nameText}>{r.muted ? `${r.name} · Muted` : r.name}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
      </View>
      {showResearch && state.research?.on && !done ? (
        <View testID="research-tray" accessibilityLabel="Research" style={styles.people}>
          <Text style={styles.peopleTitle}>Research</Text>
          <ScrollView style={{ maxHeight: 220 }}>
            {state.research.cards.length === 0 ? <Text style={styles.personMeta}>Ask: “Hey Servant, …”</Text> : null}
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
                <View style={[styles.personDot, { backgroundColor: colors.primary }]}><Text style={[styles.personInitial, { color: colors.onPrimary }]}>{p.name.slice(0, 1).toUpperCase()}</Text></View>
                <Text style={styles.personName} numberOfLines={1}>{p.name}</Text>
                <View accessible={false} style={styles.personMic}><AppIcon name={p.muted ? "micOff" : "mic"} size={18} color={p.muted ? "#E5484D" : "#C9D3E0"} /></View>
                {state.host && !p.you && !p.muted ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Mute ${p.name}`} onPress={() => void call.current?.muteOther(p.id)} style={styles.muteBtn}>
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
      {!done ? <View style={styles.noise}><NoiseToggle /></View> : null}
      <View style={styles.controls}>
        {done ? <CallPrimaryButton label="Back to the conversation" onPress={close} /> : <>
          <View style={styles.chips}>
            {screenShareSupported() && state.status === "live" ? <CallChip icon="screenShare" label={state.sharing ? "Stop sharing" : "Share screen"} active={state.sharing} onPress={() => void call.current?.toggleScreen()} /> : null}
            {state.research?.on || (state.host && state.research?.available) ? <CallChip icon="sparkles" label={state.research?.on && state.research.cards.some(c => c.status === "working") ? "Research…" : "Research"} active={showResearch && !!state.research?.on} onPress={researchPress} /> : null}
            {speakerSupported() && state.status === "live" ? <CallChip icon="speaker" label={state.speaker ? "Earpiece" : "Speaker"} active={!!state.speaker} onPress={() => call.current?.toggleSpeaker()} /> : null}
            <CallChip icon="people" label={peopleLabel} accessibilityLabel={others > 0 ? `People, ${others + 1} on the call` : "People"} active={showPeople} onPress={() => setShowPeople(v => !v)} />
          </View>
          <View style={styles.controlRow}>
            <CallControl icon={state.muted ? "micOff" : "mic"} label={state.muted ? "Unmute" : "Mute"} active={state.muted} onPress={() => call.current?.toggleMute()} />
            {hasCamera ? <CallControl icon={state.cameraOff ? "cameraOff" : "meetings"} label={state.cameraOff ? "Camera on" : "Camera off"} active={state.cameraOff} onPress={() => call.current?.toggleCamera()} /> : null}
            <CallControl icon="leave" label="Leave" danger onPress={leave} />
          </View>
          {state.host ? <CallTextButton label={ending ? "Ending…" : "End for all"} accessibilityLabel={ending ? "Ending the call for everyone" : "End for all"} danger disabled={ending} onPress={confirmEnd} /> : null}
        </>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: DARK },
  people: { marginHorizontal: space.xs, marginBottom: space.xs, padding: space.sm, borderRadius: radius.lg, backgroundColor: CALL_PANEL },
  peopleTitle: { ...typography.label, color: CALL_MUTED_TEXT, marginBottom: space.xs },
  personRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
  personDot: { width: 32, height: 32, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  personInitial: { ...typography.bodyStrong },
  personName: { ...typography.body, color: "#FFFFFF", flex: 1 },
  personMic: { width: 24, alignItems: "center" },
  card: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#243045" },
  cardAsk: { ...typography.label, color: "#C9D3E0" },
  cardAnswer: { ...typography.body, color: "#FFFFFF", marginTop: 2 },
  muteBtn: { minHeight: 44, paddingHorizontal: space.sm, borderRadius: radius.pill, justifyContent: "center", backgroundColor: CALL_CONTROL },
  nameRow: { position: "absolute", left: space.xs, bottom: space.xs, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(0,0,0,0.45)", paddingHorizontal: space.xs, paddingVertical: 2, borderRadius: radius.sm },
  nameText: { ...typography.label, color: "#FFFFFF" },
  personMeta: { ...typography.label, color: "#C9D3E0" },
  calling: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm },
  callingText: { ...typography.bodyStrong, color: "#FFFFFF" },
  endedTitle: { ...typography.title, color: "#FFFFFF", textAlign: "center", paddingHorizontal: 20 },
  endedBody: { ...typography.body, color: CALL_MUTED_TEXT, textAlign: "center", paddingHorizontal: 20 },
  top: { paddingHorizontal: 20, paddingBottom: space.sm, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  clock: { ...typography.label, color: "#FFFFFF", fontVariant: ["tabular-nums"] },
  minimize: { minHeight: 44, paddingHorizontal: space.sm, borderRadius: radius.pill, justifyContent: "center", backgroundColor: CALL_CONTROL },
  minimizeText: { ...typography.label, color: "#FFFFFF" },
  status: { flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 1 },
  recDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: "#E5484D" },
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
  controls: { gap: space.sm, paddingHorizontal: 20, paddingTop: space.xs, width: "100%", maxWidth: 600, alignSelf: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.xs },
  noise: { paddingHorizontal: 20, paddingBottom: space.xs, width: "100%", maxWidth: 600, alignSelf: "center" },
  controlRow: { flexDirection: "row", gap: space.xs },
});
