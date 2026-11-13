# Contributing

Thanks for helping. Servant is dedicated to the public domain under [CC0 1.0](LICENSE): by contributing you agree your work is released the same way.

## Before you start

- Open an issue first for anything bigger than a small fix, so we agree on the idea before you spend time on it.
- Read [README.md](README.md) for how the pieces fit, [AGENTS.md](AGENTS.md) for the repository map and rules, and [app/AGENTS.md](app/AGENTS.md) before changing the app.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Workflow

Changes come in as pull requests against `main`, from a fork or a branch. Nobody pushes straight to `main`.

1. Fork the repository (or create a branch if you have write access) and branch from the latest `main`.
2. Make one focused change. Small pull requests with tests get reviewed and merged fastest; split unrelated fixes into separate pull requests.
3. Add or update tests with every behavior change, and update the docs that describe it.
4. Run the checks below for every part you touched, plus `scripts/scrub-check.sh`.
5. Open the pull request and fill in the template: what changed, why, before/after screenshots, and how you verified it. Every PR needs real, labeled screenshots with base/head commits and viewports. Use matching synthetic fixtures and durable image links; include desktop and phone for responsive UI. For new features, explain the actual previous state. For backend-only or documentation changes, show the relevant observable behavior, rendered document, or validation output and label it accurately. Review images for private data and refresh them when visible behavior changes.

## Checks

Use Node 22.13 or newer. Run from the repository root. The server and relay tests import the app's encrypted transport client, so run `npm ci --prefix app` once before them (CI does the same).

| Part | Command |
| --- | --- |
| Server (`server/`) | `cd server && node --test` |
| App (`app/`) | `cd app && npm ci && npx tsc --noEmit && npm test && npm run lint` |
| Relay (`relay/`) | `cd relay && npm ci && npm test` |
| Mac app (`desktop/`) | `cd desktop && npm test` (unit tests need no install; packaging needs `npm ci` in `app/` and `desktop/`) |
| MCP (`mcp/`) | `cd mcp && npm ci && npm test` |
| Any changed `.mjs` or `.js` file | `node --check <file>` |
| Any changed shell script | `bash -n <file>` |
| Everything | `bash scripts/scrub-check.sh` |

`scripts/scrub-check.sh` must pass before you push. It fails when a tracked file or file name matches a pattern in `scripts/scrub-denylist.txt` (names of organizations and people, internal hostnames, personal paths). CI runs it on every push and pull request.

## What we look for

- Keep the server dependency-free. If you think a package is needed, say why in the pull request.
- No hardcoded identifiers: bundle ids, Apple team ids, hostnames, email addresses and project names come from `SERVANT_BUNDLE_ID`, environment variables or the server's `config.json`. Use the placeholders `com.example.servant`, `example-org`, `example.gov` and made-up people (Pat Tester, Jo Park, Ana Ruiz) in examples and tests.
- The app ships English text only; there is no translation layer or Spanish locale. Write strings in plain English.
- Plain words in the app: "server", not "hub"; the agent is "Agent", mentioned with `@agent`.
- Anything that changes what other people see or belong to is announced in the app.
- Errors say what failed, at which step, and what to do next.
- Never refuse a message after someone typed it; show limits before they start typing.
- Do not weaken the privacy and records-preservation guarantees described in [AGENTS.md](AGENTS.md).

## Never commit

- Tokens, API keys, invite codes, device tokens, passwords or app passwords
- Signing material: `.p8`, `.p12`, `.pem` private keys, `.jks`, `.keystore`, `.mobileprovision`, the OTA private key, the server's `transport-key`
- Firebase or Google config files (`google-services.json`, `GoogleService-Info.plist`) and service-account JSON
- `.env` files, `push.json`, mail credentials, relay configs, or a server `config.json` from a real installation
- Anything from a server data directory (`server/data/`, `*.db`, `*.sqlite`), logs, recordings or exports
- Personal information: real names, email addresses, phone numbers, home-directory paths, or screenshots showing real people or conversations
- Internal links, organization names or hostnames from your own deployment

`.gitignore` covers most of these, but check `git status` and your diff before every commit. If something sensitive does land, follow "If a secret lands" in [AGENTS.md](AGENTS.md) and tell the maintainers privately through [SECURITY.md](SECURITY.md).

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
