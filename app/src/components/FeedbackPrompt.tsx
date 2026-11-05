import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Dimensions, Platform, View } from "react-native";
import { usePathname } from "expo-router";
import * as Haptics from "expo-haptics";
import { Accelerometer } from "expo-sensors";
import * as ScreenCapture from "expo-screen-capture";
import { captureScreen } from "react-native-view-shot";
import { FeedbackSketch, type Shot } from "./FeedbackSketch";
import { createShakeDetector, feedbackPromptAllowed, supportsScreenshotFeedback } from "../lib/feedback-trigger";
import { useSession } from "../lib/session";

type Reason = "shake" | "screenshot";

// Shake the phone, or take a screenshot, and Servant captures this screen so
// you can circle the problem and send it straight to the agent. Replaces the hold-for-five-seconds gesture, which
// was hard to discover and fought with scrolling (owner, 10/31).
export function FeedbackPrompt({ children }: { children: ReactNode }) {
  const { account } = useSession();
  const pathname = usePathname();
  const capturing = useRef(false);
  const [shot, setShot] = useState<Shot | null>(null);
  const shotOpen = useRef(false);
  const [active, setActive] = useState(AppState.currentState === "active");
  const allowed = feedbackPromptAllowed(pathname, !!account) && Platform.OS !== "web";
  const screenshotAllowed = allowed && supportsScreenshotFeedback(Platform.OS, Platform.Version);
  // Grab the screen the instant it happens, then open the markup view on it.
  const offer = useCallback((why: Reason) => {
    if (capturing.current || shotOpen.current) return;
    capturing.current = true;
    const { width, height } = Dimensions.get("window");
    captureScreen({ format: "jpg", quality: 0.9, result: "tmpfile" })
      .then((uri) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        shotOpen.current = true;
        setShot({ uri, width, height, screen: pathname, via: why });
      })
      .catch(() => {})
      .finally(() => { capturing.current = false; });
  }, [pathname]);

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

  return (
    <View style={{ flex: 1 }}>
      {children}
      <FeedbackSketch shot={shot} onClose={() => { shotOpen.current = false; setShot(null); }} />
    </View>
  );
}
