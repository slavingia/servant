# Push notifications

The iOS and Android apps register their native device token with the authenticated hub. The hub sends directly through APNs and FCM HTTP v1. Expo's push relay is not used.

The default is direct messages, mentions (`@name`, `@channel`, `@here`), replies in threads you participate in, and agent replies. You → Notifications also offers all messages, no notifications, message previews, and timed pauses. Archived channels do not notify. The conversation currently open on a device is silenced using a short presence lease. Tapping a notification opens the conversation or thread after validating the current user and registered device.

## Hub configuration

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

Device tokens live in private hub state. Jobs are persisted in `hub/data/push.db` for up to one hour and re-check membership, preferences, archive status, device revocation, and message visibility before sending. Transient delivery failures retry with backoff; invalid tokens are removed without deleting a newly rotated token. Signing out removes the device registration. Private agent jobs include the reply preview in this private database; ordinary channel jobs store message references.

Message previews pass through Apple or Google when enabled. Disable previews to send generic alert text instead. The hub must be running and connected for delivery. Production iOS delivery needs a signed device build; simulator injection alone does not verify APNs delivery.

## Verification

Run `node --test --test-timeout=20000 hub/`, then in `app/` run `npm test`, `npx tsc --noEmit`, and `npx expo lint`. On release builds, allow notifications, background the app, send a DM from a separate QA account, and verify the alert and tap destination. Repeat with previews off, pause enabled, and an archived channel. Verify both warm and cold notification taps; never send QA messages to real shared channels.
