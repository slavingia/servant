import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { radius, space, useTheme } from "../lib/theme";

// Placeholder shapes shown while something loads, so the screen keeps its shape
// instead of showing a spinner. They pulse unless Reduce Motion is on, and start
// at full strength: the launch screen's still frames (the iOS launch screen and
// the web page before its script runs) hand over to them without a flicker.
function usePulse() {
  const [value] = useState(() => new Animated.Value(1));
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(on => { if (active) setReduced(on); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (reduced) { value.setValue(0.7); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(value, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      Animated.timing(value, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reduced, value]);
  return value;
}

/** Shapes that pulse together. With a label, a screen reader hears one "loading" for the lot. */
export function Pulse({ label, style, children }: { label?: string; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const opacity = usePulse();
  return (
    <Animated.View accessible={!!label} accessibilityRole={label ? "progressbar" : undefined} accessibilityLabel={label} accessibilityState={label ? { busy: true } : undefined} style={[style, { opacity }]}>
      {children}
    </Animated.View>
  );
}

export function SkeletonRows({ label, count = 7, avatar = true, style }: { label: string; count?: number; avatar?: boolean; style?: ViewStyle }) {
  const { colors } = useTheme();
  const opacity = usePulse();
  const fill = { backgroundColor: colors.line };
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }} style={[styles.list, style]}>
      {Array.from({ length: count }, (_, i) => (
        <Animated.View key={i} style={[styles.row, { opacity }]}>
          {avatar ? <View style={[styles.avatar, fill]} /> : null}
          <View style={styles.lines}>
            <View style={[styles.line, fill, { width: `${46 + ((i * 17) % 30)}%` }]} />
            <View style={[styles.line, styles.short, fill, { width: `${70 - ((i * 13) % 25)}%` }]} />
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingTop: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.sm, minHeight: 64 },
  avatar: { width: 40, height: 40, borderRadius: radius.md },
  lines: { flex: 1, gap: 8 },
  line: { height: 12, borderRadius: radius.pill },
  short: { height: 10 },
});
