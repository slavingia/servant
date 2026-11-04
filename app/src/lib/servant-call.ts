import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";

/** The phone's own call screen (CallKit on iPhone, a full-screen ring on Android). Absent on the web and in old builds. */
type Native = {
  getVoipToken(): string | null;
  takePendingAnswer(): string | null;
  endCall(meetingId: string): void;
  addListener(event: "onVoipToken" | "onAnswer", fn: (e: { token?: string; meetingId?: string }) => void): { remove(): void };
};
const native = requireOptionalNativeModule<Native>("ServantCall");

export const systemCalls = {
  available: !!native,
  /** True when this build can ring with the phone's call screen on Android. */
  androidRings: Platform.OS === "android" && !!native,
  voipToken: () => { try { return native?.getVoipToken() ?? null; } catch { return null; } },
  /** A call the person answered on the system screen while the app was not running. Read once. */
  takeAnswered: () => { try { return native?.takePendingAnswer() ?? null; } catch { return null; } },
  /** Clears the system ring (they joined in the app, or the call ended). */
  end: (meetingId: string) => { try { native?.endCall(meetingId); } catch { /* nothing ringing */ } },
  onToken: (fn: (token: string) => void) => native?.addListener("onVoipToken", e => { if (e.token) fn(e.token); }),
  onAnswer: (fn: (meetingId: string) => void) => native?.addListener("onAnswer", e => { if (e.meetingId) fn(e.meetingId); }),
};

export const validMeetingId = (id: unknown): id is string => typeof id === "string" && /^meet_[A-Za-z0-9_-]{1,40}$/.test(id);
