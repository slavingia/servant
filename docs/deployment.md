# Deploying Servant without losing work

Servant supports planned API deployments through a stable loopback reverse proxy.
The supervisor starts a checked, immutable release, verifies readiness, switches
new requests, and lets accepted work finish on the previous API. The public
tunnel and durable worker remain running. This document describes the implemented
architecture and operator procedure; an installation is migrated only after its
launch agents have been changed and the live checks below pass.

## Processes and persistent paths

| Process | Stable entrypoint | Lifetime |
| --- | --- | --- |
| Proxy and API supervisor | `bootstrap/run-supervisor.sh` | Keeps `127.0.0.1:8787`; API releases change through the private control socket |
| API children | `releases/<id>/server.mjs` | One active version plus retiring versions finishing accepted work |
| Channel-agent and notification worker | `bootstrap/run-worker.sh` | Pinned to `SERVANT_WORKER_RELEASE`, independently of API deployments |
| Tunnel and discovery publisher | `bootstrap/run-tunnel.sh` | Restarts only for its own failure or configuration/code changes |
| Feedback worker | Existing `feedback-worker.mjs` service | Independent of the API, durable worker, and tunnel |

The examples use these absolute paths:

```text
SERVANT_RUNTIME_DIR=/Users/sahil-irs/.local/share/servant
SERVANT_DATA_DIR=/Users/sahil-irs/servant/server/data

$SERVANT_RUNTIME_DIR/bootstrap/       stable supervisor, CLI, and tunnel code
$SERVANT_RUNTIME_DIR/releases/<id>/   read-only code and checksum manifest
$SERVANT_RUNTIME_DIR/deployment.json  active and previous API release IDs
$SERVANT_RUNTIME_DIR/control.sock     private deploy/status/rollback socket (0600)
$SERVANT_RUNTIME_DIR/logs/            service logs and API logs by release ID
```

The shared data path is deliberately outside release directories. Keeping the
existing data path avoids moving identity keys or databases during the first
cutover; it can later be moved offline with every writer stopped. Set the same
absolute data path on all services and administrative CLI invocations. Never
copy data, credentials, `.env` files, or logs into a release. The runtime directory
is private (0700), and the service account must own it. Use the same tested Node
runtime with `node:sqlite` support for all services; `NODE` can pin its executable.

## One-time bootstrap and migration

The first conversion from the combined `server/run.sh` runner has a maintenance
gap. The older API owns port 8787 and may write JSON state or own channel jobs;
it cannot safely overlap the first new version. Prepare everything before stopping
it, and perform the cutover after active agent work finishes.

From the repository root, prepare the stable bootstrap and stage the initial
release. Choose a unique release ID; the timestamp below is an example generator.
These commands do not start services or modify account data.

```sh
export SERVANT_RUNTIME_DIR=/Users/sahil-irs/.local/share/servant
export SERVANT_DATA_DIR=/Users/sahil-irs/servant/server/data
umask 077
mkdir -p "$SERVANT_RUNTIME_DIR/bootstrap" "$SERVANT_RUNTIME_DIR/logs"
cp server/supervisor.mjs server/deploy.mjs server/tunnel.mjs server/publish.mjs \
  server/run-supervisor.sh server/run-worker.sh server/run-tunnel.sh \
  "$SERVANT_RUNTIME_DIR/bootstrap/"
chmod 700 "$SERVANT_RUNTIME_DIR" "$SERVANT_RUNTIME_DIR/bootstrap" "$SERVANT_RUNTIME_DIR/logs"
chmod 700 "$SERVANT_RUNTIME_DIR/bootstrap/"*.sh
SERVANT_RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-initial"
node "$SERVANT_RUNTIME_DIR/bootstrap/deploy.mjs" stage \
  --source "$PWD/server" --id "$SERVANT_RELEASE"
```

Do not repeat the bootstrap copy during normal API deployments. It is a separate
component upgrade; running the supervisor from a mutable checkout would make a
later process restart silently load unrelated edits.

1. Run `node --test server/` and the app's applicable checks against the code to
   stage. Tests use temporary data and fake upstreams; do not substitute the
   production data directory for a test fixture.
2. Customize `server/gov.irs.servant.supervisor.plist.example`,
   `server/gov.irs.servant.worker.plist.example`, and
   `server/gov.irs.servant.tunnel.plist.example`. Replace the staged release ID
   placeholders and check executable, data, bootstrap, and log paths. The
   supervisor uses `SERVANT_INITIAL_RELEASE` only when no saved selection exists.
   The worker always uses its independently pinned `SERVANT_WORKER_RELEASE`.
   Validate each customized file with `plutil -lint` before installing it under
   `~/Library/LaunchAgents/`.
