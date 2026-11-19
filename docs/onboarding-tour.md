# The onboarding tour

Six short pages a person sees once, right after they join, and again any time from **You → Take the tour**. Every page has **Skip**.

1. **What's your role?** They choose one: Designer, Researcher, Engineer, Content, Product, Manager or Other.
2. **You stay in charge.** Stop, and whether anything asks before the agent acts for them.
3. **Your access level.** The level an owner gave them and what it allows on this server.
4. **Your daily limit.** Their own limit, about what it costs, and today so far.
5. **Where your data goes.** The server, the encryption between the app and it, the agent behind it, and connections.
6. **Try asking @agent.** First asks for their role. One press opens a new agent chat with the words in the message box; nothing is sent until they press Send.

The design comes from [issue #41](https://github.com/slavingia/servant/issues/41) and its prototype. Captures are in [captures/onboarding-tour](captures/onboarding-tour/README.md).

## The role only describes

A role is a word a person chooses for themselves. It does two things: it tailors the tour's example and first asks, and it shows beside their name (on You, and in People as "Role: Designer"). "Other" is not shown.

It never changes what an agent may do. Nothing that decides access reads it: not the access level (`agentTier`), the daily limit, entitlements, approvals or the network gate. If it did, people would be giving themselves access, which the privacy invariants in [AGENTS.md](../AGENTS.md) rule out. The tour says so on the page: "Your role tailors tips. Your owner sets what the agent can do."

- The list is one file, [`server/job-roles.mjs`](../server/job-roles.mjs): an id, a label, an example and the asks. The server sends it to the app, so editing that file changes the tour, with no copy to keep in step.
- A person sets their own with `PATCH /v1/people/me` and `{ "jobRole": "designer" }` (`null` clears it). Anything not on the list is refused (`400 bad_role`). There is no route that sets someone else's; an owner's `PATCH /v1/people/<id>` does not take it.
- It is stored as `jobRole` on the person and sent as `{ id, label }` in `GET /v1/me` and `GET /v1/people`.

## Every page is true to this server

`GET /v1/tour` ([`server/tour.mjs`](../server/tour.mjs)) answers for the person asking, read-only, and the app turns the facts into sentences ([`app/src/lib/tour.ts`](../app/src/lib/tour.ts)). A fact that is not known is left out, and so is its line.

| Page | What it reads | What it says |
| --- | --- | --- |
| In charge | `agentCapabilities.mode`, the agent the person's chats run on, who their manager is, `agentEgress.mode` | With the check on and a full agent: "it stops and Ana Ruiz decides: allow once, allow always or decline". With it off (the default): "No approval step on this server", and what the agent can then do. An owner: "Your agent acts without asking". A researcher or a restricted member: "Nothing to approve". |
| Access level | The person's level, and `agentAccess` | The level's name and what it allows. On a server with `"agentAccess": "limited"`, a member is told their agent works with text and images only, whatever the level is called. |
| Daily limit | The usage store's `limitFor`, today's tokens, and the agent's price ([`server/usage-cost.mjs`](../server/usage-cost.mjs)) | "About $56 a day at most", "Today: about $0.80 of about $56". No limit says so. An owner: "No limit; you pay for what the team uses", with the team's total today. No agent says so and how to ask. Without a price the page speaks in tokens. |
| Data | The server's name and whether the person has an agent | What [member-security.md](member-security.md), [encryption.md](encryption.md) and [connections.md](connections.md) say, including what is not hidden: the owner can read what is on the server, and what a person asks the agent goes to the model the owner set up. It makes no compliance claim. |

A member is sent their own limit and one number for price (dollars per million tokens at this server's mix, for each level). The model's name and its separate prices stay with owners, as before.

## When it shows

Joining marks the person (`tourDue`), and `POST /v1/pair` and `GET /v1/me` say `"tour": { "due": true }` until they finish or skip (`POST /v1/tour/seen`). "Seen" is kept on the server, with the person, for three reasons:

- it is once for the person, not once for each phone and computer they sign in on;
- people who were here before the tour are never interrupted by it, because only someone who joins from now on is marked;
- an app talking to a server from before the tour is told nothing, so nothing opens.

If the app closes the tour while the server can't be reached, it stays closed on that device and the server is told the next time the app runs.

## Check it

`node --test server/tour.test.mjs server/tour-http.test.mjs` and `app/src/lib/tour.test.ts` cover the role list, each person's facts, the refusals and the rule that a role changes nothing about access. `node scripts/onboarding-tour-e2e.mjs` walks the tour in a browser against a temporary server as an owner, a full member, a researcher, a member with a 5M limit and someone with no agent, and saves the captures.

## Not here yet

A tour for each role, and Design Studio, are separate follow-ups to issue #41.
