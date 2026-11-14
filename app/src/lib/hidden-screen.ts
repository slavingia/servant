// A list under another screen (Home while a conversation is open, the Chats tab while another tab is)
// keeps getting the conversation list, which changes with every message anywhere. Drawing every row
// again each time, for a screen nobody can see, is wasted work on the thread that also draws the screen
// in front. A hidden list now waits until the changes have paused and catches up once, so it is
// current by the time anyone goes back to it; the moment it is in front it draws every change again.

/** How long the changes must pause before a hidden list catches up. */
export const SETTLE_MS = 1500;

export type Shown = { focused: boolean; settled: number };

/**
 * For React.memo: true means "skip this render". A screen in front always draws. A hidden one draws only
 * when `settled` has moved on, which happens once the changes have paused (see useSettled).
 */
export const skipWhileHidden = (previous: Shown, next: Shown) => !next.focused && previous.settled === next.settled;
