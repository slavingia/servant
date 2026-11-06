# Servant for Mac 1.0.0 preview — November 2, 2026

Download page: https://servant-desktop.web.app

Installers: https://github.com/slavingia/servant-desktop-releases/releases/tag/v1.0.0-preview.1

The Apple silicon and Intel DMGs require macOS 13 or later. Open the disk image,
drag Servant to Applications, then scan its QR code from **You → Link a computer**
in the updated phone app. Confirm the matching number before approving. The Mac
receives a separate device credential for the phone's existing account.

## Distribution status

- Mac installers have ad-hoc signatures and pass disk-image and signature-integrity
  checks. They are **not Developer ID signed or notarized**, and Gatekeeper rejects
  them under its default policy. The download page clearly labels this limitation
  and links Apple's opening instructions. Developer ID creation was blocked by an
  Account Holder restriction on the API credential and expired Xcode authentication.
- Phone build **25** is available in the existing TestFlight group, Firebase
  `servant-internal` group, and Google Play internal track. TestFlight reports
  `VALID / IN_BETA_TESTING`; Play reports `completed`; Firebase distribution and
  release-note readback succeeded. No Servant chat announcements were posted.
- API release `20261102-mac-qr-a334aa0` is active and healthy. The previous API
  drained through the existing supervisor. Other live runtime modules matched
  the prior release; the only changes were device-link handling and its module.
- Firebase Hosting serves the page and checksums. Its Spark plan rejected DMGs,
  so the installers are hosted in the dedicated public release repository.

## Source and verification

Backend source: `a334aa0`. Phone source: `006c4db`. Mac runtime source: `8ac7caa`.
Later documentation/download-link commits do not change these compiled artifacts.

- 189 server tests, 113 app tests, desktop policy tests, app typecheck, and lint
  passed. Lint retains three existing warnings in unrelated screens.
- The isolated Electron smoke test decoded the actual displayed QR image, approved
  the matching request, verified the same user and separate token, sent/read a
  channel message, restarted the app, and signed out. Encrypted account storage,
  absence of plaintext localStorage credentials, token revocation, sandbox flags,
  and zero external HTTP requests were checked.
- The packaged Apple silicon app launched with all network access blocked.
  Intel architecture and artifact integrity were verified; Intel execution was
  unavailable on the build Mac. Physical phone camera scanning was not exercised.
- Only public workspace metadata is bundled. Packaged runtime files match source.

SHA-256:

```text
44362759f9b59f45c57a76645e07f35aebeda4fabce4c9c379557ecbe28053d7  Servant-1.0.0-arm64.dmg
496507f1a8e0c8cee6461dc7c7f202741f03a96c3f29578f2db0209812ae1c06  Servant-1.0.0-x64.dmg
```

Automatic Mac updates are not implemented. **Help → Download the latest Servant**
opens the download page. Signing and notarization remain outstanding for the
normal macOS installation experience.
