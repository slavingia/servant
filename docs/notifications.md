# Push notifications

The iOS and Android apps register their native device token with the authenticated server. The server sends directly through APNs and FCM HTTP v1. Expo's push relay is not used.

The default is direct messages, mentions (`@name`, `@channel`, `@here`), replies in threads you participate in, and agent replies. You → Notifications also offers all messages, no notifications, and timed pauses. Archived channels do not notify. The conversation currently open on a device is silenced using a short presence lease. Tapping a notification opens the conversation or thread after validating the current user and registered device.

## Server configuration

Store a private JSON file at `~/.config/servant/push.json`, or set `SERVANT_PUSH_CONFIG` to a different path:

```json
{
  "fcmProjectId": "your-firebase-project",
  "fcmKeyPath": "/private/path/service-account.json",
  "apnsKeyPath": "/private/path/apns.p8",
  "apnsKeyId": "APPLE_KEY_ID",
  "apnsTeamId": "APPLE_TEAM_ID"
}
```

Use directory mode 0700 and file mode 0600. Never commit credentials. The FCM service account needs `cloudmessaging.messages.create` on the Firebase project. The APNs key is restricted to production notifications for the app's bundle id (`com.slavingia.servant` by default; a server whose app uses another one sets `"push": { "apnsTopic": "<bundle id>" }` in `server/data/config.json`); release provisioning must include the production `aps-environment` entitlement. The release script uses the `Servant Push App Store` provisioning profile.

Device tokens live in private server state. Jobs are persisted in `server/data/push.db` for up to one hour and re-check membership, preferences, archive status, device revocation, and message visibility before sending. Transient delivery failures retry with backoff; invalid tokens are removed without deleting a newly rotated token. Signing out removes the device registration. Ordinary channel jobs store message references. Legacy private-agent jobs may still contain reply text in this private on-Mac database; queue storage is not encrypted at rest. Agent replies are also stored as plain text in the job queue (previously only some legacy jobs were).

Alerts show who sent the message and what they said (owner's decision, 11/2):

- Channel: **Jordan Lee in #general** / the message
- Direct message: **Jordan Lee** / the message
- Agent chat: **Agent · <chat title>** / the reply
- Build notes: **Build N is out** / the notes

Text is flattened to one line (markdown markers removed), titles are capped at 80 characters and bodies at 240. A message with no text but an attachment says "Sent an attachment" (agent: "Sent an image" / "Sent a video").

You → Notifications → **Show sender and message** (on by default) turns this off per person; then alerts say **Servant — You have a new message**. The preference is `contentPreviews`. The old `previews` flag was forced to false for every account before this change, so the server ignores incoming `previews` values and mirrors `contentPreviews` into it for older app builds; an old build therefore cannot switch content off.

**Privacy trade-off:** with previews on, Apple (APNs) or Google (FCM) receives the sender name, channel or chat title, and up to 240 characters of the message in plain text, and the text appears on the lock screen. That is outside the app's encrypted connection. Provider serialization still allowlists fields: only the title, body and opaque routing references (user/device/conversation/message IDs) leave the server. Encrypted previews (Notification Service Extension + Android decrypt) remain unimplemented and would remove the provider exposure.

The server must be running and connected for delivery. Existing APNs/FCM credentials are still required; no shared relay credential service or keyless Apple enrollment was added. The optional [stable relay](relay-transport.md) carries app traffic only. Production iOS delivery needs a signed device build; simulator injection alone does not verify APNs delivery. Previously sent previews cannot be withdrawn retroactively.

## Verification

Run `node --test --test-timeout=20000 server/`, then in `app/` run `npm test`, `npx tsc --noEmit`, and `npx expo lint`. On release builds, allow notifications, background the app, send a DM from a separate QA account, and verify the alert and tap destination. Verify generic text even for a legacy account with previews enabled, then repeat with pause enabled and an archived channel. Verify both warm and cold notification taps; never send QA messages to real shared channels.
