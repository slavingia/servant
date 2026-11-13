// The Meetings screen: words for the list and the detail. Pure, so it can be tested.
import type { MeetingItem } from "./server.ts";

/** "12 min", "1 h 05 min": how long a meeting ran, for the list. */
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

type Status = MeetingItem["status"];
/** Still changing on the server: live, or the notes are being written. The list keeps polling while any is. */
export const meetingBusy = (m: { status: Status }) => m.status === "live" || m.status === "recorded" || m.status === "processing" || m.status === "uploading";
export const anyBusy = (items: readonly { status: Status }[]) => items.some(meetingBusy);

/** One line under the title: what state the meeting is in, in plain words. */
export function statusLabel(m: { status: Status; openSteps: number }): string {
  switch (m.status) {
    case "live": return "Live now";
    case "uploading": return "Sending";
    case "recorded": case "processing": return "Writing notes";
    case "failed": return "Couldn't make notes";
    default: return m.openSteps ? `${m.openSteps} to do` : "Notes ready";
  }
}

/** "You", "Ann and Bo", "Ann, Bo and 2 others": who was there, for the list. */
export function peopleText(people: readonly { id: string; name: string }[], meId: string): string {
  const names = people.map(p => p.id === meId ? "You" : p.name);
  if (!names.length) return "";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** The recording's file name extension, from its uri ("file:///x/rec.m4a" -> "m4a"). */
export function extensionOf(uri: string, fallback = "m4a"): string {
  const name = uri.split("?")[0]!.split("#")[0]!.split("/").pop() || "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : fallback;
}
