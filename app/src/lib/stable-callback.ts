import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A handler whose identity never changes and that always runs the latest version it was given.
 * For handlers handed to memoized rows: a row keeps its handler across the screen's re-renders, so it is
 * not drawn again, and the handler still sees the screen's current state when it is pressed.
 */
export function useStableCallback<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  const latest = useRef(handler);
  useLayoutEffect(() => { latest.current = handler; });
  return useCallback((...args: A) => latest.current(...args), []);
}
