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

Use directory mode 0700 and file mode 0600. Never commit credentials. The FCM service account needs `cloudmessaging.messages.create` on the Firebase project. The APNs key is restricted to production notifications for `gov.irs.servant`; release provisioning must include the production `aps-environment` entitlement. The release script uses the `Servant Push App Store` provisioning profile.

Device tokens live in private server state. Jobs are persisted in `server/data/push.db` for up to one hour and re-check membership, preferences, archive status, device revocation, and message visibility before sending. Transient delivery failures retry with backoff; invalid tokens are removed without deleting a newly rotated token. Signing out removes the device registration. Ordinary channel jobs store message references. Legacy private-agent jobs may still contain reply text in this private on-Mac database; queue storage is not encrypted at rest. The provider payload never includes that text.

All notifications now say **Servant — You have a new message**. Message text, sender names, channel names, attachment names, and agent replies are never sent in the alert. This applies even when an older app has saved `previews: true`. The server's queue and provider serializers both enforce generic alerts; provider serialization allowlists only opaque routing references needed to open the right conversation after validating the current user and device.

Apple or Google still receives the device push token, badge count, conversation grouping and opaque user/device/conversation/message IDs. Notification timing can reveal activity. This is content-minimizing push delivery, not encrypted notification previews. Tapping the alert retrieves the actual conversation through the existing pinned encrypted app-to-server connection.

Encrypted previews are **not implemented**. They require device-specific encryption keys plus native iOS Notification Service Extension and Android receive/decrypt handling, including a deliberate key-access policy while the phone is locked. Sending ciphertext as a normal alert would not produce a useful preview. The generic notification path protects content now without pretending that native decryption exists.

The server must be running and connected for delivery. Existing APNs/FCM credentials are still required; no shared relay credential service or keyless Apple enrollment was added. The optional [stable relay](relay-transport.md) carries app traffic only. Production iOS delivery needs a signed device build; simulator injection alone does not verify APNs delivery. Previously sent previews cannot be withdrawn retroactively.

## Verification

Run `node --test --test-timeout=20000 server/`, then in `app/` run `npm test`, `npx tsc --noEmit`, and `npx expo lint`. On release builds, allow notifications, background the app, send a DM from a separate QA account, and verify the alert and tap destination. Verify generic text even for a legacy account with previews enabled, then repeat with pause enabled and an archived channel. Verify both warm and cold notification taps; never send QA messages to real shared channels.
