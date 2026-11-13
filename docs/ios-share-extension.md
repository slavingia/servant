# Releasing the iPhone share extension

The iOS share target is enabled in `app/app.json`. `app/app.config.js` derives the
app identifier, extension identifier (`<bundle id>.share`) and shared App Group
(`group.<bundle id>`) from `SERVANT_BUNDLE_ID`. Android sharing does not depend on
these Apple signing steps. A simulator build does not verify distribution signing
or receiving shares on a real iPhone.

## Apple Developer setup

Use the Apple Developer team that distributes the app. Keep the identifiers and
signing material in private release configuration, outside the repository.

1. Register the App Group `group.<bundle id>` in Certificates, Identifiers & Profiles.
2. Enable App Groups on the app's explicit App ID and select that group.
3. Register the explicit extension App ID `<bundle id>.share`, enable App Groups,
   and select the same group. The extension does not need push notifications.
4. Regenerate the app's App Store distribution profile after enabling the group.
5. Create the extension's App Store distribution profile with an Apple Distribution
   certificate whose private key is installed on the build Mac.
6. Download and install both profiles. Xcode uses either
   `~/Library/MobileDevice/Provisioning Profiles` or
   `~/Library/Developer/Xcode/UserData/Provisioning Profiles`.

Apple documents [configuring App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups)
and [regenerating provisioning profiles after changing app services](https://developer.apple.com/help/account/provisioning-profiles/edit-download-or-delete-profiles/).

## Check and build

Set `SERVANT_BUNDLE_ID` and `SERVANT_APPLE_TEAM_ID` in the private release
environment. Profile names default to `Servant Push App Store` and
`Servant Share App Store`. Override them with `SERVANT_IOS_APP_PROFILE` and
`SERVANT_IOS_SHARE_PROFILE`; profile UUIDs also work. The older `SHARE_PROFILE`
variable remains supported by the release script.

A read-only check can run before starting a build:

```sh
python3 scripts/ios-share-release.py preflight \
  --bundle-id "$SERVANT_BUNDLE_ID" --team-id "$SERVANT_APPLE_TEAM_ID" \
  --app-profile "${SERVANT_IOS_APP_PROFILE:-Servant Push App Store}" \
  --share-profile "${SERVANT_IOS_SHARE_PROFILE:-Servant Share App Store}"
```

`scripts/testflight.sh <build-number> --no-upload` runs this check automatically
before prebuild and CocoaPods. It requires nonexpired iOS App Store profiles for
both exact identifiers, the shared App Group, the configured team, and an installed
signing identity matching each profile. It stops with an action to take if setup
is incomplete; it never disables the extension to get a build through.

After archive and export, it verifies both signatures and embedded profiles,
matching bundle identifiers, build numbers, versions and signed App Group
entitlements, and the embedded extension's share target type. The exported IPA
is checked again because export can change signing. These checks inspect the
actual signed artifacts; they do not prove the share flow works on a phone.
Apple describes the inspected fields in [Inside Code Signing: Provisioning Profiles](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles).

To upload, use `scripts/testflight.sh <build-number> --notes <notes.md>` with the
upload and App Store Connect environment described at the top of that script.

With `SERVANT_IOS_SIGNING=automatic` the script needs no installed profiles and no
app-specific password: Xcode registers both App IDs and the App Group, makes the
App Store profiles and signs with a cloud-managed distribution certificate through
the App Store Connect API key in `SERVANT_ASC_CONFIG` (see `scripts/asc.py`; the key
needs the Admin role, or App Manager with access to cloud-managed certificates), and
the upload uses the same key. The archive and IPA checks above still run. The
preflight profile check is skipped, since there are no named profiles to inspect.
Do not reuse a build number already uploaded to App Store Connect. Keep signing
logs, profiles and archives private.

The validation tests use synthetic fixtures and need no Apple account:

```sh
python3 scripts/test-ios-share-release.py
```

## Real iPhone acceptance checks

Record the source commit, TestFlight build, iOS version, device and results in a
private release receipt. Use synthetic content and capture no account or signing
information in public screenshots. Leave these checks open until performed on
the installed TestFlight build:

- Share a photo from Photos, a PDF from Files and a link from Safari. Check the
  selected project/chat, attachment content and successful send.
- Repeat with the app closed and already open. One incoming share must open one
  composer, without a second navigation or duplicate send.
- Repeat signed out and after a session expires. Pair or sign in, then verify the
  original content is still available to review and send once.
- Share a mixed link and image from a source app that supports it; verify activation
  and both pieces of content. Also check multiple files and an over-limit file.
- Check that a large file names the problem on its card, blocks Send, and can be
  removed; check readable long names and the choice to start or continue a chat.

Expo's receiving API is experimental, and launching the host from the share
extension requires real-device validation. Do not mark device acceptance complete
based on the simulator, unit tests, preflight or a successful archive alone.
