import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppState, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { router, usePathname } from "expo-router";
import * as Haptics from "expo-haptics";
import { Accelerometer } from "expo-sensors";
import * as ScreenCapture from "expo-screen-capture";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "./Button";
import { createShakeDetector, feedbackPromptAllowed, supportsScreenshotFeedback } from "../lib/feedback-trigger";
import { useSession } from "../lib/session";
import { radius, space, typography, createThemedStyles } from "../lib/theme";

type Reason = "shake" | "screenshot";

// Shake the phone, or take a screenshot, and Servant offers to report a
// problem on this screen. Replaces the hold-for-five-seconds gesture, which
// was hard to discover and fought with scrolling (owner, 10/31).
export function FeedbackPrompt({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { account } = useSession();
  const pathname = usePathname();
  // The prompt remembers the screen it was opened on.
  const [prompt, setPrompt] = useState<{ reason: Reason; screen: string } | null>(null);
  const reason = prompt?.reason ?? null;
  const [active, setActive] = useState(AppState.currentState === "active");
  const allowed = feedbackPromptAllowed(pathname, !!account) && Platform.OS !== "web";
  const screenshotAllowed = allowed && supportsScreenshotFeedback(Platform.OS, Platform.Version);
  const offer = useCallback((why: Reason) => {
    setPrompt((open) => open ?? { reason: why, screen: pathname });
  }, [pathname]);
  useEffect(() => {
    if (prompt) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  }, [prompt]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);

  // Only listen while it could matter: paired, foreground, on a normal screen.
  useEffect(() => {
    if (!allowed || !active) return;
    const push = createShakeDetector();
    Accelerometer.setUpdateInterval(50);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      if (push({ x, y, z, t: Date.now() })) offer("shake");
    });
    return () => sub.remove();
  }, [allowed, active, offer]);

  useEffect(() => {
    if (!screenshotAllowed || !active) return;
    // Android 14+ and iOS report screenshots without any permission.
    const sub = ScreenCapture.addScreenshotListener(() => offer("screenshot"));
    return () => sub.remove();
  }, [screenshotAllowed, active, offer]);

  const close = () => setPrompt(null);
  const report = () => {
    if (!prompt) return;
    setPrompt(null);
    router.push({ pathname: "/feedback", params: { screen: prompt.screen, via: prompt.reason } });
  };

  return (
    <View style={{ flex: 1 }}>
      {children}
      <Modal visible={!!reason} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
        <Pressable style={styles.scrim} onPress={close} accessibilityLabel="Dismiss" accessibilityRole="button" />
        <View
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.md) + space.xs }]}
          accessibilityViewIsModal
          testID="feedback-prompt"
        >
          <Text accessibilityRole="header" style={styles.title}>Something wrong here?</Text>
          <Text style={styles.body}>
            {reason === "screenshot"
              ? "Tell us what you noticed. We'll include which screen this is."
              : "Tell us what went wrong. We'll include which screen this is."}
          </Text>
          <Button label="Report a problem" onPress={report} />
          <Button label="Not now" kind="secondary" onPress={close} />
        </View>
      </Modal>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.side,
    paddingTop: space.lg,
    gap: space.sm,
  },
  title: { ...typography.title, color: colors.ink },
  body: { ...typography.body, color: colors.muted, marginBottom: space.xs },
}));
