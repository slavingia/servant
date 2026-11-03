import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, type StyleProp, type TextStyle } from "react-native";

const native = Platform.OS !== "web";

// What the agent is doing right now ("Thinking…", "Searching the web…").
// A slow breathing fade says it's alive; each new line fades and rises in.
// Reduce Motion gets the same words without movement.
export function LiveStatus({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const [still, setStill] = useState(false);
  const [breath] = useState(() => new Animated.Value(1));

  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then(on => { if (live) setStill(on); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", on => setStill(on));
    return () => { live = false; sub.remove(); };
  }, []);

  useEffect(() => {
    if (still) { breath.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breath, { toValue: 0.55, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
      Animated.timing(breath, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [still, breath]);

  const line = `${text.replace(/[.…]+$/, "")}…`;
  return (
    <Animated.View style={{ opacity: breath, flexShrink: 1 }}>
      {/* A new key per line remounts it, so every change fades in fresh. */}
      <FadeIn key={line} still={still} text={line} style={style} />
    </Animated.View>
  );
}

function FadeIn({ text, still, style }: { text: string; still: boolean; style?: StyleProp<TextStyle> }) {
  const [shown] = useState(() => new Animated.Value(still ? 1 : 0));
  useEffect(() => {
    if (still) { shown.setValue(1); return; }
    const anim = Animated.timing(shown, { toValue: 1, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: native });
    anim.start();
    return () => anim.stop();
  }, [still, shown]);
  const rise = shown.interpolate({ inputRange: [0, 1], outputRange: [4, 0] });
  return (
    <Animated.Text accessibilityLiveRegion="polite" style={[style, { opacity: shown, transform: [{ translateY: rise }] }]}>
      {text}
    </Animated.Text>
  );
}
