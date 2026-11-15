import { useEffect, type ReactNode } from "react";
import { type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { cancelAnimation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { SETTLE_MS, swipePosition, swipeReveals } from "../lib/swipe-row";

export type SwipeSurfaceProps = {
  /** Is the row slid open, showing what is behind it? */
  open: boolean;
  /** How far it slides, in points: the width of what is behind it. */
  width: number;
  /** Can it be dragged right now? */
  enabled: boolean;
  /** Let go: should it be open? Called for every release, also when the answer is what it already was. */
  onSettle: (reveal: boolean) => void;
  rowStyle?: StyleProp<ViewStyle>;
  /** What is behind the row, and where it sits. It is invisible until the row has moved. */
  behind: ReactNode;
  behindStyle?: StyleProp<ViewStyle>;
  behindProps?: ViewProps;
  children: ReactNode;
};

// A row that slides left to show what is behind it, on a phone. The drag is recognised by Gesture Handler and
// the row is moved by Reanimated, both on the interface thread, so the row follows the finger without a round
// trip through the app's script. The browser has its own copy (SwipeSurface.web.tsx), which leaves these two
// libraries out of the page.
export function SwipeSurface({ open, width, enabled, onSettle, rowStyle, behind, behindStyle, behindProps, children }: SwipeSurfaceProps) {
  const x = useSharedValue(0);
  const from = useSharedValue(0);
  useEffect(() => {
    x.set(withTiming(open ? -width : 0, { duration: SETTLE_MS }));
  }, [open, width, x]);
  const pan = usePanGesture({
    enabled,
    // Sideways only: a drag that starts up or down belongs to the list.
    activeOffsetX: [-12, 12],
    failOffsetY: [-12, 12],
    onActivate: () => {
      "worklet";
      cancelAnimation(x);
      from.set(x.get());
    },
    onUpdate: e => {
      "worklet";
      x.set(swipePosition(from.get(), e.translationX, width));
    },
    onDeactivate: e => {
      "worklet";
      // A drag taken away by something else closes the row.
      const reveal = !e.canceled && swipeReveals(from.get() + e.translationX, e.velocityX, width);
      // Also settle when the requested open state hasn't changed.
      x.set(withTiming(reveal ? -width : 0, { duration: SETTLE_MS }));
      runOnJS(onSettle)(reveal);
    },
  });
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  const shown = useAnimatedStyle(() => ({ opacity: interpolate(x.get(), [-1, 0], [1, 0], "clamp") }));
  return (
    <>
      <GestureDetector gesture={pan}>
        <Animated.View style={[rowStyle, moved]}>{children}</Animated.View>
      </GestureDetector>
      <Animated.View {...behindProps} style={[behindStyle, { width }, shown]}>{behind}</Animated.View>
    </>
  );
}
