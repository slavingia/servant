# Access tokens

A personal access token lets you use Servant from a script or a shell, without the app. It exists for one situation: a computer where nothing can be installed, so neither the app nor the MCP server can run there, but a shell can send web requests. With a token you can, from that shell, see the prototypes on your server, send one to people for review, and message your own agent and read its answer.

A coding agent in that shell can do the same on your say-so ("send the refund prototype to Jo and Sam for review"): `GET /api/v1` on your server is a short guide written for it, with PowerShell examples.

## Turning it on

Off by default. An owner adds this to the server's `config.json`; no restart is needed:

```json
"accessTokens": { "enabled": true, "requestsPerMinute": 60 }
```

While it is off, `/api/v1/` does not exist (every request gets the same 404 as any unknown address) and no token can be made. Turning it off again stops every token at once and deletes nothing.

## Making and revoking a token

In the app: **You**, then **Access tokens**. Name it after where you will use it, choose how long it lasts (a week to a year; 90 days unless you say), and press **Make token**. The token is shown once, with the lines to paste into PowerShell. After that the screen shows only its first and last characters, when it ends and when it was last used. **Revoke** stops it at once.

From the server's own terminal, for someone who can't get to the app:

```sh
node server/server.mjs token create --user "Pat Tester" --name "Work laptop" --days 90
node server/server.mjs token list --user "Pat Tester"
node server/server.mjs token revoke <token id> --user "Pat Tester"
```

A person can have 20 live tokens. A token also stops when its person is removed from the server.

## Using it

```powershell
$Servant = "https://team.example.gov/api/v1"
$Headers = @{ Authorization = "Bearer $env:SERVANT_TOKEN" }
Invoke-RestMethod "$Servant/me" -Headers $Headers
```

| Request | What it does |
| --- | --- |
| `GET /api/v1` | The guide. No token needed; it names nobody on the server. |
| `GET /api/v1/me` | Who the token acts as. |
| `GET /api/v1/prototypes?q=words` | Prototypes you can see: yours, ones shared with everyone, and all of them if you own the server. |
| `POST /api/v1/prototypes/<id>/shares` | `{ "emails": [...] }` or `{ "people": [{ "name", "email" }] }`, one to ten: sends each the review link ([prototype-reviews.md](prototype-reviews.md)) and returns, for each, the `link` and a `message` to paste. With `"invite": true` (owners), the person can also join the team from the review page. |
| `GET /api/v1/work?q=words` | Everything you are working on with the agent: prototypes, the app previews of your projects, and your own agent chats. Each has a `kind` (`prototype`, `app` or `chat`), and `canShare`. |
| `POST /api/v1/work/<id>/shares` | Send a prototype or a project's app preview for review. The same body and answer as for a prototype. |
| `POST /api/v1/work` | `{ "project": "permits", "folder": "pages/permit-claim" }` puts a copy of a folder of a project on the server so it can be sent for review. See [A folder from a project](#a-folder-from-a-project). |
| `POST /api/v1/agent` | `{ "text": "…" }` starts a new private chat with your agent; add `"chatId"` to continue one of yours. Answers at once; the agent works in the background. |
| `GET /api/v1/agent/<chatId>` | Whether the agent is still working, whether it is waiting for an approval, and the messages with its replies. |
| `POST /api/v1/feedback` | `{ "kind": "bug", "text": "…", "where": "…" }` reports something that broke, was slow, got in the way or was confusing. `kind` is `bug`, `friction`, `slow`, `confusing` or `idea`, and can be left out. |
| `GET /api/v1/feedback` | Your own reports and what became of each. |

### Sharing someone else's prototype

A prototype is shared by the person who made it, or by a **server owner on their behalf**. The second is new with tokens and only there: an owner can say "send the prototype Pat is working on to these two people" without going through Pat. The share still belongs to Pat: it appears in Pat's share sheet, the reviewers' comments arrive in Pat's chat, and Pat can end it. The email says who sent the link. Someone who is not an owner can share only their own.

### A message to copy, and inviting someone onto the server

Each person the link was sent to comes back with the review `link` and a `message` ready to paste into a chat or an email of your own, beside the email Servant sent: "Hi Jo, I've shared the prototype "Refund tracker" with you for review: … It will ask you to confirm your email with a code…". A name, when given, is used to greet them there and in Servant's email; it is not kept. Both end with a footnote for someone who has never seen Servant: what it is, that reviewing needs no account or install, and, when they are invited too, what joining adds.

The review link is returned only here, to the person who asked for it; the app's own share sheet never shows it. It shows the prototype to whoever opens it, as a prototype's own address always has; commenting as that person, and joining with their invite, still need the code sent to the address it was shared with.

With `"invite": true`, a **server owner** also invites each person onto the server in the same request, for someone who has no account and may want more than the full-screen prototype. Names are required.

It is still **one link**, and it opens on the prototype straight away. A box in the corner says they are invited: when they type the code emailed to them, right there, they can comment, and the page offers **Join <team>** for anyone who wants to go further. Because they already confirmed the address, joining puts that work email on their account without asking for a second code. The invite is single use, in their name, good for a week, and starts them as a member at the **Business owner** access level, with the owner who invited them deciding their entitlement requests. The message and the email say the invitation is waiting on that page; neither carries a join link, and the result says only `invited: true`. So nobody can join with a forwarded message: the invite is shown only to someone who confirmed the address it was sent to.

No invite is made for an address a prototype can't be shared with, or for someone who is already a member (`alreadyMember`). Once it is used or out of date, the page stops offering it and the prototype stays open to review.

Bringing people onto a server is an owner's job in the app (Invite people), and it is here: anyone else's token is refused `invite`.

## What a token can and can't do

- It works **only at `/api/v1/`**. The app's own API (`/v1/`) does not accept it, even over the encrypted transport, and `/api/v1/` does not accept a device's credential. So a token cannot read or post in channels, direct messages or cases, cannot read anyone else's agent chats (not even an owner's token can), and cannot change people, projects, entitlements or settings.
- A report sent to `/api/v1/feedback` joins the same queue as feedback sent from the app and becomes an issue in the server's feedback repository for a person to read. No agent reads or acts on it: the words are kept as data, in a code block. The guide at `GET /api/v1` asks a coding agent to send one on its own when something fails, is slow or is unclear, so friction gets written down without anyone having to remember. Limits are the app's: 4,000 characters, five reports an hour for each person. A credential in the text is refused. Sending the same `requestId` again returns the first report.
- The work list shows more than prototypes, because a prototype built in Servant is only one of the things people make with the agent. A project's **app preview** ([app-preview.md](app-preview.md)) is listed for everyone in the project and each person sends it as themselves, as in the app; an invitation to join does not go with it. A **chat** is listed only for its own person, with `canShare: false` and a `why`: work the agent did in a project's folder or repository (a page in a repository, a branch) is not on the server, so there is nothing a reviewer's link could open. Asking to share one answers `409 nothing_to_open` with the same words. To get comments on that work, publish its folder (below), build it as a prototype in Servant, or put the project's app preview on the server.
- A message to the agent runs as you, in a private chat of yours, under your access, entitlements and daily limit, like one typed in the app. It gets the same two checks: a credential in it is refused, and personal information gets a warning (send again with `"confirmPii": true`). Approvals are still given in the app.
- Each token has a number of requests a minute (`requestsPerMinute`, 60 unless set).

