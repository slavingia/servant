# Servant for Mac 1.0.1 preview — November 2, 2026

Download: https://servant-desktop.web.app

Installers: https://github.com/slavingia/servant-desktop-releases/releases/tag/v1.0.1-preview.1

## Multiple devices and owner preview

A person can keep any number of devices signed in. QR linking and existing-user
invites issue separate credentials for the same user. Signing out or revoking
one device leaves the others active; presence combines sessions and read receipts
belong to the person.

The owner sees Mobile, Computer, or Browser beside messages with a known source,
including consecutive messages. The server snapshots the authenticated session's
category when the message is sent. It projects that metadata only for the owner
across history, search, previews, write responses, and live/replayed events.
Members receive no source-device field. This preview does not grant access to
other people's private chats. Unknown and historical sources remain unlabeled;
these are client categories, not attested hardware identities.

The phone source also includes the legacy-account invite scanner correction
from `4e9114c`, so this release preserves that parallel fix.

## Distribution

- Mac 1.0.1 Apple silicon and Intel DMGs are published and linked from the download
  page. Both public downloads were streamed without authentication and their
  SHA-256 values matched the verified local artifacts.
- macOS 13 or later is required. The DMGs have ad-hoc signatures and are **not
  Developer ID signed or notarized**. Gatekeeper rejects them under its default
  policy. The page retains the preview notice and Apple's opening guidance.
- API release `20261102-message-devices-6838303` is active and healthy. The previous
  API drained normally. The existing independent worker remains pinned to its
  prior release; its compatibility was exercised before deployment.
- QR approval continues to work with phone build 25 or later. Phone build **27**,
  containing the owner indicators and scanner correction, is available in the
  existing IRS TestFlight group (`VALID / IN_BETA_TESTING` with verified group
  membership), Firebase `servant-internal` group, and Google Play internal track
  (`completed`, with the uploaded bundle hash verified).
- No Servant chat announcements or production QA accounts/messages were created.

## Source and verification

API, phone, and Mac runtime source: `6838303`. Documentation-only follow-ups do
not change compiled artifact provenance.

- Server: 196 tests passed, including four devices for one user, independent
  revocation, owner/member privacy, role changes, forged metadata, and an actual
  pinned old worker operating through an API upgrade and additive schema changes.
- App: 122 tests, typecheck, and lint passed; lint retains three existing warnings.
- All six GitHub Actions contract checks passed at `6838303`.
- The isolated Electron flow decoded and approved the displayed QR, sent/read
  messages, verified owner-only Computer/Mobile labels on live and compact rows,
  checked encrypted storage, restarted, and signed out. It reported zero UI errors
  and zero external HTTP requests.
- Both final mounted DMGs passed disk-image/signature-integrity and architecture
  checks. Their complete packaged web assets and runtime matched source. The
  packaged Apple silicon app launched with networking blocked. Intel execution
  and physical phone camera scanning were not exercised.
- The phone IPA, APK, and AAB match the frozen app source and contain the expected
  QR and device-label code. iOS signing, production push entitlement, and all 22
  retained dSYMs were verified. Android signing matches build 25, all four ABIs
  are present, and native symbols and mapping files are retained.

SHA-256:

```text
24490e598f11289bc9c8d3bdbb97bb8f848a9472535caa39176be6c9f15b082d  Servant-1.0.1-arm64.dmg
45753283741cf0ceab2f3deb2217c7e2f57413a01843aa8df0603394021be4dc  Servant-1.0.1-x64.dmg
```

Automatic Mac updates are not implemented. **Help → Download the latest Servant**
opens the download page. Signing and notarization remain outstanding for the
normal macOS installation experience.
