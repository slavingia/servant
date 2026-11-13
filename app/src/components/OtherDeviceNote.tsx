import { StyleSheet, Text, View } from "react-native";
import { useActiveCall } from "../lib/active-call";
import { OTHER_DEVICE_NOTE } from "../lib/call-audio";
import { radius, space, typography } from "../lib/theme";

/** A quiet line while the same account is on the call from another device too. */
export function OtherDeviceNote() {
  const active = useActiveCall();
  const s = active?.state;
  if (!s?.otherDevice || s.status === "ended" || s.status === "failed") return null;
  return (
    <View testID="other-device-note" accessibilityLiveRegion="polite" style={styles.note}>
      <Text style={styles.text}>{OTHER_DEVICE_NOTE}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: { marginHorizontal: 20, marginBottom: space.sm, paddingHorizontal: space.sm, paddingVertical: 8, borderRadius: radius.md, backgroundColor: "#1B2433" },
  text: { ...typography.caption, color: "#C9D3E0" },
});
