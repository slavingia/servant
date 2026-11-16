# Working in this repository

Servant is agents for public servants, with self-hosted secure team messaging: an Expo phone app, a dependency-free Node server, an Electron Mac app, an optional relay and an MCP server. This file is for people and coding agents alike. App-specific guidance lives in [app/AGENTS.md](app/AGENTS.md).

## Repository map

| Path | What it is |
| --- | --- |
| `server/` | Node server with no npm dependencies (`servant-server`): pairing, device tokens, roles, the encrypted transport, messaging, calls, agent turns, push, records preservation. Tests are `*.test.mjs` beside the code. Its data lives in `server/data/` or `$SERVANT_DATA_DIR` (gitignored). |
| `app/` | Expo (SDK 58) React Native app for iOS, Android and the web (`servant`). Routes in `src/app/`, components in `src/components/`, logic and tests in `src/lib/`, native code in `modules/` and config plugins in `plugins/`. |
| `desktop/` | Electron Mac app (`servant-desktop`) that packages the app's web build. |
| `relay/` | Optional Cloudflare Worker relay (`servant-relay`) that gives a server a stable address; tested with Miniflare. |
| `mcp/` | MCP server and client library (`servant-mcp`) so other tools can sign in like the Mac app. |
| `deploy/` | Mac installer (`deploy/mac`) and Linux installer and systemd units (`deploy/linux`). |
| `config/` | Reproducible restricted member agent profiles (`config/profiles`) and the supported Hermes versions (`hermes-versions.json`). |
| `scripts/` | Release helpers (TestFlight, Firebase App Distribution, Play, App Store Connect notes, OTA publish), Hermes compatibility tests, and `scrub-check.sh` with its denylist. |
| `docs/` | Operator guides, design notes, release notes and captures. |
| `.github/` | CI workflows (`hermes-compatibility.yml`: server, app, relay and Hermes contracts; `scrub.yml`: the scrub check), issue and pull request templates. |

## Commands

Use Node 22.13 or newer and run from the repository root. The server and relay tests import the app's transport client, so install the app's dependencies first.

```sh
npm ci --prefix app                                  # once, before server or relay tests

cd server && node --test                             # server tests (also: npm test --prefix server)
cd app && npx tsc --noEmit                           # app typecheck
cd app && npm test                                   # app unit tests (node --test on src/lib/*.test.ts)
cd app && npm run lint                               # app lint (expo lint)
cd relay && npm ci && npm test                       # relay integration test (Miniflare)
cd desktop && npm test                               # Mac app unit tests; no install needed
cd mcp && npm ci && npm test                         # MCP tests
node --check path/to/file.mjs                        # syntax check any changed JS file
bash -n path/to/script.sh                            # syntax check any changed shell script
bash scripts/scrub-check.sh                          # no org names, people, internal links or personal paths
```

## Rules

