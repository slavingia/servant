# Over-the-air app updates from your Mac

The Servant server on your Mac can send JavaScript and asset updates straight to phones. There is no app store review, no TestFlight build and no Expo account or cloud service. Phones fetch updates from your Mac over the same tunnel or relay as everything else.

```text
your Mac:   servant ota publish          expo export → <data>/ota (signed when served)
phone:      opens Servant → GET <server>/ota/manifest → downloads changed files → runs them on the next launch
```

## What an update can and can't change

- **Can:** screens, copy, logic, fixes, images and fonts that ship in the JavaScript bundle.
- **Can't:** anything native, such as a new Expo module, a permission, an app icon or a new SDK version. Those need a new build, and the build's version changes, which starts a new *runtime version* (below).

A phone only takes an update made for its own runtime version. The runtime version is `version(buildNumber)` from `app/app.json` on iOS and `version(versionCode)` on Android, for example `1.0.0(28)`. Bump `buildNumber` and `versionCode` whenever you ship a build with native changes. Updates published for the old number then stop reaching new builds, so a new build can never run JavaScript that expects different native code.

## One-time setup

1. **Signing key.** Already generated for this project. The private key lives only at `~/.config/servant/ota-keys/private-key.pem` (mode 0600) and is never committed. The certificate is `app/certs/certificate.pem`, built into every app. To make a new pair: `cd app && npx expo-updates codesigning:generate --key-output-directory ~/.config/servant/ota-keys --certificate-output-directory certs --certificate-validity-duration-years 10 --certificate-common-name Servant`, then `npx expo-updates codesigning:configure --certificate-input-directory=certs --key-input-directory=$HOME/.config/servant/ota-keys`. A new certificate needs a new build, and builds with the old one keep trusting only the old key.
2. **A stable address for your Mac.** Each build has the update address built in, so it must not change. A quick tunnel's `trycloudflare.com` address changes on restart, so use a fixed one: a named Cloudflare tunnel or the stable relay in [relay-transport.md](relay-transport.md). The update address is `https://<that host>/ota/manifest`.
3. **A build that contains expo-updates and that address.** Updates only reach builds made after this was added, and only builds given the address: `SERVANT_OTA_URL=https://<host>/ota/manifest scripts/testflight.sh <n>` (same for `scripts/firebase.sh` and the Play bundle). Without `SERVANT_OTA_URL`, updates are off in that build. Older builds ignore updates.
4. **The server.** Nothing to configure. `/ota/manifest` and `/ota/assets/<hash>` are part of the API and use `<data>/ota`.

## Publish

```sh
servant ota publish --note "Fix call errors"     # both platforms
servant ota publish --platform ios               # one platform
servant ota status                               # what is published
servant ota rollback --runtime '1.0.0(28)'       # send phones back to the version inside their app
```

`servant ota publish` runs `expo export` in the checkout that installed the server (the `SERVANT_REPO` in `~/.local/share/servant/servant.env`), so check out the commit you want first. Without the `servant` command: `node scripts/ota-publish.mjs`.

Each publish keeps the last eight updates per runtime version and removes files nothing refers to. Files are named by their SHA-256, so repeat publishes upload only what changed.

## What a phone does

1. On launch, `expo-updates` asks the address built into the app (`SERVANT_OTA_URL`, wired in `app/app.config.js`).
2. It sends its platform and runtime version and asks for a signature.
3. The server answers with the newest update for that runtime, or "no update", or "roll back".
4. The phone checks the signature against the certificate inside the app, then checks each file's hash, then downloads what it doesn't have.
5. The new version runs the next time the app starts. You → Help & updates → **Check for updates** fetches it right away and offers **Restart to update**.

## Security

- **Code is signed.** The server signs each manifest and rollback with the private key on your Mac. Phones refuse anything not signed by the matching certificate, so a Cloudflare tunnel, a relay or anyone on the path cannot change the code. A server without the key answers `503` rather than serving unsigned code.
- **Files are hash-checked** against the signed manifest. Asset names are their hashes and the server serves only those, so there are no path tricks.
- **The routes are public** (they are fetched before sign-in) and contain app code only: the same JavaScript that's in the store build. No user data, tokens or settings.
- **The built-in version is always the fallback.** The address is fixed in the build, so anti-bricking stays on: if the server is unreachable, has nothing for this build, or you roll back, the app opens the version inside it. (An earlier design let the app change its address at runtime. Testing showed that removes the built-in fallback and the app dies on launch after a rollback, so it was dropped.) A bad update that opens but misbehaves is fixed by publishing again or `servant ota rollback`.
- **The private key is the crown jewel.** Whoever holds it can run code in every installed Servant. Back it up somewhere private and never put it in the repo, a chat or the server's data directory. The `.gitignore` already excludes `*.pem`.

## Troubleshooting

| What you see | Cause |
| --- | --- |
| Check for updates says "Up to date" but you published | The build's runtime version differs from the published one. `servant ota status` lists them; compare with `You → Servant 1.0.0` and `buildNumber` in `app.json`. |
| "Your server doesn't offer app updates yet" | The server is older than this feature. Deploy it. |
| "This update isn't signed by your server" | The build trusts a different certificate than the key that signed. Publish with the key that matches `app/certs/certificate.pem`. |
| `503 This server has no update signing key` | No key at `~/.config/servant/ota-keys/private-key.pem`. Set `SERVANT_OTA_KEY_FILE` if it lives elsewhere. |
| No Check for updates row | A development build, a web build, a build made before this feature, or a build made without `SERVANT_OTA_URL`. |
| Phones stop finding updates after a restart | The address in the build changed (quick tunnel). Use a fixed address. |
