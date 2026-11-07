# Research Hub connector

Servant's Research Studio can use approved Research Hub evidence without giving
the Researcher agent GitHub, shell, or local-file access. The connector is a
server-owned, read-only snapshot. It never performs a runtime GitHub request and
never accepts a repository URL, path, SQL statement, or workflow name from a
client.

## What is included

The first connector release exports only publish-eligible, unsuppressed
`repository_aggregate` rows from these governed catalog layers:

- theme-period aggregates;
- feature-request aggregates;
- technical-bug aggregates; and
- rating-period aggregates.

Each picker result preserves the product, exact stored period bounds and grain,
metric and sample size, release and disclosure status, catalog reference, a
tracked release `catalog_manifest.json` path, source commit, snapshot revision,
and review date. The snapshot points to the tracked canonical source-set file;
the generated SQLite database is never presented as a commit-addressable
source. Missing evidence remains missing; the exporter does not turn it into
zero or infer suppressed values.

Raw exports, respondent identifiers, row-level records, comment text, held or
quarantined data, report binaries, and unapproved study summaries are excluded.
Study summaries can be added later through an upstream curated manifest with an
explicit Servant audience approval.

## Publish an approved snapshot

Publishing is an owner/CI operation, separate from the running server. Start
from the exact fetched `origin/main` commit in a clean Research Hub checkout.
The same commit must contain a reviewed approval at
`approvals/servant/APPROVAL-ID.json`; a command-line string alone is not an
approval. The record is bound to the Git tree for `survey-research-catalog`,
must cover all four exported layers and the exact private Servant/Researcher
model audience, and must not be expired. Its schema is:

```json
{
  "schemaVersion": 1,
  "approvalId": "APPROVAL-ID",
  "status": "APPROVED",
  "audience": "servant-private-workspace-and-configured-researcher-model",
  "catalogTree": "the Git tree ID for survey-research-catalog",
  "layers": ["theme", "feature", "bug", "rating"],
  "approvedAt": "2026-11-06T20:00:00.000Z",
  "expiresAt": "2027-02-04T20:00:00.000Z"
}
```

After that approval is reviewed and merged, run:

```sh
SERVANT_DATA_DIR=/private/servant-data node server/research-hub-export.mjs \
  --checkout /path/to/research-hub \
  --approval APPROVAL-ID
```

The exporter:

1. fetches the authoritative private Research Hub `origin/main`, then verifies
   that exact commit, a clean worktree with no tracked symlinks, and the
   committed approval contract;
2. checks out that commit into an isolated immutable worktree, rebuilds the
   canonical catalog into a new temporary database, then runs the Hub's
   value-free catalog validator;
3. reads only four static aggregate queries from that fresh database in
   read-only/query-only mode, then removes it;
4. validates every field, record ID, source path, status, and audience;
5. content-addresses the manifest with a SHA-256 integrity revision; and
6. atomically publishes `research-hub.json` with mode `0600` inside a mode
   `0700` Servant data directory.

Snapshots require refresh by their `reviewBy` date (30 days by default; use
`--review-days` with a value from 1 to 90). A missing, stale, corrupt,
world-readable, symlinked, or modified snapshot fails closed.

## Client and API behavior

All routes use the existing encrypted Servant transport and device bearer
authentication. The server checks Researcher tier 4 on every request:

- `GET /v1/research-hub/status`
- `GET /v1/research-hub/evidence?q=...&limit=20`
- `POST /v1/research-hub/evidence/resolve` with the picker snapshot revision and
  up to eight record IDs
- `POST /v1/research-hub/design-guidance` with the same record IDs and revision
  plus bounded study context

Search is deterministic and local; it makes no model call and therefore spends
no agent tokens. The final resolve repeats authorization after the body arrives
and resolves IDs against the current snapshot, so removed or changed evidence
cannot silently enter a brief.

Design guidance is the only supported bridge from governed Hub evidence to a
prototype build. After reading the request body, the server reauthenticates the
device, confirms Researcher tier 4 and the person's token allowance, and
re-resolves the selected IDs against the requested snapshot revision. It sends
those current records only to the attested restricted Researcher Agent, never
to the Prototype Agent. The Researcher Agent must return strict structured JSON
containing one to five generalized user needs, pain points, design
opportunities, and unknowns. The server rejects malformed or extra fields and
rejects guidance containing source details such as record or product names,
record IDs, catalog references, paths, links, dates, counts, percentages,
sample sizes, or source-specific metrics. It fails closed rather than falling
back to the original records. The response contains the current Hub metadata
and a formatted, generalized guidance draft; this model call counts toward
the person's normal token allowance. Guidance completions are serialized per
person and output-bounded, so simultaneous devices cannot spend the same
remaining daily allowance. Access and the exact snapshot are checked again
after the model responds before any derivative is returned.

The UX client inserts resolved records only into the existing unsent plain-text
draft for the restricted Researcher Agent. When a study needs a new prototype,
the person may ask that Researcher Agent to prepare design guidance from the
selected evidence, then review and edit the generalized draft before choosing
to include it. Changing the selected evidence or the study context invalidates
the earlier guidance and requires a fresh review. Immediately before creating a
prototype that includes approved guidance, the client re-resolves the selected
records and snapshot revision again. Changed, expired, unavailable, or revoked
Hub access blocks the handoff before a Prototype Agent chat is created. The
client sends the reviewed guidance and exact generated first prompt as a
`researchHandoff` on that explicit prototype-chat request. The server validates
the edited four-section guidance against the current records, validates the
prompt boundary, and rechecks both authorization and the snapshot after the
upstream chat session is opened. The chat response must confirm a pending
handoff; an updated client deletes the workspace if an older server silently
ignores that field.

Only that explicitly reviewed guidance may enter the unsent Prototype Agent
build prompt, inside a boundary that labels it as context data rather than
instructions. Raw Hub records, summaries, citations, catalog metadata, source
details, metrics, and snapshot identifiers never enter the prototype/full-agent
prompt through this supported flow. The exact first prompt is hash-bound to the
server-issued handoff. It is checked again when queued and immediately before
the worker contacts the Prototype Agent; tier changes, snapshot withdrawal,
attachments, forwarding, or prompt edits fail closed. After that bound first
prompt is accepted, the workspace behaves like an ordinary prototype chat.
The persisted chat scope and its first queued turn use versioned internal states
that older API and worker releases do not process, so API-first rolling deploys
and rollback fail closed instead of bypassing the handoff checks.
The Prototype Agent uses the guidance to suggest distinct design
directions tied to numbered needs or pain points, while labeling tradeoffs,
assumptions, accessibility considerations, and evidence limits. It asks the
researcher to choose or revise a direction before building it, and it must not
claim that the Hub validates, approves, or proves a direction. The final
Researcher chat still receives freshly re-resolved evidence with citations.
Original Servant clients continue to see ordinary private chats and ordinary
messages; there is no new message type and ordinary Researcher chats retain
their restricted capability.
