import { useEffect, useMemo, useState } from "react";
import { Animated, PanResponder } from "react-native";
import { SETTLE_MS, swipePosition, swipeReveals } from "../lib/swipe-row";
import type { SwipeSurfaceProps } from "./SwipeSurface";

// The browser's and the Mac app's copy of SwipeSurface.tsx. A page has one thread, so there is nothing to gain
// from the phone's gesture and animation libraries here, and leaving them out keeps about 290 KB (compressed)
// off every first load. Where the row comes to rest is the same arithmetic (lib/swipe-row.ts).
export function SwipeSurface({ open, width, enabled, onSettle, rowStyle, behind, behindStyle, behindProps, children }: SwipeSurfaceProps) {
  const [x] = useState(() => new Animated.Value(0));
  const shown = useMemo(() => x.interpolate({ inputRange: [-1, 0], outputRange: [1, 0], extrapolate: "clamp" }), [x]);
  useEffect(() => {
    const animation = Animated.timing(x, { toValue: open ? -width : 0, duration: SETTLE_MS, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [open, width, x]);
  const pan = useMemo(() => {
    const from = open ? -width : 0;
    const settle = (reveal: boolean) => {
      onSettle(reveal);
      // Also settle when the requested open state hasn't changed.
      Animated.timing(x, { toValue: reveal ? -width : 0, duration: SETTLE_MS, useNativeDriver: true }).start();
    };
    return PanResponder.create({
      // Sideways only: a drag that starts up or down belongs to the list.
      onMoveShouldSetPanResponder: (_, g) => enabled && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderGrant: () => { x.stopAnimation(); },
      onPanResponderMove: (_, g) => x.setValue(swipePosition(from, g.dx, width)),
      // The browser reports speed in points a millisecond.
      onPanResponderRelease: (_, g) => settle(swipeReveals(from + g.dx, g.vx * 1000, width)),
      // A drag taken away by something else closes the row.
      onPanResponderTerminate: () => settle(false),
    });
  }, [enabled, onSettle, open, width, x]);
  return (
    <>
      <Animated.View {...pan.panHandlers} style={[rowStyle, { transform: [{ translateX: x }] }]}>{children}</Animated.View>
      <Animated.View {...behindProps} style={[behindStyle, { width, opacity: shown }]}>{behind}</Animated.View>
    </>
  );
}
