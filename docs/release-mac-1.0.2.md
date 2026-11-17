# Servant for Mac 1.0.2 preview — November 2, 2026

Download: https://servant-mac.web.app

Installers: https://github.com/slavingia/servant-desktop-releases/releases/tag/v1.0.2-preview.1

## Updates

1.0.2 is the first release with the updater from `dafe7ab`. It reads
`latest-mac.yml` from the newest release in the release repository 10 seconds
after launch, every 6 hours, and from **Servant → Check for Updates…**. The
release includes both ZIPs, their blockmaps, and `latest-mac.yml` alongside the
DMGs, so later releases can be found by 1.0.2.

These are ad-hoc preview builds, so Squirrel.Mac can't install an update in
place. The app shows the new version and opens the download page. Silent
background installs start once a Developer ID signed and notarized build is
installed. That needs a Developer ID Application certificate, which this Mac
doesn't have yet.

## Existing users

1.0.0 and 1.0.1 have no updater. Anyone on those versions installs 1.0.2 by hand
once, through **Help → Download the latest Servant** or the download page. The
page has a notice saying this. After that, the app finds new versions itself.

## Source and verification

Mac runtime source: `dafe7ab` plus the version bump. The bundled public workspace
(server, transport public key, discovery) is byte-identical to 1.0.1's, and the
key matches the running server's transport identity.

- Desktop policy tests (4) and app typecheck passed.
- Built with `npm run dist:preview`. Both apps have the expected single
  architecture (arm64, x86_64), pass `codesign --verify --deep --strict` (ad-hoc),
  report version 1.0.2, and carry `app-update.yml` for
  `slavingia/servant-desktop-releases` (prerelease channel).
- Both DMGs passed `hdiutil verify`. Every SHA-512 in `latest-mac.yml` matches its
  file.
- The packaged Apple silicon app launched with a fresh profile and reached the
  live server's QR sign-in screen. Its first background check ran before 1.0.2
  was published, so it failed quietly, with no dialog. Intel execution was not
  exercised. An in-app update from 1.0.2 to a later version is first exercised
  by the next release.

SHA-256:

```text
dfbae60a3acc920949eea16d1538b3e90e6d303ef8e5ce34820c957f8127e647  Servant-1.0.2-arm64.dmg
881a0eee7326c969750324ccad6bd8eaf14bed0c39ba9f29ab592da9c1ac7ffd  Servant-1.0.2-x64.dmg
8a75deaab2167edd331de8ed2418ddb34668747f935ba8a6b9c7299947dff87f  Servant-1.0.2-arm64.zip
caaa9c59a131827b1bd450a97d73f3148cfc3a2a52c6d8650a2d35f74140a740  Servant-1.0.2-x64.zip
```
