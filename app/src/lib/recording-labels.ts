// Words for voice memos. Pure, so they can be tested.
import type { RecordingSummary } from "./server.ts";

/** "12 min", "1 h 05 min": how long a memo ran. */
export function durationText(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "";
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** "3:07" or "1:02:07": the running timer while recording. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

type Status = RecordingSummary["status"];
/** Still changing on the server while it uploads or the notes are written. */
export const recordingBusy = (r: { status: Status }) => r.status === "uploading" || r.status === "processing";
export const anyBusy = (items: readonly { status: Status }[]) => items.some(recordingBusy);

/** One line under the title: what state the memo is in, in plain words. */
export function statusLabel(r: { status: Status; openSteps: number }): string {
  switch (r.status) {
    case "uploading": return "Sending";
    case "processing": return "Writing notes";
    case "failed": return "Couldn't make notes";
    default: return r.openSteps ? `${r.openSteps} to do` : "Notes ready";
  }
}

/** The recording's file name extension, from its uri ("file:///x/rec.m4a" -> "m4a"). */
export function extensionOf(uri: string, fallback = "m4a"): string {
  const name = uri.split("?")[0]!.split("#")[0]!.split("/").pop() || "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : fallback;
}
