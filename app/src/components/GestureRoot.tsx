import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

// Gestures recognised off the app's script (the swipe on a conversation's row) need this around the app on a
// phone. The browser's copy (GestureRoot.web.tsx) adds nothing.
export function GestureRoot({ children }: { children: ReactNode }) {
  return <GestureHandlerRootView style={styles.fill}>{children}</GestureHandlerRootView>;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
