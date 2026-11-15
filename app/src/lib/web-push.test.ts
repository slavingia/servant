// Browser notifications: the helpers the app uses, and the service worker that shows the alert.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { applicationServerKey, launchNotification, pushScope, subscriptionBody, webPushSupported } from "./web-push.ts";
import { notificationAccountRoute } from "./notification-accounts.ts";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "../..", file), "utf8");

test("only a browser that can show alerts while closed is offered them; the Mac app has its own", () => {
  const browser = { navigator: { serviceWorker: {} } as Partial<Navigator>, PushManager: function () {}, Notification: function () {}, isSecureContext: true };
  assert.equal(webPushSupported(browser), true);
  assert.equal(webPushSupported({ ...browser, servantDesktop: { platform: "macos" } }), false);
  assert.equal(webPushSupported({ ...browser, isSecureContext: false }), false, "not over plain http");
  assert.equal(webPushSupported({ ...browser, PushManager: undefined }), false, "Safari on an iPhone, in a tab");
  assert.equal(webPushSupported({ ...browser, Notification: undefined }), false);
  assert.equal(webPushSupported({ ...browser, navigator: {} }), false);
  assert.equal(webPushSupported({}), false);
});

test("each server has its own registration, and its key must be a whole P-256 point", () => {
  assert.equal(pushScope("abc123"), "/push/abc123/");
  assert.equal(pushScope("https://example.gov/a b"), "/push/https%3A%2F%2Fexample.gov%2Fa%20b/");
  assert.notEqual(pushScope("one"), pushScope("two"));
  const point = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]);
  assert.deepEqual([...applicationServerKey(point.toString("base64url"))!], [...point]);
  for (const bad of [undefined, 42, "", "not base64!", Buffer.alloc(65, 7).toString("base64url"), point.subarray(0, 64).toString("base64url"), point.toString("base64")]) assert.equal(applicationServerKey(bad), null);
});

test("the server is told the address and the two keys of a subscription, and nothing else", () => {
  const keys = { p256dh: Uint8Array.from([4, 1, 2, 250, 251]).buffer, auth: Uint8Array.from([9, 8, 7]).buffer };
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/example", expirationTime: 5, options: { applicationServerKey: new ArrayBuffer(65) }, getKey: (name: "p256dh" | "auth") => keys[name] };
  assert.deepEqual(subscriptionBody(subscription), { platform: "web", token: "https://fcm.googleapis.com/fcm/send/example", keys: { p256dh: "BAEC-vs", auth: "CQgH" } });
  assert.equal(subscriptionBody(null), null);
  assert.equal(subscriptionBody({ ...subscription, endpoint: "http://example.net/x" }), null);
  assert.equal(subscriptionBody({ endpoint: subscription.endpoint, getKey: () => null }), null);
});

// The service worker, run here with a stand-in for the browser around it. What it hands back was made inside
// its own context, so it is copied before being compared.
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function worker(windows: { url: string; focused?: boolean; visibilityState?: string }[] = []) {
  const listeners: Record<string, (event: Record<string, unknown>) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const posted: { url: string; message: unknown; focused: boolean }[] = [];
  const opened: string[] = [];
  let skipped = false;
  const clients = windows.map(w => ({ ...w, postMessage(message: unknown) { posted.push({ url: w.url, message: plain(message), focused: false }); }, focus() { posted[posted.length - 1]!.focused = true; return Promise.resolve(this); } }));
  const self = {
    location: { origin: "https://servant.example.gov" },
    addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => { listeners[name] = listener; },
    skipWaiting: () => { skipped = true; },
    registration: { showNotification: (title: string, options: Record<string, unknown>) => { shown.push({ title, options: plain(options) }); return Promise.resolve(); } },
    clients: { matchAll: (options: unknown) => { assert.deepEqual(plain(options), { type: "window", includeUncontrolled: true }); return Promise.resolve(clients); }, openWindow: (url: string) => { opened.push(url); return Promise.resolve(null); } },
  };
  vm.runInNewContext(read("public/sw.js"), { self, URL });
  const fire = async (name: string, event: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    listeners[name]!({ ...event, waitUntil: (p: Promise<unknown>) => { waits.push(p); } });
    await Promise.all(waits);
  };
  return { listeners, shown, posted, opened, fire, skipped: () => skipped };
}
const push = (message: unknown) => ({ data: { json: () => message } });

