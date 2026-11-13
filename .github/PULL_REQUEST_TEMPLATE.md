## What and why

<!-- One focused change. Link the issue it addresses, if any. -->

## Before / after

<!-- Required on every PR. Embed real screenshots using durable image links.
Record base/head commits, scenario, viewport and synthetic fixture context.
Match before/after viewports; include desktop and phone for responsive UI.
For a new screen, show the actual previous state and explain what did not exist.
For backend/docs changes, show relevant observable behavior, rendered docs or
validation output, accurately labeled. Never fabricate a before state.
Inspect images for private data and refresh them after visible changes. -->

| Before | After |
| --- | --- |
| <!-- Screenshot, base commit, viewport --> | <!-- Screenshot, changed commit, viewport --> |

## How I verified it

<!-- Paste the summary lines of the checks you ran (pass/fail counts). -->

## Checklist

- [ ] Tests added or updated for the behavior I changed
- [ ] Before/after screenshots embedded, commits and viewports identified, images visually reviewed and free of private data
- [ ] Ran the checks for every part I touched (see CONTRIBUTING.md): server `cd server && node --test`; app `cd app && npm ci && npx tsc --noEmit && npm test && npm run lint`; relay `cd relay && npm ci && npm test`; desktop `cd desktop && npm test`; `node --check` / `bash -n` on changed scripts
- [ ] `bash scripts/scrub-check.sh` passes
- [ ] No secrets, credentials, data files, real names, email addresses, internal links or personal paths in the diff or screenshots
- [ ] No hardcoded bundle ids, team ids, hostnames or emails (use `SERVANT_BUNDLE_ID`, environment variables or `config.json`)
- [ ] Docs updated (README, docs/, AGENTS.md) if behavior, configuration or commands changed
- [ ] Privacy and records-preservation guarantees in AGENTS.md still hold
