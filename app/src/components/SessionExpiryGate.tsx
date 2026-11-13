import { useEffect } from "react";
import { AppState } from "react-native";
import { router, usePathname } from "expo-router";
import { checkSessionOnResume, useSessionExpiry } from "../lib/session-expiry";

// Mounted while signed in. When the server ends this device's session (401 session_expired), or
// the deadline it gave us passes while the app was in the background, this opens the one
// "Confirm it's you" screen on top of whatever was showing. Nothing is signed out or cleared:
// the screen comes back to where the person was once the code is accepted.
export function SessionExpiryGate() {
  const { expired } = useSessionExpiry();
  const pathname = usePathname();
  useEffect(() => {
    if (expired && pathname !== "/reverify") router.push("/reverify");
  }, [expired, pathname]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", s => { if (s === "active") checkSessionOnResume(); });
    return () => sub.remove();
  }, []);
  return null;
}