test("a push shows the alert the server sent, one per conversation", async () => {
  const sw = worker();
  assert.deepEqual(Object.keys(sw.listeners).sort(), ["install", "notificationclick", "push"], "no fetch handler: it answers no request");
  await sw.fire("install");
  assert.equal(sw.skipped(), true);
  await sw.fire("push", push({ title: "Jo Park in #general", body: "Two requests have come in already.", tag: "ch_1", data: { userId: "u1", deviceId: "d1", conversationId: "ch_1", messageId: "7" } }));
  assert.deepEqual(sw.shown, [{ title: "Jo Park in #general", options: { body: "Two requests have come in already.", tag: "ch_1", renotify: true, icon: "/favicon.ico",
    data: { userId: "u1", deviceId: "d1", conversationId: "ch_1", messageId: "7" } } }]);
});

test("a push always shows something, and only the routing ids it knows are kept", async () => {
  const sw = worker();
  await sw.fire("push", {});
  await sw.fire("push", { data: { json: () => { throw new Error("not JSON"); } } });
  await sw.fire("push", push({ title: 42, body: "", data: { conversationId: "ch_1/../x", chatId: "cht_ok", url: "https://example.net", html: "<b>x</b>", userId: { nested: true } }, actions: [{ action: "x" }], image: "https://example.net/a.png" }));
  assert.deepEqual(sw.shown.map(s => [s.title, s.options.body, s.options.tag]), Array(3).fill(["Servant", "You have a new message", "messages"]));
  assert.deepEqual(sw.shown[2]!.options.data, { chatId: "cht_ok" });
  assert.deepEqual(Object.keys(sw.shown[2]!.options).sort(), ["body", "data", "icon", "renotify", "tag"], "no image, action or link from the message");
  // Long text is cut to what a phone alert carries.
  await sw.fire("push", push({ title: "t".repeat(200), body: "b".repeat(900) }));
  assert.deepEqual([sw.shown[3]!.title.length, (sw.shown[3]!.options.body as string).length], [80, 240]);
});

test("clicking an alert brings an open Servant forward and tells it what to open", async () => {
  const data = { userId: "u1", deviceId: "d1", conversationId: "ch_1" };
  let closed = false;
  const click = { notification: { data, close: () => { closed = true; } } };
  const sw = worker([{ url: "https://servant.example.gov/channels", visibilityState: "hidden" }, { url: "https://servant.example.gov/c/dm_2", focused: true, visibilityState: "visible" }]);
  await sw.fire("notificationclick", click);
  assert.equal(closed, true);
  assert.deepEqual(sw.posted, [{ url: "https://servant.example.gov/c/dm_2", message: { type: "servant-notification", data }, focused: true }], "the window being used, not another");
  assert.deepEqual(sw.opened, []);
});

test("with Servant closed, the click starts it with the ids after the #, where no host sees them", async () => {
  const data = { userId: "u1", deviceId: "d1", conversationId: "ch_1", threadRoot: "5", messageId: "9" };
  const sw = worker([]);
  await sw.fire("notificationclick", { notification: { data, close() {} } });
  assert.equal(sw.opened.length, 1);
  const url = new URL(sw.opened[0]!, "https://servant.example.gov");
  assert.deepEqual([url.pathname, url.search], ["/channels", ""], "an app page, with nothing in the part of the address a host receives");
  // The app reads them back, checks them against its signed-in servers, and opens the thread.
  const read = launchNotification(url.hash);
  assert.deepEqual(read, data);
  assert.deepEqual(notificationAccountRoute(read!, [{ id: "a1", userId: "u1", deviceId: "d1" }]), { accountId: "a1", route: { pathname: "/thread", params: { conv: "ch_1", root: "5", focus: "9", from: "push" } } });
  assert.equal(notificationAccountRoute(read!, [{ id: "a1", userId: "someone-else", deviceId: "d1" }]), null, "an alert for another person or browser opens nothing");
});

