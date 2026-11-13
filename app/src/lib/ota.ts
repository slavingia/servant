// Over-the-air updates come from the owner's Mac. The address is fixed in the
// build (app.config.js, SERVANT_OTA_URL), and the version built into the app is
// always kept as the fallback, so an unreachable server never stops the app
// from opening. Builds made without an address have updates turned off.
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { getActiveCall } from "./active-call";
import { shouldApplyNow } from "./ota-apply";
import * as Updates from "expo-updates";

export const otaSupported = () => Platform.OS !== "web" && !__DEV__ && Updates.isEnabled;

export type OtaStatus = "idle" | "checking" | "downloading" | "current" | "ready" | "failed";

/** Says what happened in words a person can act on. */
export function otaMessage(status: OtaStatus, detail?: string): string {
  switch (status) {
    case "checking": return "Checking…";
    case "downloading": return "Downloading…";
    case "current": return "Up to date";
    case "ready": return "Ready";
    case "failed": return detail || "Couldn't check";
    default: return "";
  }
}

export function otaFailure(e: unknown): string {
  const text = e instanceof Error ? e.message : "";
  if (/signature|certificate|code signing/i.test(text)) return "This update isn't signed by your server";
  if (/network|offline|internet|timed out|connect|could not be completed|hostname/i.test(text)) return "Can't reach your server";
  if (/404|not found/i.test(text)) return "Your server doesn't offer app updates yet";
  return text ? `Couldn't update: ${text}` : "Couldn't check for updates";
}

export function useOtaCheck() {
  const [status, setStatus] = useState<OtaStatus>("idle");
  const [detail, setDetail] = useState<string | undefined>();
  const supported = otaSupported();
  async function check() {
    if (!supported || status === "checking" || status === "downloading") return;
    setDetail(undefined); setStatus("checking");
    try {
      const found = await Updates.checkForUpdateAsync();
      // A rollback means "go back to the version inside the app"; it has no new files.
      if (!found.isAvailable && !found.isRollBackToEmbedded) { setStatus("current"); return; }
      setStatus("downloading");
      const fetched = await Updates.fetchUpdateAsync();
      setStatus(fetched.isNew || fetched.isRollBackToEmbedded ? "ready" : "current");
    } catch (e) { setDetail(otaFailure(e)); setStatus("failed"); }
  }
  const restart = () => Updates.reloadAsync().catch(e => { setDetail(otaFailure(e)); setStatus("failed"); });
  return { supported, status, detail, check, restart };
}

/**
 * Gets the newest update and starts it without waiting for a second launch: right away if it
 * arrives in the first few seconds, otherwise the next time the app comes back to the
 * foreground. Never during a call. Also checks again whenever the app comes back after an hour.
 */
export function useApplyUpdates() {
  useEffect(() => {
    if (!otaSupported()) return;
    const launched = Date.now();
    let ready = false; let busy = false; let lastCheck = 0;
    const tryApply = (returningToApp: boolean) => {
      if (ready && shouldApplyNow({ msSinceLaunch: Date.now() - launched, onCall: !!getActiveCall(), returningToApp })) {
        void Updates.reloadAsync().catch(() => {});
      }
    };
    const check = async () => {
      if (busy) return;
      busy = true; lastCheck = Date.now();
      try {
        const found = await Updates.checkForUpdateAsync();
        if (found.isAvailable || found.isRollBackToEmbedded) {
          const fetched = await Updates.fetchUpdateAsync();
          if (fetched.isNew || fetched.isRollBackToEmbedded) { ready = true; tryApply(false); }
        }
      } catch { /* offline or no server: keep running this version */ } finally { busy = false; }
    };
    void check();
    const sub = AppState.addEventListener("change", state => {
      if (state !== "active") return;
      tryApply(true);
      if (!ready && Date.now() - lastCheck > 60 * 60 * 1000) void check();
    });
    return () => sub.remove();
  }, []);
}
