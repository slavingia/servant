// How a swipeable row moves and where it comes to rest. These run on the interface thread while a finger is
// down (components/SwipeChannelRow.tsx), so they are plain arithmetic with nothing from outside.

/** How long the row takes to slide open or shut once let go. */
export const SETTLE_MS = 180;

/** Where the row sits while dragged: never right of closed, never left of fully open. */
export function swipePosition(from: number, dragged: number, width: number) {
  "worklet";
  return Math.max(-width, Math.min(0, from + dragged));
}

/**
 * Let go at `position` (0 is closed, -width is open) moving at `velocity` points a second: does the row open?
 * A flick left opens it and a flick right closes it; otherwise it opens when dragged past a third of the way.
 */
export function swipeReveals(position: number, velocity: number, width: number) {
  "worklet";
  return velocity < -400 || (velocity <= 400 && position < -width / 3);
}
