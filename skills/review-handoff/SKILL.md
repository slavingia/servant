---
name: review-handoff
description: Hand work to human reviewers through Servant instead of a code host. Use when a feature, build or change is ready for someone's step (design, QA, content, sign-off), when asked to tell or ask a teammate, to keep a Servant release checklist up to date, or to act on what reviewers replied. Reviewers should never have to open a pull request to learn what is being asked of them.
---

# Hand work to reviewers through Servant

A Servant project has **releases**; each release has **items** (features); each item moves through the project's **stages**, and each stage has **reviewers** ([docs/projects.md](../../docs/projects.md)). When your work is ready for a person, tell that person in Servant, in plain words, with everything they need in the message. They should not have to check the code host, read a pull request, or ask what "ready" means.

## Set up (once per computer)

Link this computer to your Servant account as described in [docs/mcp.md](../../docs/mcp.md): `cd mcp && npm ci && node src/index.ts link "<workspace link>" "Ana's laptop"`, then approve it on your phone. Everything the tool posts shows as you, labelled **Posted by agent**, so readers can tell an agent wrote it. Do not remove or work around that label.

## Tool

`mcp/src/handoff.ts` wraps the API. Run it from the repository root:

```sh
H="node mcp/src/handoff.ts"
$H whoami                      # check who you post as
$H releases example-app        # stages, reviewers (with user ids), releases, items, cell statuses
$H convs                       # channels and DMs with ids
$H read <conversation> 20      # read before you post: do not repeat an ask or miss a reply
$H dm <user_id> [<user_id>…]   # one id = DM, several = group chat; prints the conversation id
$H post <conversation> "text" [thread_root_message_id] [--attach shot1.png shot2.png]
$H cell example-app "November 17" "Dark mode" Design doing "note"   # todo | doing | done | blocked
$H add-release example-app "December 1" 2026-12-01
$H add-item example-app "December 1" "Feature name"
$H ship example-app "November 17"   # only when every item is done and the owner said it shipped
$H ask-log <conversation> "<feature>" "<who>" "<where the work lives>"
$H replies                     # what people sent since each logged ask
$H replies --mark              # record them as seen, after you acted on them
```

The same calls exist as MCP tools (`send_message`, `open_dm`, `list_conversations`, `read_messages`) when the Servant MCP server is connected. Any other route is `call(account, method, path, body)` from `mcp/src/client.ts`.

## When to message

- Message a reviewer when there is something they can act on **now**: a build they can install, a link they can open, a picture they can look at. Not when a pull request opens, and not for progress.
- Do not message people about things only an engineer can act on (failing checks, merge conflicts). Fix those yourself.
- One ask per message. If the same person owes two things, send a numbered list of two.
- Read the conversation first. If the ask was already made, reply in that thread instead of asking again.
- Keep to working hours unless the owner says it is urgent.

Who gets asked when:

- **Design: as soon as there are pixels to critique.** Do not wait for an installable build. Send real captures of the real component, light and dark, each state, attached to the message. Never mock-ups or generated pictures of the interface.
- **Content: as soon as the wording exists.** Put every string in the message, in each language the product ships.
- **QA and accessibility: when there is a build to install**, with the build number and where to get it.

## Where to post

1. A channel for the feature, if one exists: post there when more than one person needs to see it, and name the person each ask is for.
2. Otherwise a **group chat** of exactly the people who have a step on this feature. Reuse the existing group for that feature; do not start a second one.
3. A **DM** for an ask that concerns one person only.
4. Never the general channel for review asks.

Who owns which stage comes from `releases <project>` (the `reviewers:` line). Read it fresh each time.

## What the message says

Write for someone who has not seen the code and will read it on a phone:

- First line: the feature and the release it is for.
- What you need from **them**, as steps they can follow, and what done looks like.
- How to get it: the build number and where to install it, or the pictures attached.
- What is known not to work yet, so they do not report it.
- By when, if there is a date.
- How to answer: "Reply here with what you find", and that you will tick their stage when they approve.

Leave out pull request numbers as the only reference, branch names, file paths, commit hashes, links they must open to understand the ask, internal hostnames, and any private or personal data. A link may be added "for reference", never as the instructions.

Example (content review):

> Dark mode, December 1 release. Ana, the wording is ready for your content step. Nothing to install.
> 1. The switch in Settings reads "Appearance", with the choices "Light", "Dark" and "Match my phone".
> 2. Under it: "Dark uses less light at night. It does not change what you can do."
> Tell me here what should change. If it all reads right, say so and I will mark Content done. Friday would be ideal.

## Feed replies back in

A reply is input to the work, not a notification to file away.

1. Right after every ask, run `ask-log` with the conversation, the feature, the person, and where the work lives (repository, branch, how to capture). At the start of any session that touches the feature, and whenever the owner asks what came back, run `replies`.
2. Turn each piece of feedback into a change, or a short reason it cannot be done. Make the change and capture new pictures.
3. Answer in the same thread: what changed, with the new capture attached, and what is left for them to confirm.
4. Update their stage cell: `blocked` with their note while a requested change is open, `done` (quoting them) once they approve. Never mark someone else's stage done without their words in the conversation.
5. Run `replies --mark`, then tell the owner what came back and what you changed.
6. A question only the owner can decide (scope, dates, policy, anything about security or private data): do not guess. Tell the reviewer the owner will answer, and pass it on.

To act on replies without being asked, schedule a job that runs `replies` and starts an agent with this skill only when it prints something. Keep that agent's limits tight: the feature's own branch, no merging, no new people, one reply per incoming message.

## Keep the release checklist true

- When you start a stage you own, set the cell to `doing`.
- A feature that moves to a later release: add it there and remove it from the old one, after the owner decides.
- `ship` only after the owner confirms the release went out.

## After posting

Tell the owner what you sent, to whom, and in which conversation, in one or two lines.

## Don'ts

- Don't post secrets, tokens, invite links, or screenshots with real people's information.
- Don't mention `@agent` unless you want Servant's own agent to act.
- Don't send the same ask to a DM and a channel.
- Don't message people outside the project's reviewers unless the owner asks.
