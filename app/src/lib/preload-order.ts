// In a browser each screen's code arrives the first time the screen is opened. While it is on its way the
// screen is an empty placeholder, and React then keeps the placeholder up for about 300 ms even when the code
// arrived in 10. So every kind of screen was slow once: measured at 350–400 ms against 30–45 ms for a second
// visit (docs/performance.md). Loading the code ahead of the first press removes that.
//
// This file decides the order. The screens a person opens most go first and at once; the rest follow when the
// page is quiet.

/** Opened most, and often within a second of the app appearing: loaded straight away. */
export const FIRST = ["./c/[id].tsx", "./chat/[id].tsx", "./thread.tsx", "./(tabs)/messages.tsx", "./(tabs)/agent.tsx", "./(tabs)/members.tsx", "./(tabs)/you.tsx"];

/** Screens for signing in and pairing: someone using the app is past them, so they are left for when they are needed. */
const NOT_NEEDED = /^\.\/(welcome|pair|sign-in|join-server|invite|scan|reverify|index)\.tsx$/;

/** The screens to load ahead, in order, from every file the router knows. Layouts are already loaded with the app. */
export function preloadOrder(keys: readonly string[]): { first: string[]; later: string[] } {
  const screens = keys.filter(key => /\.tsx?$/.test(key) && !/(^|\/)_layout\.tsx?$/.test(key) && !/(^|\/)\+/.test(key) && !NOT_NEEDED.test(key));
  const first = FIRST.filter(key => screens.includes(key));
  return { first, later: screens.filter(key => !first.includes(key)).sort() };
}
