# Servant UX for Mac

This checkout builds a separately installable UX client: product name
`Servant UX`, app ID `gov.irs.servant.ux.desktop`, URL scheme `servant-ux`, and
storage under `~/Library/Application Support/Servant UX/`. It accepts both
`servant-ux://pair` and ordinary `servant://pair` invites when they are pasted.
Because the operating-system handler is intentionally distinct, opening an
ordinary `servant://` link directly still targets the upstream Servant app.

Binary updates and downloaded web-interface updates are disabled until the UX
team has a dedicated signed release feed and desktop runtime. The upstream
release repository, Firebase Hosting site, artifact names, signing identities,
and `mac-shell-*` update namespace described later in this file are core Servant
infrastructure; do not publish a Servant UX build to them.

The Mac app packages the Expo web application with Electron. It bundles the app
locally, opens external web links in the default browser, and saves its account
using macOS Keychain-backed encryption. It does not run the Servant server or
Hermes on a teammate’s computer.

Electron 45.2.1 requires **macOS 13 Ventura or later**. Release packages are built
separately for Apple silicon (`arm64`) and Intel (`x64`).

## Build

Use Node 22.13 or later and the checked-in lockfiles. From the repository root:

```sh
npm ci --prefix app
npm ci --prefix desktop
npm test --prefix desktop
npm run typecheck --prefix app
npm run lint --prefix app
SERVANT_DESKTOP_WORKSPACE=/absolute/path/workspace-public.json npm run dist --prefix desktop
```

The public workspace file contains only these fields:

```json
{
  "server": "https://your-servant-server.example",
  "serverKey": "<trusted compressed P-256 public key: 66 lowercase hex characters>",
  "discovery": "https://your-trusted-discovery.example/workspace.json"
}
```

`discovery` is optional. Obtain the public key through a trusted operator channel;
do not trust a key supplied by an unverified relay or discovery document. The
build validates HTTPS addresses and projects only the allowed public fields into
the bundled `workspace.json`. Without a workspace file, the app supports existing
invite-link sign-in. Never use a server data directory, private transport key,
device token, account export, or credential file as the workspace configuration.
Both `web/` and `workspace.json` are generated and ignored by Git.

`npm run pack --prefix desktop` creates an unpacked app for inspection.
`npm run dist --prefix desktop` exports the web app and creates `Servant-UX-*`
DMG and ZIP files
in `desktop/dist/`. Packaged apps must use production HTTPS configuration; local
test configuration is for development only.

## Set up and sign in with no phone

The Mac app does not need the phone app or a QR code. On the Mac that will host the server, from a Servant checkout:

```sh
deploy/mac/install.sh            # add --tunnel so phones and other computers can reach it
```

It installs the server as launch agents, adds a `servant` command, and prints a one-time `servant://pair` link for the owner. The installer's automatic open targets `/Applications/Servant.app`; for Servant UX, open the app, choose **Paste an invite link**, and paste the same link.

Later, on the same Mac: `servant invite --owner` (a new device for you), `servant invite` (team link), `servant invite --name "Ann"` (one person). Without a public address, links point at `127.0.0.1` and work only on that Mac. Running the installer again deploys newer code and keeps the data.

To join a server run by someone else, ask the admin for an invite link and paste it into the Mac app. Direct links for this app use `servant-ux://`; ordinary `servant://` links remain assigned to upstream Servant when it is installed.

## QR sign-in

The Mac displays a short-lived QR request. A signed-in phone scans it through
**You → Link a computer**, shows the verification number, and asks the user to
approve. Approval adds a new device to the phone’s existing user; it does not
create a duplicate account or copy the phone’s device token.

Each person can have any number of devices. Pair another computer using the
signed-in phone, or issue an existing-user invite for another phone. Each device
has its own credential; signing out or revoking one leaves the others signed in.
Presence combines active sessions, while read receipts belong to the person.

Starting with Mac 1.0.1 and phone build 27, the owner sees **Mobile**, **Computer**,
or **Browser** beside messages with a known sending-device category. The server
records the authenticated session's category when the message is sent and omits
it from member responses. These are client categories, not hardware attestation;
older messages and unrecognized sessions remain unlabeled. This preview applies
only to conversations the owner can already access.

