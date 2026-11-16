import { useEffect, useMemo, useRef, useState } from "react";
import { Image, PanResponder, Platform, View, type GestureResponderEvent } from "react-native";
import { clampScale, distance, doubleTapZoom, FIT, midpoint, panZoom, pinchZoom, type Zoom } from "../lib/zoom-gesture";

// Android and the browser have no zooming scroll view (iOS's ScrollView has one), so pinch, drag and
// double tap are worked out here from the raw touches. Fit is the resting state: at fit, one finger is
// left to the gallery for paging and pulling down to close.
export function ZoomableImage({ uri, label, width, height, active, onZoomChange, onError }: {
  uri: string; label: string; width: number; height: number; active: boolean;
  onZoomChange: (zoomed: boolean) => void; onError: () => void;
}) {
  const [zoom, setZoom] = useState<Zoom>(FIT);
  const live = useRef({ zoom: FIT, start: FIT, gap: 0, mid: { x: 0, y: 0 }, fingers: 0, lastTap: 0, moved: false });
  const size = useRef({ width, height, active, onZoomChange });
  // Written after render so the gesture callbacks always read current values.
  useEffect(() => { size.current = { width, height, active, onZoomChange }; });
  const apply = (next: Zoom) => {
    const was = live.current.zoom.scale > 1.01;
    live.current.zoom = next;
    setZoom(next);
    const now = next.scale > 1.01;
    if (now !== was && size.current.active) size.current.onZoomChange(now);
  };
  const pan = useMemo(() => {
    // The picture ignores touches, so locationX/Y are always measured in the fixed frame.
    const points = (event: GestureResponderEvent) => event.nativeEvent.touches.map(p => ({ x: p.locationX - size.current.width / 2, y: p.locationY - size.current.height / 2 }));
    const begin = (event: GestureResponderEvent) => {
      const state = live.current;
      const t = points(event);
      state.start = state.zoom;
      state.fingers = t.length;
      if (t.length >= 2) { state.gap = distance(t[0], t[1]); state.mid = midpoint(t[0], t[1]); }
    };
    // create only registers these callbacks; refs are read during gestures.
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: event => event.nativeEvent.touches.length >= 2 || live.current.zoom.scale > 1.01,
      onMoveShouldSetPanResponderCapture: event => event.nativeEvent.touches.length >= 2 || live.current.zoom.scale > 1.01,
      onPanResponderGrant: begin,
      onPanResponderStart: begin,
      onPanResponderMove: (event, gesture) => {
        const state = live.current;
        const { width: w, height: h } = size.current;
        const t = points(event);
        state.moved = true;
        if (t.length >= 2) {
          if (state.fingers < 2) { begin(event); return; }
          apply(pinchZoom(state.start, { mid: state.mid, gap: state.gap }, { mid: midpoint(t[0], t[1]), gap: distance(t[0], t[1]) }, w, h));
        } else if (state.fingers < 2) {
          apply(panZoom(state.start, gesture.dx, gesture.dy, w, h));
        }
      },
      onPanResponderRelease: () => { const z = live.current.zoom; apply(z.scale < 1.05 ? FIT : { ...z, scale: clampScale(z.scale) }); },
      onPanResponderTerminationRequest: () => false,
    });
  }, []);
  const tap = (event: GestureResponderEvent) => {
    const state = live.current;
    const now = Date.now();
    if (state.moved || event.nativeEvent.touches.length) { state.lastTap = 0; return; }
    if (now - state.lastTap < 300) {
      state.lastTap = 0;
      apply(doubleTapZoom(state.zoom, { x: event.nativeEvent.locationX - width / 2, y: event.nativeEvent.locationY - height / 2 }, width, height));
    } else state.lastTap = now;
  };
  return <View {...pan.panHandlers} onTouchStart={() => { live.current.moved = false; }} onTouchEnd={tap} style={[{ width, height, overflow: "hidden" }, Platform.OS === "web" ? ({ touchAction: "none" } as object) : null]}>
    <Image pointerEvents="none" source={{ uri }} resizeMode="contain" accessibilityLabel={label} onError={onError}
      style={{ width, height, transform: [{ translateX: zoom.x }, { translateY: zoom.y }, { scale: zoom.scale }] }} />
  </View>;
}
