import { Pressable, StyleSheet, Text, View } from "react-native";
import { useCallAwake } from "../lib/call-awake";
import { router, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { leaveCall, useActiveCall } from "../lib/active-call";
import { useCallClock } from "../lib/call-clock";
import { radius, space, typography } from "../lib/theme";
import { useFeature } from "../lib/features";

/** While you're on a call and looking at something else: a green bar on every screen to go back. */
export function ActiveCallBar({ safeTop = false }: { safeTop?: boolean }) {
  const active = useActiveCall();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const live = !!active && !["ended", "failed"].includes(active.state.status);
  const clock = useCallClock(live ? active?.state.startedAt : undefined);
  const meetings = useFeature("meetings");
  if (!live || !active || !meetings || pathname.startsWith("/meeting/")) return null;
  return (
    <View style={[styles.bar, { paddingTop: (safeTop ? insets.top : 0) + 8 }]}>
      <KeepAwake />
      <Pressable testID="active-call-bar" accessibilityRole="button" accessibilityLabel={`Return to the call${clock ? `, ${clock}` : ""}`}
        onPress={() => router.push({ pathname: "/meeting/[id]", params: { id: active.id } })} style={styles.back}>
        <View style={styles.dot} />
        <Text style={styles.text} numberOfLines={1}>On a call</Text>
        {clock ? <Text style={styles.time}>{clock}</Text> : null}
        <View style={styles.return}><Text style={styles.returnText}>Return</Text></View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Leave the call" onPress={() => void leaveCall()} style={({ pressed }) => [styles.leave, pressed && { opacity: 0.8 }]}>
        <Text style={styles.leaveText}>Leave</Text>
      </Pressable>
    </View>
  );
}

// The screen stays on for the whole call, wherever you are in the app.
function KeepAwake() { useCallAwake(); return null; }

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.side, paddingBottom: 4, backgroundColor: "#1E7B34" },
  back: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 44 },
  dot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: "#FFFFFF" },
  text: { ...typography.bodyStrong, color: "#FFFFFF", flexShrink: 1 },
  time: { ...typography.bodyStrong, color: "#FFFFFF", fontVariant: ["tabular-nums"] },
  return: { marginLeft: "auto", minHeight: 32, paddingHorizontal: space.sm, borderRadius: radius.pill, justifyContent: "center", backgroundColor: "#FFFFFF" },
  returnText: { ...typography.label, color: "#1E7B34" },
  leave: { minHeight: 44, paddingHorizontal: space.xs, justifyContent: "center" },
  leaveText: { ...typography.label, color: "#FFFFFF", textDecorationLine: "underline" },
});
