# External services and data flows

This inventory is evidence for an agency review, not an authorization to operate. It describes the source configuration as of October 30, 2026. The deploying agency must record its actual accounts, regions, contracts, retention settings, access list, and approved data classification.

| Service or endpoint | Purpose | Data visible there | Repository evidence |
| --- | --- | --- | --- |
| Owner's Mac / Servant server | Authentication, conversation storage, attachments, agent work | Plaintext messages, attachments, device credentials and member records after transport decryption | `server/server.mjs`, `state-store.mjs`, `messaging.mjs`, `chat-media.mjs` |
| Hermes and its configured model providers | Produce agent replies | Prompt, relevant history and supported attachments; any tool results the owner's agent supplies | Hermes configuration is deployment-specific; see `docs/member-security.md` |
| Cloudflare tunnel or optional stable relay | Route encrypted phone↔Mac requests | Encrypted bytes, timing, sizes, network addresses and public routing information; no application bearer token in the outer transport | `server/secure-transport.mjs`, `docs/encryption.md`, `docs/relay-transport.md` |
| Apple APNs / Google FCM | Native push alerts | Device push tokens, delivery metadata, generic alert text and opaque routing identifiers | `server/push.mjs`, `server/push-transport.mjs`, `docs/notifications.md` |
| Browser push services (Google, Mozilla, Apple, Microsoft) | Alerts to a browser that enabled notifications | The subscription address, timing, size and the server's contact address if set. The alert itself is encrypted to the browser and cannot be read in transit | `server/web-push.mjs`, `app/public/sw.js`, `docs/notifications.md` |
| Any website a person links to (unless `linkPreviews` is off) | Read the page's title and description for a preview | One request for that page from the server's address; no cookie, credential, person or conversation. The site learns the server looked at the page | `server/link-preview.mjs`, `docs/features.md` |
| **Google Firebase Crashlytics** | Native crash diagnostics | Crash/stack information and SDK diagnostic metadata, including installation identifiers. Exception text can contain application data; message encryption does not cover this service. | `app/package.json`: `@react-native-firebase/crashlytics`; `app/app.json`: Crashlytics config plugin |
| GitHub Gist (legacy discovery only) | Find a changed quick-tunnel address | Published server address and public discovery metadata | `server/publish.mjs`; stable relay deployment can disable discovery |
| Apple App Store Connect / Google Play / Firebase App Distribution | Distribute builds and manage testers | Application binaries, build metadata and distribution/tester information | `scripts/testflight.sh`, `scripts/play.py`, `scripts/firebase.sh` |

## Crashlytics boundary

Crashlytics is bundled into both native apps. There is no checked-in `firebase.json` disabling automatic collection, and no application-level `setUserId`, custom Crashlytics logs, attributes or `recordError` calls in `app/src`. This is not proof that crash reports contain no sensitive data: native diagnostics and exception messages require review. The SDK's default collection behavior and installation identifiers are documented in [React Native Firebase's Crashlytics guide](https://rnfirebase.io/crashlytics/usage) and [Firebase's privacy documentation](https://firebase.google.com/support/privacy#crashlytics).

The inventory deliberately lists Crashlytics separately from push delivery. End-to-end message transport does not mean that Google receives no data. Before sensitive use, inspect representative release crash reports, approve or disable crash collection, set retention/access controls in the actual Firebase project, and record that decision in the agency package. Do not add message text, attachments, invite links, tokens, commands, or model prompts to diagnostic logs.

## Scope of the privacy claim

“Only the phone and the Mac can read messages in transit through the relay” describes the transport endpoints. The server stores plaintext and sends context to Hermes and its selected model provider. The owner can access server data. Shared channels are intentionally visible to their members. Member agent isolation prevents cross-member built-in memory reuse; it does not remove those intentional server and conversation access paths.

Version 1 transport has no forward secrecy after compromise of the Mac's long-term transport key and has not received an independent protocol audit. See the encryption documentation for replay, key pinning, attachment and web-origin boundaries. Generic push alerts omit message content rather than claiming a native encrypted-preview implementation exists.
