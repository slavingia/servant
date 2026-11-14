import { memo, useEffect, useState, type ReactNode } from "react";
import { SETTLE_MS, skipWhileHidden } from "../lib/hidden-screen";

/**
 * Draws its children on every change while the screen is in front (`focused`, from useIsFocused). Under
 * another screen it keeps what it last drew until `settled` moves on, then catches up once.
 * See lib/hidden-screen.ts.
 */
export const WhileFocused = memo(function WhileFocused({ children }: { focused: boolean; settled: number; children: ReactNode }) {
  return children;
}, skipWhileHidden);

/**
 * A number that moves on when `value` has stopped changing for a moment while the screen is hidden: the cue for
 * WhileFocused to catch up. It does not move while the screen is in front (nothing waits then).
 */
export function useSettled(focused: boolean, value: unknown): number {
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    if (focused) return;
    const timer = setTimeout(() => setSettled(count => count + 1), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [focused, value]);
  return settled;
}
