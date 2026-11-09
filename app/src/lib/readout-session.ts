// A study readout's loaded files and written comments, kept in memory while the
// app is open, so a change that redraws the page (such as the window crossing
// between the phone and desktop layouts) doesn't drop them. Never saved to the
// device: a reload, Start over or signing out clears it.
import type { Comment } from "./readout-answers";

export type PickedFile = { name: string; text: string };
export type ReadoutSession = {
  survey2: PickedFile | null;
  survey1: PickedFile | null;
  includePreviews: boolean;
  comments: Comment[] | null;
};

let current: { key: string; session: ReadoutSession } | null = null;

/** What's loaded for this person's readout (key: their form-draft key), or null. */
export function readoutSession(key: string | null): ReadoutSession | null {
  return key && current?.key === key ? current.session : null;
}

export function keepReadoutSession(key: string | null, session: ReadoutSession) {
  if (!key) return;
  const empty = !session.survey2 && !session.survey1 && !session.comments && !session.includePreviews;
  current = empty ? (current?.key === key ? null : current) : { key, session };
}

export function clearReadoutSession() {
  current = null;
}
