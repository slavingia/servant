import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Platform, StyleSheet, type LayoutChangeEvent } from "react-native";
import * as Haptics from "expo-haptics";
import { dropIndex, moveId } from "../lib/channel-sort";
import { createThemedStyles } from "../lib/theme";

const buzz = (strong = false) => {
  if (Platform.OS === "web") return;
  void (strong ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium) : Haptics.selectionAsync()).catch(() => {});
};

export type DragBindings = {
  /** Long press anywhere on the row: lift it so the same touch can drag it. */
  onLongPress: (e: { nativeEvent: { pageY: number } }) => void;
  /** Touching the grip lifts the row straight away. */
  gripProps: { onStartShouldSetResponder: () => boolean; onResponderGrant: (e: { nativeEvent: { pageY: number } }) => void; onResponderRelease: () => void };
  /** This row is lifted (no pressed tint: the lift style shows it). */
  lifted: boolean;
  /** VoiceOver / TalkBack: move one place at a time. */
  accessibilityActions: { name: string; label: string }[];
  onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => void;
};

type Drag = { from: number; to: number; h: number };

// A short list whose rows can be dragged into a new order. Long press lifts a
// row (the parent turns off scrolling until the finger comes up); dragging
// moves it; letting go calls onDrop with every ID in the new order.
export function ReorderableList<T extends { id: string }>({ items, onLift, onSettle, onDrop, renderRow }: {
  items: readonly T[];
  onLift: () => void;
  onSettle: () => void;
  onDrop: (ids: string[]) => void;
  renderRow: (item: T, bind: DragBindings) => ReactNode;
}) {
  const [layouts] = useState<{ y: number; h: number }[]>(() => []);
  const [dy] = useState(() => new Animated.Value(0));
  const [armed, setArmed] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The same drag, readable from touch handlers without waiting for a render.
  const dragNow = useRef<Drag | null>(null);
  // Where the finger was when the row lifted. Drag distance is measured from
  // here, so the movement before the pan takes over isn't lost.
  const [startY, setStartY] = useState(0);
  const update = (next: Drag | null) => { dragNow.current = next; setDrag(next); };
  const ids = items.map(item => item.id);

  const arm = (index: number, pageY: number) => { setStartY(pageY); setArmed(index); buzz(true); onLift(); };
  const disarm = () => { if (!drag && armed !== null) { setArmed(null); onSettle(); } };
  const finish = () => {
    const current = dragNow.current;
    dy.setValue(0);
    update(null);
    setArmed(null);
    onSettle();
    if (current && current.to !== current.from) onDrop(moveId(ids, current.from, current.to));
  };
  const move = (index: number, by: number) => {
    const to = Math.max(0, Math.min(ids.length - 1, index + by));
    if (to !== index) onDrop(moveId(ids, index, to));
  };

  return <>
    {items.map((item, index) => {
      const shift = !drag || index === drag.from ? 0
        : drag.from < index && index <= drag.to ? -drag.h
        : drag.to <= index && index < drag.from ? drag.h : 0;
      return <DragRow key={item.id} index={index} armed={armed === index} dragging={drag?.from === index} shift={shift} dy={dy}
        onLayout={e => { layouts[index] = { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height }; }}
        onStart={() => update({ from: index, to: index, h: layouts[index]?.h ?? 0 })}
        onMove={(pageY) => {
          const dragY = pageY - startY;
          dy.setValue(dragY);
          const to = dropIndex(layouts, index, dragY);
          const current = dragNow.current;
          if (current && current.to !== to) { buzz(); update({ ...current, to }); }
        }}
        onEnd={finish}
        onTouchEnd={disarm}>
        {renderRow(item, {
          onLongPress: e => arm(index, e.nativeEvent.pageY),
          gripProps: { onStartShouldSetResponder: () => true, onResponderGrant: e => arm(index, e.nativeEvent.pageY), onResponderRelease: disarm },
          lifted: armed === index || drag?.from === index,
          accessibilityActions: [
            ...(index > 0 ? [{ name: "moveUp", label: "Move up" }] : []),
            ...(index < items.length - 1 ? [{ name: "moveDown", label: "Move down" }] : []),
          ],
          onAccessibilityAction: e => { if (e.nativeEvent.actionName === "moveUp") move(index, -1); if (e.nativeEvent.actionName === "moveDown") move(index, 1); },
        })}
      </DragRow>;
    })}
  </>;
}

function DragRow({ armed, dragging, shift, dy, onLayout, onStart, onMove, onEnd, onTouchEnd, children }: {
  index: number; armed: boolean; dragging: boolean; shift: number; dy: Animated.Value;
  onLayout: (e: LayoutChangeEvent) => void; onStart: () => void; onMove: (pageY: number) => void; onEnd: () => void; onTouchEnd: () => void;
  children: ReactNode;
}) {
  const styles = useStyles();
  const [offset] = useState(() => new Animated.Value(0));
  // The responder is made once; it reads the newest callbacks from here.
  const live = useRef({ armed, onStart, onMove, onEnd });
  useEffect(() => { live.current = { armed, onStart, onMove, onEnd }; });
  useEffect(() => {
    const animation = Animated.timing(offset, { toValue: shift, duration: 140, useNativeDriver: Platform.OS !== "web" });
    animation.start();
    return () => animation.stop();
  }, [offset, shift]);
  // Made once so a drag survives re-renders; the ref is only read inside touch handlers.
  // eslint-disable-next-line react-hooks/refs
  const [pan] = useState(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: () => live.current.armed,
    onMoveShouldSetPanResponder: () => live.current.armed,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => live.current.onStart(),
    onPanResponderMove: (_, g) => live.current.onMove(g.moveY),
    onPanResponderRelease: () => live.current.onEnd(),
    onPanResponderTerminate: () => live.current.onEnd(),
  }));
  return <Animated.View onLayout={onLayout} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd} {...pan.panHandlers}
    style={[{ transform: [{ translateY: dragging ? dy : offset }] }, (dragging || armed) && styles.lifted]}>
    {children}
  </Animated.View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  lifted: {
    zIndex: 10,
    backgroundColor: colors.background,
    elevation: 6,
    shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
}));
