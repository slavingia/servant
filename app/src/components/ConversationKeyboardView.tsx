import { useCallback, useLayoutEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { AccessibilityInfo, Keyboard, Platform, StyleSheet, View, type KeyboardEvent, type KeyboardMetrics } from "react-native";
import { keyboardOverlap } from "../lib/keyboard-layout";

// Measure the unchanged outer frame, including the native header and app chrome.
// Unlike summing header offsets, this also works after Android resizes its window.
export function ConversationKeyboardView({ children }: { children: ReactNode }) {
  const view = useRef<ComponentRef<typeof View>>(null);
  const keyboard = useRef<KeyboardMetrics | undefined>(Platform.OS === "web" ? undefined : Keyboard.metrics());
  const measurement = useRef(0);
  const [bottom, setBottom] = useState(0);
  const update = useCallback((event?: KeyboardEvent) => {
    const current = ++measurement.current;
    if (!keyboard.current) { setBottom(0); return; }
    view.current?.measureInWindow(async (x, y, width, height) => {
      // iOS reports a zero keyboard origin with Prefer Cross-Fade Transitions.
      // Preserve React Native’s accessibility guard rather than collapse the pane.
      const crossFade = Platform.OS === "ios" && keyboard.current?.screenY === 0
        && await AccessibilityInfo.prefersCrossFadeTransitions();
      if (current !== measurement.current) return;
      if (event) Keyboard.scheduleLayoutAnimation(event);
      setBottom(crossFade ? 0 : keyboardOverlap({ x, y, width, height }, keyboard.current));
    });
  }, []);

  const invalidate = useCallback(() => { measurement.current++; }, []);

  useLayoutEffect(() => {
    if (Platform.OS === "web") return;
    const show = (event: KeyboardEvent) => { keyboard.current = event.endCoordinates; update(event); };
    const hide = (event: KeyboardEvent) => { keyboard.current = undefined; Keyboard.scheduleLayoutAnimation(event); update(); };
    const subscriptions = Platform.OS === "ios"
      ? [Keyboard.addListener("keyboardWillShow", show), Keyboard.addListener("keyboardWillChangeFrame", show), Keyboard.addListener("keyboardWillHide", hide), Keyboard.addListener("keyboardDidShow", show), Keyboard.addListener("keyboardDidHide", hide)]
      : [Keyboard.addListener("keyboardDidShow", show), Keyboard.addListener("keyboardDidHide", hide)];
    // A new conversation can mount while a keyboard is already on screen.
    keyboard.current = Keyboard.metrics();
    update();
    return () => {
      // Invalidate pending native measurements rather than reading a captured node.
      invalidate();
      subscriptions.forEach(subscription => subscription.remove());
    };
  }, [update, invalidate]);

  return <View ref={view} collapsable={false} onLayout={() => update()} style={[styles.root, { paddingBottom: bottom }]}>{children}</View>;
}

const styles = StyleSheet.create({ root: { flex: 1, minHeight: 0 } });
