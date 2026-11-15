// Servant's service worker. It does two things and nothing else: it shows an alert when the server pushes one
// to this browser, and when the alert is clicked it brings Servant forward and tells it what to open.
// It controls no page, answers no request and keeps nothing: the app registers it under /push/<server>/, one
// registration for each server signed in to, because a browser's push subscription belongs to one server's key.
//
// What arrives was encrypted by the server to this browser (the push service in between cannot read it) and is
// the same title, body and routing ids a phone gets (docs/notifications.md). Only those are used.

const text = (value, max, fallback) => typeof value === 'string' && value.trim() ? value.slice(0, max) : fallback;
const ROUTING = ['userId', 'deviceId', 'conversationId', 'chatId', 'caseId', 'threadRoot', 'messageId', 'meetingId'];

function alertFrom(event) {
  let message = null;
  try { message = event.data ? event.data.json() : null; } catch { /* not ours, or not readable: the generic words */ }
  const data = {};
  for (const key of ROUTING) {
    const value = message && message.data ? message.data[key] : undefined;
    if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)) data[key] = value;
  }
  return {
    title: text(message && message.title, 80, 'Servant'),
    body: text(message && message.body, 240, 'You have a new message'),
    // One alert per conversation: a newer one takes the older one's place and still makes itself heard.
    tag: text(message && message.tag, 128, 'messages'),
    data,
  };
}

self.addEventListener('install', () => { self.skipWaiting(); });

// A browser expects every push to show something, so one always does.
self.addEventListener('push', event => {
  const alert = alertFrom(event);
  event.waitUntil(self.registration.showNotification(alert.title, { body: alert.body, tag: alert.tag, renotify: true, icon: '/favicon.ico', data: alert.data }));
});

self.addEventListener('notificationclick', event => {
  const data = event.notification.data || {};
  event.notification.close();
  event.waitUntil(open(data));
});

async function open(data) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const here = windows.filter(client => { try { return new URL(client.url).origin === self.location.origin; } catch { return false; } });
  const client = here.find(c => c.focused) || here.find(c => c.visibilityState === 'visible') || here[0];
  if (client) {
    // Servant is open: it checks the alert against its signed-in servers and opens the conversation itself.
    client.postMessage({ type: 'servant-notification', data });
    return client.focus();
  }
  // Not open: start it with the routing ids after the #, which stays in the browser and is never sent to a host.
  return self.clients.openWindow('/channels#notification=' + encodeURIComponent(JSON.stringify(data)));
}
