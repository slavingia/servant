import { ctx } from "expo-router/_ctx";
import { preloadOrder } from "./preload-order";

let started = false;

// Asking the router's own list for a screen loads its code; once loaded, opening the screen needs no
// placeholder (see preload-order.ts). A failure here is left alone: the screen loads the usual way when opened.
const load = (key: string) => { try { return Promise.resolve(ctx(key)).then(() => undefined, () => undefined); } catch { return Promise.resolve(); } };
const quiet = () => new Promise<void>(resolve => {
  const idle = (globalThis as { requestIdleCallback?: (run: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(() => resolve(), { timeout: 2000 }); else setTimeout(resolve, 200);
});

/** Loads every screen's code ahead of its first use: the most used at once, the rest one at a time when the page is quiet. Runs once. */
export function preloadScreens() {
  if (started) return;
  started = true;
  const { first, later } = preloadOrder(ctx.keys());
  void (async () => {
    await Promise.all(first.map(load));
    for (const key of later) { await quiet(); await load(key); }
  })();
}
