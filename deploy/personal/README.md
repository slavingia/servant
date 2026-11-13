# Sahil’s personal Servant deployment

This directory deploys the public homepage, support and legal pages, and an allowlisted API
proxy at **https://servant.sahillavingia.com**. It serves Sahil Lavingia’s personal
instance. It does not deploy or modify other teams’ workspaces.

The native Servant app connects through this domain. The homepage is informational;
there is no browser messaging app in this deployment.

## Topology

```text
servant.sahillavingia.com (Vercel)
  /, /support, /privacy, /terms static files in public/
  /health, /v1/*, /join,
  /ota/*                     external rewrites
    → personal.servant.com (dedicated Cloudflare named tunnel)
      → 127.0.0.1:8790 (personal Servant supervisor)
        → immutable API release + separate durable worker
```

Only the four application route families listed in `vercel.json` reach the origin. There is no
catch-all proxy or administrative route. The supervisor must also retain its own
administrative route block because the tunnel origin can be reached directly.
Private API requests still use Servant’s application encryption and device
credentials. `/health`, `/join`, and `/privacy` are public.

All rewritten responses explicitly disable Vercel rewrite caching. Static public
pages can use Vercel’s normal static asset caching. The privacy and terms pages
reuse the repository's `privacyPage()` and `termsPage()` text inside the personal
site layout. Regenerate both from the private config's public contact fields:

```sh
node deploy/personal/generate-legal.mjs "$HOME/.local/share/servant-personal/data/config.json"
node --test deploy/personal/generate-legal.test.mjs
```

Only `contactEmail` and `footer` are rendered. The private config is never copied
or printed. Static legal pages remain available when the Mac is offline and avoid
Cloudflare email rewriting breaking the contact link. Deploy the regenerated
`public/` files together with `vercel.json`.

## Personal server setup

Use a clean, verified source snapshot. The repository’s Mac installer stages the
files present in its checkout, including uncommitted edits. Do not stage another
task’s unfinished code.

Keep the personal service separate:

| Setting | Personal value |
| --- | --- |
| Runtime | `~/.local/share/servant-personal` |
| Data | `~/.local/share/servant-personal/data` |
| Launchd label prefix | `com.sahillavingia.servant` |
| Stable proxy | `127.0.0.1:8790` |
| Public URL and join URL | `https://servant.sahillavingia.com` |
| Tunnel origin | `https://personal.servant.com` |

Create its private `data/config.json` before first install. Set a personal `name`,
`host` to `127.0.0.1`, `port` to `8790`, `publicUrl` and `joinUrl` to the public URL,
`discovery` to `off`, and `upstreams` to `{}` until a separate personal agent is
configured. Omitting `upstreams` would use the default localhost agent services;
do not reuse another team’s agent keys, data, projects, or configuration.

Run the Mac installer with the isolated paths and label:

```sh
deploy/mac/install.sh \
  --name "Sahil’s Servant" \
  --port 8790 \
  --runtime "$HOME/.local/share/servant-personal" \
  --data "$HOME/.local/share/servant-personal/data" \
  --label com.sahillavingia.servant \
  --no-open
```

Set `SERVANT_PUSH_CONFIG` on both personal supervisor and worker launch agents to
`$HOME/.config/servant-personal/push.json` (use an absolute path in the plist).
Keep that file mode 0600 with the personal Apple team's `apnsTeamId`, `apnsKeyId`,
`apnsKeyPath`, and `apnsTopic: "com.sahillavingia.servant"`. Do not let the personal
services fall back to another workspace's default push configuration. Restart
only these personal services after changing their launch environment.

The installer prints a private owner sign-in invitation. Keep that output private;
do not paste it into a deployment log, issue, public page, or Git commit. Create
and share personal owner invitations separately after the public domain works.

Configure a dedicated Cloudflare named tunnel for `personal.servant.com`, pointing
to `http://127.0.0.1:8790`, followed by a `http_status:404` fallback. Run it as its
own launch agent. Keep its credential file and configuration outside the checkout
in a private directory (0700, files 0600). Do not use the quick-tunnel publisher:
it would replace the configured public URL with a temporary address.

The Mac must be awake, online, and running the personal supervisor, worker, and
tunnel for API requests to work. The Vercel homepage, support, privacy and terms pages remain available independently. Persistent
SQLite data, uploads, recordings, and keys stay on the Mac. This is not a migration
of the backend into Vercel Functions.

## Vercel deployment

Create or select a personal Vercel project whose root directory is
`deploy/personal`. Use framework preset **Other**, no build command, no install
command, and output directory `public`. Deploy only this directory. If deploying
from the CLI, use an authenticated personal account/team and link this directory
to the intended project before deployment:

