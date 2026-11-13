// What to show when joining or signing in fails. Every problem gets a title, a
// sentence that says what happened, and the one action that can actually fix
// it. "Try again" is offered only when trying again can work.
export type JoinAction = "retry" | "new-link" | "new-invite" | "back";
export type JoinProblem = { title: string; message: string; action: JoinAction; actionLabel: string };

const NEW_LINK = "Make a new link on the device you already use: You, then Link a computer, then Make a link.";

export function describeJoinError(code: string, message: string, { existing = false }: { existing?: boolean } = {}): JoinProblem {
  const fromOtherDevice = existing ? { action: "new-link" as const, actionLabel: "Paste a new link" } : { action: "new-invite" as const, actionLabel: "Paste a different link" };
  switch (code) {
    case "invite_used":
      return { title: "This link was already used", message: existing ? `Each sign-in link works once. ${NEW_LINK}` : "Each invite link is used once. Ask the person who invited you for a new one.", ...fromOtherDevice };
    case "invite_replaced":
      return { title: "A newer link replaced this one", message: existing ? "Making a new link cancels the old one. Use the newest link from your other device." : "The team's invite link was replaced. Ask for the current one.", ...fromOtherDevice };
    case "invite_expired":
      return { title: "This link expired", message: existing ? `Sign-in links work for ten minutes. ${NEW_LINK}` : "Ask the person who invited you for a new invite link.", ...fromOtherDevice };
    case "invalid_invite":
      return { title: "This link doesn't work", message: existing ? `It isn't a link this workspace knows. ${NEW_LINK}` : "Check that you pasted the whole link, or ask the person who invited you for a new one.", ...fromOtherDevice };
    case "rate_limited":
      return { title: "Too many tries", message: "Wait ten minutes, then try again.", action: "back", actionLabel: "Back" };
    case "encryption_required":
      return { title: "This link is too old", message: "This invite came from an older version of Servant. Ask for a new one.", ...fromOtherDevice };
    case "unreachable":
    case "network":
      return { title: "Can't reach the server", message: "Check your connection, then try again.", action: "retry", actionLabel: "Try again" };
    case "draining":
      return { title: "The server is restarting", message: "Give it a moment, then try again.", action: "retry", actionLabel: "Try again" };
    case "server_error":
      return { title: "Something went wrong on the server", message: "Trying again usually works. If it keeps failing, tell the person who runs Servant.", action: "retry", actionLabel: "Try again" };
    default:
      return { title: "Couldn't sign in", message: message || "Something went wrong.", action: "retry", actionLabel: "Try again" };
  }
}

// The steps for getting a sign-in link from a device that is already signed in.
// Shown on the sign-in screen, in the claim flow, and copied as a ready-to-send note.
export const SIGN_IN_LINK_STEPS: readonly string[] = [
  "Open Servant on a device you already use.",
  "Tap You, then Link a computer, then Make a link.",
  "Send the link here and paste it below.",
];

export function signInInstructions(): string {
  return "To sign in to Servant on another device: open Servant on a device you already use, tap You, then Link a computer, then Make a link, and send the link to the new device. It works once, for ten minutes.";
}

// Left of the countdown on Link a computer: "Works once, for 8:32 more".
export function countdownText(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
