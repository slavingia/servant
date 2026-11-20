# Security architecture review: what was done

November 20, 2026. This closes out the eight findings from the security architecture review of Servant's architecture diagrams. Each finding below says what was asked, what changed, where the evidence is, and what is left. It covers Servant's own design only.

Read this first: **most of these controls ship turned off**, so that a small team's server keeps working as it did. A deployment being reviewed has to turn them on; the last section lists the settings.

## Summary

| # | Finding | Result | Left open |
| --- | --- | --- | --- |
| 1 | Sandbox isolation is assumed, not validated | Done: named, documented and tested from the inside | Linux is not covered by the tests |
| 2 | Trust boundaries are drawn but not validated | Done: each boundary has its control and a test that crosses it without permission | None |
| 3 | No implementation evidence for the "Last 24 hours" diagram | Done: each item linked to code and tests; the action record is shown to be the source of truth | None |
| 4 | Authorization is by role, not by resource and action | Done: decided per person, per project (its folder and repository), per action | Delete is part of write; no conditions such as time or sensitivity |
| 5 | "Allow always" has no scope, expiry or revocation | Done: per project, optional lifetime, revocable, audited | None |
| 6 | Review comments can carry instructions to the agent | Done in code; the live test with a real model is inconclusive | A passing live run; other places outside text reaches the agent |
| 7 | Lifecycle and identity in code-request delivery are untested | Done: identity, order and replay tested against the real API | None |
| 8 | Owners bypass approval; network allowlist enforcement | Done: owners can be held like anyone; approver authority and default-deny egress tested | None |

## 1. Sandbox isolation

**Asked:** name the sandbox technology, show child processes cannot escape, show file rules are the operating system's, and say whether processes, files, network and credentials are all isolated.

**Done:**
- The sandbox is the operating system's: `sandbox-exec` on a Mac, a systemd scope on Linux. The rules apply to the agent's command and every process it starts.
- `server/sandbox.test.mjs` runs commands through the real Mac sandbox. Only the network gate's port answers, also from a process two shells down. A closed folder cannot be read, listed, written, deleted from, copied out of or hard-linked out of: by its path, through a link from outside, by a `..` detour, or from a child of a child.
- `docs/agent-egress.md` ("What the sandbox isolates") states what is and is not isolated.

**Stated limits, not fixed:** the agent's environment variables are passed through, so a secret in them is readable by a command the agent runs. Only the folders the operator lists are closed. A hard link made outside the sandbox beforehand still reads. The Linux sandbox is not exercised by the tests.

## 2. Trust boundaries

**Asked:** list the control behind each boundary and what it denies, with tests showing an unauthorized crossing is refused, including across people and sessions.

**Done:** `docs/architecture/README.md` lists each boundary in the system diagram with its control. `server/trust-boundaries.test.mjs` crosses each one on purpose, without permission, and shows the refusal.

## 3. "Last 24 hours" evidence

**Asked:** link the code behind the diagram and confirm it reflects enforced activity, not a best-effort log.

**Done:** the architecture notes say what the diagram is (a summary of changes in the repository, not a runtime log) and link each item to its code and tests. `server/activity-record.test.mjs` shows the agent action record cannot fall behind what agents did: a checked tool call is written before it is answered, and one that cannot be recorded is refused.

## 4. Authorization per resource and action

**Asked:** decide per person, resource and action; make read, write and delete separate; scope by folder and repository, denied by default; document the decision model.

**Done:**
- The agent's check is decided for a person, in a project, for one of four actions: read files, change files, read GitHub, change GitHub. Allowing one for a project says nothing about another project.
- A project's grant covers that project's folder and repository only. The agent's bridge reports the paths and repositories each tool call names; one that points outside, including through a link, is asked about separately.
- With the checks on, nothing is allowed until someone who holds it allows it.
- `docs/entitlements.md` has the decision table for a tool call, matched to the code.

