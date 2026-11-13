# iPhone share validation captures

These are browser screenshots of actual validation output, rendered at the same
1116 × 846 viewport with the same synthetic fixtures. They are not screenshots
of an iPhone, TestFlight build or successful signed archive. There is no visible
app layout change in this patch.

- Before source: `1ff5f04f1748eb7e09a51f077b9e6b5ea58ddb85`.
- After source: `f28d49f4000bbe75c7a5d4c9db526b883cadc478` (includes the share routing fix in `b812dbf`).
- Images were reviewed for readability and contain only synthetic data and source identifiers.

## Pending-share navigation

The same `app/src/lib/share-gate.test.ts` harness ran against the actual base and
changed `ShareGate.tsx` and `incoming-share.ts` source. Native payload storage,
foreground events, router calls and timers are simulated; the production hook
callbacks and native adapter execute unchanged.

| Result | Before | After |
| --- | --- | --- |
| Tests | 5 | 5 |
| Pass | 2 | 5 |
| Fail | 3 | 0 |

The failures cover a pending share interrupting verification, expiry while a
foreground timer is pending, and reopening a claimed share after sign-out and
pairing. The checks also assert that routing does not clear native payloads.

## Release entry point

The actual base and changed `scripts/testflight.sh` ran with the same synthetic
bundle/team and nonexistent profile names, using `900 --no-upload`. Tool shims
return no usable profiles or identities and stop if prebuild is requested. No
real signing, native generation, archive or upload occurs; the output directory
is not created.

| Result | Before | After |
| --- | --- | --- |
| Expo prebuild requested | Yes | No |
| Exit status | 86 (intentional fixture stop) | 1 (missing-profile rejection) |

The changed script reports how to install the missing profile before doing build
work. `python3 scripts/test-ios-share-release.py` includes a regression test for
this boundary as well as synthetic archive/IPA validation tests.

## Limits

Real iPhone acceptance remains pending: share activation from Photos, Files and
Safari; mixed payloads; OS deep-link delivery; files surviving pairing and session
verification; and one successful send. See [the release checklist](../../ios-share-extension.md).
