// A list under another screen (Home while a conversation is open, the Chats tab while another tab is)
// keeps getting the conversation list, which changes with every message anywhere. Drawing every row
// again each time, for a screen nobody can see, is wasted work on the thread that also draws the screen
// in front. A hidden list is handed the list it last showed until the changes have paused, then the
// current one, once; so it is current by the time anyone goes back to it, and going back draws nothing
// when nothing changed. In front it gets every change at once.
import { useEffect, useState } from "react";

/** How long the changes must pause before a hidden list is handed the current value. */
export const SETTLE_MS = 1500;

/** What a screen is handed: the current value while it is in front, the last settled one while it is hidden. */
export const whileHidden = <T,>(focused: boolean, current: T, settled: T): T => focused ? current : settled;

/**
 * `value` for a screen that may be under another one (`focused` from useIsFocused). In front it is `value`
 * itself. Hidden, it is what the screen last showed, replaced by the current value once `value` has stopped
 * changing for a moment.
 */
export function useWhileHidden<T>(value: T, focused: boolean): T {
  const [settled, setSettled] = useState(value);
  // In front, what is on screen is the current value: remember it, so going under another screen changes nothing.
  if (focused && settled !== value) setSettled(value);
  useEffect(() => {
    if (focused) return;
    const timer = setTimeout(() => setSettled(value), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [focused, value]);
  return whileHidden(focused, value, settled);
}
