# Servant UX client identity and builds

Servant UX is a client flavor, not a new server protocol. It uses the existing
encrypted pairing, API, live-update, and account formats, so a UX client can
join an ordinary Servant server without a server migration.

## Identities

| Surface | Servant UX identity | Upstream core identity |
| --- | --- | --- |
| Expo display name | `Servant UX` | `Servant` |
| Expo slug | `servant-ux` | `servant` |
| iOS bundle ID | `gov.irs.servant.ux` | `gov.irs.servant` |
| Android package | `gov.irs.servant.ux` | `gov.irs.servant` |
| Mobile URL scheme | `servant-ux` | `servant` |
| Electron product | `Servant UX` | `Servant` |
| Electron app ID | `gov.irs.servant.ux.desktop` | `gov.irs.servant.desktop` |
| Electron URL scheme | `servant-ux` | `servant` |
| Electron storage | `~/Library/Application Support/Servant UX/` | `~/Library/Application Support/Servant/` |

The distinct native identifiers, URL handlers, storage path, and OTA runtime
versions allow both clients to be installed at the same time without sharing an
account file or claiming each other's direct links.

The server still generates ordinary `servant://pair` invites. Servant UX accepts
those through **Paste an invite link** and its QR scanner. A link intended to
open Servant UX directly can use `servant-ux://pair` with the same query
parameters. The app does not register the ordinary `servant` scheme because two
installed apps cannot both own that handler reliably.

## Milestone 1 feature contract

The UX layer deliberately reuses existing Servant data instead of introducing a
second protocol:

- New pairings enter a resumable, device-local role and goals flow. These
  preferences personalize starting points but never grant server permissions;
  the server's agent tier remains authoritative and is shown separately.
- **Design Studio** is a library view over existing agent chats whose
  `mode` is `vibe`. Creating a design still calls the normal chat endpoint with
  `mode: "vibe"`, and the client offers that action only for server-authorized
  Design prototyper and Design engineer tiers when prototyping is configured.
- Sharing a design posts an ordinary plain-text message to an existing channel
  or direct message, then opens its ordinary Servant thread for feedback. Older
  and upstream clients therefore receive a useful title, status, preview URL,
  review focus, and thread instructions without needing a new card renderer.
- Workspace owners may see private teammate designs through their existing
  admin visibility. The UX library labels these as private and does not offer
  them for resharing.

Existing paired accounts with no onboarding record continue to their normal
home screen, so installing the UX client does not turn a local preference into a
server migration. A person can restart the flow from **You → Restart
onboarding**.

Milestone 1 intentionally deferred Research Studio. The milestone 2 implementation
follows the same compatibility rule: compose existing researcher-agent capabilities
and ordinary Servant sharing/thread primitives before proposing any new server resource.

## Milestone 2 compatibility contract

Milestone 2 adds role-aware research starting points without changing access or
adding a new server resource:

- A person's onboarding role remains a local preference. Research actions are
  active only when the server reports Researcher tier 4; the client never grants,
  promotes, or infers that tier.
- **Research Studio** studies use ordinary titled, private agent chats. Starting
  one opens the existing chat composer with a prefabricated draft for the person
  to review and edit; onboarding and task shortcuts must not send it
  automatically.
- The starting task label is exactly **Run a research-informed design review**.
  Research Hub reviews must cite their evidence and sources and clearly remain a
  research-informed first pass. They must not claim or imply human validation,
  research approval, or design approval.
- Sharing continues to use normal Servant controls and ordinary channel or
  direct-message posts with threads. Upstream clients can therefore read the
  study summary, follow permitted shared chats, and participate in feedback
  without a Research Studio-specific renderer.

This milestone adds no Research Studio endpoint, message type, persistence
schema, or pairing change. It adds only two optional, backwards-compatible
fields to the existing chat-creation exchange: the UX client requests
`requiredAgentRole: "researcher"`, and the server confirms the resulting chat
with `agentRole: "researcher"`. The request is checked again in the same state
transaction that stores the chat, so an access change cannot silently create a
different kind of workspace. Original clients ignore the optional response
field and continue to use the same chats, sharing, messages, and threads.

## Mobile builds

`app/app.config.js` defaults to the UX flavor:

```sh
cd app
npx expo config --type public
npx expo prebuild --clean
```

This configuration does not reference `GoogleService-Info.plist` or
`google-services.json`, filters the React Native Firebase and Crashlytics config
plugins, omits the PushKit/background-call config plugin, and disables remote
notifications in the notifications plugin. No Firebase or push secret is
invented or checked in.

To inspect or reproduce the upstream native identity explicitly:

```sh
SERVANT_APP_FLAVOR=core npx expo config --type public
SERVANT_APP_FLAVOR=core npx expo prebuild --clean
```

Core native builds retain their Firebase file references and therefore still
need the existing ignored service files and normal Apple/Google signing setup.
The repository's TestFlight and Firebase distribution scripts belong to the
upstream app and refuse to run unless the operator explicitly sets
`SERVANT_APP_FLAVOR=core`. Do not use those targets for a UX release.

## Push limitation

The first UX build reports native push as unsupported. It does not ask for
notification permission, obtain a device push token, or register one with the
server. Native notification alerts and background system call ringing are
therefore unavailable; in-app messaging and calls while the app is active still
use the existing server connection.

Enabling push later requires all of the following together:

1. UX-owned APNs and FCM app registrations for the new bundle/package IDs.
2. UX service files and securely managed provider credentials outside Git.
3. Server routing that selects the correct FCM project and APNs topics for each
   client. The current APNs transport targets `gov.irs.servant` and
   `gov.irs.servant.voip`, so reusing it for `gov.irs.servant.ux` would fail.
4. A UX build with the Firebase/notification configuration enabled and a
   deliberate telemetry decision for Crashlytics.

## Updates

UX mobile runtime versions are prefixed with `servant-ux-`, which prevents an
upstream binary from accepting a UX JavaScript update. The Electron package does
not point at the upstream GitHub release feed, and its downloaded web-interface
updates are disabled: the existing shared server namespace is `mac-shell-*` and
would otherwise allow one desktop flavor to receive the other's bundle.

Before distributing Electron updates, create a UX-owned signed release feed and
a flavor-specific server/runtime namespace. Until then, distribute new UX desktop
builds manually; **Check for Updates** explains that limitation instead of
contacting the upstream feed.
