import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { router, usePathname, useRootNavigationState } from "expo-router";
import { claimShareRoute, pendingSharePayloads, resetShareRouteClaim } from "../lib/incoming-share";
import { useSessionExpiry } from "../lib/session-expiry";

// Mounted while signed in, on phones. A share normally opens the app on the Send to agent screen
// through the deep link expo-sharing fires (+native-intent.tsx). This covers what that link can't:
// the person had to sign in or confirm it's them first, or the app was already open and the link
// raced the foreground event. The share itself waits natively until the screen clears it.
export function ShareGate() {
  const pathname = usePathname();
  const ready = !!useRootNavigationState()?.key;
  const { expired } = useSessionExpiry();
  // A revoked account or sign-out removes this gate and the share screen. Pairing again must
  // be able to reopen the native share; only the navigation claim ends, never the payload.
  useEffect(() => () => resetShareRouteClaim(), []);
  useEffect(() => {
    if (Platform.OS === "web" || !ready || expired || pathname === "/reverify" || pathname === "/share") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A moment later than the link itself, so a share that already opened the screen isn't opened twice.
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const pending = pendingSharePayloads();
        if (pending.length && claimShareRoute(pending)) router.push("/share");
      }, 400);
    };
    check();
    const sub = AppState.addEventListener("change", state => { if (state === "active") check(); });
    return () => { clearTimeout(timer); sub.remove(); };
  }, [ready, expired, pathname]);
  return null;
}
