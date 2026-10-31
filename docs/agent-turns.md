# Agent replies and action controls

Private Agent chats now use the independent Mac worker already used by channels.
The phone submits a turn to SQLite and observes a persisted event journal. Locking
the phone, losing its network connection, or restarting the API process does not
close the worker's connection to Hermes. Accepted input, streamed text, completed
replies and their media remain available when the phone returns.

## Running it

Production must run `server/worker.mjs` alongside the API with
`SERVANT_WORKER_MODE=external`. The existing supervisor/deployment setup uses this
mode. Keep the worker running when replacing only the API. Development mode can
run private turns inside the API for convenience; that mode does not survive an
abrupt API process death. A graceful shutdown waits for active work.

Run the repository-owned Hermes bridge for true Stop and action approvals; see
[supported Hermes versions](supported-hermes-versions.md) and the launcher
`scripts/run-hermes-servant.py`. Stock compatible session-stream APIs retain
worker-owned replies and media, but cannot advertise working Stop or approval
controls. The app only offers Stop while a turn is queued or its upstream run can
be stopped. A queued Stop prevents the request reaching Hermes.

Member upstreams must attest the repository's restrictive policy before Servant
creates a session, reads upstream history or submits a private/channel turn.
Unverified member upstreams fail closed. An authenticated member can still read
their already-cached messages while that upstream is unavailable.

## Reliability boundaries

- `agent-turns.db` contains queued requests, a persisted event journal, control
  requests, run IDs and a notification outbox. It is local plaintext protected by
  Mac filesystem permissions, like the existing message databases; transport
  encryption does not make the Mac's database encrypted at rest.
- Four private turns can run concurrently, with one active turn per chat. An
  approval waiting in one chat does not block the other available slots.
- An optional client `requestId` deduplicates the same request in the same chat.
  Reusing the ID with different text or media returns a conflict. Attachment
  delivery keys also deduplicate cache writes across worker recovery.
- After a worker restart, a turn with a saved Hermes run ID reconnects or polls
  that existing run. It never resubmits the prompt. Hermes event subscriptions
  are consumptive; persisted partial text is retained, and polling recovers the
  authoritative final reply and pending approval if event streaming is gone.
- A crash after starting a turn but before saving its run ID is ambiguous.
  Servant marks it interrupted and preserves any partial text. It does not replay
  an action whose side effects are unknown. Review before submitting a new turn.
- If Hermes itself restarts and forgets a run, that turn becomes interrupted.
  There is no promise of surviving a Hermes or Mac crash mid-tool execution.
- Transient status/Stop/approval transport errors keep the existing run active
  and retry reads or ID-bound controls. They do not release its chat slot and
  silently start another run.
- Message/history reads fall back to authenticated local cache for upstream
  transport and server failures, with `upstreamUnavailable: true`. An upstream
  missing-session response or malformed history is not treated as a valid empty
  history and cannot purge media by accident.

## Approvals and Stop

Approvals expose the dangerous-action requests Hermes actually generates. They
are not a universal review gate for every tool, message, API request or write.
Hermes decides which actions require approval according to its configured
policy. Servant presents the redacted command and reason supplied by Hermes.

Only the owner, in their own owner-agent chat, can choose **Allow once** or
**Deny**. Servant never exposes session-wide or permanent permission. Every card
has a stable approval ID; the UI, journal and bridge bind the response to that
exact request. Duplicate/stale responses cannot approve a later action. Pending
cards survive phone/API disconnection and are available from run status after a
worker event-stream failure. General agent questions are ordinary messages;
there is no invented question/answer API.

Stop is bound to the authenticated user's own chat and persisted run. It asks
Hermes to interrupt that run, and the turn remains stopping until Hermes reports
a terminal state. An already-finished external effect cannot be undone. The
partial reply remains visible and is marked incomplete.

## API and verification

`POST /v1/chats/:id/messages` retains its existing SSE events and additionally
emits `turn`, `approval` and `approval_resolved`. `sent` is emitted only after
Hermes accepts input and the local message is durable. Every event has a cursor.
`GET /v1/chats/:id/turns/:turnId/events?after=N` catches up from that cursor.
`GET /v1/chats/:id/turns` lists recent state; chat lists and message reads include
`latestTurn`. Partial messages have `pending`/`interrupted` and `turnId` fields.

Controls are `POST .../turns/:turnId/stop` and
`POST .../turns/:turnId/approval` with `{approvalId, choice: "once" | "deny"}`.
All endpoints use the existing authenticated encrypted transport.

`server/agent-turns.test.mjs` verifies atomic deduplication, uncertain-start
recovery, concurrent chats, approval IDs, queued cancellation and idempotent
media delivery. `server/private-turns-integration.test.mjs` runs the real
encrypted API and independent worker against a deterministic bridge, kills and
restarts the API/worker, verifies saved history, exercises transient outages,
and checks ownership, approval and real Stop delivery. Existing media, shutdown,
state and deployment tests cover the retained behavior. The Python bridge suite
executes its media/history/policy/approval contract against supported Hermes
versions without model credentials.
