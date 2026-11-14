// Browser notifications (web push). A browser that is not showing Servant can still be told about a message:
// the server pushes an alert through the browser's own push service to the service worker (public/sw.js),
// which shows it. Nothing here is used by the phone apps or the Mac app, which have their own alerts.
//
// Each signed-in server gets its own service worker registration, under /push/<server>/, because a browser's
// push subscription is tied to one server's key and a registration holds one subscription.

export const SERVICE_WORKER = "/sw.js";

type Scope = { navigator?: Partial<Navigator>; PushManager?: unknown; Notification?: unknown; isSecureContext?: boolean; servantDesktop?: unknown };

/** This browser can show alerts while Servant is closed. The Mac app has its own, so it is not asked. */
export function webPushSupported(scope: Scope = globalThis as Scope): boolean {
  return !scope.servantDesktop && scope.isSecureContext !== false && !!scope.navigator && "serviceWorker" in scope.navigator
    && typeof scope.PushManager !== "undefined" && typeof scope.Notification !== "undefined";
}

/** Where a server's registration lives. The id is whatever the app calls that server. */
export const pushScope = (accountId: string) => `/push/${encodeURIComponent(accountId)}/`;

const fromBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch { return null; }
};
const toBase64Url = (bytes: ArrayBuffer | Uint8Array) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The server's public key for browser push as a browser wants it: 65 bytes, an uncompressed P-256 point. */
export function applicationServerKey(key: unknown): Uint8Array | null {
  if (typeof key !== "string") return null;
  const bytes = fromBase64Url(key);
  return bytes && bytes.length === 65 && bytes[0] === 4 ? bytes : null;
}

export type WebPushRegistration = { platform: "web"; token: string; keys: { p256dh: string; auth: string } };
type SubscriptionLike = { endpoint?: unknown; getKey?: (name: "p256dh" | "auth") => ArrayBuffer | null };

/** What the server is told about a subscription: where to send, and the keys alerts are encrypted to. */
export function subscriptionBody(subscription: SubscriptionLike | null | undefined): WebPushRegistration | null {
  const p256dh = subscription?.getKey?.("p256dh"), auth = subscription?.getKey?.("auth");
  if (typeof subscription?.endpoint !== "string" || !subscription.endpoint.startsWith("https://") || !p256dh || !auth) return null;
  return { platform: "web", token: subscription.endpoint, keys: { p256dh: toBase64Url(p256dh), auth: toBase64Url(auth) } };
}

/** The routing ids the service worker put after the # when it had to start Servant. Anything else is ignored. */
export function launchNotification(hash: string): Record<string, string> | null {
  const match = /^#notification=(.+)$/.exec(hash);
  if (!match) return null;
  try {
    const data: unknown = JSON.parse(decodeURIComponent(match[1]!));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const ids: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) if (typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)) ids[key] = value;
    return Object.keys(ids).length ? ids : null;
  } catch { return null; }
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false;
  const view = new Uint8Array(a);
  return view.length === b.length && view.every((byte, i) => byte === b[i]);
};

async function registration(accountId: string, create: boolean): Promise<ServiceWorkerRegistration | null> {
  const scope = pushScope(accountId);
  if (create) return navigator.serviceWorker.register(SERVICE_WORKER, { scope });
  return (await navigator.serviceWorker.getRegistration(scope)) ?? null;
}

// A browser refuses to subscribe until the registration's worker is running. `navigator.serviceWorker.ready`
// cannot say when: it waits for a worker that controls this page, and these control none.
function whenActive(worker: ServiceWorkerRegistration, wait = 15000): Promise<void> {
  if (worker.active) return Promise.resolve();
  const starting = worker.installing ?? worker.waiting;
  if (!starting) return Promise.reject(new Error("Could not start notifications in this browser"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { starting.removeEventListener("statechange", check); reject(new Error("Notifications took too long to start in this browser")); }, wait);
    function check() {
      if (starting!.state !== "activated" && starting!.state !== "redundant") return;
      clearTimeout(timer);
      starting!.removeEventListener("statechange", check);
      if (starting!.state === "activated") resolve(); else reject(new Error("Could not start notifications in this browser"));
    }
    starting.addEventListener("statechange", check);
    check();
  });
}

/** The subscription this browser already has for a server, if any. */
export async function currentSubscription(accountId: string): Promise<WebPushRegistration | null> {
  const worker = await registration(accountId, false);
  return subscriptionBody(await worker?.pushManager.getSubscription());
}

/**
 * Subscribe this browser for one server, with that server's key. A subscription made for another key (the
 * server's data was replaced) is dropped first: a push service delivers only from the key it was made with.
 */
export async function subscribe(accountId: string, serverKey: string): Promise<WebPushRegistration> {
  const key = applicationServerKey(serverKey);
  if (!key) throw new Error("This server sent a key this browser cannot use");
  const worker = await registration(accountId, true);
  if (!worker) throw new Error("Could not start notifications in this browser");
  await whenActive(worker);
  let subscription = await worker.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) { await subscription.unsubscribe(); subscription = null; }
  subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  const body = subscriptionBody(subscription);
  if (!body) throw new Error("This browser did not give a usable subscription");
  return body;
}

/** Stop this browser hearing from one server, and remove that server's registration. */
export async function unsubscribe(accountId: string): Promise<void> {
  const worker = await registration(accountId, false);
  if (!worker) return;
  await (await worker.pushManager.getSubscription())?.unsubscribe().catch(() => false);
  await worker.unregister().catch(() => false);
}

/** Take down alerts already showing for what is now on screen. */
export async function closeShown(accountId: string, matches: (data: Record<string, unknown>) => boolean): Promise<void> {
  const worker = await registration(accountId, false);
  for (const shown of await worker?.getNotifications() ?? []) if (matches((shown.data ?? {}) as Record<string, unknown>)) shown.close();
}
