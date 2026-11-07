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

Search is deterministic and local; it makes no model call and therefore spends
no agent tokens. The final resolve repeats authorization after the body arrives
and resolves IDs against the current snapshot, so removed or changed evidence
cannot silently enter a brief.

The UX client inserts the resolved records only into the existing unsent
plain-text draft for the restricted Researcher agent. Even when a Researcher
chooses **Create a new prototype**, governed Hub records do not enter that
prototype/full-agent prompt; the prototype uses only the person's separately
written public-or-made-up context. The evidence block is labeled as quoted data,
not instructions, and the client resolves selected record IDs again immediately
before the final Researcher chat is created. Original Servant clients still see
ordinary private chats and ordinary messages; there is no new message type and
ordinary Researcher chats retain their restricted capability.