## The decision this records: not app-encrypted

Everything the app sends is encrypted to the server's own key on top of HTTPS, so a relay or tunnel in between cannot read it ([encryption.md](encryption.md)). **`/api/v1/` is not.** It is ordinary HTTPS: whatever carries the connection to the server (the tunnel or relay in front of it) can read these requests and answers, and the token in them. That is the price of working from a shell with nothing installed, and it is why:

- it is off unless an owner turns it on;
- it is a short list of things, not the app's API under another name;
- nothing under `/v1/` changed: it still refuses anything unencrypted, and still does not take a token.

Decided by the maintainer on 2026-11-20, in place of running the MCP server, which would have to be installed on the computer in question. If your server sits behind a relay you do not run, weigh that before turning this on, and keep what you send through it to what you would be content for the relay to see.

Use the server's `https://` address. A token sent to an `http://` address crosses the network in the clear.

## What is kept

`access-tokens.db` in the data directory holds, for each token: its hash (never the token), whose it is, its name, its first eight and last four characters, when it was made, when it ends, when it was last used (to the minute) and when it was revoked. Tokens are revoked, never deleted; the table refuses deletes.

`node scripts/access-tokens-e2e.mjs` makes a token in the app in a browser against a temporary server, uses it with `curl`, and saves captures to `docs/shots/access-tokens`.

## A folder from a project

A page the agent built in a project's repository (a folder with an `index.html`) lives on the computer the project is on. A reviewer's link has nothing to open. `POST /api/v1/work` with the project and the folder copies that one folder to where the server serves prototypes, and from then on it is a prototype of yours: it has an address, a chat where reviewers' comments arrive, and it is sent with `POST /api/v1/work/<id>/shares` like any other.

- **Who:** someone in the project, for themselves. Each person who publishes a folder gets their own copy.
- **One folder, never the whole project.** The folder must be named and must be inside the project; a request with no folder is refused, even when the project's own folder has an `index.html`.
- **What is copied:** plain files in that folder and the folders inside it. Never anything whose name starts with a dot (`.git`, `.env`), `node_modules`, or links, so nothing outside the folder comes along. A folder that is hidden, that is not inside the project, or that is a link leading out of it is refused.
- **Limits:** 2,000 files, 200 MB in all, 25 MB a file. The folder needs an `index.html`.
- **It is a copy as of now.** It does not follow the repository. Publish the same folder again to replace the copy; its address, its chat and the reviewers' links stay the same. Changes the agent makes in the prototype's chat change the copy, not the repository, and the next publish replaces them.
- **Who can open it:** the same as any prototype on the server. Its address is long and unguessable, and a review link goes only to an address at a domain this server allows.
- With records preservation on, a copy that is replaced is moved aside, not deleted.

This is a change to what can leave the project's folder: before it, files in a project reached people outside only through the agent or through GitHub. Here a person in the project chooses one folder and the server shows a copy of it to the reviewers they name.