- Small, focused changes. One idea per commit and per pull request; small follow-up commits rather than rewriting pushed history.
- Tests with every change. A behavior change without a test that would have caught its absence is not done.
- Keep the server dependency-free.
- Never commit credentials, data or personal information: tokens, invite codes, keys and certificates, Firebase or Google config files, `.env` files, `push.json`, a real `config.json`, anything from `server/data/`, databases, logs, recordings, real names, emails or home-directory paths. See the full list in [CONTRIBUTING.md](CONTRIBUTING.md#never-commit).
- No hardcoded identifiers. Bundle ids derive from `SERVANT_BUNDLE_ID` (default `com.example.servant`: share extension `<id>.share`, app group `group.<id>`, VoIP topic `<id>.voip`, Mac app `<id>.desktop`). Apple team ids, provisioning profiles, App Store Connect, Play and Firebase settings come from environment variables (`SERVANT_APPLE_TEAM_ID`, `SERVANT_IOS_APP_PROFILE`, `SERVANT_IOS_SHARE_PROFILE`, `SERVANT_ASC_CONFIG`, `PLAY_JSON_KEY`, `SERVANT_FIREBASE_PROJECT`). Hostnames, contact addresses, allowed email domains and project names come from the server's `config.json` (`publicUrl`, `contactEmail`, `emailVerification.domains`, `prototypesProject`) or `push.json` (`apnsTopic`).
- Examples and tests use placeholders: `example-org`, the projects `example-app` and `prototypes`, the domain `example.gov`, and made-up people such as Pat Tester, Jo Park and Ana Ruiz.
- The app ships English strings only: there is no translation layer or Spanish locale. Do not add strings in other languages unless a localization layer is added on purpose.
- Plain words in the app: "server", not "hub"; the agent is "Agent", mentioned with `@agent`. Errors say what failed, at which step, and what to do next.

## Privacy invariants

Do not weaken these without an explicit decision recorded in the docs. If a change touches one, say so in the pull request.

- **Message encryption is pinned app-to-server.** The app encrypts API requests to the server's public key from a trusted invite, pins it, never learns or replaces it from a relay or discovery file, and never falls back to plaintext. The server rejects unencrypted `/v1/` requests except public server information. See [docs/encryption.md](docs/encryption.md).
- **The server's private key never leaves the owner's machine.** `transport-key` lives in the data directory, is never published with discovery and is never part of a desktop workspace file or a build.
- **The agent never gets someone further than their own access goes.** With the network gate on ([docs/agent-egress.md](docs/agent-egress.md)), a person's agent reaches a host only through an entitlement that person asked for, confirmed and was granted ([docs/entitlements.md](docs/entitlements.md)). Nobody is given one without their own confirmation, a manager grants only what they hold themselves, nobody chooses their own manager, and the entitlement history is never changed or deleted.
- **The agent is reachable only from the server.** The Hermes API listens on localhost; members get the restricted profile in `config/` ([docs/member-security.md](docs/member-security.md)).
- **No prompt text in `usage.db`.** Usage stores only the token counts the agent reports and topic labels, never request or reply text.
- **Notifications carry only what [docs/notifications.md](docs/notifications.md) says:** a title and body (sender, conversation or chat title or case reference, up to 240 characters of text, or none when the person turns off **Show sender and message**) plus opaque routing ids. Provider payloads are allowlisted; nothing else leaves the server. A reply email to a visitor of the secure inbox carries the team's name and that visitor's own return link, and nothing from the conversation; it goes only to an address the visitor confirmed with a code ([docs/secure-inbox.md](docs/secure-inbox.md#reply-emails)).
- **Feature flags only hide.** Turning a `features` flag off (channels, direct messages, meetings) or switching on Deep work never deletes data.

## Records preservation invariants

See [docs/records-management.md](docs/records-management.md) and `server/records-preserve.mjs`. When `"recordsPreservation": { "enabled": true }` is set:

- Servant must not destroy authored content. Every path that edits or deletes a message, deletes a conversation or agent chat, drops a message from the agent's history, removes a recording, meeting audio, project or file, or blanks an agent turn's approval record must first copy the content into the append-only, hash-chained archive (`records_archive` in `messages.db`).
- The copy is made in the same transaction as the change. If the copy cannot be saved, the change does not happen and the person is told.
- The archive is never updated or deleted (triggers refuse it); nothing adds a retention or disposition path.
- Any new way to edit, delete or drop content must go through the same preservation step and come with a test that proves both the archived copy and the refusal when archiving fails.
- When the setting is off, behavior is unchanged. The feature is not a records schedule or a compliance claim; do not describe it as one.

## Before you claim something is done

Run the commands for every part you touched and paste the summary lines (for example `ℹ tests 460`, `ℹ pass 460`, `ℹ fail 0`, `TSC` with no output, lint with 0 errors, `scrub-check: OK`). If a check fails for a reason unrelated to your change, say which test and why you think so; do not call the work done on an unverified claim. For UI changes, look at the result in the running app (`cd app && npx expo start --web`) as well as the tests.

Every pull request must embed labeled **Before** and **After** screenshots in its description. Capture the real base and changed versions, identify their commits, and match viewports and synthetic fixtures where possible. Include desktop and phone views for responsive changes. For a new feature, show the actual previous state and explain that the new screen did not exist. For backend-only or documentation changes, capture relevant observable behavior, rendered documentation, or validation output and say exactly what it demonstrates. Review every image for readability and private information. Use durable image links, update captures after visible changes, and report a real capture blocker rather than fabricating or silently omitting evidence.

## Public repo hygiene

This repository is public. The earlier private workflow of committing straight to `main` does not apply here.

This is the only repository: there is no private mirror, and the history before the public baseline is not published. Everyone, maintainers included, lands changes through pull requests after `scripts/scrub-check.sh` passes.

- Changes land through pull requests from forks or branches, reviewed before merge.
- Run `bash scripts/scrub-check.sh` before every push; CI runs it on every push and pull request. Add new sensitive terms to `scripts/scrub-denylist.txt` written so the file does not contain them in plain text (for example a character class in the middle of the word).
- No organization names, real people, internal links, internal hostnames, ticket numbers, or screenshots that show real names or conversations. Use the placeholders above, and `~` instead of a full home-directory path (only `/Users/you` is allowed where an absolute path is unavoidable, such as launchd files).
- **If a secret lands** (a key, token, password, invite code, personal data): treat it as compromised. Rotate or revoke it first (APNs or FCM key, OTA signing key, relay token, transport key with fresh invites, device tokens with `servant revoke`). Then remove it from the tree in a new commit, report it privately to the maintainers through the repository's security advisories, and let them decide whether history must be rewritten. Removing it from the latest commit alone does not make it secret again.