3. Stop the legacy combined launch agent and all other legacy JSON writers.
   Verify that its API, cloudflared, and discovery publisher children have exited.
   Stop other data writers, including feedback work, for a consistent backup of
   the complete data directory, including SQLite WAL files and transport keys.
   Older API versions may lack graceful shutdown; finish their work before this
   step. Never run a new CLI against live data while an old API still writes JSON.
4. Load the customized supervisor and worker launch agents using
   `launchctl bootstrap "gui/$(id -u)" <absolute-plist-path>`. Start the tunnel
   agent after local readiness succeeds. Resume other services stopped for backup.
   Ensure only one tunnel publisher and one durable worker are running.
5. Check private deployment status, local `/ready`, public `/health`, and an
   authenticated app request. Verify a message, an attachment, a channel-agent
   turn, and event reconnection. Confirm the worker logs `durable worker ready`.
   Preserve the backup and record the release IDs and observed checks separately.

Editing examples alone does not install services. Keep the old combined job
unloaded after migration. Do not use its restart commands for API deployments.

## Routine API deployment and rollback

Stage the complete tested server source, then deploy the returned release ID:

```sh
export SERVANT_RUNTIME_DIR=/Users/sahil-irs/.local/share/servant
SERVANT_RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-api"
node "$SERVANT_RUNTIME_DIR/bootstrap/deploy.mjs" stage \
  --source /Users/sahil-irs/servant/server --id "$SERVANT_RELEASE"
node "$SERVANT_RUNTIME_DIR/bootstrap/deploy.mjs" deploy --release "$SERVANT_RELEASE"
node "$SERVANT_RUNTIME_DIR/bootstrap/deploy.mjs" status
curl --fail --silent http://127.0.0.1:8787/ready
```

Staging copies direct runtime `.mjs` files and `package.json`, excluding test
files and the encrypted test client. It rejects symlinks, records SHA-256 checksums,
and writes read-only releases. Changing an existing release ID to different code
is rejected. New runtime assets or dependencies require extending this staging
contract before deployment; they are not copied automatically.

The supervisor verifies every manifest and starts a candidate on an ephemeral
loopback port with `SERVANT_WORKER_MODE=external`. Readiness must return
`{ok:true, release:"<id>", deploymentProtocol:1}` and `/health` must return
`{ok:true}`. The default candidate startup limit is 30 seconds, configurable with
`SERVANT_CANDIDATE_TIMEOUT_MS` on the supervisor. A failed candidate leaves the old
API serving. After an atomic routing switch, a second readiness/health smoke
check can restore the old selection if the candidate fails.

Existing requests, uploads, and direct-agent streams remain attached to the API
that accepted them. The old API closes event subscriptions so clients reconnect
through the new release; the listener remains available for already-dispatched
requests. Once proxy requests finish, SIGTERM starts the old API's internal drain,
which waits for accepted handlers even after client disconnect. The supervisor
sets `SERVANT_SHUTDOWN_TIMEOUT_MS=0`, so rollout never force-kills accepted work.
At most three retiring APIs may accumulate before another deploy is refused;
inspect status and logs and allow that work to finish.

Deployments are serialized. A control timeout is an uncertain result: inspect
status before retrying. Status reports active release, PID, private backend port,
retiring APIs, and whether a deploy is running. Control is available only through
the private Unix socket; the public proxy blocks `/admin` routes and strips the
local administrative header. Local administrative API calls, when needed, must
use the active backend port from private status and the existing local admin
contract. Do not expose that backend port or admin credentials publicly.

Rollback starts the previous release through the same readiness and drain path:

```sh
node "$SERVANT_RUNTIME_DIR/bootstrap/deploy.mjs" rollback
node "$SERVANT_RUNTIME_DIR/bootstrap/deploy.mjs" status
```

Rollback changes code selection only. It never restores databases or rewinds
messages, accounts, agent work, or push delivery. Both API releases and the pinned
worker must understand the current schema and transport protocol. Protocol 1
checks the deployment handshake; it is not proof that an arbitrary database
migration is compatible. Use additive schema changes and an explicit migration
plan for incompatible changes. Never roll back to the legacy JSON writer, a
release without the shared event log, or an API that resumes in-process workers.

Keep the active, previous, retiring, and pinned worker releases on disk. The
supervisor does not prune them. It best-effort respawns the active release after
a crash; requests can fail during crash recovery. Restarting the supervisor,
tunnel, Mac, or network is outside the planned API deployment guarantee.

## Worker ownership and upgrades

Message commits persist channel-agent jobs and notification outbox entries in
`messages.db`. The independent worker claims jobs and drains notification work;
APIs do not execute those background side effects. A dedicated SQLite transaction
lock in `worker-lock.db` is held for the worker's lifetime, preventing concurrent
workers for the same shared data directory. The OS releases ownership on death.

