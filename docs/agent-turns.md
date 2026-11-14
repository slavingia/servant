# Agent replies and action controls

Private Agent chats now use the independent Mac worker already used by channels.
The phone submits a turn to SQLite and observes a persisted event journal. Locking
the phone, losing its network connection, or restarting the API process does not
close the worker's connection to Hermes. Accepted input, streamed text, completed
replies and their media remain available when the phone returns.

The app shows a working indicator until a reply finishes, then presents the text
and attachments together. Private reply events are buffered for display while
status and approval events remain live. Channel and thread drafts are checkpointed
for recovery without broadcasting each text update; pending history and previews
also hide draft content. Saved output from an interrupted turn is still available
after it ends and is marked incomplete.

## While the agent replies

**One calm line.** In the conversation, where the reply will be, a single line
says what the agent is doing: "Thinking", then a plain line for each step
("Reading a file", "Searching the web", "Running a command", "Writing"). A soft
light passes over the words to show it is alive; with Reduce Motion on, the words
stay still. For the first minute the line says nothing about time. After that it
adds how long it has been, short ("2 min"; screen readers hear "two minutes"). A bare "Thinking" that goes
on becomes "Thinking it through" and then "Still working on it"; a line that
names what the agent is doing is left as it is.

Tap the line for the steps so far, one plain line each. On the full agent a step
also shows what it worked on: the command, search, file or a short excerpt of its
reasoning, with secrets masked and anything long cut. On the restricted member
agent every tool is "Working on it" and nothing about what it ran is shown; tool
names and tool inputs do not leave the worker for those chats.

**When it finishes.** The reply appears whole under a short summary, "Worked for
12 sec" (spoken as "12 seconds"). The summary opens to the same steps. The turns list that every
device polls only counts a finished turn's steps; the steps themselves are
fetched when the summary is opened, and only by the person whose chat it is.

**Sending while it replies.** A message sent while the agent is replying joins
that reply. The worker hands the text to the agent, which reads it at its next
step, and the message takes its place in the conversation above the reply still
being written. Until the agent has it, the message reads "Adding this to the
current reply…". If the agent finishes before reading it, the message runs next
as its own turn, so nothing is lost.

A message waits instead, and is sent once the reply is done, when it cannot
join: it has files, the reply is stopping or has not started, or the agent cannot
take a message mid-task (a member's restricted agent, or a bridge that does not
report `servant_steer`). It reads "Sends after the current reply" and has a small
close to take it back. The running turn says which applies (`canSteer`), so the
app knows before it sends.

**Queueing on purpose.** To send something after the current reply rather than
into it, touch and hold Send (the phone gives a short tap, and "Hold to queue" sits beside the
button while a reply is running) or type `/queue` and the message. Up to five
messages can wait in one chat.

**Stop.** While the agent can be stopped and nothing is typed, the Send button is
Stop. `/stop` does the same. There is no separate Stop or Steer button in the
conversation.

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

A turn carries `activity` (the latest line) and `steps` while it runs, `canSteer`
(a message sent now can join it; true only once the worker has asked its agent),
`startedAt`, and after it ends `finishedAt`, `stepCount` and the `messageId` of
the reply it wrote. `GET /v1/chats/:id/turns/:turnId` returns one turn with its
steps, to the chat's author only.

Controls are `POST .../turns/:turnId/stop`, `POST .../turns/:turnId/steer` and
`POST .../turns/:turnId/approval` with `{approvalId, choice: "once" | "deny"}`.
Steer folds a waiting text message into the running reply. It answers 403 for a
chat on the member agent and 409 when there is nothing to join: `steer_files`
(the message has files), `steer_unsupported` (this reply cannot take one),
`nothing_to_steer` (the reply already ended) or `steer_unavailable` (the message
is no longer waiting). In each case the message keeps its place and runs next.
All endpoints use the existing authenticated encrypted transport.

`server/agent-turns.test.mjs` verifies atomic deduplication, uncertain-start
recovery, concurrent chats, approval IDs, queued cancellation, steering and
idempotent media delivery. `server/private-turns-integration.test.mjs` runs the real
encrypted API and independent worker against a deterministic bridge, kills and
restarts the API/worker, verifies saved history, exercises transient outages,
and checks ownership, approval, real Stop delivery, and a message sent mid-reply
both joining the reply and waiting its turn. Existing media, shutdown,
state and deployment tests cover the retained behavior. The Python bridge suite
executes its media/history/policy/approval contract against supported Hermes
versions without model credentials.
