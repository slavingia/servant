// Over-the-air updates come from the owner's Mac. The address is fixed in the
// build (app.config.js, SERVANT_OTA_URL), and the version built into the app is
// always kept as the fallback, so an unreachable server never stops the app
// from opening. Builds made without an address have updates turned off.
import { useState } from "react";
import { Platform } from "react-native";
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