The QR contains an approval handle, not the desktop’s polling secret or an account
token. Requests use the pinned encrypted transport. The phone verifies the server
identity before approving, and the desktop’s separate secret is required to claim
the new device credential. Expired and already-used requests cannot be reused.
Treat QR codes and verification numbers as transient sign-in material and do not
publish QA screenshots containing them.

This flow needs a server release containing desktop pairing and a phone build
containing the approval screen (**build 25 or later** for the initial rollout).
Existing build 24 phones do not gain the screen automatically. Publish the phone
update through the established TestFlight, Firebase, and Google Play testing
channels. The repository’s `testflight.sh` and `firebase.sh` upload modes also
post release notes into Servant; use their `--no-upload` modes when building and
upload separately if no chat announcement has been authorized.

## Isolated QA

Follow the repository’s isolated-test instructions. Start a dedicated test
instance using `node scripts/test-instance.mjs start` where that runner is
available; never pair test devices or create test accounts in the main instance.
Keep the test server, public key, profile, and runtime separate from production.
For an unpackaged Electron run, set both a test workspace and a separate profile:

```sh
SERVANT_DESKTOP_TEST=1 \
SERVANT_DESKTOP_WORKSPACE=/absolute/path/test-workspace-public.json \
  npm run prepare:web --prefix desktop
SERVANT_DESKTOP_TEST_PROFILE=/absolute/path/isolated-desktop-profile \
  npm start --prefix desktop
```

The test workspace may use loopback HTTP. Rebuild with the production public
workspace configuration before packaging or distributing. Verify approval,
rejection, expiry, repeat redemption, restart persistence, and the existing
account’s conversations using isolated fixtures.

After exporting the web bundle, `npm run test:smoke --prefix desktop` performs
an isolated end-to-end test using fresh temporary server data and desktop profiles.
It decodes the displayed QR image with macOS Vision, approves it in a second
profile, sends a channel message, restarts the Mac app, and checks sign-out.
It also checks owner-only device labels on live and consecutive messages and
confirms that a member receives and displays no device metadata.
It needs macOS and Xcode command-line tools. It does not exercise a physical
phone camera or native deep-link delivery.

## Signing and notarization

Distribution outside the Mac App Store needs a **Developer ID Application**
identity and Apple notarization for the normal Gatekeeper installation flow.
Apple Development and Apple Distribution identities are not substitutes.
The download page currently labels the release as an unsigned, unnotarized
preview; change that notice only after verifying the final release artifacts.

For an explicitly labeled preview, `npm run dist:preview` uses ad-hoc signatures
and the separate preview entitlements required to load Electron without a
Developer ID team. This is not a notarized distribution build; Gatekeeper may
block it. Keep the preview notice visible and use the normal `dist` command
with Developer ID signing for the finished release.

Electron Builder can use an installed Developer ID identity through
`CSC_NAME`, or a protected certificate export through `CSC_LINK` and
`CSC_KEY_PASSWORD`. Keep certificate exports, private keys, and passwords outside
the repository. Never put them in the workspace JSON, web assets, release notes,
or download directory. Hardened runtime and the checked-in entitlements are
enabled in the Mac build configuration.

Apple notarization credentials may be supplied through Electron Builder’s
supported `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` environment
variables, or a preconfigured notarytool Keychain profile. A separate notarization
step is also supported after packaging:

```sh
xcrun notarytool submit desktop/dist/Servant-1.0.0-arm64.dmg \
  --keychain-profile servant-notary --output-format json
xcrun notarytool info <submission-id> --keychain-profile servant-notary
```

Wait for Apple’s `Accepted` result, then staple and validate each architecture’s
DMG. Check the contained app’s signature and Gatekeeper assessment as well:

```sh
xcrun stapler staple desktop/dist/Servant-1.0.0-arm64.dmg
xcrun stapler validate desktop/dist/Servant-1.0.0-arm64.dmg
codesign --verify --deep --strict --verbose=2 /path/to/Servant.app
spctl --assess --type execute --verbose=2 /path/to/Servant.app
```

