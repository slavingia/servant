// How long the app waits before reopening its live connection. Pure, so it can be tested.
//
// The wait doubles after each failed attempt, up to half a minute. It used to go back to one second the moment a
// connection came up. When connections were being cut seconds after they opened (a tunnel dropping, a server too
// busy to keep up), every open app was back within a second and refetched everything each time, which kept the
// server too busy to hold a connection. So the wait goes back to the start only after a connection has lasted,
// and each wait is spread out at random so apps that lost their connection together don't return together.
export const FIRST_WAIT_MS = 1000;
export const LONGEST_WAIT_MS = 30000;
/** A connection that lasted this long was a real one: the next reconnect starts from the short wait again. */
export const STEADY_AFTER_MS = 30000;

/** The wait after a connection ended or an attempt failed. `lastedMs` is how long it was up (0 when it never opened). */
export function nextWait(current: number, lastedMs: number): number {
  if (lastedMs >= STEADY_AFTER_MS) return FIRST_WAIT_MS;
  return Math.min(Math.max(current, FIRST_WAIT_MS) * 2, LONGEST_WAIT_MS);
}

/** The wait actually slept: between half of it and all of it, so reconnects spread out. `random` is 0 to 1. */
export function spread(wait: number, random: number = Math.random()): number {
  return Math.round(wait * (0.5 + 0.5 * Math.min(1, Math.max(0, random))));
}
