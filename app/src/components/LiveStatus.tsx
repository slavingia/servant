import { useEffect, useRef, useState, type ReactNode } from "react";
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

// VoiceOver has no live regions: a new line is spoken, but not more often than this.
const ANNOUNCE_EVERY = 4000;
// One slow breath from our green to our blue and back.
const BREATH = 1400;

// What the agent is doing right now ("Thinking…", "Searching the web…"). The words breathe between our green and
// blue to say it's alive; each new line fades and rises in. The color comes from the theme, not the caller, so
// it reads the same in a chat, the chat list and dark mode. Reduce Motion gets the same words in blue, still.
// `announce` speaks each new line to a screen reader, for the one line a person is waiting on.
export function LiveStatus({ text, style, announce = false }: { text: string; style?: StyleProp<TextStyle>; announce?: boolean }) {
  const still = useReduceMotion();
  const { colors } = useTheme();
  const [breath] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (still) { breath.setValue(1); return; }
    breath.setValue(0);
    const ease = Easing.inOut(Easing.sin);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breath, { toValue: 1, duration: BREATH, easing: ease, useNativeDriver: native }),
      Animated.timing(breath, { toValue: 0, duration: BREATH, easing: ease, useNativeDriver: native }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [still, breath]);

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
    <View aria-live="polite" accessibilityLiveRegion="polite" style={styles.wrap}>
      {/* A new key per line remounts it, so every change fades in fresh. Green underneath, the same words in blue
          on top, and only the blue copy's opacity moves, so the native driver can run it. */}
      <FadeIn key={line} still={still} text={line} style={[style, { color: colors.green }]}>
        <Animated.Text aria-hidden importantForAccessibility="no-hide-descendants"
          style={[style, styles.over, { color: colors.blue, opacity: breath }]}>{line}</Animated.Text>
      </FadeIn>
    </View>
  );
}

/** Words that fade and rise into place once, when they first appear. */
export function FadeIn({ text, still, style, children }: { text: string; still: boolean; style?: StyleProp<TextStyle>; children?: ReactNode }) {
  const [shown] = useState(() => new Animated.Value(still ? 1 : 0));
  useEffect(() => {
    if (still) { shown.setValue(1); return; }
    const anim = Animated.timing(shown, { toValue: 1, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: native });
    anim.start();
    return () => anim.stop();
  }, [still, shown]);
  const rise = shown.interpolate({ inputRange: [0, 1], outputRange: [4, 0] });
  const words = <Animated.Text style={[style, { opacity: shown, transform: [{ translateY: rise }] }]}>{text}</Animated.Text>;
  if (!children) return words;
  // Anything laid over the words (LiveStatus's blue copy) moves with them.
  return <View>{words}<Animated.View style={[styles.cover, { opacity: shown, transform: [{ translateY: rise }] }]}>{children}</Animated.View></View>;
}

const styles = StyleSheet.create({
  wrap: { flexShrink: 1 },
  cover: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, pointerEvents: "none" },
  over: { flexShrink: 0 },
});
