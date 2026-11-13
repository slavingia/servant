# Public testing on TestFlight and Google Play

Anyone can try Servant before it is in the stores: a public TestFlight link on iPhone and an open testing track on Google Play. A tester still needs an invite from a Servant server to sign in; the apps alone show only the join screen.

## iPhone: a public TestFlight link

Once, in App Store Connect: create the app record (iOS, the name, your `SERVANT_BUNDLE_ID`, any SKU) and note its Apple ID under App Information. Build and upload with `scripts/testflight.sh <build> --notes <notes.md>` (see [the share extension guide](ios-share-extension.md) for signing, including `SERVANT_IOS_SIGNING=automatic`).

Then open the build to everyone:

```sh
SERVANT_ASC_APP_ID=<apple id> python3 scripts/public-testflight.py <build> \
  --feedback you@example.org --privacy https://servant.example.org/privacy \
  --description "Agents for public servants. You need an invite from a Servant server." \
  --notes notes.md --encryption-exempt
```

It waits for App Store Connect to process the build, fills in the test information external builds need (once), creates the external group **Public** with a public link (or reuses it), adds the build, submits it for Beta App Review and prints the link. The link never changes, so it can go on a website at once; installs start when Apple approves the first build, usually within a day or two, and later builds in the same version need no new review. `--limit` caps how many testers can join through the link (default 10,000, the TestFlight maximum). Leave out `--encryption-exempt` to answer the export compliance question in App Store Connect yourself; see [encryption](encryption.md) before claiming an exemption.

Beta App Review needs a way in. The script sets the review contact from `--feedback` and a note that Servant is a client for a self-hosted server; put a working invite link for a review server in the notes in App Store Connect (TestFlight > Test Information > Beta App Review Information) before the first submission, or the review fails with "unable to sign in".

## Android: open testing on Google Play

Once, in Play Console: create the app with the same package name, finish the store listing, content rating and data safety forms, and invite a service account from your Google Cloud project with release permissions (`PLAY_JSON_KEY` points at its key). Build with `scripts/firebase.sh <build> --notes <notes.md> --no-upload` (it writes `app-release.aab`), then:

```sh
PLAY_TRACK=beta python3 scripts/play.py upload <path to app-release.aab> "What changed"
```

`beta` is Play's open testing track: the listing shows **Join the beta** and anyone can install. Until the console forms are complete, Play rejects the track; use `PLAY_TRACK=internal` (console-listed testers only, no forms needed) in the meantime. A new app's first release may be accepted only as a draft; finish it in the console once.

## Keeping both links in the app

Put the TestFlight link in `downloads.ios` and the Play listing in `downloads.android` in the server's `config.json` ([deployment](deployment.md)); the join page and the invite screens show them.
