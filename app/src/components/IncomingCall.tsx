import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { router, usePathname } from "expo-router";
import { CallPulse } from "./CallPulse";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { api } from "../lib/server";
import { systemCalls } from "../lib/servant-call";
import { callsSupported } from "../lib/meeting-call";
import { useFeature } from "../lib/features";
import { RING_MS, shouldRing } from "../lib/incoming-call";
import { startRingSound } from "../lib/ring-sound";
import { radius, space, typography, useTheme } from "../lib/theme";

type Ring = { id: string; name: string; conversation: string; until: number };

/** Full-screen ring when someone starts a call: pulsing rings and a repeating buzz, so a silent phone still shows it. */
export function IncomingCall() {
  const { colors } = useTheme();
  const { account } = useSession();
  const { subscribe, conversations } = useLive();
  const pathname = usePathname();
  const [ring, setRing] = useState<Ring | null>(null);
  const dismissed = useRef(new Set<string>());
  const onMeeting = pathname.startsWith("/meeting/");
  const meetings = useFeature("meetings");

  useEffect(() => {
    // A server without meetings never rings (its calls can't start either).
    if (!account || !meetings || !callsSupported()) return;
    return subscribe(e => {
      if (e.event !== "message.created" && e.event !== "message.updated") return;
      const m = e.data.meeting;
      if (!m || m.kind !== "call") return;
      if (m.status !== "live") { setRing(r => (r?.id === m.id ? null : r)); return; }
      if (e.event !== "message.created" || dismissed.current.has(m.id)) return;
      api.meeting(account, m.id).then(info => {
        const joined = info.participants.some(p => p.you);
        if (!shouldRing({ status: info.status, startedAt: info.startedAt, startedById: info.startedBy.id, me: account.user.id, now: Date.now(), dismissed: dismissed.current, id: m.id, joined })) return;
        const conv = conversations?.find(c => c.id === info.conversationId);
        setRing({ id: m.id, name: info.startedBy.name, conversation: conv ? (conv.kind === "channel" ? `#${conv.name ?? conv.title}` : conv.title) : "", until: Date.now() + RING_MS });
      }).catch(() => { /* no ring if we can't tell */ });
    });
  }, [account, meetings, subscribe, conversations]);

  useEffect(() => {
    if (!ring) return;
    // The app is open and showing its own ring, so the phone's call screen would be a second one.
    systemCalls.end(ring.id);
    const buzz = () => { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}); };
    buzz();
    const tick = setInterval(buzz, 1500);
    const sound = startRingSound("incoming");
    const stop = setTimeout(() => setRing(null), Math.max(0, ring.until - Date.now()));
    return () => { clearInterval(tick); clearTimeout(stop); sound(); };
  }, [ring]);

  const hide = () => { if (ring) { dismissed.current.add(ring.id); systemCalls.end(ring.id); } setRing(null); };
  const join = () => { if (!ring) return; const id = ring.id; hide(); router.push({ pathname: "/meeting/[id]", params: { id } }); };
  if (!ring || onMeeting) return null;
  return (
    <Modal visible animationType="fade" statusBarTranslucent onRequestClose={hide}>
      <View style={styles.screen} accessibilityViewIsModal>
        <View accessible accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.who}>
          <Text style={styles.label}>Incoming call</Text>
          <Text style={styles.name}>{ring.name}</Text>
          {ring.conversation ? <Text style={styles.label}>{ring.conversation}</Text> : null}
        </View>
        <CallPulse initial={ring.name} />
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Decline" onPress={hide} style={({ pressed }) => [styles.btn, styles.decline, pressed && { opacity: 0.8 }]}><Text style={styles.btnText}>Decline</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Join" onPress={join} style={({ pressed }) => [styles.btn, { backgroundColor: colors.primary }, pressed && { opacity: 0.8 }]}><Text style={[styles.btnText, { color: colors.onPrimary }]}>Join</Text></Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B1220", alignItems: "center", justifyContent: "space-around", paddingVertical: 80, paddingHorizontal: 20 },
  who: { alignItems: "center", gap: space.xs },
  label: { ...typography.label, color: "#C9D3E0" },
  name: { ...typography.display, color: "#FFFFFF", textAlign: "center" },
  actions: { flexDirection: "row", gap: space.sm, alignSelf: "stretch" },
  btn: { flex: 1, minHeight: 56, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  decline: { backgroundColor: "#D11242" },
  btnText: { ...typography.bodyStrong, color: "#FFFFFF" },
});
