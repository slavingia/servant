# Approved Answers

Approved Answers resolve stable, repeated workspace questions without starting an
upstream agent turn. They are governed content, not cached model output: an owner
publishes each answer with sources and review dates, and the server either finds
one exact, current match or follows the existing live-agent path unchanged.

## Version 1 behavior

Version 1 is intentionally narrow. It is suitable for workspace-wide onboarding,
navigation, policy, and stable “how do I?” guidance that is safe for every
authenticated member with normal agent access.

Eligible messaging requests are a person's first human turn in their personal
agent direct message and top-level messages that begin with a supported agent
mention in channels or group direct messages. Requests with attachments,
multiple lines, thread context, forwarded or action-specific content,
private/project context, ambiguity, or no exact match continue to the live
agent. A person can always force that path with:

```text
ask live: <their question>       (personal agent direct message)
@s ask live: <their question>    (channel or group direct message)
```

On a hit, the server posts an ordinary agent Markdown message in the same
conversation. It includes the answer, linked sources, approval and review
metadata, and the live-agent bypass. No upstream agent session or token-usage
row is created for the hit.

Private chats in the app’s **Agent** tab use a separate durable turn journal and
streaming lifecycle. Approved Answer interception for that surface is explicitly
deferred until it can preserve the complete replay, SSE, media, cancellation,
and usage contract. Version 1 does not shortcut Agent-tab private chats.

## Exact matching and freshness

Matching is deterministic and local. The server:

1. normalizes Unicode with NFKC;
2. trims and collapses whitespace;
3. lowercases the request;
4. removes one leading `@s`, `@agent`, or `@servant` handle; and
5. removes at most one final `?` or `.`.

The result must equal one canonical question or alias. There is no substring,
fuzzy, stemming, embedding, semantic, or model-based routing. Normalized aliases
must be unique across the manifest. Empty, ambiguous, malformed, or unsupported
input fails closed to the existing agent behavior.

An entry is eligible only when all of these are true:

- `status` is `published`;
- `approvedAt` is not in the future;
- the current time is before `reviewBy`; and
- the current time is before `expiresAt`, when present.

A missing or malformed manifest behaves like an empty library. An expired or
review-due answer is never served from an earlier cache.

## Manifest

The active manifest is `${SERVANT_DATA_DIR}/approved-answers.json`. The data
directory and file are kept private (`0700` and `0600`), and publishing validates
the complete candidate before replacing the active file atomically.

```json
{
  "version": 1,
  "answers": [
    {
      "id": "show-me-around",
      "question": "How do I get started?",
      "aliases": [
        "Show me around",
        "Where should I begin?"
      ],
      "answer": "Start with **Home**, then choose Agent, Designs, or Research.",
      "status": "published",
      "sources": [
        {
          "title": "Servant onboarding guide",
          "url": "https://docs.example.gov/servant/onboarding",
          "date": "2026-11-01"
        }
      ],
      "approvedBy": "Workspace owner",
      "approvedAt": "2026-11-01T12:00:00.000Z",
      "reviewBy": "2027-02-01T12:00:00.000Z",
      "expiresAt": "2027-05-01T12:00:00.000Z",
      "version": 1
    }
  ]
}
```

`id` is a stable lowercase identifier. `question` is the canonical display
question. Every entry needs at least one distinct alias and one HTTPS source.
`answer` is plain Markdown. `approvedBy`, `approvedAt`, and `reviewBy` are
required; `expiresAt` is optional. A `version` is required before an entry can
be published or retired, and owners must increment or replace it whenever the
answer content or sources change. Supported statuses are `draft`, `published`,
and `retired`, but only fresh `published` entries can match. The rendered answer,
sources, and governance details together must fit in one 8,000-character message.

## Owner CLI

Author the candidate outside the active data directory, then use the local
server CLI. These commands never create a remotely writable authoring endpoint.

```bash
SERVANT_DATA_DIR=/path/to/servant-data \
  node server/server.mjs faq validate /path/to/candidate.json

SERVANT_DATA_DIR=/path/to/servant-data \
  node server/server.mjs faq publish /path/to/candidate.json

SERVANT_DATA_DIR=/path/to/servant-data \
  node server/server.mjs faq status
```

- `validate` checks the schema, normalized duplicates, sources, and dates without
  changing the active manifest.
- `publish` repeats validation and atomically installs the complete candidate.
- `status` reports whether the active file is valid; counts total, published,
  and currently fresh entries; and shows Approved Answer hits by answer and
  version.

Retire or replace an answer by publishing a complete new manifest. Do not edit
the live file in place during a request.

## Analytics and privacy

Successful hits are recorded in `faq_events` inside `messages.db` using the
trigger and reply sequence IDs, answer ID and version, surface, and timestamp.
The table stores no raw question or answer text. Unmatched questions are not
collected by this feature, and answers are never derived automatically from
private conversations or prior model output.

Report hits and hit rate directly. A hit bypasses the live-agent path, but it is
not necessarily an upstream call avoided (for example, the upstream may be
unconfigured). Any token-savings figure must be labeled as an estimate based on
historical live-turn averages for otherwise eligible traffic. Do not insert
synthetic zero-token events into `token_usage` or the leaderboard.

## Compatibility and safety

Approved Answers add no message type, pairing change, or client-only renderer.
The reply is an ordinary message with plain Markdown, so original Servant clients
can display, search, receive, and thread it normally. Existing conversation
membership and search visibility remain authoritative.

The manifest is server-local and version 1 content must be workspace-wide. It
must not interpolate user, project, channel, or private-message data; perform
actions; make time-sensitive factual claims without an appropriate review date;
or stand in for research, legal, medical, financial, or other individualized
judgment. A miss, bypass, stale entry, access failure, or configuration error
always returns to the existing live-agent flow.