test("what follows the # is read as routing ids or not at all", () => {
  assert.deepEqual(launchNotification("#notification=" + encodeURIComponent(JSON.stringify({ chatId: "cht_1", extra: 5, bad: "a b" }))), { chatId: "cht_1" });
  for (const hash of ["", "#", "#notification=", "#notification=%", "#notification=42", "#notification=%5B%5D", "#other=1", "#notification=" + encodeURIComponent("{}"), "#notification=" + encodeURIComponent('{"x":"<script>"}')]) assert.equal(launchNotification(hash), null);
});

test("the app asks the browser only when Enable notifications is chosen, and each kind of app gets its own alerts", () => {
  const provider = read("src/lib/notifications.tsx");
  assert.match(provider, /window\.servantDesktop\?\.notifications \? 'desktop' : webPushSupported\(\) \? 'browser' : 'none'/, "the Mac app's bridge first, then a browser's web push, then none");
  const hook = read("src/lib/notifications-web-push.ts");
  // One place asks for permission: enable, and nothing is awaited before the question.
  assert.equal(hook.match(/requestPermission\(/g)?.length, 1);
  assert.match(hook, /const enable = useCallback\(async \(\) => \{\s*setError\(null\);\s*\/\/[^\n]*\n\s*const permission = Notification\.permission === 'default' \? await Notification\.requestPermission\(\) : Notification\.permission;/);
  // On load it subscribes only where the person turned it on and the browser still allows it.
  assert.match(hook, /else void sync\(wanted\(\) && allowed\(\)\);/);
  // Signing out of a server stops this browser listening for it; turning off tells every server.
  assert.match(hook, /for \(const gone of known\.current\.filter\(id => !ids\.includes\(id\)\)\) void unsubscribe\(gone\)/);
  assert.match(hook, /await unsubscribe\(accountId\(a\)\);\s*const config = await notificationApi\.register\(a, null\);/);
  // What is on screen is reported, so the conversation being read stays quiet.
  assert.match(hook, /notificationApi\.presence\(account, conversation, looking\(\)\)/);
  // A clicked alert opens only through the same check a phone uses.
  assert.match(hook, /notificationAccountRoute\(data, registrations\)/);
  // A subscription waits for its worker to be running; a browser refuses otherwise.
  assert.match(read("src/lib/web-push.ts"), /await whenActive\(worker\);\s*let subscription = await worker\.pushManager\.getSubscription\(\);/);
});

test("the service worker only shows alerts: no requests answered, nothing stored, nothing fetched", () => {
  const worker = read("public/sw.js");
  assert.doesNotMatch(worker, /addEventListener\('fetch'|importScripts|caches\.|indexedDB|fetch\(|XMLHttpRequest/);
  assert.match(read("src/lib/web-push.ts"), /export const SERVICE_WORKER = "\/sw\.js";/);
});

test("the Notifications screen says what a browser can do and how to turn it off", () => {
  const screen = read("src/app/notifications.tsx");
  assert.match(screen, /This browser can alert you to chats, mentions and agent replies while Servant is in the background or closed\./);
  assert.match(screen, /<Button compact kind="link" label="Turn off in this browser"/);
  assert.match(screen, /This browser cannot show notifications\. They work in the iPhone and Android app, the Mac app, and in Chrome, Edge, Firefox and Safari on a computer\./);
});
