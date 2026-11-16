import { useEffect, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useReduceMotion } from "./LiveStatus";
import { createThemedStyles, radius, space } from "../lib/theme";

const native = Platform.OS !== "web";

// Under a reply's live line when the server has an estimate (lib/agent-turns.ts, replyTime): a thin bar for how
// far the reply is through the time replies like it usually take, with the words "about 17 min left" drawn beside the live line by the caller.
// The same row in a chat and on the Agent tab, so the times line up down the list.
//
// The bar is there only while there is time left on the estimate. Before the first minute is up there is
// nothing; once the usual time is spent the bar goes and the words say so ("21 min, longer than usual"), so it
// is never a bar that sits full. It carries no number of its own: nobody measured a percentage, and a screen
// reader hears the words. A reply waiting for the person's OK keeps its bar where it was, in grey.
export function ReplyBar({ progress, paused, style }: { progress: number; paused: boolean; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  return <View testID="reply-time" style={[styles.row, style]}><Track progress={progress} paused={paused} /></View>;
}

// Each new position is eased to. Reduce Motion gets the same bar, placed without the glide.
function Track({ progress, paused }: { progress: number; paused: boolean }) {
  const styles = useStyles();
  const still = useReduceMotion();
  const [at] = useState(() => new Animated.Value(progress));
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (still) { at.setValue(progress); return; }
    const glide = Animated.timing(at, { toValue: progress, duration: 600, easing: Easing.out(Easing.quad), useNativeDriver: native });
    glide.start();
    return () => glide.stop();
  }, [still, progress, at]);

  return (
    <View testID="reply-bar" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      onLayout={e => setWidth(e.nativeEvent.layout.width)} style={styles.track}>
      {/* The fill is as wide as the track and slides in from its left edge, so it moves without being laid out again. */}
      {width ? <Animated.View style={[styles.fill, paused && styles.held, { transform: [{ translateX: at.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] }) }] }]} /> : null}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  row: { alignSelf: "flex-start", maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: space.xs },
  // The same length on a phone and in a wide window. It gives way before the words beside it do.
  track: { width: 160, flexShrink: 1, minWidth: 64, height: space.xxs, borderRadius: radius.pill, backgroundColor: colors.line, overflow: "hidden" },
  fill: { width: "100%", height: space.xxs, borderRadius: radius.pill, backgroundColor: colors.blue },
  held: { backgroundColor: colors.borderStrong },
}));
