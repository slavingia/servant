import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View, type StyleProp, type TextStyle } from "react-native";
import { useTheme } from "../lib/theme";

const native = Platform.OS !== "web";

/** True when the person has asked for less motion: the words stay, the movement goes. */
export function useReduceMotion() {
  const [still, setStill] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then(on => { if (live) setStill(on); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", on => setStill(on));
    return () => { live = false; sub.remove(); };
  }, []);
  return still;
}

// The soft light that passes over the words: thin strips of the page's own color, faintest at the edges, so the
// words under it ease out and back in. No gradient or mask is needed, and it reads the same in light and dark.
const VEIL = [0.1, 0.22, 0.36, 0.5, 0.58, 0.5, 0.36, 0.22, 0.1];
const STRIP = 9;
const BAND = VEIL.length * STRIP;
// VoiceOver has no live regions: a new line is spoken, but not more often than this.
const ANNOUNCE_EVERY = 4000;

// What the agent is doing right now ("Thinking…", "Searching the web…"). A soft light passes over the words to
// say it's alive; each new line fades and rises in. Reduce Motion gets the same words, still. `announce` speaks
// each new line to a screen reader, for the one line a person is waiting on.
export function LiveStatus({ text, style, announce = false }: { text: string; style?: StyleProp<TextStyle>; announce?: boolean }) {
  const still = useReduceMotion();
  const { colors } = useTheme();
  const [sweep] = useState(() => new Animated.Value(0));
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (still || !width) return;
    sweep.setValue(0);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(sweep, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
      Animated.delay(500),
    ]));
    loop.start();
    return () => loop.stop();
  }, [still, width, sweep]);

  const line = `${text.replace(/[.…]+$/, "")}…`;
  const spoken = useRef(0);
  useEffect(() => {
    if (!announce || Platform.OS !== "ios" || Date.now() - spoken.current < ANNOUNCE_EVERY) return;
    spoken.current = Date.now();
    AccessibilityInfo.announceForAccessibility(line);
  }, [announce, line]);

  return (
    // The live region is this box, which stays put: the line inside is a new element each time, and a screen
    // reader only speaks changes inside something it already knows.
    <View aria-live="polite" accessibilityLiveRegion="polite" onLayout={e => setWidth(e.nativeEvent.layout.width)} style={styles.wrap}>
      {/* A new key per line remounts it, so every change fades in fresh. */}
      <FadeIn key={line} still={still} text={line} style={style} />
      {!still && width ? (
        <Animated.View aria-hidden importantForAccessibility="no-hide-descendants"
          style={[styles.band, { transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-BAND, width] }) }] }]}>
          {VEIL.map((opacity, i) => <View key={i} style={[styles.strip, { backgroundColor: colors.background, opacity }]} />)}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** Words that fade and rise into place once, when they first appear. */
export function FadeIn({ text, still, style }: { text: string; still: boolean; style?: StyleProp<TextStyle> }) {
  const [shown] = useState(() => new Animated.Value(still ? 1 : 0));
  useEffect(() => {
    if (still) { shown.setValue(1); return; }
    const anim = Animated.timing(shown, { toValue: 1, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: native });
    anim.start();
    return () => anim.stop();
  }, [still, shown]);
  const rise = shown.interpolate({ inputRange: [0, 1], outputRange: [4, 0] });
  return <Animated.Text style={[style, { opacity: shown, transform: [{ translateY: rise }] }]}>{text}</Animated.Text>;
}

const styles = StyleSheet.create({
  // Clipped to the words, so the light never touches what sits beside them.
  wrap: { flexShrink: 1, overflow: "hidden" },
  band: { position: "absolute", top: 0, bottom: 0, left: 0, width: BAND, flexDirection: "row", pointerEvents: "none" },
  strip: { width: STRIP },
});
