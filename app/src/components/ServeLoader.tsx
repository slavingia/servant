import { useEffect, useId, useMemo, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { ClipPath, Circle, Defs, Ellipse, Path, RadialGradient, Stop } from "react-native-svg";
import { BOX, LOADER_DELAY_MS, LOADER_FADE_MS, SERVE_LOOP_MS, serveKeyframes } from "../lib/serve-loop";
import { useTheme } from "../lib/theme";
import { BALL_SHADOW } from "../lib/theme-colors";

// What the app shows while something loads: the icon's ball, in the primary color with a white S so it shows on
// any page (the icon's own ball is white), bouncing a few times, served away into the
// distance until it is tiny, rallied back and caught on the bounce, over and over. Its shadow stays on the
// ground and grows paler and smaller as the ball rises or goes away. Nothing is drawn behind it.
//
// It takes ActivityIndicator's place where a page, a list or a picture is loading. A spinner inside a button,
// a check box or at the end of a row stays a system spinner: the ball needs room to be served.
//
// It is not drawn for the first quarter of a second (lib/serve-loop.ts says why): it holds its place, and a
// screen reader is told at once that something is loading, but a load that is quick never flashes a ball.

const hidden = Platform.OS === "web" ? { "aria-hidden": true } as const : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;

// The icon's S, in a 100-unit ball: in at the top right, over the top, down through the middle, out at the
// bottom left. Measured from icon.png's seam.
const SEAM = "M92 20 C80 5 52 3 42 17 C33 30 44 41 50 50 C56 59 67 70 58 83 C48 97 20 95 8 80";
const SIZES = { small: 24, large: 40 };
/** Room under the resting ball for its shadow, in diameters. */
const FLOOR = 0.16;

type Props = {
  /** As ActivityIndicator: "small" (24 points across) or "large" (40), or the ball's width. */
  size?: "small" | "large" | number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /** Show at once, with no quarter-second wait: pull to refresh, where the person asked for it. */
  immediate?: boolean;
  /** Rest round and still on its shadow, as with reduced motion: the pull before the refresh starts. */
  still?: boolean;
};

function useReduceMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then(on => { if (live) setReduced(on); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", on => setReduced(on));
    return () => { live = false; sub.remove(); };
  }, []);
  return reduced;
}

export function ServeLoader({ size = "small", accessibilityLabel = "Loading", style, testID, immediate = false, still = false }: Props) {
  const d = typeof size === "number" ? size : SIZES[size];
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { colors } = useTheme();
  const reduced = useReduceMotion() || still;
  const [t] = useState(() => new Animated.Value(0));
  const keys = useMemo(() => serveKeyframes(), []);
  const [shown] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (immediate) { shown.setValue(1); return; }
    const appear = Animated.timing(shown, { toValue: 1, duration: LOADER_FADE_MS, delay: LOADER_DELAY_MS, easing: Easing.linear, useNativeDriver: Platform.OS !== "web" });
    appear.start();
    return () => appear.stop();
  }, [shown, immediate]);

  useEffect(() => {
    if (reduced) return;
    // Each loop starts the next itself: a looped animation on the web plays once and stops on the last frame.
    let live = true;
    let run: Animated.CompositeAnimation | null = null;
    const serve = () => {
      if (!live) return;
      t.setValue(0);
      run = Animated.timing(t, { toValue: 1, duration: SERVE_LOOP_MS, easing: Easing.linear, useNativeDriver: Platform.OS !== "web" });
      run.start(({ finished }) => { if (finished) serve(); });
    };
    serve();
    return () => { live = false; run?.stop(); };
  }, [reduced, t]);

  const at = (output: number[]) => t.interpolate({ inputRange: keys.input, outputRange: output });
  const turn = (output: string[]) => t.interpolate({ inputRange: keys.input, outputRange: output });
  const ball = {
    transform: [
      { translateY: at(keys.y.map(y => -y * d)) },
      { scaleX: at(keys.scale.map((s, i) => s * keys.scaleX[i]!)) },
      { scaleY: at(keys.scale.map((s, i) => s * keys.scaleY[i]!)) },
    ],
  };
  const spin = { transform: [{ rotate: turn(keys.rotate.map(r => `${r}deg`)) }] };
  const shadow = {
    opacity: at(keys.shadowOpacity),
    transform: [{ translateY: at(keys.shadowY.map(y => -y * d)) }, { scale: at(keys.shadowScale) }],
  };
  // With reduced motion the ball rests on its shadow, round and still.
  const ballMotion = reduced ? null : ball, spinMotion = reduced ? null : spin, shadowMotion = reduced ? null : shadow;
  const box = { width: d * BOX.width, height: d * (BOX.height + FLOOR) };
  const ballBox = { width: d, height: d, left: (box.width - d) / 2, bottom: d * FLOOR };
  const shadowBox = { width: d * 1.1, height: d * 0.3, left: (box.width - d * 1.1) / 2, bottom: d * (FLOOR - 0.15) };

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
      style={[styles.center, style]}
    >
      <Animated.View style={[box, { opacity: shown }]} {...hidden}>
        <Animated.View style={[styles.layer, shadowBox, shadowMotion]}>
          <Svg width="100%" height="100%" viewBox="0 0 110 30">
            <Defs>
              <RadialGradient id={`s${id}`} cx="50%" cy="50%" rx="50%" ry="50%">
                <Stop offset="0" stopColor={BALL_SHADOW} stopOpacity={0.4} />
                <Stop offset="0.6" stopColor={BALL_SHADOW} stopOpacity={0.18} />
                <Stop offset="1" stopColor={BALL_SHADOW} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Ellipse cx={55} cy={15} rx={55} ry={15} fill={`url(#s${id})`} />
          </Svg>
        </Animated.View>
        <Animated.View style={[styles.layer, ballBox, ballMotion]}>
          <Animated.View style={[styles.fill, spinMotion]}>
            <Svg width="100%" height="100%" viewBox="0 0 100 100">
              <Defs>
                <ClipPath id={`c${id}`}><Circle cx={50} cy={50} r={50} /></ClipPath>
              </Defs>
              <Circle cx={50} cy={50} r={50} fill={colors.primary} />
              <Path d={SEAM} stroke={colors.onPrimary} strokeWidth={8} strokeLinecap="round" fill="none" clipPath={`url(#c${id})`} />
            </Svg>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  layer: { position: "absolute" },
  fill: { flex: 1 },
});