A worker crash leaves running agent jobs marked interrupted on recovery. Those
jobs are not automatically replayed because an external agent may already have
performed side effects. Queued jobs can resume. Notification IDs deduplicate
outbox handoff across worker restarts, but a crash or lost provider response can
still make external push delivery uncertain; this is not exactly-once delivery.

For a worker code upgrade, stage a compatible release, then signal the running
worker without unloading its launch agent:

```sh
launchctl kill SIGTERM "gui/$(id -u)/gov.irs.servant.worker"
```

Wait for that process to exit. It stops claiming new work, finishes its current
agent and notification tasks, drains pending notifications, and releases ownership.
The worker example uses `KeepAlive: {SuccessfulExit:false}`: a successful SIGTERM
drain stays stopped, while failure exits restart. Confirm this policy on an older
installation before relying on it; unconditional `KeepAlive=true` restarts the old
worker immediately. Once the worker has exited, use `launchctl bootout` to remove
its loaded definition, update `SERVANT_WORKER_RELEASE` in its installed plist,
validate it, and `launchctl bootstrap` the new definition. APIs and the tunnel stay
running; channel jobs queue during the worker gap. Do not use `kickstart -k`,
SIGKILL, or start a replacement before the old worker has exited. The runner
verifies the pinned release manifest before executing `worker.mjs`.

The worker and supervisor plists set `ExitTimeOut=310` to bound service and system
shutdown. Unloading a busy worker first would allow launchd to kill it after that
deadline; signal and wait before unloading during a planned worker upgrade.
Setting the timeout to zero would allow indefinite shutdown waits and can stall
Mac shutdown. System shutdown and stopping the supervisor are outside the
unbounded API rollout drain guarantee. Routine API deployments never restart
either launch agent. The standalone API's
default shutdown deadline remains five minutes unless explicitly configured;
a deadline expiry reports interruption and must not trigger blind agent replay.

## Public tunnel and discovery

The tunnel process targets the stable proxy at `127.0.0.1:8787`. It stays alive
through API switches, publishes discovery only after public `/health` succeeds,
and retries failed health checks. Its publisher uses the existing configuration
and GitHub gist; keep its `HOME`, `PATH`, and authenticated `gh` context available.
Do not run the old and new publishers concurrently. The tunnel reads the origin
port from `SERVANT_PORT`, then `config.json`, then 8787; `CF` can pin cloudflared.