Repeat for Intel. Checksums must be calculated after all signing and stapling.
Do not describe an artifact as signed, notarized, or accepted unless the relevant
checks pass on the exact artifact being published.

## Publish the download page

The dedicated Firebase Hosting site is **servant-desktop**, in project
**irs2go-apps**, at <https://servant-desktop.web.app>. `downloads/index.html` is the
page source. Hosting serves only the HTML page and checksums in `desktop/dist/downloads/`.
The Spark plan rejects executable uploads, so installers are published through
[the dedicated GitHub Releases repository](https://github.com/slavingia/servant-desktop-releases).
Keep build source, maps, private configuration, and QA material outside the public directory.

After verifying both final DMGs, publish them to the release repository and stage
only the page and checksums for Firebase:

```sh
mkdir -p desktop/dist/downloads
cp desktop/downloads/index.html desktop/dist/downloads/index.html
(cd desktop/dist && shasum -a 256 Servant-1.0.0-*.dmg Servant-1.0.0-*.zip > downloads/SHA256SUMS)
gh release create v1.0.0-preview.1 --repo slavingia/servant-desktop-releases \
  --title "Servant for Mac 1.0.0 preview" --notes-file /path/to/release-notes.md \
  --prerelease --draft desktop/dist/Servant-1.0.0-arm64.dmg \
  desktop/dist/Servant-1.0.0-x64.dmg desktop/dist/Servant-1.0.0-*.zip \
  desktop/dist/Servant-1.0.0-*.zip.blockmap desktop/dist/latest-mac.yml \
  desktop/dist/downloads/SHA256SUMS
# Verify uploaded assets, then publish the release.
gh release edit v1.0.0-preview.1 --repo slavingia/servant-desktop-releases --draft=false
```

Update the version, minimum macOS version, phone requirement, download filenames,
and signing notice when preparing a later release. Point the page’s buttons at
the exact published release asset URLs. Verify every link and checksum
before publishing. Clear unrelated inherited Google settings, as the existing
Firebase distribution script does:

```sh
cd desktop
env -u GOOGLE_CLOUD_QUOTA_PROJECT -u GOOGLE_CLOUD_PROJECT \
  -u CLOUDSDK_CORE_PROJECT -u GOOGLE_APPLICATION_CREDENTIALS \
  firebase deploy --only hosting --project irs2go-apps --config firebase.json
```

After deployment, download both public artifacts and compare their SHA-256 values
to `SHA256SUMS`. Verify the page’s instructions and artifact status match what was
actually released. Publishing the website does not deploy the pairing server or
update the phone apps.

## Updates

The update behavior below documents the upstream core app. Servant UX currently
shows a clear "not configured" message for binary update checks and does not poll
the shared `mac-shell-*` web-interface runtime, preventing cross-flavor updates.

The app checks [the release repository](https://github.com/slavingia/servant-desktop-releases)
10 seconds after launch, every 6 hours, and from **Servant → Check for Updates…**.
It reads `latest-mac.yml` from the newest release, including pre-releases, so every
release must upload `latest-mac.yml` and both ZIPs (with their blockmaps) alongside
the DMGs. Bump `version` in `desktop/package.json` for each release; the updater
compares it with the version in `latest-mac.yml`.

- **Developer ID signed builds** download the update in the background, then offer
  **Restart Now** or install the next time Servant quits.
- **Ad-hoc preview builds** can't install in place: Squirrel.Mac only accepts an
  update carrying the running app's Developer ID signature. They show the new
  version and open the download page instead.

Builds released before 1.0.2 have no updater; those users install one release
manually through **Help → Download the latest Servant**.
The download page carries a notice telling 1.0.0 and 1.0.1 users to do this.

Silent installs need a **Developer ID Application** certificate (see Signing and
notarization). The first signed build still reaches preview users through the
download prompt, because their ad-hoc copies can't verify it; after that, updates
install in the background.
