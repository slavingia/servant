import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { useLiveList } from "../lib/live";
import { UNREACHABLE_MESSAGE } from "../lib/unreachable";
import { space, typography, useTheme } from "../lib/theme";

// The server can't be reached: a red bar at the very top that paints the status bar area too, so it is the
// first thing seen on every screen. It goes away by itself once the connection is back.
export function OfflineBanner({ topInset = 0 }: { topInset?: number }) {
  const { unreachable } = useLiveList();
  const { colors } = useTheme();
  if (!unreachable) return null;
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={[styles.root, { backgroundColor: colors.danger, paddingTop: space.sm + topInset }]}>
      <StatusBar style="light" />
      <Text style={[styles.text, { color: colors.white }]}>{UNREACHABLE_MESSAGE}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: space.side, paddingBottom: space.sm },
  text: { ...typography.bodyStrong, textAlign: "center" },
});