```sh
cd deploy/personal
vercel link
vercel deploy --prod --skip-domain
```

Inspect the resulting deployment before assigning production traffic, then promote
that tested deployment. Add `servant.sahillavingia.com` to the personal project and
configure the DNS record Vercel requests. Existing Vercel credentials should remain
in the authenticated tooling; never add tokens or private environment files here.

No secrets or environment variables are required by this static proxy project.
Do not expose `.vercel/`, server data, tunnel credentials, or installer output in
`public/`.

The App Store marketing URL can use the homepage, support can use `/support`, and
privacy can use `/privacy`. The homepage also links to both pages and `/terms`.

## Verification and operational limits

Check both the direct tunnel origin and public domain. Verify:

- `/` and `/support` display personal ownership and working contact/privacy links.
- `/health` reports the personal server name; `/v1/server` reports the public URL.
- `/join`, `/privacy` and `/terms` return their expected pages; all static navigation links work.
- `/admin/releases` is unavailable at both the public domain and the origin.
- Plaintext `/v1/me` is rejected; an encrypted pairing and authenticated `/v1/me`
  succeed using a disposable personal test device. Revoke that device afterward.
- Encrypted message/event streaming, reconnection, an attachment upload, and
  native calls work through the public domain. Test agent execution separately
  once a personal agent is configured.

Vercel’s [external rewrites](https://vercel.com/docs/routing/rewrites) forward HTTP
traffic to the tunnel. Its [proxied-request timeout](https://vercel.com/docs/limits#proxied-request-timeout)
is 120 seconds. The [origin-timeout announcement](https://vercel.com/changelog/cdn-origin-timeout-increased-to-two-minutes)
describes the wait for the backend to start sending data. This configuration does
not extend that platform limit or establish unlimited streaming: verify the
app’s long-running encrypted streams and reconnect behavior on the deployed path.
A successful health check alone does not verify long-running agent responses,
large uploads, or calls. WebRTC media has its own connectivity requirements;
HTTP rewrites do not provide a TURN relay.

See [server deployment](../../docs/deployment.md) for immutable API updates,
worker draining, rollback, and backup responsibilities. Keep the personal
runtime/data environment explicit for every administrative command.

## Installed instance (November 11, 2026)

The initial backend is immutable release
`20261111T192516Z-personal-0dbe44c584ef`, built from clean commit
`0dbe44c584ef27d3c3b4f1d96b6aed17458c5377`. It uses the paths and labels above;
all three launch agents load automatically at login. Personal APNs configuration
is explicit on the supervisor and worker. No personal Hermes upstream or Android
push provider is configured.

The Vercel project is `servant-personal` in `sahil-lavingias-projects`.
The named Cloudflare tunnel is `servant-personal`. Both are independent of the
other teams’ services. Routine backend updates use the personal runtime's
`bootstrap/deploy.mjs` and the procedure in `docs/deployment.md`; retain the
personal push configuration when updating launch agents.

Server tests: 461 passed and 4 skipped; the single Git-history-dependent test
passed separately with repository history available (462 passed total).
Typecheck passed; lint passed with four existing warnings. The APNs transport
test also validates the personal app's alert and VoIP topics with signed fixtures.

Live verification passed through the public domain: encrypted pairing, profile,
private message and attachment roundtrip, anonymous attachment denial, event
stream startup/cancellation, and signout revocation. Test content was deleted and
the temporary member removed. Native call quality, delivery to a physical device,
and streams beyond the proxy timeout were not part of this deployment smoke test.

The public legal-page update on November 11, 2026 is Vercel production deployment
`dpl_J8k3QM8dDEQxbUZwnVWq7PwQ5rv3`. `/`, `/support`, `/privacy`, `/terms` and
`/health` returned HTTP 200 after deployment. All four static pages link to the
terms; contact links remain readable without Cloudflare email rewriting. The
static pages fit a 320-pixel viewport in Chrome. The generator's two tests passed
and prove only the public contact fields enter generated HTML. This update
changed static public files only; it did not update either backend runtime.

## Public identity and repository checks

The owner explicitly authorized publishing this personal deployment’s name, public
domain, support address and independence disclaimer on November 11, 2026. Only the
reviewed identity lines in this README and the four public HTML pages are exempt
from the repository scrub check. The policy in `scripts/scrub-public-lines.py`
checks exact file paths and complete-line fingerprints; changing or appending text
requires another review. Other names, addresses, private paths and prohibited
content in these same files still fail the check. This is not an exception for
credentials or private server configuration.
