# Contributing

Thanks for helping. Servant is public domain (CC0): by contributing you agree your work is released the same way.

## Before you start

- Open an issue first for anything bigger than a small fix, so we agree on the idea
- Read [README.md](README.md) for how the pieces fit, and [app/AGENTS.md](app/AGENTS.md) before changing the app

## Working on it

- Commit small changes to `main`. Pull requests from forks are welcome too
- Server tests: `node --test --test-timeout=20000 server/`
- App checks: `cd app && npm ci && npx tsc --noEmit && npm test`
- Keep the server dependency-free. Say why if you need to add a package
- Plain words in the app: "server", not "hub"; the agent is "Agent", mentioned with `@s`

## What we look for

- Anything that changes what other people see or belong to is announced in the app
- Errors say what failed, at which step, and what to do next
- Never refuse a message after someone typed it; show limits before they start typing

## Never commit

Tokens, invite codes, signing keys, Firebase or Google config files, `.env` files, personal paths or email addresses. `server/data/` is gitignored for a reason.

Security problems: see [SECURITY.md](SECURITY.md), not a public issue.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
