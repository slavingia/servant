// "/feedback the unread dot stays on after I read" sends feedback about Servant from wherever you are typing,
// without leaving the conversation. With nothing after it, it opens the Feedback page instead.
// Only the words typed after the command are sent, with the screen, app build and platform the Feedback page
// also sends. Nothing from the conversation is attached.
import { Platform } from "react-native";
import Constants from "expo-constants";
import { nativeBuildVersion } from "expo-application";
import { api, type Account } from "./server";

export const FEEDBACK_SENT = "Feedback sent. Thank you. Find it under You, then Feedback.";

/** What goes with the words: where it was typed (a kind of screen, never a conversation's id), and the app. */
export function feedbackContext(screen: "channel" | "direct message" | "agent chat", app = { platform: Platform.OS, version: Constants.expoConfig?.version || "", build: nativeBuildVersion || "development" }) {
  return { screen, platform: app.platform, version: app.version, build: app.build, via: "slash" };
}

export async function sendSlashFeedback(account: Account, text: string, screen: Parameters<typeof feedbackContext>[0]) {
  await api.sendFeedback(account, { text, requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`, context: feedbackContext(screen) });
  return FEEDBACK_SENT;
}