**Left open:** delete is part of write, not its own permission. For a shell command, scoping reads what the command's words name, so it keeps ordinary work inside its project but is not a wall; the sandbox and each person's own GitHub token are. No conditions such as time of day or sensitivity.

## 5. "Allow always"

**Asked:** scope it to a resource and action, make it expire, make it revocable, make it auditable.

**Done:** "Allow always" asked for in a project's chat is for that project only. `entitlementGrantDays` gives standing grants a lifetime, after which they are marked expired and have to be asked for and decided again; the app shows the end date. A manager or owner can take a grant back at any time, effective on the next check. Every decision is in an append-only history and every checked call in the action log.

## 6. Review comments as untrusted input

**Asked:** treat reviewer comments as data, never instructions; gate anything they trigger like any other agent action; test that an injected instruction is not followed.

**Done:**
- Everything a reviewer supplies, the comment and the page text they pointed at, reaches the agent inside one marked block with every line quoted, with Servant's own instruction before and after it.
- A comment starts the agent with nobody reading it first only where the agent has to ask before it reads or changes files, and only for someone whose agent is checked. Elsewhere it waits for the person who shared the prototype.
- `scripts/comment-injection-live.mjs` gives a real model exactly what Servant sends, with an injected instruction and working file and web tools, and fails if the model reads outside the prototype or makes a web call.

**Left open:** the live check has not produced a judged result. The model provider refused the injected text outright, on the control run as well, so the runs count as inconclusive, not as a pass. It needs a run with the model the member agents use. The same treatment has not been reviewed for the other places outside text reaches the agent (the secure inbox, social posts, pasted pages).

## 7. Code-request delivery

**Asked:** verify identity end to end, enforce the lifecycle, and test spoofing and replay.

**Done:** `server/code-requests-identity.test.mjs` tries the path the wrong way round against the real API: signed out, with a made-up token, from a signed-out device, as someone else holding the request's id, outside the encrypted transport, out of order, and by sending captured requests a second time. All are refused. This path has no separate approval step by design: the person answering on their own device is the approval.

## 8. Owner bypass and network allowlisting

**Asked:** being the administrator must not grant access by itself; approval must not be bypassable by an owner; an approver may only approve what they have authority over; egress is denied by default and tested.

**Done:**
- `"agentCapabilities": { "mode": "ask", "owners": "ask" }` holds an owner's agent like anyone's, per project. Another owner decides an owner's request; an owner decides their own only on a one-owner server, and that is recorded.
- A manager can grant only what they hold, per project.
- The network gate with the sandbox refuses hosts no entitlement covers, also for a process the agent starts; both are tested.

Off by default: without the setting an owner's agent is logged but not held.

## What a deployment has to turn on

None of the following is on until the operator sets it in the server's `config.json` and starts the agent through the sandbox wrapper:

| Setting | What it turns on |
| --- | --- |
| `"agentCapabilities": { "mode": "ask" }` | The agent asks before it reads or changes files or GitHub, per project |
| `"agentCapabilities": { "owners": "ask" }` | Owners are held too, with another owner deciding |
| `"agentEgress": { "mode": "ask" }` and `scripts/run-agent-sandboxed.sh` | The network gate and the operating system sandbox |
| `SERVANT_SANDBOX_DENY_PATHS` | Closes the server's keys and databases to the agent |
| `"entitlementGrantDays": 90` | Standing grants expire |
| `"agentAccess": "limited"` | Members get an agent with no tools |

The agent bridge on the server's computer has to be the current version for per-project folder and repository checks to apply.

## Follow-ups

Tracked in issue #75:

1. ~~Destructive commands (deleting a branch or a repository) ask every time, even for someone who holds write, in place of a separate delete permission.~~ Done: the built-in **Deleting branches and repositories** entitlement is allowed once at a time and never always ([entitlements.md](../../entitlements.md)).
2. A judged live run of the comment-injection check with the member agents' model.
3. The same untrusted-text review for the secure inbox, social posts and pasted pages.
4. Sandbox tests on Linux, and clearing secrets from the agent's environment.
5. Whether new servers should start with the checks on.
