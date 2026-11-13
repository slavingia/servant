// The share expo-sharing is holding for the app. Its native side keeps it until the app clears
// it, so a share survives signing in and the confirm-it's-you screen. Safe on web and on native
// builds made before the extension existed: those simply have nothing pending.
import { Platform } from "react-native";
import * as Sharing from "expo-sharing";
import type { RawSharePayload, ResolvedSharePayload } from "./share-payload";

export function pendingSharePayloads(): RawSharePayload[] {
  if (Platform.OS === "web") return [];
  try { return Sharing.getSharedPayloads() ?? []; } catch { return []; }
}

/** Files copied where the app can read them, with names and sizes; null when resolving failed (the raw view still works). */
export async function resolvePendingShare(): Promise<ResolvedSharePayload[] | null> {
  if (Platform.OS === "web") return null;
  try { return await Sharing.getResolvedSharedPayloadsAsync(); } catch { return null; }
}

export function clearPendingShare(): void {
  resetShareRouteClaim();
  if (Platform.OS === "web") return;
  try { Sharing.clearSharedPayloads(); } catch { /* nothing was pending */ }
}

// The deep link opens the Send to agent screen; ShareGate opens it when the link couldn't (sign-in
// first, or the app was already open). Each share is claimed once, so they never stack two screens.
let routed = "";
/** Allow the same native share to reopen after the signed-in navigation tree is removed. */
export function resetShareRouteClaim(): void { routed = ""; }
const signature = (payloads: readonly RawSharePayload[]) => payloads.map(item => `${item.shareType ?? ""}:${item.value ?? ""}`).join("\n");
export function claimShareRoute(payloads: readonly RawSharePayload[]): boolean {
  const key = signature(payloads);
  if (!key || key === routed) return false;
  routed = key;
  return true;
}