No named-tunnel credentials were available during this rollout's preparation.
The quick-tunnel fallback preserves its current URL across API deployments, but
its URL changes when cloudflared restarts. Cloudflare documents no uptime
guarantee, a 200 in-flight request limit, and no SSE support for
[Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
The app's encrypted POST streaming workaround does not turn that fallback into
a production availability guarantee. Discovery helps paired phones find a changed
URL; a provisioned named tunnel is needed for a persistent public hostname.

For a locally managed named tunnel, provision credentials and DNS outside the
repository, following Cloudflare's
[setup guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/).
Set all three variables on the tunnel launch agent:

```text
SERVANT_TUNNEL_ID=<tunnel UUID or name>
SERVANT_TUNNEL_CONFIG=/absolute/private/path/servant.yml
SERVANT_PUBLIC_URL=https://servant.example.org
```

Its private configuration must route to the proxy; `SERVANT_PORT` does not rewrite
named-tunnel ingress:

```yaml
tunnel: <tunnel UUID>
credentials-file: /absolute/private/path/<tunnel UUID>.json
ingress:
  - hostname: servant.example.org
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Changing tunnel configuration or bootstrap code is its own controlled service
restart. It does not require restarting the API supervisor or worker.

## State, transport, and event compatibility

`state.db` is the source of truth for users, device-token hashes, invites, and
direct-agent chat metadata. Mutations read the latest versioned JSON document
under SQLite `BEGIN IMMEDIATE` and commit atomically. Authorization is rechecked
before committing work that awaited an agent. API routes, CLI account changes,
and push-token cleanup share this store. Writes serialize, so this design is
intended for the current small server rather than unlimited write throughput.

On first open, an uninitialized store imports `state.json` once and leaves that
file unchanged. Later opens ignore it. Invalid JSON, corrupt initialized data,
or unsupported database versions fail startup rather than resetting accounts.
There is no dual write or reconciliation with the old JSON file. Preserve all
databases and the transport identity together. Separate state, messages, replay,
and push databases do not form one cross-database transaction.

New pairing and normal authenticated requests use the encrypted transport. For
an existing paired device only, an operator may explicitly grant a finite
migration window by setting `legacyPlaintextUntil` to an epoch-millisecond expiry
in private transactional device state. This is opt-in; do not grant it by default
or extend it indefinitely. It temporarily permits that authenticated device's
legacy plaintext requests and adds `Deprecation` and `Sunset` response headers.
Expiry or device revocation ends access. Plaintext `/v1/pair` is always refused,
even with a legacy device grant. Update older app builds and issue trusted
encrypted invites before removing the temporary grant. See [encryption.md](encryption.md)
for the protocol and its limits.

Conversation changes and their event records commit together in `messages.db`.
Each API polls the log every 250 ms, so subscribers can observe writes from other
API releases and the independent worker. Schema setup and additive messaging
migrations serialize under a write transaction.

`GET` and `POST /v1/events?after=<cursor>` carry nonnegative cursors and SSE IDs
inside the authenticated transport. Reconnects replay permitted events, then
send `ready` with `{cursor,reset:false}`. `checkpoint` advances past unrelated
events. Missing, stale, future, or more than 2,000-events-behind cursors receive
`reset:true`; the log retains the latest 10,000 global events. This bounded log
supports synchronization rather than permanent auditing.

Replay checks current membership and resolves current content, including edits
and deletions. Former members receive only safe invalidations; revoked devices
are disconnected. Typing expires after six seconds, and slow readers reconnect
instead of accumulating unbounded server buffers. The app scopes its in-memory
cursor to the pinned server identity, device token, and user; a tunnel URL change
preserves it. It acknowledges handled frames, ignores duplicates, and replaces
cached history with snapshots after a reset while preserving composer drafts.
A fresh app launch loads snapshots. Older app builds need updating for cursor
replay and complete recovery.

## Verification and operational limits

The automated deployment suite exercises uninterrupted concurrent requests,
slow responses, uploads, event-stream closure, failed candidates, rollback,
serialized deploys, active-process crash recovery, and the administrative proxy
boundary. State, event, worker, encryption, and shutdown suites cover their own
cross-process and recovery contracts. Run the complete server suite after changes.

Before calling a live rollout successful, verify local and public health, the
selected release ID, authenticated messaging and attachment behavior, worker job
completion, and event catch-up. For a deployment-under-load check, confirm old
requests finish and new requests reach the new release; record any observed
failures rather than inferring success from readiness alone. Keep release and
worker IDs in the deployment receipt. Mac sleep/restarts, disk failure, upstream
agent availability, and internet loss require a separate availability design.

## Installed deployment: October 30, 2026

The Mac was migrated to this architecture at 23:47 UTC. The active API release is
`20261030T235100Z-c57f2625ba`; the compatible rollback release and independently
pinned worker/feedback release are `20261030T234751Z-c57f2625ba`. Both release
snapshots have source SHA-256
`c57f2625ba71ced1774f6cb632f762d1eddf3fc7feb5836340a2462a78701d9e`.
They were staged from the tested working tree, including its uncommitted server
changes. The stable bootstrap is installed outside the checkout. The old combined
launch agent was unloaded and its plist preserved with the offline backup.

The initial local cutover took 1.089 seconds. Public recovery took longer while
the new quick-tunnel hostname propagated through DNS; this first migration was
not a zero-downtime switch. The replacement URL was published and discovery was
verified. No permanent named hostname was provisioned.

After migration, a live deploy → rollback → deploy sequence served 271 requests
with zero observed failures: 140 local health checks, 66 public health checks,
and 65 encrypted authenticated requests. The measured deployment operations took
144, 148, and 168 ms, and maximum observed request latency was 199 ms. Supervisor,
tunnel, and worker PIDs and the public URL stayed unchanged; all old API processes
drained. An invalid candidate was rejected without changing the active release.
These measurements cover that verification run, not a general availability SLA.

The isolated real-server integration test also held direct and channel-agent
responses across deployment and rollback, checked exactly one completion per
accepted turn, and retained all 33 concurrent writes. Agent upstreams were fake
in that test; live verification did not send agent prompts or messages to users.
The full server suite passed 94 tests. The app passed 14 tests and TypeScript;
lint reported four warnings and zero errors. No mobile binary was distributed.

All five active application databases passed SQLite quick checks, all 25
pre-migration messages were preserved, and the legacy JSON snapshot remained
unchanged. Temporary verification credentials were removed. Existing four
paired devices have a migration grant until **November 29, 2026, 23:47:56 UTC**;
new pairing remains encrypted. Update/re-pair those phones with the encrypted
client before the grants expire. Cursor replay also requires the updated app.

Private operational evidence is retained at:

```text
~/.local/share/servant/backups/pre-supervisor-20261030T234755Z/
~/.local/share/servant/receipts/migration-20261030T234755Z.json
~/.local/share/servant/receipts/live-verification-2026-10-30T23-51-07-962Z.json
```
