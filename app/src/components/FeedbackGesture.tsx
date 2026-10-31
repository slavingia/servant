import { useEffect, useRef, type ReactNode } from "react";
import { AppState, View, type GestureResponderEvent } from "react-native";
import { router, usePathname } from "expo-router";
import { useSession } from "../lib/session";

// Observe touches without taking the responder away from scrolling or buttons.
export function FeedbackGesture({ children }: { children: ReactNode }) {
  const { account } = useSession();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }
  useEffect(() => {
    cancel();
    const subscription = AppState.addEventListener("change", cancel);
    return () => { cancel(); subscription.remove(); };
  }, [pathname, account]);
  function start(e: GestureResponderEvent) {
    cancel();
    if (!account || pathname === "/feedback" || e.nativeEvent.touches.length !== 1) return;
    origin.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
    timer.current = setTimeout(() => {
      timer.current = null;
      router.push({ pathname: "/feedback", params: { screen: pathname } });
    }, 5000);
  }
  return <View style={{ flex: 1 }} collapsable={false} onTouchStart={start}
    onTouchMove={e => {
      if (Math.hypot(e.nativeEvent.pageX-origin.current.x, e.nativeEvent.pageY-origin.current.y)>12) cancel();
    }} onTouchEnd={cancel} onTouchCancel={cancel}>{children}</View>;
}
