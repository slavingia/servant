# Push notifications

The iOS and Android apps register their native device token with the authenticated server. The server sends directly through APNs and FCM HTTP v1. Expo's push relay is not used. A browser can be alerted too, through its own push service: see [Browsers (web push)](#browsers-web-push).

The default is direct messages, mentions (`@name`, `@channel`, `@here`), replies in threads you participate in, agent replies, and messages from visitors to the [secure inbox](secure-inbox.md) (Cases). You → Notifications also offers all messages, no notifications, and timed pauses. Archived channels do not notify. The conversation currently open on a device is silenced using a short presence lease. Tapping a notification opens the conversation or thread after validating the current user and registered device.

## Browsers (web push)

Owner's decision, 11/14: the web app can alert a browser that is not showing Servant, for the same things a phone hears about. It is off until a person chooses You → Notifications → **Enable notifications** in that browser, which is when the browser asks its own permission question; **Turn off in this browser** undoes it. It works in Chrome, Edge, Firefox and Safari on a computer and in Chrome and Firefox on Android. A tab on an iPhone cannot (the iPhone app can), and the Mac app keeps its own alerts.

How it travels: the browser subscribes with its own push service (Google for Chrome, Mozilla for Firefox, Apple for Safari, Microsoft for Edge) and gives the server the subscription over the encrypted connection: an address at that push service and two keys. The server sends each alert to that address using the Web Push standards (RFC 8030, VAPID in RFC 8292, message encryption in RFC 8291), implemented in `server/web-push.mjs` with Node's own crypto and no added dependency. The app's service worker (`app/public/sw.js`) shows the alert, and a click brings Servant forward and opens the conversation after the same check of user and device as a phone tap.

**What the push service can see.** The alert is the same allowlisted title, body and opaque routing ids a phone gets, and it is encrypted to keys that never leave the browser, so the push service carries it without being able to read it: unlike APNs and FCM, it sees no sender, title or message text, with previews on or off. It does see that this server sent something to that browser, when, and how large (a few hundred bytes), and the server's contact address if one is set (below). **Show sender and message** still decides what the alert says on screen.

- **The server's key.** Made on first use and kept as `web-push-key` in the data directory with mode 0600. Its public half is what browsers subscribe with (`webPushKey` in `GET /v1/notifications`); the private half never leaves the machine. Back it up with the rest of the data directory: without it every browser has to enable notifications again. A damaged key file is an error, never silently replaced.
- **Contact address.** Push services ask who is sending. The server gives `contactEmail` from `config.json` as a `mailto:` address, or else `publicUrl` when it is an `https` address, or else nothing. Safari's push service may refuse a server that gives neither, so set one.
- **Where the server will send.** Only to the browsers' own push services (`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`), over https, without following redirects. A subscription naming any other address is refused when it is registered and never contacted, so a signed-in browser cannot point the server at something inside its own network.
- **Nothing to configure.** No Apple or Google credentials are involved; `push.json` is not needed for browsers. The server must be able to reach those hosts.
- **Lifecycle.** Alerts wait up to an hour at the push service for a browser that is closed, and a newer alert for the same conversation replaces one still waiting. A subscription the push service reports gone (404 or 410) is removed. Signing out removes the registration, and the browser stops listening for that server. With several servers signed in, each has its own subscription (a service worker registration under `/push/<server>/`), because a subscription belongs to one server's key.
- **Quiet while reading.** The page reports the conversation on screen while its window is in front, as the phone app does, so that conversation does not alert, and alerts already showing for it are taken down.
- **Not included.** Calls show as an ordinary alert and do not ring. There is no unread badge on the browser's icon. The web app is not installable, so there is no push on an iPhone's Home Screen.

## Server configuration

Store a private JSON file at `~/.config/servant/push.json`, or set `SERVANT_PUSH_CONFIG` to a different path:

```json
{
  "fcmProjectId": "your-firebase-project",
  "fcmKeyPath": "/private/path/service-account.json",
  "apnsKeyPath": "/private/path/apns.p8",
  "apnsKeyId": "APPLE_KEY_ID",
  "apnsTeamId": "APPLE_TEAM_ID",
  "apnsTopic": "com.example.servant"
}
```

Use directory mode 0700 and file mode 0600. Never commit credentials. The FCM service account needs `cloudmessaging.messages.create` on the Firebase project. `apnsTopic` is the iOS app's bundle id, which APNs uses as the topic (calls use `<apnsTopic>.voip`). Without it the server uses the `SERVANT_BUNDLE_ID` environment variable, then `com.example.servant`; set it to the bundle id you build the app with. The APNs key is restricted to production notifications for that bundle id; release provisioning must include the production `aps-environment` entitlement. The release script uses the `Servant Push App Store` provisioning profile.

Device tokens live in private server state. Jobs are persisted in `server/data/push.db` for up to one hour and re-check membership, preferences, archive status, device revocation, and message visibility before sending. Transient delivery failures retry with backoff; invalid tokens are removed without deleting a newly rotated token. Signing out removes the device registration. Ordinary channel jobs store message references. Legacy private-agent jobs may still contain reply text in this private on-Mac database; queue storage is not encrypted at rest. Agent replies are also stored as plain text in the job queue (previously only some legacy jobs were).

