# Entitlements

An entitlement is a named piece of access a person can hold: "GitHub", "Tax data API", "Jira". It is how a server says who may have the agent work with what.

Each entitlement has:

- a **name** and a line of **description**;
- the **hosts** it opens for a person's agent (`api.example.gov`, or `*.example.gov` for every name under it);
- the **confirmation** a person agrees to when they ask. The default is: "I already have this access myself, under my own name, and I will only ask the agent to do what I am allowed to do."

Two rules sit behind it.

**The agent never gets someone further than their own access goes.** The agent works with the server's credentials, which usually reach more than any one person's do. So before the agent reaches a system for someone, that person says they hold that access themselves, and their manager agrees. It is the same step a new teammate takes to get into a repository, done once per entitlement when they join.

**Access is handed down, never made up.** A manager can only grant an entitlement they hold themselves. Owners can grant anything. So every grant traces back, person by person, to an owner.

## Managers

Everyone except an owner has a manager: the person who decides their entitlement requests.

- It starts as **whoever invited them** (the owner who made the team link they joined with), and otherwise the server's first owner.
- **An owner, or the person's current manager, can change it** (`PUT /v1/people/<id>/manager`). The new manager is told. Nobody picks their own manager this way, and a change that would make someone their own manager, even several steps up, is refused.
- **Invite your manager.** Anyone can send a one-use invite to their manager when that person isn't on the server yet (`POST /v1/people/me/manager-invite` with their name). When they join, they become the sender's manager. The new manager reports to an owner until someone says otherwise, so the chart fills in from the bottom up without anyone drawing it. Because a manager can only grant what they hold, inviting someone as your manager does not open anything by itself: they have to be granted the entitlement by their own manager first.
- When a manager leaves the server, the people they managed go back to whoever invited them, or an owner.

In the app, **People** has an **Org chart** view beside Name and Last seen: each manager followed by the people who report to them, stepped in a level at a time, with "Reports to Ana Ruiz · 2 reports" under each name. Everyone sees the chart. Someone who isn't an owner also sees who they report to and **Invite your manager**. An owner's ••• sheet for a person has a **Manager** section to choose from everyone who isn't under that person; a manager gets the same sheet for their own reports, with only that section.

`GET /v1/people` carries each person's `managerId`; `GET /v1/entitlements` gives your own `manager` and `reports`, and `org` for owners. `node scripts/org-chart-e2e.mjs` drives all of this in a browser against a temporary server and saves the captures in `docs/shots/org-chart`.

## How it goes

1. **An owner makes the entitlement.**
2. **A person asks for it.** They must tick the confirmation; a request without it is refused (`confirmation_required`). They can add a note ("I'm on the example-app team"). The exact words they agreed to are kept with the request.
3. **Their manager is told** with a push alert: "Pat Tester asked for Tax data API".
4. **Their manager, or an owner, grants or declines.** The person is told either way. A manager who does not hold the entitlement can decline but not grant (`not_held`). Nobody but an owner decides their own request; an owner can, because an owner is where trust on the server starts (it is still recorded).
5. **Their manager or an owner can take it back** at any time. The hosts close at once.

Nobody can be given an entitlement they did not ask for: the confirmation is the person's own, so it cannot be made for them.

When a person is removed from the server, everything they held or were waiting on is revoked. Changing an entitlement's hosts applies at once to everyone who holds it. Retiring an entitlement closes it for everyone.

## In the app

**Entitlements** is on You (and in search), and People's Org chart view links to it.

- Everyone sees the list: each entitlement's name, description, the hosts it opens, and where they stand ("Waiting for Jo Park", "You have this", "Declined", "Taken back").
- **Ask for this** opens the confirmation as a checkbox that has to be ticked, and an optional note. After a refusal or a revocation the button reads **Ask again**.
- **Waiting on you** lists the requests that are yours to decide, oldest first, with the note and the words the person confirmed, and **Grant** and **Decline**. A manager who doesn't hold the entitlement is told why they can't grant it.
- Under each entitlement, the people you decide for who hold it, each with **Take back** (confirmed first).
- Owners get **New entitlement**, **Edit** and **Retire**, a line saying whether the network gate is on, and the hosts agents were recently refused. Hosts can be pasted as addresses; only the host name is kept.

`node scripts/entitlements-e2e.mjs` drives the whole exchange in a browser against a temporary server and saves the captures in `docs/shots/entitlements`.

## What it controls

With the agent's network gate on ([agent-egress.md](agent-egress.md)), a person's agent can reach a host only when that person holds an entitlement that covers it. Without the gate, entitlements are a record of who asked for and was given what, and open nothing by themselves.

When the agent is refused a host:

- if an entitlement covers that host, the **person** is told which one to ask for;
- if none does, the **owners** are told that someone's agent tried a host nothing covers, so they can decide whether an entitlement should.

The same refusal is told at most once a day per person and host.

## What is kept

`entitlements.db` in the data directory holds the entitlements, each person's standing (`requested`, `granted`, `denied`, `revoked`), and a history of every step: made, changed, asked (with the note and the confirmation), granted, declined, taken back, retired. Nothing in it is deleted, and the history refuses updates and deletes. Owners can read an entitlement's history. Who manages whom is kept with the people in the server's state.

## Who sees what

- Everyone signed in sees the list of entitlements, their hosts and confirmation wording, their own standing, their manager and their reports.
- A manager also sees what their reports hold or asked for, with notes and decisions. Owners see everyone's.
- Owners see the hosts agents were recently refused.

## API

All under the encrypted `/v1/` API.

| Request | Who | What |
| --- | --- | --- |
| `GET /v1/entitlements` | anyone | The list, your standing, your `manager` and `reports`, `waiting` (requests for you to decide), and the gate's mode. Owners also get `org`. |
| `POST /v1/entitlements` | owner | `{ "name", "description", "hosts": [], "confirmation" }` |
| `PATCH /v1/entitlements/<id>` | owner | Any of the same fields. |
| `DELETE /v1/entitlements/<id>` | owner | Retire it. |
| `POST /v1/entitlements/<id>/request` | anyone | `{ "confirmed": true, "note" }` |
| `POST /v1/entitlements/<id>/people/<user id>` | their manager or an owner | `{ "decision": "grant" \| "deny" \| "revoke", "reason" }` |
| `GET /v1/entitlements/<id>/history` | owner | Every step, newest first. |
| `PUT /v1/people/<user id>/manager` | their manager or an owner | `{ "managerId" }` |
| `POST /v1/people/me/manager-invite` | anyone but an owner | `{ "name" }`; returns a one-use invite link. |

## Limits

- The confirmation is the person's word, checked by their manager. Servant does not look the person up in the other system.
- An entitlement opens hosts, not paths or repositories. Holding "GitHub" opens `github.com` for that person's agent; what the agent can do there is whatever the server's own credentials allow. Keep those credentials as narrow as the entitlement is meant to be.
- Taking an entitlement back from a manager does not take it back from the people they granted it to. Take those back one by one.
