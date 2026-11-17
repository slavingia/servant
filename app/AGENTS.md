This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

This project uses npm (`package-lock.json`); use `npx`, not `bunx`.

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npm run lint                # lint (expo lint)
npx tsc --noEmit            # typecheck
npm test                    # unit tests: node --test on src/lib/*.test.ts
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint, typecheck and tests before declaring any task done. Testable logic belongs in `src/lib/` with a `*.test.ts` beside it.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

No `eas.json` is checked in: run `npx eas-cli@latest build:configure` under your own Expo account if you want EAS builds (`eas build`, `eas submit`). The repository's own release path builds locally with `scripts/testflight.sh` (iOS) and `scripts/firebase.sh` (Android), configured through environment variables, and ships over-the-air updates with its own signed OTA server (`docs/ota.md`, `scripts/ota-publish.mjs`), not `eas update`.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Design rules the tests enforce

Read `docs/design-system.md` before adding a screen. These rules have a test in `src/lib/` that reads every screen, so `npm test` fails when a new one breaks them:

- One `Button`: `primary`, `secondary`, `danger` (red outline, for anything that deletes, removes, leaves, stops or signs out) and `link`. Do not build a button from a `Pressable` and a `Text` (`button-standard.test.ts`).
- Blue words are a link and spread `linkUnderline`, so they are underlined on the web (`links.test.ts`).
- No `numberOfLines` on anything a person needs to read; names, titles, labels and values wrap (`truncation.test.ts`).
- A fill with words or an icon on it is `colors.primary` or `colors.danger`, never `colors.blue`, `green` or `red` (`fills.test.ts`).
- Radios, checkboxes, switches and tabs set `aria-checked` or `aria-selected`, and disclosures set `aria-expanded`, beside `accessibilityState` (`aria-state.test.ts`). One of several is a radio, not a button with `selected`; a button that is on sets `aria-pressed`; the open page sets `aria-current`.
- Controls are at least 44 points by their own size. No `hitSlop`: it does nothing in a browser or the Mac app. A smaller shape (a chip, a pill) sits inside a 44-point control (`touch-targets.test.ts`). The wide layout's sidebar is the exception: it stays a compact list (32-point rows) with no gaps between its groups.
- An icon alone is an `IconButton`; a switch is a `Toggle`; a ticked box is a `CheckBox`. Draw a close with the `close` icon, not a character.
- Colors, type, radii and spacing come from the theme. `token-ratchet.test.ts` fails when a file gains a literal; when you remove one, lower its number in `token-ratchet.json`.

## App identity

The bundle id is one build-time setting, `SERVANT_BUNDLE_ID` (default `com.example.servant`), read by `app.config.js`. It sets the iOS bundle identifier and the Android package; the iOS share extension is `<id>.share` and its app group is `group.<id>`. The server's APNs topic uses the same id, so build the app and run the server with the same value. The ids in `app.json` are only the static default; `app.config.js` overrides them. Your Firebase files (`GoogleService-Info.plist`, `google-services.json`) must be registered for the same id. They are optional: with no file for a platform, that build leaves Crashlytics out and sends no crash reports.
