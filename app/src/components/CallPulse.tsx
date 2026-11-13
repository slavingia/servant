import { useEffect, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, Text, View } from "react-native";
import { createThemedStyles } from "../lib/theme";

/** Three rings that swell and fade around a centred initial: the call is ringing, even with the phone silent. */
export function CallPulse({ initial, size = 112 }: { initial: string; size?: number }) {
  const styles = useStyles();
  const [rings] = useState(() => [0, 1, 2].map(() => new Animated.Value(0)));
  useEffect(() => {
    const loops = rings.map((v, i) => Animated.loop(Animated.sequence([
      Animated.delay(i * 600),
      Animated.timing(v, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: Platform.OS !== "web" }),
    ])));
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [rings]);
  const box = size * 2.4;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: box, height: box, alignItems: "center", justifyContent: "center" }}>
      {rings.map((v, i) => (
        <Animated.View key={i} style={[styles.ring, { width: size, height: size, borderRadius: size / 2, opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }] }]} />
      ))}
      <View style={[styles.core, { width: size, height: size, borderRadius: size / 2 }]}><Text style={[styles.initial, { fontSize: size * 0.4 }]}>{initial.slice(0, 1).toUpperCase()}</Text></View>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  ring: { position: "absolute", backgroundColor: colors.primary },
  core: { backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  initial: { color: colors.onPrimary, fontWeight: "700" },
}));