Alerts show who sent the message and what they said (owner's decision, 11/2):

- Channel: **Jordan Lee in #general** / the message
- Direct message: **Jordan Lee** / the message
- Agent chat: **Agent · <chat title>** / the reply
- Build notes: **Build N is out** / the notes
- Case (a visitor wrote to the secure inbox): **Ana Ruiz · CASE-000001** / the message
- Entitlements ([entitlements.md](entitlements.md)), only to the people named: a request to the person's manager (**Entitlement request** / Pat Tester asked for Tax data API), the decision to the person (**Entitlements** / You now have Tax data API), a new report to their manager (**Entitlements** / You now decide Pat Tester's entitlement requests), and a refused host to the person or the owners (**Agent · access needed** / The agent couldn't reach api.example.gov. Ask for Tax data API in Entitlements). These carry a person's name, an entitlement's name and a host name, never the request's note. Their only routing value is `page: "entitlements"`, so a tap opens the Entitlements screen

Text is flattened to one line (markdown markers removed), titles are capped at 80 characters and bodies at 240. A message with no text but an attachment says "Sent an attachment" (agent: "Sent an image" / "Sent a video").

You → Notifications → **Show sender and message** (on by default) turns this off per person; then alerts say **Servant — You have a new message**. The preference is `contentPreviews`. The old `previews` flag was forced to false for every account before this change, so the server ignores incoming `previews` values and mirrors `contentPreviews` into it for older app builds; an old build therefore cannot switch content off.

**Privacy trade-off:** with previews on, Apple (APNs) or Google (FCM) receives the sender name, channel or chat title, and up to 240 characters of the message in plain text, and the text appears on the lock screen. That is outside the app's encrypted connection. Provider serialization still allowlists fields: only the title, body and opaque routing references (user/device/conversation/message IDs) leave the server. Encrypted previews (Notification Service Extension + Android decrypt) remain unimplemented and would remove the provider exposure.

The server must be running and connected for delivery. Existing APNs/FCM credentials are still required; no shared relay credential service or keyless Apple enrollment was added. The optional [stable relay](relay-transport.md) carries app traffic only. Production iOS delivery needs a signed device build; simulator injection alone does not verify APNs delivery. Previously sent previews cannot be withdrawn retroactively.

## When a visitor writes to the secure inbox

A visitor's message, including the first one that opens a case, alerts the team the way a direct message does. If the case is assigned, only the assignee is alerted; if it is not, or the assignee has left the team, every owner and member is. It follows the same rules as a direct message: nothing in **No notifications**, during a pause or in Deep work, nothing on a device that has the case open, and nothing for a message already read. A message the visitor's browser sends twice alerts once. A teammate's reply, a team note and a follow-up do not alert anyone. Tapping the alert opens the case.

With **Show sender and message** on, the alert carries the visitor's name, the case reference and up to 240 characters of the message, so Apple or Google receives them as it does for a direct message. The visitor's email address, the subject, file names and team notes never leave the server. Turn the switch off to get **Servant — You have a new message** instead. Anyone can write to the public page, so the secure inbox's own limits on new conversations and messages also bound how many alerts it can cause.

The Mac app does not alert for cases yet: it shows the unread count in Cases.

## Email to a visitor of the secure inbox

Someone writing to the team through the public page has no app and gets no push notification. If the owner has set up a mailer and the visitor has confirmed an address, the server emails them when the team replies. That email carries the team's name and the visitor's private return link, and nothing from the conversation: no message text, subject, file name, teammate's name or case reference. The mailer and whoever can read the mailbox see the address and the link. See [Reply emails](secure-inbox.md#reply-emails).

## Verification

Run `node --test --test-timeout=20000 server/`, then in `app/` run `npm test`, `npx tsc --noEmit`, and `npx expo lint`. On release builds, allow notifications, background the app, send a DM from a separate QA account, and verify the alert and tap destination. Verify generic text even for a legacy account with previews enabled, then repeat with pause enabled and an archived channel. Verify both warm and cold notification taps; never send QA messages to real shared channels.

## Multiple servers

Every saved server keeps its own authenticated notification registration and
preferences. Switching the visible server does not sign out or unregister any
other server. Notification taps match the saved user and device, activate that
server, and then open its conversation. An ambiguous match is ignored. Signing
out revokes only the selected server's device; other server registrations remain.

While the phone app is active, its badge is the sum of unread conversations and
agent chats across all saved servers. It refreshes on resume, notification
receipt, navigation and a short timer. An unreachable server never counts as an
empty inbox. With multiple servers, updated servers omit per-server badge values
from push payloads, so they cannot overwrite the last complete aggregate. iOS
cannot recompute that aggregate while the app is suspended or terminated without
a native notification extension: the last complete count remains until resume.
Older servers still send their own count until upgraded. Android zero-count
repair continues to preserve existing notification cards.

The updated Mac app encrypts each server's credentials separately with Keychain
protection, monitors every saved server, and totals the Dock badge. Its alerts
respect each server's notification mode, pauses, mentions, thread participation
and archived conversations. It keeps monitoring when the window is closed; Quit
stops it. Notification clicks switch to the originating server. Older Mac app
binaries continue to support their existing single account and need an app
update before adding more servers. These native bridge changes require a new
Mac binary; an interface update alone cannot add them.
